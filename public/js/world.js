/**
 * world.js
 * Jamri Pixel World — Phase 1 (presence only).
 *
 * A self-contained realtime pixel world: an emoji avatar you move with WASD /
 * arrows (or an on-screen joystick on mobile), other players walking around,
 * and a camera that follows you. Rendering is fully procedural (no image assets
 * to load): floor, walls and avatars are all drawn on a 2D canvas with
 * `imageSmoothingEnabled = false` for a crisp pixel-art look.
 *
 * Networking is intentionally separate from the room WebSocket so the legacy
 * room flow stays untouched. The server is authoritative for collisions; the
 * client predicts locally for instant response and lerps remote avatars.
 */

// ---------------------------------------------------------------------------
// Tiny deterministic helpers used by the procedural art (no assets needed).
// ---------------------------------------------------------------------------

/** Stable 0..1 noise for a tile coordinate; same value on every client. */
function hash2(x, y, seed = 0) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Stable 0..1 hash for a string id (mat colours). */
function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
}

/** Rounded-rect path helper (kept local so the canvas API stays portable). */
function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
}

// ---------------------------------------------------------------------------
// Speech-bubble text hardening.
//
// Chat arrives from other clients, so a bubble must survive anything: control
// characters, zero-width joiners, bidi overrides (which can visually reverse the
// line), RTL marks, huge single "words" without spaces, or a 5000-char payload.
// Everything is normalised to one safe line-set BEFORE it reaches the canvas:
// canvas has no HTML escaping, so the danger here is not XSS but a broken layout
// (infinite wrap loop) or a poisoned direction/measure.
// ---------------------------------------------------------------------------
const BUBBLE_MAX_CHARS = 120;   // hard cap on rendered characters
const BUBBLE_MAX_LINES = 3;     // a bubble never grows taller than this
const BUBBLE_MAX_WIDTH = 190;   // px, before zoom

/**
 * Normalise untrusted chat text for canvas rendering.
 * Returns '' when nothing printable is left, which means "draw no bubble".
 */
function sanitizeBubbleText(raw) {
    if (typeof raw !== 'string') {
        if (raw === null || raw === undefined) return '';
        try { raw = String(raw); } catch (e) { return ''; }
    }
    let text = raw
        // Control chars + DEL (tabs/newlines included: a bubble is one paragraph).
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        // Bidi overrides/isolates + RTL/LTR marks: these reorder the drawn line.
        .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, '')
        // Zero-width and invisible formatting characters.
        .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
        // Unicode line/paragraph separators.
        .replace(/[\u2028\u2029]/g, ' ')
        // Collapse any whitespace run.
        .replace(/\s+/g, ' ')
        .trim();

    if (text === '') return '';

    // Cap by code point so a surrogate pair (emoji) is never split in half.
    const chars = Array.from(text);
    if (chars.length > BUBBLE_MAX_CHARS) {
        text = chars.slice(0, BUBBLE_MAX_CHARS).join('').trimEnd() + '…';
    }
    return text;
}

/**
 * Split sanitised text into at most BUBBLE_MAX_LINES lines that fit maxWidth.
 * Long tokens without spaces are hard-broken character by character, otherwise
 * the old word-based wrapper emitted a single overflowing line.
 */
function wrapBubbleLines(ctx, text, maxWidth) {
    const lines = [];
    if (!text) return lines;

    let current = '';
    const flush = () => {
        if (current !== '') {
            lines.push(current);
            current = '';
        }
    };

    for (const word of text.split(' ')) {
        if (word === '') continue;

        // Does this word fit on the current line?
        const candidate = current === '' ? word : current + ' ' + word;
        if (ctx.measureText(candidate).width <= maxWidth) {
            current = candidate;
            continue;
        }

        // Word does not fit: close the current line first.
        flush();

        // A single word wider than the bubble must be broken by character.
        if (ctx.measureText(word).width > maxWidth) {
            let chunk = '';
            for (const ch of Array.from(word)) {
                if (ctx.measureText(chunk + ch).width > maxWidth && chunk !== '') {
                    lines.push(chunk);
                    chunk = ch;
                    if (lines.length === BUBBLE_MAX_LINES) break;
                } else {
                    chunk += ch;
                }
            }
            if (lines.length === BUBBLE_MAX_LINES) {
                current = '';
                break;
            }
            current = chunk;
        } else {
            current = word;
        }

        if (lines.length === BUBBLE_MAX_LINES) break;
    }

    if (lines.length < BUBBLE_MAX_LINES) flush();

    // Anything that did not fit is summarised, never silently dropped.
    const rendered = lines.slice(0, BUBBLE_MAX_LINES);
    if (lines.length > BUBBLE_MAX_LINES || rendered.join(' ').length < text.length) {
        const last = rendered[rendered.length - 1] || '';
        if (!last.endsWith('…')) {
            rendered[rendered.length - 1] = (last.length > 1 ? last.slice(0, -1) : last) + '…';
        }
    }
    return rendered;
}

class JamriWorld {
    static SPEED = 150;          // px per second
    static SEND_HZ = 12;         // position updates per second
    static LERP = 14;            // higher = snappier remote interpolation
    static TILE = 32;

    constructor(player) {
        this.player = player;
        this.ws = null;
        this.worldId = null;
        this.user = null;
        this.map = null;
        this.myId = null;
        this.me = { x: 0, y: 0, dir: 0 };
        this.avatars = new Map();
        this.cam = { x: 0, y: 0 };
        this.keys = {};
        this.joystick = { x: 0, y: 0, active: false, id: null };
        this.lastSend = 0;
        this.lastFrame = 0;
        this.rafId = null;
        this.canvas = null;
        this.ctx = null;
        this._bound = {};
        this.online = 0;

        // Mats (jamming boxes)
        this.boxes = [];
        this.activeBox = null;
        this.roomEventsBound = false;
        this.choiceOpen = false;

        // Phase 3/4 polish
        this.emotes = [];            // floating emote bubbles {id, emote, t}
        this.worldChat = [];         // global world chat log
        this.chatTab = 'mat';        // active chat tab: 'mat' | 'world'
        this._playlist = [];         // mat Bank Musik mirror
        this._matUsers = [];
        // Deferred mat-snapshot re-applies (see onRoomInit). Tracked so a newer
        // play/pause/seek cannot be undone by a stale snapshot.
        this._matApplyTimers = [];
        this.minimap = null;
        this.minimapCtx = null;

        // Animation + scene cache (bright daylight rendering)
        this.now = 0;
        this.moving = false;
        this.walkPhase = 0;
        this.camLook = { x: 0, y: 0 };
        this.footTimer = 0;
        this.noteTimer = 0;
        this.particles = [];
        this.bubbles = new Map();
        this.decor = null;
        this.plaza = { x: 0, y: 0, r: 0 };
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------
    enter(worldId, user) {
        this.worldId = worldId;
        this.user = user;
        // Fresh scene state on every entry (re-entering must not inherit the
        // previous world's particles/bubbles or stale tile cache).
        this.particles = [];
        this.bubbles.clear();
        this.decor = null;
        this.camLook = { x: 0, y: 0 };
        this.walkPhase = 0;
        // No mat is joined yet on entry: clear the shared mirrors so a world opened
        // right after a room/mat never shows that session's queue or Bank Musik.
        this.activeBox = null;
        this.roomState = null;
        this._resetMatLists();
        this.buildDom();
        this.bindInput();
        // connect() resets listeners and (re)binds all handlers.
        this.connect();
    }

    /**
     * Bind all websocket events on the SHARED client. World-presence events are
     * routed to handleMessage(); room/mat events hydrate the mat panel.
     */
    bindRoomEvents() {
        const ws = window.JAMRI_APP && window.JAMRI_APP.wsClient;
        if (!ws) return;
        this.roomEventsBound = true;

        // World presence protocol.
        ws.on('world_init', (d) => this.handleMessage(d));
        ws.on('world.snapshot', (d) => this.handleMessage(d));
        ws.on('world.leave', (d) => this.handleMessage(d));
        ws.on('world.boxes', (d) => this.handleMessage(d));
        ws.on('world.chat', (d) => this.handleMessage(d));
        ws.on('world.emote', (d) => this.handleMessage(d));
        ws.on('mat.placed', (d) => this.handleMessage(d));
        ws.on('mat.removed', (d) => this.handleMessage(d));
        ws.on('zone.enter', (d) => this.handleMessage(d));
        ws.on('zone.exit', (d) => this.handleMessage(d));
        ws.on('zone.choice_required', (d) => this.handleMessage(d));
        ws.on('world_full', (d) => this.handleMessage(d));
        ws.on('world_not_found', (d) => this.handleMessage(d));

        // Room/mat panel events (same protocol as the legacy room flow).
        ws.on('connection_change', (data) => {
            const dot = document.getElementById('world-conn-dot');
            if (dot) {
                dot.style.background = (data && data.connected) ? 'var(--success)' : 'var(--danger)';
                dot.title = (data && data.connected) ? 'Terhubung' : 'Terputus';
            }
            const loading = document.getElementById('world-loading');
            if (loading && data && data.connected) {
                loading.style.display = 'none';
            }
            if (loading && data && !data.connected && this.map) {
                loading.style.display = 'flex';
                loading.innerHTML = '<span>Koneksi terputus. Menghubungkan ulang...</span>';
            }
        });
        ws.on('room_init', (data) => this.onRoomInit(data));
        ws.on('chat_message', (data) => {
            if (data.message) {
                this.appendRoomChat(data.message);
                this.showBubble(data.message);
            }
        });
        ws.on('queue_updated', (data) => {
            if (data.queue) this.renderQueue(data.queue);
        });
        ws.on('playlist_updated', (data) => {
            if (data.playlist) this.renderPlaylist(data.playlist);
        });
        ws.on('user_joined', (data) => {
            if (data.online_users) this.renderUsers(data.online_users);
        });
        ws.on('user_left', (data) => {
            if (data.online_users) this.renderUsers(data.online_users);
        });

        // Playback events for the mat we are standing on.
        ws.on('play', (data) => this.player.syncJammingState(data.track || null, 'playing', data.position, data.server_time, true));
        ws.on('pause', (data) => this.player.syncJammingState(data.track || null, 'paused', data.position, data.server_time, true));
        ws.on('seek', (data) => this.player.syncJammingState(data.track || null, data.state, data.position, data.server_time, true));
        ws.on('track_change', (data) => {
            if (data.track) {
                this.player.serverPlaybackState = data.state || 'playing';
                this.player.serverBasePos = data.position || 0;
                this.player.serverSyncTime = data.server_time || Date.now();
                this.player.playTrack(data.track, data.position || 0);
            }
        });
        ws.on('playback_stopped', () => this.player.stop());
        ws.on('loop_changed', (data) => {
            if (data.loop_mode) this.player.setLoopMode(data.loop_mode);
        });

        // Playback heartbeat. connect() wipes every listener before re-binding,
        // so without this the mat never re-synced after the initial room_init:
        // someone joining mid-song drifted from the rest of the mat (legacy
        // rooms already handled pong in app.js).
        ws.on('pong', (data) => {
            if (!this.activeBox) return;
            if (document.hidden) return;
            this.player.syncJammingState(data.track || null, data.state, data.position, data.server_time);
        });

        ws.on('notice', (data) => {
            if (data.message && window.showToast) window.showToast(data.message, data.level || 'info');
        });
    }

    onRoomInit(data) {
        this.roomState = {
            roomId: data.room_id,
            control: data.control_mode || 'everyone',
        };
        if (data.queue) this.renderQueue(data.queue);
        // room_init is the authoritative snapshot for the mat we just entered, so
        // the Bank Musik is refreshed here too (leaving/re-entering must show the
        // current playlist, not a cached one).
        this.renderPlaylist(data.playlist || []);
        if (data.online_users) this.renderUsers(data.online_users);

        // Any pending "re-apply the snapshot" timer from a previous join belongs to
        // a stale snapshot. Leaving them running made a later play/pause look like
        // it "reverted" on its own after re-entering the mat.
        this._clearMatApplyTimers();

        // Joining a mat mid-song must land on the SAME position as everyone else.
        // playTrack(track, pos) alone is not reliable here: the YouTube bridge may
        // still be initialising, and playTrack() then only queues the track and
        // drops the start position (late joiners used to begin at 0:00).
        if (data.current_track) {
            const player = this.player;
            const wantTrack = data.current_track;
            const wantState = data.state || 'stopped';
            const wantPos = data.position || 0;
            const wantTime = data.server_time || Date.now();

            player.serverPlaybackState = wantState;
            player.serverBasePos = wantPos;
            player.serverSyncTime = wantTime;

            const isSame = player.currentTrack && player.currentTrack.youtube_id === wantTrack.youtube_id;
            if (isSame) {
                player.syncJammingState(wantTrack, wantState, wantPos, wantTime, true);
            } else {
                // Seed the server state BEFORE playTrack so the player knows it must
                // not auto-play when the mat is paused.
                player.serverPlaybackState = wantState;
                player.playTrack(wantTrack, wantPos);
                if (wantState !== 'playing') player.pause();
            }

            // Re-apply once the engine is ready so the start position sticks. Only
            // do this while the snapshot is still the newest thing we know about:
            // if a play/pause/seek/pong arrived in the meantime, that newer state
            // wins and the deferred apply must not undo it.
            const apply = () => {
                if (!player.currentTrack || player.currentTrack.youtube_id !== wantTrack.youtube_id) return;
                if ((player.serverSyncTime || 0) > wantTime) return;
                player.syncJammingState(wantTrack, wantState, wantPos, wantTime, true);
            };
            this._matApplyTimers = this._matApplyTimers || [];
            this._matApplyTimers.push(setTimeout(apply, 900));
            this._matApplyTimers.push(setTimeout(apply, 2200));
        } else {
            this.player.stop();
        }
        this.updatePanelRoomInfo();
        this.setChatTab(this.chatTab || 'mat');
    }

    /** Cancel deferred mat-snapshot re-applies (new join, mat exit, teardown). */
    _clearMatApplyTimers() {
        if (!this._matApplyTimers) {
            this._matApplyTimers = [];
            return;
        }
        this._matApplyTimers.forEach((t) => clearTimeout(t));
        this._matApplyTimers = [];
    }

    appendRoomChat(msg) {
        const list = document.getElementById('mat-chat-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'mat-chat-row';
        const isMe = window.JAMRI_USER && window.JAMRI_USER.nickname === msg.sender_nickname;
        row.innerHTML = `<span class="mat-chat-nick">${safeEmoji(msg.sender_emoji)} ${escapeHtml(msg.sender_nickname)}</span>
            <span class="mat-chat-text" style="${isMe ? 'color:var(--primary)' : ''}">${escapeHtml(msg.message)}</span>`;
        list.appendChild(row);
        list.scrollTop = list.scrollHeight;
    }

    renderUsers(users) {
        const el = document.getElementById('mat-users-list');
        if (!el) return;
        el.innerHTML = (users || []).map(u =>
            `<span class="mat-user-chip">${safeEmoji(u.emoji)} ${escapeHtml(u.nickname)}</span>`
        ).join('');
    }

    renderQueue(queue) {
        this._queue = queue || [];
        // search.js checks JAMRI_APP.roomQueue for duplicates before adding. The
        // mat queue is the shared queue in world mode, so mirror it there or the
        // same song can be queued twice and the two lists drift apart.
        if (window.JAMRI_APP) window.JAMRI_APP.roomQueue = this._queue;
        const el = document.getElementById('mat-queue-list');
        if (!el) return;
        if (this._queue.length === 0) {
            el.innerHTML = '<div class="mat-empty">Antrean kosong. Klik "Cari Musik" untuk menambah lagu.</div>';
            return;
        }
        el.innerHTML = this._queue.map((t, i) => `
            <div class="mat-queue-row">
                <span class="mat-queue-idx">${i + 1}</span>
                <span class="mat-queue-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
                <button type="button" class="btn btn-ghost btn-icon btn-xs mat-queue-play" data-id="${t.id}" title="Putar sekarang">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </button>
                <button type="button" class="btn btn-ghost btn-icon btn-xs mat-queue-remove" data-id="${t.id}" title="Hapus">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>
        `).join('');

        el.querySelectorAll('.mat-queue-play').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.id, 10);
                const track = this._queue.find(t => t.id === id);
                if (track) {
                    window.JAMRI_APP.wsClient.sendSetTrack(track);
                }
            });
        });
        el.querySelectorAll('.mat-queue-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                window.JAMRI_APP.wsClient.sendQueueRemove(parseInt(btn.dataset.id, 10));
            });
        });
    }

    /**
     * Blank every panel that belongs to the mat we just left: queue, Bank Musik,
     * chat log and the user chips. Also drops the shared mirrors that search.js
     * consults (`roomQueue` / `roomPlaylist`), otherwise a stale list makes the
     * next "add to queue" look like a duplicate or silently targets the old mat.
     */
    _resetMatLists() {
        this._queue = [];
        this._playlist = [];
        this._matUsers = [];
        if (window.JAMRI_APP) {
            window.JAMRI_APP.roomQueue = [];
            window.JAMRI_APP.roomPlaylist = [];
        }

        const ql = document.getElementById('mat-queue-list');
        if (ql) ql.innerHTML = '<div class="mat-empty">Belum bergabung ke tikar.</div>';
        const pl = document.getElementById('mat-playlist-list');
        if (pl) pl.innerHTML = '<div class="mat-empty">Belum bergabung ke tikar.</div>';
        const ul = document.getElementById('mat-users-list');
        if (ul) ul.innerHTML = '';
        const cl = document.getElementById('mat-chat-list');
        if (cl) cl.innerHTML = '';
    }

    /** Mirror the mat's Bank Musik (shared with the room) into the panel. */
    renderPlaylist(playlist) {
        this._playlist = playlist || [];
        if (window.JAMRI_APP) window.JAMRI_APP.roomPlaylist = this._playlist;
        const el = document.getElementById('mat-playlist-list');
        if (!el) return;
        if (this._playlist.length === 0) {
            el.innerHTML = '<div class="mat-empty">Bank Musik tikar masih kosong.</div>';
            return;
        }
        el.innerHTML = this._playlist.map((t) => `
            <div class="mat-queue-row">
                <span class="mat-queue-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
                <button type="button" class="btn btn-ghost btn-icon btn-xs mat-playlist-queue" data-id="${t.id}" title="Masukkan ke antrean">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                </button>
                <button type="button" class="btn btn-ghost btn-icon btn-xs mat-playlist-remove" data-id="${t.id}" title="Hapus dari Bank Musik">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>
        `).join('');

        el.querySelectorAll('.mat-playlist-queue').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.id, 10);
                const track = this._playlist.find((t) => t.id === id);
                if (track) window.JAMRI_APP.wsClient.sendQueueAdd(track);
            });
        });
        el.querySelectorAll('.mat-playlist-remove').forEach((btn) => {
            btn.addEventListener('click', () => {
                window.JAMRI_APP.wsClient.sendPlaylistRemove(parseInt(btn.dataset.id, 10));
            });
        });
    }

    updatePanelRoomInfo() {
        const info = document.getElementById('mat-room-info');
        if (!info) return;
        if (!this.activeBox) {
            info.textContent = 'Belum bergabung ke tikar mana pun.';
            return;
        }
        const controlLabel = (this.roomState && this.roomState.control === 'owner')
            ? 'Hanya pemilik yang bisa kontrol'
            : 'Semua peserta bisa kontrol';
        info.textContent = `${this.activeBox.label} • ${controlLabel}`;
    }

    appendWorldChat(message) {
        if (!message) return;
        this.worldChat.push(message);
        if (this.worldChat.length > 100) this.worldChat.shift();
        const list = document.getElementById('world-chat-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'mat-chat-row';
        row.innerHTML = `<span class="mat-chat-nick">${safeEmoji(message.sender_emoji)} ${escapeHtml(message.sender_nickname)}</span>
            <span class="mat-chat-text">${escapeHtml(message.message)}</span>`;
        list.appendChild(row);
        list.scrollTop = list.scrollHeight;
    }

    /**
     * WorkAdventure-style speech bubble above the avatar that wrote a message.
     * Bubbles are keyed by avatar id and fade out on their own.
     *
     * Both chat channels funnel through here: mat chat (`chat_message`, scoped to
     * the mat you are standing on) and world chat (`world.chat`, whole map).
     */
    showBubble(msg) {
        if (!msg) return;
        const text = sanitizeBubbleText(msg.message);
        if (text === '') return;

        const id = this.resolveAvatarId(msg);
        if (id === null || id === undefined) return;

        // Newest message wins for that avatar; the layout is measured lazily on
        // the first frame so the canvas font metrics are authoritative.
        this.bubbles.set(id, { text, t: performance.now(), layout: null });

        // Defensive cap: never keep more bubbles than there are avatars.
        if (this.bubbles.size > 64) {
            const oldest = Array.from(this.bubbles.entries())
                .sort((a, b) => a[1].t - b[1].t)
                .slice(0, this.bubbles.size - 64);
            oldest.forEach(([key]) => this.bubbles.delete(key));
        }
    }

    /**
     * Map a chat payload to an avatar id.
     *
     * `sender_res_id` (the sender's connection id, added by the server) is the
     * exact answer. Nickname matching is only a fallback for older payloads and
     * for our own avatar, because two players can share a nickname.
     */
    resolveAvatarId(msg) {
        const resId = Number(msg.sender_res_id);
        if (Number.isFinite(resId) && resId > 0) {
            if (resId === this.myId) return this.myId;
            if (this.avatars.has(resId)) return resId;
        }

        const nick = typeof msg.sender_nickname === 'string' ? msg.sender_nickname : '';
        if (nick === '') return null;
        if (this.user && nick === this.user.nickname) return this.myId;

        for (const [avId, av] of this.avatars.entries()) {
            if (av.nick === nick) return avId;
        }
        return null;
    }

    sendEmote(emote) {
        this.send('world.emote', { emote });
        // Show it locally right away for instant feedback.
        this.emotes.push({ id: this.myId, emote, t: performance.now() });
    }

    leave() {
        this.unbindInput();
        this._clearMatApplyTimers();
        // A world exit is also a shared-session exit: never leave the mat's song
        // or its mirrors behind for the lobby/solo view.
        this.activeBox = null;
        this.roomState = null;
        this.player.setMatVolumeScale(1);
        this.player.resetSharedSession();
        this._resetMatLists();
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        // Disconnect the shared client so the next room/world starts clean.
        const client = window.JAMRI_APP && window.JAMRI_APP.wsClient;
        if (client) {
            try { client.disconnect(); } catch (e) {}
        }
        this.ws = null;
        this.avatars.clear();
        const container = document.getElementById('world-view');
        if (container) container.innerHTML = '';
        this.canvas = null;
        this.ctx = null;
    }

    buildDom() {
        const container = document.getElementById('world-view');
        if (!container) return;
        container.innerHTML = `
            <div class="world-shell">
                <div class="world-hud-top">
                    <button type="button" id="btn-leave-world" class="btn btn-outline btn-sm">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="19" y1="12" x2="5" y2="12"></line>
                            <polyline points="12 19 5 12 12 5"></polyline>
                        </svg>
                        <span>Keluar World</span>
                    </button>
                    <div class="world-hud-info">
                        <span id="world-conn-dot" title="Status koneksi" style="display:inline-block; width:9px; height:9px; border-radius:50%; background:var(--text-muted); flex-shrink:0;"></span>
                        <span id="world-name-label" class="world-name-label">World</span>
                        <span id="world-online-badge" class="world-online-badge">0 online</span>
                        <span id="world-debug-badge" class="world-online-badge" title="Versi antarmuka & ukuran peta" style="background:var(--bg-surface-elevated);color:var(--text-muted);">v5</span>
                    </div>
                    <div class="world-hud-actions">
                        <button type="button" id="btn-place-mat" class="btn btn-primary btn-sm" title="Gelar tikar jamming di posisi Anda">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                                <path d="M3 15h18"></path>
                            </svg>
                            <span>Gelar Tikar</span>
                        </button>
                        <button type="button" id="btn-mat-search" class="btn btn-outline btn-sm" title="Cari musik untuk tikar Anda">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="11" cy="11" r="8"></circle>
                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                            </svg>
                            <span>Cari Musik</span>
                        </button>
                    </div>
                </div>

                <div class="world-hud-sub">
                    <span id="mat-room-info" class="mat-room-info">Belum bergabung ke tikar mana pun.</span>
                    <span class="world-hint">Gerak: WASD / panah</span>
                </div>

                <div class="world-body">
                    <div class="world-stage" id="world-stage">
                        <canvas id="world-canvas"></canvas>
                        <canvas id="world-minimap" class="world-minimap" width="150" height="100"></canvas>
                        <div class="world-emote-bar" id="world-emote-bar">
                            <button type="button" class="world-emote-btn" data-emote="😂">😂</button>
                            <button type="button" class="world-emote-btn" data-emote="🔥">🔥</button>
                            <button type="button" class="world-emote-btn" data-emote="👏">👏</button>
                            <button type="button" class="world-emote-btn" data-emote="❤️">❤️</button>
                            <button type="button" class="world-emote-btn" data-emote="👍">👍</button>
                            <button type="button" class="world-emote-btn" data-emote="🎵">🎵</button>
                        </div>
                        <div class="world-loading" id="world-loading">
                            <div class="spinner"></div>
                            <span>Memasuki world...</span>
                        </div>
                        <div class="world-joystick" id="world-joystick">
                            <div class="world-joystick-knob" id="world-joystick-knob"></div>
                        </div>
                    </div>

                    <aside class="mat-panel" id="mat-panel">
                        <div class="mat-panel-head">
                            <span>Tikar Saya</span>
                            <button type="button" class="btn btn-ghost btn-icon btn-xs" id="btn-mat-pickup" title="Angkat tikar (hanya pemilik)">✕</button>
                        </div>
                        <div class="mat-users-list" id="mat-users-list"></div>
                        <div class="mat-queue-title-label">Antrean Tikar</div>
                        <div class="mat-queue-list" id="mat-queue-list">
                            <div class="mat-empty">Belum bergabung ke tikar.</div>
                        </div>

                        <div class="mat-queue-title-label">Bank Musik Tikar</div>
                        <div class="mat-queue-list" id="mat-playlist-list">
                            <div class="mat-empty">Belum bergabung ke tikar.</div>
                        </div>

                        <div class="world-chat-block">
                            <div class="world-chat-tabs" role="tablist">
                                <button type="button" class="world-chat-tab active" id="world-chat-tab-mat" role="tab"
                                        aria-selected="true" aria-controls="world-chat-panel-mat" data-chat-tab="mat">Chat Tikar</button>
                                <button type="button" class="world-chat-tab" id="world-chat-tab-world" role="tab"
                                        aria-selected="false" aria-controls="world-chat-panel-world" data-chat-tab="world">Chat World</button>
                            </div>
                            <div class="world-chat-panel active" id="world-chat-panel-mat" role="tabpanel" aria-labelledby="world-chat-tab-mat">
                                <div class="mat-chat-list" id="mat-chat-list"></div>
                            </div>
                            <div class="world-chat-panel" id="world-chat-panel-world" role="tabpanel" aria-labelledby="world-chat-tab-world">
                                <div class="mat-chat-list" id="world-chat-list"></div>
                            </div>
                            <form class="mat-chat-form" id="world-chat-form">
                                <input type="text" id="world-chat-input" class="mat-chat-input" placeholder="Chat tikar..." maxlength="300" autocomplete="off" />
                                <button type="submit" class="btn btn-primary btn-sm" id="world-chat-send">Kirim</button>
                            </form>
                        </div>
                    </aside>
                </div>
            </div>
        `;
        this.canvas = container.querySelector('#world-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.minimap = container.querySelector('#world-minimap');
        this.minimapCtx = this.minimap ? this.minimap.getContext('2d') : null;

        container.querySelectorAll('.world-emote-btn').forEach(btn => {
            btn.addEventListener('click', () => this.sendEmote(btn.dataset.emote));
        });

        const leaveBtn = container.querySelector('#btn-leave-world');
        if (leaveBtn) leaveBtn.addEventListener('click', () => leaveWorld());

        const placeBtn = container.querySelector('#btn-place-mat');
        if (placeBtn) placeBtn.addEventListener('click', () => this.openPlaceMatDialog());

        const searchBtn = container.querySelector('#btn-mat-search');
        if (searchBtn) searchBtn.addEventListener('click', () => {
            if (window.JAMRI_APP.searchModule) {
                window.JAMRI_APP.searchModule.setWebSocket(window.JAMRI_APP.wsClient);
                window.JAMRI_APP.searchModule.showModal();
            }
        });

        const pickupBtn = container.querySelector('#btn-mat-pickup');
        if (pickupBtn) pickupBtn.addEventListener('click', () => {
            if (!this.activeBox) {
                if (window.showToast) window.showToast('Kamu belum berada di tikar.', 'warning');
                return;
            }
            this.send('mat.pickup', { box_id: this.activeBox.id });
        });

        const chatForm = container.querySelector('#world-chat-form');
        if (chatForm) {
            chatForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const input = document.getElementById('world-chat-input');
                const text = input.value.trim();
                if (!text) return;
                if (this.chatTab === 'world') {
                    this.send('world.chat', { message: text });
                } else {
                    if (!this.activeBox) {
                        if (window.showToast) window.showToast('Masuk ke tikar dulu untuk chat tikar.', 'warning');
                        return;
                    }
                    window.JAMRI_APP.wsClient.sendChatMessage(text);
                }
                input.value = '';
            });
        }

        container.querySelectorAll('.world-chat-tab').forEach(tab => {
            tab.addEventListener('click', () => this.setChatTab(tab.dataset.chatTab));
        });
        this.setChatTab(this.chatTab || 'mat');

        window.addEventListener('resize', this._bound.resize = () => this.resize());

        // The stage can also change size without a window resize (panel content
        // growing, dock height changes, layout settling after the first paint).
        // Without this the canvas buffer goes stale and the world is stretched.
        if (typeof ResizeObserver !== 'undefined') {
            if (this._resizeObserver) this._resizeObserver.disconnect();
            this._resizeObserver = new ResizeObserver(() => this.resize());
            const stage = document.getElementById('world-stage');
            if (stage) this._resizeObserver.observe(stage);
        }

        this.resize();
    }

    /**
     * One chat panel, two tabs. The mat tab is only meaningful while standing on
     * a mat, so the tab shows that state instead of silently swallowing input.
     */
    setChatTab(tab) {
        const target = tab === 'world' ? 'world' : 'mat';
        this.chatTab = target;

        document.querySelectorAll('.world-chat-tab').forEach(el => {
            const on = el.dataset.chatTab === target;
            el.classList.toggle('active', on);
            el.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        document.querySelectorAll('.world-chat-panel').forEach(el => {
            el.classList.toggle('active', el.id === `world-chat-panel-${target}`);
        });

        const input = document.getElementById('world-chat-input');
        const send = document.getElementById('world-chat-send');
        const onMat = !!this.activeBox;
        if (input) {
            input.placeholder = target === 'world'
                ? 'Chat world...'
                : (onMat ? 'Chat tikar...' : 'Chat tikar (masuk tikar dulu)');
        }
        if (send) {
            send.className = target === 'world' ? 'btn btn-outline btn-sm' : 'btn btn-primary btn-sm';
        }

        const matTab = document.getElementById('world-chat-tab-mat');
        if (matTab) matTab.classList.toggle('needs-mat', !onMat);

        // Keep the newest message visible when switching tabs.
        const list = document.getElementById(target === 'world' ? 'world-chat-list' : 'mat-chat-list');
        if (list) list.scrollTop = list.scrollHeight;
    }

    openPlaceMatDialog() {
        let modal = document.getElementById('mat-place-modal');
        if (modal) modal.remove();

        modal = document.createElement('div');
        modal.id = 'mat-place-modal';
        modal.className = 'modal-backdrop active';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-card" style="max-width:380px;">
                <div class="modal-header">
                    <h3 class="modal-title">Gelar Tikar Jamming</h3>
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label class="form-label" for="mat-label-input">Nama Tikar</label>
                        <input type="text" id="mat-label-input" class="form-input" placeholder="contoh: Tikar Lo-Fi" maxlength="40" />
                    </div>
                    <div class="form-group">
                        <label class="form-label">Siapa yang boleh kontrol musik?</label>
                        <div style="display:flex; gap:16px; margin-top:6px;">
                            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                                <input type="radio" name="mat_control" value="everyone" checked /> Semua peserta
                            </label>
                            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                                <input type="radio" name="mat_control" value="owner" /> Hanya saya
                            </label>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-outline" id="btn-mat-cancel">Batal</button>
                    <button type="button" class="btn btn-primary" id="btn-mat-confirm">Gelar Tikar</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Guard against stacked dialogs (e.g. a modal left open on top).
        const topModal = document.querySelector('.modal-backdrop.active');
        if (topModal && topModal !== modal) {
            topModal.remove();
        }

        const labelInput = modal.querySelector('#mat-label-input');
        const close = () => modal.remove();
        modal.querySelector('#btn-mat-cancel').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        modal.querySelector('#btn-mat-confirm').addEventListener('click', () => {
            const label = labelInput.value.trim();
            const control = modal.querySelector('input[name="mat_control"]:checked').value;
            this.send('mat.place', { label, control_mode: control });
            close();
        });

        // Focus the name input and submit on Enter so the dialog is usable
        // immediately (previously keystrokes leaked to the avatar movement).
        setTimeout(() => { if (labelInput) labelInput.focus(); }, 50);
        labelInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                modal.querySelector('#btn-mat-confirm').click();
            }
        });
    }

    resize() {
        if (!this.canvas) return;
        const stage = document.getElementById('world-stage');
        const w = stage ? stage.clientWidth : window.innerWidth;
        const h = stage ? stage.clientHeight : window.innerHeight;
        // Render at device pixel ratio so text/emoji stay sharp on retina and
        // high-DPI laptops; the CSS box stays 100% of the stage.
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        this.dpr = dpr;
        // Never force a size bigger than the stage: the canvas is stretched by
        // CSS to 100%, so a mismatch would squash the world vertically.
        this.canvas.width = Math.max(160, Math.round(w * dpr));
        this.canvas.height = Math.max(120, Math.round(h * dpr));
        if (this.ctx) this.ctx.imageSmoothingEnabled = false;
    }

    // ------------------------------------------------------------------
    // Networking
    // ------------------------------------------------------------------
    connect() {
        // Use the ONE shared websocket client (window.JAMRI_APP.wsClient) with
        // mode=world. Earlier this class opened its own socket for receiving
        // while sending actions through the (unconnected) room client, so
        // "Gelar Tikar" and every other action silently went nowhere.
        const client = window.JAMRI_APP && window.JAMRI_APP.wsClient;
        if (!client) {
            console.error('[World] shared websocket client missing');
            return;
        }

        // Reset handlers so we do not double-bind if the world is re-entered.
        client.listeners = {};
        this.bindRoomEvents();

        client.connect(this.worldId, this.user, 'world');
    }

    /** Send a world/room message through the shared client. */
    send(type, payload = {}) {
        const client = window.JAMRI_APP && window.JAMRI_APP.wsClient;
        if (!client) return false;
        // Make a silent failure visible: if the socket is not open the action
        // would otherwise just vanish.
        if (!client.isConnected || !client.ws || client.ws.readyState !== 1) {
            if (window.showToast) {
                window.showToast('Koneksi belum siap. Tunggu sebentar lalu coba lagi.', 'warning');
            }
            return false;
        }
        return client.send(type, payload);
    }

    handleMessage(data) {
        switch (data.type) {
            case 'world_init':
                this.map = data.map;
                this.myId = data.you.id;
                this.me = { x: data.you.x, y: data.you.y, dir: 0 };
                this.cam = { x: data.you.x, y: data.you.y };
                this.iAmOwner = !!(data.you && data.you.is_owner);
                (data.avatars || []).forEach(a => this.upsertAvatar(a, true));
                this.boxes = data.boxes || [];
                this.online = data.online || 0;
                this.updateHud(data.name, this.online, data.max_users);
                const dbg = document.getElementById('world-debug-badge');
                if (dbg) dbg.textContent = `v5 · ${this.map.w}×${this.map.h}`;
                const connDot = document.getElementById('world-conn-dot');
                if (connDot) connDot.style.background = 'var(--success)';
                const loading = document.getElementById('world-loading');
                if (loading) loading.style.display = 'none';
                this.resize();
                this.startLoop();
                break;

            case 'world.snapshot':
                (data.avatars || []).forEach(a => this.upsertAvatar(a, false));
                this.reapAvatars(data.avatars || []);
                break;

            case 'world.leave':
                this.avatars.delete(data.id);
                this.bubbles.delete(data.id);
                this.online = data.online || Math.max(0, this.avatars.size);
                this.updateOnline(this.online);
                break;

            case 'world.boxes':
                this.boxes = data.boxes || [];
                if (this.activeBox) {
                    const refreshed = this.boxes.find(b => b.id === this.activeBox.id);
                    if (refreshed) this.activeBox = refreshed;
                }
                this.updatePanelRoomInfo();
                break;

            case 'mat.placed':
                if (data.box && !this.boxes.some(b => b.id === data.box.id)) {
                    this.boxes.push(data.box);
                }
                break;

            case 'mat.removed':
                this.boxes = this.boxes.filter(b => b.id !== data.box_id);
                if (this.activeBox && this.activeBox.id === data.box_id) {
                    this.activeBox = null;
                    this.updatePanelRoomInfo();
                }
                break;

            case 'world.chat':
                this.appendWorldChat(data.message);
                this.showBubble(data.message);
                break;

            case 'world.emote':
                this.emotes.push({ id: data.id, emote: data.emote || '😄', t: performance.now() });
                if (this.emotes.length > 40) this.emotes.shift();
                break;

            case 'zone.enter':
                this.activeBox = this.boxes.find(b => b.id === data.box_id) || {
                    id: data.box_id, room_id: data.room_id, label: data.label, control: data.control,
                };
                this.choiceOpen = false;
                this.closeChoiceDialog();
                this.updatePanelRoomInfo();
                if (this.statusEl) this.statusEl.classList.add('on-mat');
                // Chat mat tab only makes sense on a mat: refresh placeholder state.
                this.setChatTab(this.chatTab || 'mat');
                if (window.showToast) window.showToast(`Masuk tikar: ${data.label || 'Tikar'}`, 'success');
                break;

            case 'zone.exit':
                this.activeBox = null;
                this._clearMatApplyTimers();
                this.player.setMatVolumeScale(1);
                // Leaving the mat ends the shared session completely: the current
                // track, the timeline anchor, loop/shuffle and every mirrored list
                // must reset, otherwise the dock keeps showing the mat's song and
                // the next visit renders a stale snapshot instead of the live one.
                this.player.resetSharedSession();
                this.roomState = null;
                this._resetMatLists();
                this.updatePanelRoomInfo();
                this.setChatTab(this.chatTab || 'mat');
                break;

            case 'zone.choice_required':
                this.openChoiceDialog(data.boxes || []);
                break;

            case 'world_full':
            case 'world_not_found':
                if (window.showToast) window.showToast(data.message || 'World tidak tersedia.', 'warning');
                else alert(data.message || 'World tidak tersedia.');
                leaveWorld();
                break;
        }
    }

    upsertAvatar(a, immediate) {
        const id = a.i;
        if (id === this.myId) return; // never override local prediction
        let av = this.avatars.get(id);
        if (!av) {
            av = { x: a.x, y: a.y, rx: a.x, ry: a.y, dir: a.d, emoji: a.e, nick: a.n, owner: !!a.o };
            this.avatars.set(id, av);
        } else {
            av.x = a.x;
            av.y = a.y;
            av.dir = a.d;
            av.emoji = a.e;
            av.nick = a.n;
            av.owner = !!a.o;
            if (immediate) { av.rx = a.x; av.ry = a.y; }
        }
    }

    /** Ask the player which mat to join when they are inside several. */
    openChoiceDialog(boxes) {
        if (boxes.length === 0) return;
        this.choiceOpen = true;
        let modal = document.getElementById('mat-choice-modal');
        if (modal) modal.remove();

        modal = document.createElement('div');
        modal.id = 'mat-choice-modal';
        modal.className = 'modal-backdrop active';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-card" style="max-width:400px;">
                <div class="modal-header">
                    <h3 class="modal-title">Pilih Tikar</h3>
                    <p class="modal-subtitle">Kamu berada di beberapa tikar sekaligus. Mau gabung ke yang mana?</p>
                </div>
                <div class="modal-body">
                    ${boxes.map(b => `
                        <button type="button" class="mat-choice-row" data-box="${b.id}">
                            <span class="mat-choice-name">${escapeHtml(b.label || 'Tikar')}</span>
                            <span class="mat-choice-meta">${b.users || 0} peserta</span>
                        </button>
                    `).join('')}
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-outline" id="btn-mat-choice-later">Nanti</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelectorAll('.mat-choice-row').forEach(btn => {
            btn.addEventListener('click', () => {
                this.send('zone.select', { box_id: btn.dataset.box });
                this.closeChoiceDialog();
            });
        });
        const later = modal.querySelector('#btn-mat-choice-later');
        if (later) later.addEventListener('click', () => this.closeChoiceDialog());
    }

    closeChoiceDialog() {
        this.choiceOpen = false;
        const modal = document.getElementById('mat-choice-modal');
        if (modal) modal.remove();
    }

    reapAvatars(list) {
        const present = new Set(list.map(a => a.i));
        present.add(this.myId);
        for (const id of Array.from(this.avatars.keys())) {
            if (!present.has(id)) this.avatars.delete(id);
        }
        // A departed avatar must not leave a speech bubble behind: the bubble map
        // is keyed by avatar id, so a stale key would leak for the whole session.
        for (const id of Array.from(this.bubbles.keys())) {
            if (!present.has(id)) this.bubbles.delete(id);
        }
        this.online = Math.max(0, list.length);
        this.updateOnline(this.online);
    }

    updateHud(name, online, maxUsers) {
        const nameEl = document.getElementById('world-name-label');
        if (nameEl && name) nameEl.textContent = name;
        this._maxUsers = maxUsers || 20;
        this.updateOnline(online);
    }

    updateOnline(n) {
        const el = document.getElementById('world-online-badge');
        if (el) el.textContent = `${n}/${this._maxUsers || 20} online`;
    }

    // ------------------------------------------------------------------
    // Input
    // ------------------------------------------------------------------
    bindInput() {
        this._bound.keydown = (e) => {
            // Never let movement keys hijack typing in any input, textarea or
            // contenteditable — including the "gelar tikar" dialog fields.
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
                return;
            }
            // Also ignore movement while any modal/backdrop is open.
            if (document.querySelector('.modal-backdrop.active, .jamri-insecure-guide-backdrop')) {
                return;
            }
            const k = e.key.toLowerCase();
            if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
                this.keys[k] = true;
                e.preventDefault();
            }
        };
        this._bound.keyup = (e) => {
            const k = e.key.toLowerCase();
            this.keys[k] = false;
        };
        window.addEventListener('keydown', this._bound.keydown);
        window.addEventListener('keyup', this._bound.keyup);

        const joy = document.getElementById('world-joystick');
        const knob = document.getElementById('world-joystick-knob');
        // Named handlers stored on _bound so unbindInput() can remove them. The
        // joystick listeners are on window/document-level targets that survive the
        // world DOM being torn down, so leaking them stacked a new set each enter.
        if (joy && knob) {
            const setFromEvent = (t) => {
                const rect = joy.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                let dx = t.clientX - cx;
                let dy = t.clientY - cy;
                const max = rect.width / 2;
                const len = Math.hypot(dx, dy) || 1;
                const clamped = Math.min(len, max);
                dx = (dx / len) * clamped;
                dy = (dy / len) * clamped;
                knob.style.transform = `translate(${dx}px, ${dy}px)`;
                this.joystick.x = dx / max;
                this.joystick.y = dy / max;
                this.joystick.active = true;
            };
            const reset = () => {
                knob.style.transform = 'translate(0,0)';
                this.joystick.x = 0;
                this.joystick.y = 0;
                this.joystick.active = false;
            };
            this._bound.joyTouchStart = (e) => { e.preventDefault(); setFromEvent(e.touches[0]); };
            this._bound.joyTouchMove = (e) => { e.preventDefault(); setFromEvent(e.touches[0]); };
            this._bound.joyTouchEnd = (e) => { e.preventDefault(); reset(); };
            this._bound.joyMouseDown = (e) => setFromEvent(e);
            this._bound.joyMouseMove = (e) => { if (this.joystick.active && !('ontouchstart' in window)) setFromEvent(e); };
            this._bound.joyMouseUp = () => { if (!('ontouchstart' in window)) reset(); };

            joy.addEventListener('touchstart', this._bound.joyTouchStart, { passive: false });
            joy.addEventListener('touchmove', this._bound.joyTouchMove, { passive: false });
            joy.addEventListener('touchend', this._bound.joyTouchEnd, { passive: false });
            joy.addEventListener('mousedown', this._bound.joyMouseDown);
            window.addEventListener('mousemove', this._bound.joyMouseMove);
            window.addEventListener('mouseup', this._bound.joyMouseUp);
        }
    }

    unbindInput() {
        window.removeEventListener('keydown', this._bound.keydown);
        window.removeEventListener('keyup', this._bound.keyup);
        window.removeEventListener('resize', this._bound.resize);
        window.removeEventListener('mousemove', this._bound.joyMouseMove);
        window.removeEventListener('mouseup', this._bound.joyMouseUp);
        const joy = document.getElementById('world-joystick');
        if (joy) {
            joy.removeEventListener('touchstart', this._bound.joyTouchStart);
            joy.removeEventListener('touchmove', this._bound.joyTouchMove);
            joy.removeEventListener('touchend', this._bound.joyTouchEnd);
            joy.removeEventListener('mousedown', this._bound.joyMouseDown);
        }
    }

    // ------------------------------------------------------------------
    // Simulation
    // ------------------------------------------------------------------
    startLoop() {
        this.lastFrame = performance.now();
        const loop = (now) => {
            const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
            this.lastFrame = now;
            this.update(dt, now);
            this.render();
            this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
    }

    blocked(x, y) {
        if (!this.map) return true;
        const tile = this.map.tile || JamriWorld.TILE;
        const px = x / tile;
        const py = y / tile;
        const pad = 0.28; // keep the avatar from hugging walls
        if (px < 1 + pad || py < 1 + pad || px > this.map.w - 1 - pad || py > this.map.h - 1 - pad) {
            return true;
        }
        for (const c of this.map.colliders || []) {
            if (px >= c.x - pad && px < c.x + c.w + pad &&
                py >= c.y - pad && py < c.y + c.h + pad) {
                return true;
            }
        }
        return false;
    }

    update(dt, now) {
        this.now = now;
        // Direction from keyboard + joystick.
        let dx = 0, dy = 0;
        if (this.keys['a'] || this.keys['arrowleft']) dx -= 1;
        if (this.keys['d'] || this.keys['arrowright']) dx += 1;
        if (this.keys['w'] || this.keys['arrowup']) dy -= 1;
        if (this.keys['s'] || this.keys['arrowdown']) dy += 1;
        if (this.joystick.active) { dx += this.joystick.x; dy += this.joystick.y; }

        this.moving = false;
        if (dx !== 0 || dy !== 0) {
            const len = Math.hypot(dx, dy) || 1;
            const nx = this.me.x + (dx / len) * JamriWorld.SPEED * dt;
            const ny = this.me.y + (dy / len) * JamriWorld.SPEED * dt;

            const beforeX = this.me.x;
            const beforeY = this.me.y;

            // Axis-separated so you slide along walls instead of sticking.
            if (!this.blocked(nx, this.me.y)) this.me.x = nx;
            if (!this.blocked(this.me.x, ny)) this.me.y = ny;

            this.me.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 2 : 3) : (dy > 0 ? 0 : 1);

            // Walking animation state: bob phase + footstep dust.
            this.moving = Math.hypot(this.me.x - beforeX, this.me.y - beforeY) > 0.01;
            if (this.moving) {
                this.walkPhase += dt * 11;
                this.footTimer -= dt;
                if (this.footTimer <= 0) {
                    this.footTimer = 0.18;
                    this.spawnDust(this.me.x, this.me.y + 14);
                }
            }

            if (now - this.lastSend > 1000 / JamriWorld.SEND_HZ) {
                this.lastSend = now;
                this.send('world.move', { x: this.me.x, y: this.me.y, dir: this.me.dir });
            }
        }

        // Camera: smoothed follow plus a small look-ahead in the facing
        // direction so the world feels alive (WorkAdventure-ish).
        const lookX = (this.me.dir === 2 ? 1 : this.me.dir === 3 ? -1 : 0) * 26;
        const lookY = (this.me.dir === 0 ? 1 : this.me.dir === 1 ? -1 : 0) * 26;
        const lookK = Math.min(1, dt * 3);
        this.camLook.x += (lookX - this.camLook.x) * lookK;
        this.camLook.y += (lookY - this.camLook.y) * lookK;
        this.cam.x += (this.me.x + this.camLook.x - this.cam.x) * Math.min(1, dt * 8);
        this.cam.y += (this.me.y + this.camLook.y - this.cam.y) * Math.min(1, dt * 8);

        // Proximity audio fade: volume scales by how centred you are on the mat.
        if (this.activeBox) {
            const d = Math.hypot(this.me.x - this.activeBox.x, this.me.y - this.activeBox.y);
            const r = this.activeBox.r || this.activeBox.radius || 96;
            // Full volume at the centre, fading to ~35% at the edge.
            const t = Math.max(0, Math.min(1, 1 - (d / r)));
            this.player.setMatVolumeScale(0.35 + 0.65 * t);
        }

        // Lerp remote avatars toward their latest server position.
        const t = Math.min(1, dt * JamriWorld.LERP);
        for (const av of this.avatars.values()) {
            const prevX = av.rx;
            const prevY = av.ry;
            av.rx += (av.x - av.rx) * t;
            av.ry += (av.y - av.ry) * t;
            // Remote avatars animate when they actually move.
            const speed = Math.hypot(av.rx - prevX, av.ry - prevY) / Math.max(dt, 0.0001);
            av.moving = speed > 12;
            if (av.moving) av.phase = (av.phase || 0) + dt * 11;
        }

        this.updateParticles(dt);
    }

    // ------------------------------------------------------------------
    // Particles + ambient life (dust, music notes over mats)
    // ------------------------------------------------------------------

    spawnDust(x, y) {
        if (this.particles.length > 90) return;
        this.particles.push({
            kind: 'dust',
            x: x + (Math.random() - 0.5) * 10,
            y,
            vx: (Math.random() - 0.5) * 14,
            vy: -8 - Math.random() * 10,
            life: 0,
            max: 0.45 + Math.random() * 0.2,
            size: 2 + Math.floor(Math.random() * 2),
        });
    }

    spawnNote(box) {
        if (this.particles.length > 90) return;
        const glyphs = ['♪', '♫', '♬'];
        this.particles.push({
            kind: 'note',
            glyph: glyphs[Math.floor(Math.random() * glyphs.length)],
            x: box.x + (Math.random() - 0.5) * 40,
            y: box.y - 6,
            vx: (Math.random() - 0.5) * 10,
            vy: -18 - Math.random() * 10,
            life: 0,
            max: 1.6,
            size: 12,
        });
    }

    updateParticles(dt) {
        for (const p of this.particles) {
            p.life += dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.kind === 'dust') p.vy += 6 * dt; else p.vy *= 0.99;
        }
        this.particles = this.particles.filter(p => p.life < p.max);

        // Notes drifting off every mat that has listeners.
        this.noteTimer -= dt;
        if (this.noteTimer <= 0) {
            this.noteTimer = 0.55;
            for (const b of this.boxes) {
                if (b.users > 0 || (this.activeBox && this.activeBox.id === b.id)) {
                    this.spawnNote(b);
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Rendering (procedural pixel art, bright daylight)
    // ------------------------------------------------------------------

    /**
     * Camera zoom: keeps avatars readable like WorkAdventure instead of
     * shrinking them into a huge empty field. Bigger viewports see more world.
     */
    zoomFor(W, H) {
        // Target ~20 tiles across on desktop; never below 1.35 so avatars stay
        // readable on small screens (WorkAdventure-like framing).
        return Math.max(1.35, Math.min(2.2, Math.min(W / 620, H / 430)));
    }

    render() {
        const ctx = this.ctx;
        if (!ctx || !this.map) return;

        const dpr = this.dpr || 1;
        const W = this.canvas.width / dpr;
        const H = this.canvas.height / dpr;
        const tile = this.map.tile || JamriWorld.TILE;
        const now = this.now || performance.now();
        const zoom = this.zoomFor(W, H);
        const viewW = W / zoom;
        const viewH = H / zoom;

        this.buildScene();

        // Camera top-left in world space, clamped to map bounds.
        const mapW = this.map.w * tile;
        const mapH = this.map.h * tile;
        let camX = this.cam.x - viewW / 2;
        let camY = this.cam.y - viewH / 2;
        camX = Math.max(0, Math.min(camX, Math.max(0, mapW - viewW)));
        camY = Math.max(0, Math.min(camY, Math.max(0, mapH - viewH)));

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.textBaseline = 'middle';

        // Soft grass beyond the map edge so the world never reads as a void.
        ctx.fillStyle = '#6fae5f';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // World-space pass: zoom + device pixel ratio only. The draw helpers
        // subtract camX/camY themselves (they emit screen-space coordinates), so
        // adding a camera translate here would offset the scene twice.
        const scale = zoom * dpr;
        ctx.setTransform(scale, 0, 0, scale, 0, 0);

        const startCol = Math.floor(camX / tile);
        const endCol = Math.ceil((camX + viewW) / tile);
        const startRow = Math.floor(camY / tile);
        const endRow = Math.ceil((camY + viewH) / tile);

        this.drawFloor(ctx, camX, camY, startCol, endCol, startRow, endRow, tile);
        this.drawPlaza(ctx, camX, camY, tile);
        this.drawDecor(ctx, camX, camY, viewW, viewH, now);
        this.drawWalls(ctx, camX, camY, tile);
        this.drawMats(ctx, camX, camY, now);
        this.drawParticles(ctx, camX, camY);
        this.drawAvatars(ctx, camX, camY, now, viewW);

        // Screen-space pass: light + vignette stay fixed to the viewport.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const sun = ctx.createRadialGradient(W * 0.5, H * 0.28, 0, W * 0.5, H * 0.28, Math.max(W, H) * 0.75);
        sun.addColorStop(0, 'rgba(255, 249, 214, 0.16)');
        sun.addColorStop(1, 'rgba(255, 249, 214, 0)');
        ctx.fillStyle = sun;
        ctx.fillRect(0, 0, W, H);

        const vig = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.78);
        vig.addColorStop(0, 'rgba(18, 48, 30, 0)');
        vig.addColorStop(1, 'rgba(18, 48, 30, 0.14)');
        ctx.fillStyle = vig;
        ctx.fillRect(0, 0, W, H);

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.renderMinimap(camX, camY, viewW, viewH);
    }

    /** True when a tile is inside any collider (decor placement helper). */
    tileBlocked(tx, ty) {
        for (const c of this.map.colliders || []) {
            if (tx >= c.x && tx < c.x + c.w && ty >= c.y && ty < c.y + c.h) return true;
        }
        return false;
    }

    /**
     * Build the deterministic decoration layer once per map: flowers, grass
     * tufts, bushes and small trees. Same world id -> same scenery everywhere.
     */
    buildScene() {
        if (this.decor && this.decorFor === this.map) return;
        this.decorFor = this.map;

        const tile = this.map.tile || JamriWorld.TILE;
        const decor = [];

        // Central plaza (the spawn area is always open ground). Computed first
        // so decoration placement can avoid it.
        const spawn = this.map.spawn || { x: this.map.w * tile / 2, y: this.map.h * tile / 2 };
        this.plaza = { x: spawn.x, y: spawn.y, r: tile * 5 };

        for (let ty = 1; ty < this.map.h - 1; ty++) {
            for (let tx = 1; tx < this.map.w - 1; tx++) {
                if (this.tileBlocked(tx, ty)) continue;
                const h = hash2(tx, ty, 7);
                const jx = (hash2(tx, ty, 3) - 0.5) * tile * 0.55;
                const jy = (hash2(tx, ty, 5) - 0.5) * tile * 0.55;
                const x = tx * tile + tile / 2 + jx;
                const y = ty * tile + tile / 2 + jy;
                // Keep the spawn plaza clear so the meeting area stays open.
                if (this.plaza.r && Math.hypot(x - this.plaza.x, y - this.plaza.y) < this.plaza.r + 12) continue;
                if (h < 0.045) {
                    decor.push({ type: 'flower', x, y, v: Math.floor(hash2(tx, ty, 11) * 4) });
                } else if (h < 0.068) {
                    decor.push({ type: 'bush', x, y, v: Math.floor(hash2(tx, ty, 13) * 3) });
                } else if (h < 0.150) {
                    decor.push({ type: 'tuft', x, y, v: Math.floor(hash2(tx, ty, 17) * 3) });
                } else if (h < 0.162) {
                    decor.push({ type: 'tree', x, y, v: Math.floor(hash2(tx, ty, 19) * 2) });
                }
            }
        }
        decor.sort((a, b) => a.y - b.y);
        this.decor = decor;
    }

    drawFloor(ctx, camX, camY, startCol, endCol, startRow, endRow, tile) {
        // Three grass tones picked per tile; no hard checkerboard, just soft
        // patches like a hand-painted tileset.
        const tones = ['#8ed07a', '#86c973', '#96d883'];
        for (let ry = startRow; ry <= endRow; ry++) {
            for (let rx = startCol; rx <= endCol; rx++) {
                if (rx < 0 || ry < 0 || rx >= this.map.w || ry >= this.map.h) continue;
                const h = hash2(rx, ry, 1);
                const px = Math.round(rx * tile - camX);
                const py = Math.round(ry * tile - camY);
                ctx.fillStyle = tones[Math.floor(h * tones.length) % tones.length];
                ctx.fillRect(px, py, tile, tile);

                // Fine grass blade detail (2px, deterministic).
                if (hash2(rx, ry, 23) < 0.5) {
                    ctx.fillStyle = 'rgba(58, 122, 62, 0.20)';
                    const bx = px + 4 + Math.floor(hash2(rx, ry, 29) * (tile - 10));
                    const by = py + 6 + Math.floor(hash2(rx, ry, 31) * (tile - 14));
                    ctx.fillRect(bx, by, 2, 5);
                    ctx.fillRect(bx + 5, by + 3, 2, 4);
                }
                // Occasional light moss patch.
                if (hash2(rx, ry, 37) > 0.93) {
                    ctx.fillStyle = 'rgba(198, 240, 160, 0.35)';
                    ctx.fillRect(px + 8, py + 10, 10, 7);
                }
            }
        }
    }

    /** Sand/stone plaza around the spawn so the centre reads as a meeting spot. */
    drawPlaza(ctx, camX, camY, tile) {
        const p = this.plaza;
        if (!p || !p.r) return;
        const sx = p.x - camX;
        const sy = p.y - camY;

        ctx.save();
        ctx.beginPath();
        ctx.arc(sx, sy, p.r + 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(70, 108, 62, 0.20)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(sx, sy, p.r, 0, Math.PI * 2);
        ctx.fillStyle = '#e6d7ae';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(sx, sy, p.r - 10, 0, Math.PI * 2);
        ctx.fillStyle = '#efe3c2';
        ctx.fill();
        ctx.restore();

        // Pixel paving stones, clipped to the plaza.
        ctx.save();
        ctx.beginPath();
        ctx.arc(sx, sy, p.r - 12, 0, Math.PI * 2);
        ctx.clip();
        const cell = 22;
        for (let gy = -p.r; gy < p.r; gy += cell) {
            for (let gx = -p.r; gx < p.r; gx += cell) {
                const h = hash2(Math.round(gx), Math.round(gy), 41);
                if (h > 0.55) {
                    ctx.fillStyle = h > 0.8 ? '#e2d3a6' : '#e8dcb8';
                    ctx.fillRect(Math.round(sx + gx) + 1, Math.round(sy + gy) + 1, cell - 3, cell - 3);
                }
            }
        }
        ctx.restore();

        // Warm rim highlight.
        ctx.beginPath();
        ctx.arc(sx, sy, p.r - 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.lineWidth = 3;
        ctx.stroke();
    }

    drawDecor(ctx, camX, camY, W, H, now) {
        const sway = Math.sin(now / 900) * 1.2;
        for (const d of this.decor || []) {
            const x = Math.round(d.x - camX);
            const y = Math.round(d.y - camY);
            if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;

            if (d.type === 'tuft') {
                ctx.fillStyle = 'rgba(56, 116, 58, 0.55)';
                ctx.fillRect(x - 4, y - 4, 2, 6);
                ctx.fillRect(x + 1, y - 6, 2, 8);
                ctx.fillRect(x + 5, y - 3, 2, 5);
            } else if (d.type === 'flower') {
                const colors = ['#fff1a8', '#ffd0e0', '#c9b6ff', '#ffffff'];
                ctx.fillStyle = 'rgba(48, 104, 52, 0.55)';
                ctx.fillRect(x - 1, y, 2, 6);
                ctx.fillStyle = colors[d.v % colors.length];
                ctx.fillRect(x - 3, y - 4, 6, 5);
                ctx.fillStyle = 'rgba(255, 214, 92, 0.95)';
                ctx.fillRect(x - 1, y - 3, 2, 2);
            } else if (d.type === 'bush') {
                ctx.fillStyle = 'rgba(38, 92, 46, 0.22)';
                ctx.fillRect(x - 12, y + 8, 24, 5);
                ctx.fillStyle = '#4f9a56';
                ctx.fillRect(x - 12, y - 6, 24, 14);
                ctx.fillStyle = '#63b167';
                ctx.fillRect(x - 9, y - 10, 18, 8);
                ctx.fillStyle = '#79c67a';
                ctx.fillRect(x - 6, y - 12, 12, 5);
                ctx.fillStyle = '#3f8449';
                ctx.fillRect(x - 12, y + 5, 24, 3);
            } else if (d.type === 'tree') {
                // Pixel tree: trunk + layered canopy, sways slightly.
                ctx.fillStyle = 'rgba(30, 78, 40, 0.25)';
                ctx.fillRect(x - 16, y + 14, 32, 7);
                ctx.fillStyle = '#8a5a34';
                ctx.fillRect(x - 4, y - 2, 8, 20);
                ctx.fillStyle = '#a06b3e';
                ctx.fillRect(x - 4, y - 2, 3, 20);
                const s = sway * (d.v ? 1 : -1);
                ctx.fillStyle = '#3f8b4a';
                ctx.fillRect(x - 18 + s, y - 14, 36, 16);
                ctx.fillStyle = '#4f9d55';
                ctx.fillRect(x - 14 + s, y - 22, 28, 12);
                ctx.fillStyle = '#66b566';
                ctx.fillRect(x - 9 + s, y - 27, 18, 9);
                ctx.fillStyle = '#7fcb78';
                ctx.fillRect(x - 5 + s, y - 25, 10, 4);
            }
        }
    }

    drawWalls(ctx, camX, camY, tile) {
        for (const c of this.map.colliders || []) {
            const x = Math.round(c.x * tile - camX);
            const y = Math.round(c.y * tile - camY);
            const w = c.w * tile;
            const h = c.h * tile;

            // Ground shadow, offset to the bottom-right (light comes from above).
            ctx.fillStyle = 'rgba(28, 62, 34, 0.22)';
            ctx.fillRect(x + 5, y + h - 3, w, 10);

            // Low stone kerb.
            ctx.fillStyle = '#cdb894';
            ctx.fillRect(x, y, w, h);
            ctx.fillStyle = '#e3d2b0';
            ctx.fillRect(x, y + h - 9, w, 9);

            // Hedge body sitting on the kerb.
            const top = Math.max(8, Math.round(h * 0.28));
            ctx.fillStyle = '#3f8b4a';
            ctx.fillRect(x, y + top, w, h - top);
            ctx.fillStyle = '#4f9d55';
            ctx.fillRect(x, y + top, w, Math.max(4, Math.round((h - top) * 0.55)));
            ctx.fillStyle = '#66b566';
            ctx.fillRect(x + 2, y + top - 4, Math.max(0, w - 4), 6);

            // Leafy pixel clumps so large blocks do not read as flat slabs.
            const step = 12;
            let i = 0;
            for (let bx = x + 3; bx < x + w - 6; bx += step) {
                for (let by = y + top + 3; by < y + h - 12; by += step) {
                    const hsh = hash2(i++, by, 53);
                    if (hsh > 0.55) {
                        ctx.fillStyle = hsh > 0.8 ? 'rgba(126, 200, 118, 0.75)' : 'rgba(56, 122, 60, 0.55)';
                        ctx.fillRect(bx, by, 5, 4);
                    }
                }
            }

            // Sunlit rim on top.
            ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
            ctx.fillRect(x, y + top - 6, w, 3);
        }
    }

    drawMats(ctx, camX, camY, now) {
        for (const b of this.boxes) {
            // Guard against a partial box payload (e.g. a zone.enter stub that
            // only carries id/label): a missing x/y would make the gradient
            // throw and kill the whole render loop.
            if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
            const sx = b.x - camX;
            const sy = b.y - camY;
            const r = Number.isFinite(b.r) && b.r > 0 ? b.r : (Number.isFinite(b.radius) && b.radius > 0 ? b.radius : 96);
            const isActive = this.activeBox && this.activeBox.id === b.id;
            const hue = Math.floor(hashStr(b.id || b.label || 'mat') * 360);
            const pulse = 0.5 + 0.5 * Math.sin(now / 700 + hue);

            // Soft warm glow so mats pop against the grass (kept low so the disc
            // still reads as translucent ground, not a pasted-on panel).
            const glow = ctx.createRadialGradient(sx, sy, r * 0.55, sx, sy, r * 1.12);
            glow.addColorStop(0, `hsla(${hue}, 70%, 60%, ${isActive ? 0.18 : 0.10})`);
            glow.addColorStop(1, `hsla(${hue}, 70%, 60%, 0)`);
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(sx, sy, r * 1.12, 0, Math.PI * 2);
            ctx.fill();

            // Rug body: a genuinely translucent disc (the grass shows through),
            // just a touch darker than the ground. No checkerboard / "fake
            // transparency" pattern — it read as grey squares, not a rug.
            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fillStyle = isActive
                ? `hsla(${hue}, 52%, 34%, 0.26)`
                : `hsla(${hue}, 45%, 30%, 0.17)`;
            ctx.fill();

            // Soft inner shading toward the rim so the disc has depth without
            // any hard-edged tiles.
            const shade = ctx.createRadialGradient(sx, sy, r * 0.35, sx, sy, r);
            shade.addColorStop(0, 'rgba(255, 255, 255, 0.05)');
            shade.addColorStop(1, 'rgba(0, 0, 0, 0.10)');
            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fillStyle = shade;
            ctx.fill();

            // Border: clean circle, thicker/brighter when you are standing on it.
            ctx.beginPath();
            ctx.arc(sx, sy, r - 1, 0, Math.PI * 2);
            ctx.lineWidth = isActive ? 4 : 2.5;
            ctx.strokeStyle = isActive
                ? `hsla(${hue}, 85%, 58%, ${0.75 + pulse * 0.25})`
                : `hsla(${hue}, 60%, 55%, 0.55)`;
            ctx.stroke();

            // Subtle dashed inner ring for the "zone" feel.
            ctx.save();
            ctx.beginPath();
            ctx.arc(sx, sy, r - 12, 0, Math.PI * 2);
            ctx.setLineDash([8, 10]);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = `hsla(${hue}, 50%, 45%, 0.22)`;
            ctx.stroke();
            ctx.restore();

            // Label pill above the mat.
            const label = `${b.label || 'Tikar'}${b.users ? ' · ' + b.users : ''}`;
            ctx.font = 'bold 12px system-ui, sans-serif';
            ctx.textAlign = 'center';
            const tw = ctx.measureText(label).width;
            const lx = sx - tw / 2 - 8;
            const ly = sy - r - 26;
            roundRect(ctx, lx, ly, tw + 16, 20, 10);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
            ctx.fill();
            ctx.strokeStyle = `hsla(${hue}, 70%, 55%, 0.9)`;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = `hsl(${hue}, 55%, 32%)`;
            ctx.fillText(label, sx, ly + 10);
        }
    }

    drawParticles(ctx, camX, camY) {
        for (const p of this.particles) {
            const x = p.x - camX;
            const y = p.y - camY;
            const t = p.life / p.max;
            if (p.kind === 'dust') {
                ctx.globalAlpha = (1 - t) * 0.5;
                ctx.fillStyle = '#e8e0c8';
                ctx.fillRect(Math.round(x), Math.round(y), p.size, p.size);
            } else {
                ctx.globalAlpha = (1 - t) * 0.9;
                ctx.font = `bold ${p.size}px system-ui, sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillStyle = '#2f7a4d';
                ctx.fillText(p.glyph, Math.round(x), Math.round(y));
            }
        }
        ctx.globalAlpha = 1;
    }

    drawAvatars(ctx, camX, camY, now, viewW) {
        const entities = [];
        for (const [id, av] of this.avatars.entries()) {
            entities.push({
                id, x: av.rx, y: av.ry, emoji: av.emoji, nick: av.nick,
                me: false, owner: av.owner, moving: !!av.moving, phase: av.phase || 0,
                dir: av.dir || 0,
            });
        }
        entities.push({
            id: this.myId, x: this.me.x, y: this.me.y, emoji: this.user.emoji,
            nick: this.user.nickname, me: true, owner: !!this.iAmOwner,
            moving: this.moving, phase: this.walkPhase, dir: this.me.dir || 0,
        });
        entities.sort((a, b) => a.y - b.y);

        for (const e of entities) {
            const sx = Math.round(e.x - camX);
            const sy = Math.round(e.y - camY);

            // Walk bob: 3px hop while moving, gentle idle breathing otherwise.
            const bob = e.moving
                ? Math.abs(Math.sin(e.phase)) * 3
                : Math.sin(now / 800 + (e.id || 0)) * 0.9;

            // Ground shadow (shrinks as the avatar hops).
            const shadowW = 26 - bob * 1.2;
            ctx.fillStyle = 'rgba(26, 58, 36, 0.26)';
            ctx.beginPath();
            ctx.ellipse(sx, sy + 15, shadowW / 2, 5, 0, 0, Math.PI * 2);
            ctx.fill();

            // Highlight ring under your own avatar so you never lose yourself.
            if (e.me) {
                ctx.beginPath();
                ctx.ellipse(sx, sy + 15, 17, 7, 0, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
                ctx.lineWidth = 2.5;
                ctx.stroke();
            }

            // Emoji avatar, flipped horizontally when facing left.
            ctx.save();
            ctx.translate(sx, sy - bob);
            if (e.dir === 3) ctx.scale(-1, 1);
            ctx.font = '30px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", serif';
            ctx.textAlign = 'center';
            ctx.fillText(e.emoji || '🎧', 0, 0);
            ctx.restore();

            // Name pill (light, WorkAdventure-like).
            ctx.font = 'bold 11px system-ui, sans-serif';
            ctx.textAlign = 'center';
            const label = e.nick || '';
            const tw = ctx.measureText(label).width;
            const ny = sy - 34 - bob;
            roundRect(ctx, sx - tw / 2 - 6, ny - 7, tw + 12, 15, 7);
            ctx.fillStyle = e.me ? 'rgba(37, 99, 235, 0.92)' : 'rgba(255, 255, 255, 0.92)';
            ctx.fill();
            ctx.fillStyle = e.me ? '#ffffff' : '#1f3b2a';
            ctx.fillText(label, sx, ny + 0.5);

            if (e.owner) {
                ctx.font = '13px "Segoe UI Emoji", "Apple Color Emoji", serif';
                ctx.fillText('👑', sx + tw / 2 + 12, ny);
            }

            // Floating emote above the avatar (fades + rises).
            const em = this.emotes.find(x => x.id === e.id);
            if (em) {
                const age = (now - em.t) / 1000;
                if (age < 2.2) {
                    ctx.globalAlpha = Math.max(0, 1 - age / 2.2);
                    ctx.font = '24px "Segoe UI Emoji", "Apple Color Emoji", serif';
                    ctx.fillText(em.emote, sx, sy - 52 - age * 20);
                    ctx.globalAlpha = 1;
                }
            }

            // Chat bubble (speech) above everything else for that avatar.
            const bub = this.bubbles.get(e.id);
            if (bub) {
                const age = (now - bub.t) / 1000;
                if (age < 6) {
                    const fade = age > 5 ? Math.max(0, 1 - (age - 5)) : 1;
                    ctx.globalAlpha = fade;
                    ctx.font = '12px system-ui, sans-serif';
                    ctx.textAlign = 'center';

                    // Layout is measured once per message and cached: measuring on
                    // every frame is both wasteful and a risk if the text ever
                    // slipped through unsanitised.
                    if (!bub.layout) {
                        const lines = wrapBubbleLines(ctx, bub.text, BUBBLE_MAX_WIDTH - 18);
                        if (lines.length === 0) {
                            this.bubbles.delete(e.id);
                            ctx.globalAlpha = 1;
                            continue;
                        }
                        const textW = Math.max(...lines.map(l => ctx.measureText(l).width));
                        const bw = Math.min(BUBBLE_MAX_WIDTH, Math.max(24, textW + 18));
                        const bh = lines.length * 15 + 10;
                        bub.layout = { lines, bw, bh };
                    }

                    const { lines, bw, bh } = bub.layout;
                    const viewRight = camX + (viewW || this.canvas.width);
                    const bx = Math.max(camX + 4, Math.min(sx - bw / 2, viewRight - bw - 4));
                    const by = sy - 56 - bob - bh;

                    roundRect(ctx, bx, by, bw, bh, 8);
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
                    ctx.fill();
                    ctx.strokeStyle = 'rgba(70, 110, 80, 0.35)';
                    ctx.lineWidth = 1.5;
                    ctx.stroke();

                    // Tail pointing at the speaker.
                    ctx.beginPath();
                    ctx.moveTo(sx - 5, by + bh);
                    ctx.lineTo(sx + 5, by + bh);
                    ctx.lineTo(sx, by + bh + 7);
                    ctx.closePath();
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
                    ctx.fill();

                    ctx.fillStyle = '#1f3b2a';
                    lines.forEach((line, i) => {
                        ctx.fillText(line, bx + bw / 2, by + 13 + i * 15);
                    });
                    ctx.globalAlpha = 1;
                } else {
                    this.bubbles.delete(e.id);
                }
            }
        }

        // Drop expired emotes.
        this.emotes = this.emotes.filter(x => (now - x.t) < 2200);
    }

    /** Small corner minimap: world bounds, walls, mats and every avatar. */
    renderMinimap(camX, camY, viewW, viewH) {
        const m = this.minimap;
        const mctx = this.minimapCtx;
        if (!m || !mctx || !this.map) return;

        const mw = m.width;
        const mh = m.height;
        const mapW = this.map.w * (this.map.tile || JamriWorld.TILE);
        const mapH = this.map.h * (this.map.tile || JamriWorld.TILE);
        const sx = mw / mapW;
        const sy = mh / mapH;

        mctx.clearRect(0, 0, mw, mh);
        mctx.fillStyle = 'rgba(120, 186, 118, 0.92)';
        mctx.fillRect(0, 0, mw, mh);

        // Walls.
        mctx.fillStyle = 'rgba(232, 216, 178, 0.95)';
        for (const c of this.map.colliders || []) {
            mctx.fillRect(c.x * (this.map.tile || 32) * sx, c.y * (this.map.tile || 32) * sy,
                c.w * (this.map.tile || 32) * sx, c.h * (this.map.tile || 32) * sy);
        }

        // Mats.
        for (const b of this.boxes) {
            mctx.beginPath();
            mctx.arc(b.x * sx, b.y * sy, Math.max(3, (b.r || 96) * sx), 0, Math.PI * 2);
            mctx.fillStyle = (this.activeBox && this.activeBox.id === b.id)
                ? 'rgba(99, 102, 241, 0.45)' : 'rgba(255, 255, 255, 0.45)';
            mctx.fill();
            mctx.strokeStyle = (this.activeBox && this.activeBox.id === b.id) ? '#4f46e5' : 'rgba(46, 88, 52, 0.7)';
            mctx.lineWidth = 1.5;
            mctx.stroke();
        }

        // Avatars.
        for (const av of this.avatars.values()) {
            mctx.fillStyle = '#2e6b3c';
            mctx.fillRect(av.rx * sx - 1.5, av.ry * sy - 1.5, 3, 3);
        }
        mctx.fillStyle = '#2563eb';
        mctx.fillRect(this.me.x * sx - 2.5, this.me.y * sy - 2.5, 5, 5);

        // Camera viewport rectangle.
        mctx.strokeStyle = 'rgba(30, 58, 36, 0.45)';
        mctx.lineWidth = 1;
        mctx.strokeRect(camX * sx, camY * sy, viewW * sx, viewH * sy);
    }
}

window.JamriWorld = JamriWorld;
