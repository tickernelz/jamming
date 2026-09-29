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
        this.minimap = null;
        this.minimapCtx = null;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------
    enter(worldId, user) {
        this.worldId = worldId;
        this.user = user;
        this.buildDom();
        this.bindInput();
        this.bindRoomEvents();
        this.connect();
    }

    /**
     * Reuse the room WebSocket event handlers while standing on a mat. The room
     * protocol is identical to the legacy flow, so we simply delegate to the
     * existing app-level helpers and hydrate the mat's music panel.
     */
    bindRoomEvents() {
        if (this.roomEventsBound) return;
        const ws = window.JAMRI_APP && window.JAMRI_APP.wsClient;
        if (!ws) return;
        this.roomEventsBound = true;

        ws.on('room_init', (data) => this.onRoomInit(data));
        ws.on('chat_message', (data) => {
            if (data.message) this.appendRoomChat(data.message);
        });
        ws.on('queue_updated', (data) => {
            if (data.queue) this.renderQueue(data.queue);
        });
        ws.on('user_joined', (data) => {
            if (data.online_users) this.renderUsers(data.online_users);
        });
        ws.on('user_left', (data) => {
            if (data.online_users) this.renderUsers(data.online_users);
        });

        // Playback events for the mat we are standing on. The room WebSocket is
        // shared with the legacy flow, so these must be handled here too.
        ws.on('play', (data) => this.player.syncJammingState(data.track || null, 'playing', data.position, data.server_time, true));
        ws.on('pause', (data) => this.player.syncJammingState(data.track || null, 'paused', data.position, data.server_time, true));
        ws.on('seek', (data) => this.player.syncJammingState(data.track || null, data.state, data.position, data.server_time, true));
        ws.on('track_change', (data) => {
            if (data.track) {
                this.player.playTrack(data.track, data.position || 0);
            }
        });
        ws.on('playback_stopped', () => this.player.stop());
        ws.on('loop_changed', (data) => {
            if (data.loop_mode) this.player.setLoopMode(data.loop_mode);
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
        if (data.online_users) this.renderUsers(data.online_users);
        if (data.current_track) {
            const player = this.player;
            const isSame = player.currentTrack && player.currentTrack.youtube_id === data.current_track.youtube_id;
            if (isSame) {
                player.syncJammingState(data.current_track, data.state, data.position, data.server_time, true);
            } else {
                player.playTrack(data.current_track, data.position || 0);
                if (data.state === 'paused') player.pause();
            }
        } else {
            this.player.stop();
        }
        this.updatePanelRoomInfo();
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

    sendEmote(emote) {
        window.JAMRI_APP.wsClient.send('world.emote', { emote });
        // Show it locally right away for instant feedback.
        this.emotes.push({ id: this.myId, emote, t: performance.now() });
    }

    leave() {
        this.unbindInput();
        this.player.setMatVolumeScale(1);
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
            this.ws = null;
        }
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
                        <span id="world-name-label" class="world-name-label">World</span>
                        <span id="world-online-badge" class="world-online-badge">0 online</span>
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
                        <div class="mat-chat-title-label">Chat Tikar</div>
                        <div class="mat-chat-list" id="mat-chat-list"></div>
                        <form class="mat-chat-form" id="mat-chat-form">
                            <input type="text" id="mat-chat-input" class="mat-chat-input" placeholder="Chat tikar..." maxlength="300" autocomplete="off" />
                            <button type="submit" class="btn btn-primary btn-sm">Kirim</button>
                        </form>

                        <div class="mat-chat-title-label">Chat World</div>
                        <div class="mat-chat-list" id="world-chat-list"></div>
                        <form class="mat-chat-form" id="world-chat-form">
                            <input type="text" id="world-chat-input" class="mat-chat-input" placeholder="Chat world..." maxlength="300" autocomplete="off" />
                            <button type="submit" class="btn btn-outline btn-sm">Kirim</button>
                        </form>
                    </aside>
                </div>

                <div class="world-joystick" id="world-joystick">
                    <div class="world-joystick-knob" id="world-joystick-knob"></div>
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
            window.JAMRI_APP.wsClient.send('mat.pickup', { box_id: this.activeBox.id });
        });

        const chatForm = container.querySelector('#mat-chat-form');
        if (chatForm) {
            chatForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const input = document.getElementById('mat-chat-input');
                const text = input.value.trim();
                if (!text) return;
                if (!this.activeBox) {
                    if (window.showToast) window.showToast('Masuk ke tikar dulu untuk chat.', 'warning');
                    return;
                }
                window.JAMRI_APP.wsClient.sendChatMessage(text);
                input.value = '';
            });
        }

        const worldChatForm = container.querySelector('#world-chat-form');
        if (worldChatForm) {
            worldChatForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const input = document.getElementById('world-chat-input');
                const text = input.value.trim();
                if (!text) return;
                window.JAMRI_APP.wsClient.send('world.chat', { message: text });
                input.value = '';
            });
        }

        window.addEventListener('resize', this._bound.resize = () => this.resize());
        this.resize();
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

        const close = () => modal.remove();
        modal.querySelector('#btn-mat-cancel').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        modal.querySelector('#btn-mat-confirm').addEventListener('click', () => {
            const label = modal.querySelector('#mat-label-input').value.trim();
            const control = modal.querySelector('input[name="mat_control"]:checked').value;
            window.JAMRI_APP.wsClient.send('mat.place', { label, control_mode: control });
            close();
        });
    }

    resize() {
        if (!this.canvas) return;
        const stage = document.getElementById('world-stage');
        const w = stage ? stage.clientWidth : window.innerWidth;
        const h = stage ? stage.clientHeight : window.innerHeight;
        this.canvas.width = Math.max(320, w);
        this.canvas.height = Math.max(240, h);
        if (this.ctx) this.ctx.imageSmoothingEnabled = false;
    }

    // ------------------------------------------------------------------
    // Networking
    // ------------------------------------------------------------------
    connect() {
        const isHttps = window.location.protocol === 'https:';
        const protocol = isHttps ? 'wss:' : 'ws:';
        let endpoint;
        if (isHttps) {
            endpoint = `${protocol}//${window.location.host}/ws`;
        } else if (window.location.port === '3000') {
            endpoint = `${protocol}//${window.location.host}/ws`;
        } else {
            endpoint = `${protocol}//${window.location.hostname || 'localhost'}:8080/`;
        }

        const url = `${endpoint}?mode=world&room_id=${encodeURIComponent(this.worldId)}`
            + `&device_id=${encodeURIComponent(this.user.device_id)}`
            + `&nickname=${encodeURIComponent(this.user.nickname)}`
            + `&emoji=${encodeURIComponent(this.user.emoji)}`;

        try {
            this.ws = new WebSocket(url);
        } catch (e) {
            console.error('[World] connect failed', e);
            return;
        }

        this.ws.onmessage = (ev) => {
            let data;
            try { data = JSON.parse(ev.data); } catch (e) { return; }
            this.handleMessage(data);
        };
        this.ws.onclose = () => {
            const loading = document.getElementById('world-loading');
            if (loading) loading.innerHTML = '<span>Koneksi world terputus. Muat ulang halaman.</span>';
        };
        this.ws.onerror = () => {};
    }

    send(type, payload = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ type, ...payload }));
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
                if (window.showToast) window.showToast(`Masuk tikar: ${data.label || 'Tikar'}`, 'success');
                break;

            case 'zone.exit':
                this.activeBox = null;
                this.player.setMatVolumeScale(1);
                this.player.pause();
                this.updatePanelRoomInfo();
                const ql = document.getElementById('mat-queue-list');
                if (ql) ql.innerHTML = '<div class="mat-empty">Belum bergabung ke tikar.</div>';
                const ul = document.getElementById('mat-users-list');
                if (ul) ul.innerHTML = '';
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
                window.JAMRI_APP.wsClient.send('zone.select', { box_id: btn.dataset.box });
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
            joy.addEventListener('touchstart', (e) => { e.preventDefault(); setFromEvent(e.touches[0]); }, { passive: false });
            joy.addEventListener('touchmove', (e) => { e.preventDefault(); setFromEvent(e.touches[0]); }, { passive: false });
            joy.addEventListener('touchend', (e) => { e.preventDefault(); reset(); }, { passive: false });
            joy.addEventListener('mousedown', (e) => setFromEvent(e));
            window.addEventListener('mousemove', (e) => { if (this.joystick.active && !('ontouchstart' in window)) setFromEvent(e); });
            window.addEventListener('mouseup', () => { if (!('ontouchstart' in window)) reset(); });
        }
    }

    unbindInput() {
        window.removeEventListener('keydown', this._bound.keydown);
        window.removeEventListener('keyup', this._bound.keyup);
        window.removeEventListener('resize', this._bound.resize);
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
        // Direction from keyboard + joystick.
        let dx = 0, dy = 0;
        if (this.keys['a'] || this.keys['arrowleft']) dx -= 1;
        if (this.keys['d'] || this.keys['arrowright']) dx += 1;
        if (this.keys['w'] || this.keys['arrowup']) dy -= 1;
        if (this.keys['s'] || this.keys['arrowdown']) dy += 1;
        if (this.joystick.active) { dx += this.joystick.x; dy += this.joystick.y; }

        if (dx !== 0 || dy !== 0) {
            const len = Math.hypot(dx, dy) || 1;
            const nx = this.me.x + (dx / len) * JamriWorld.SPEED * dt;
            const ny = this.me.y + (dy / len) * JamriWorld.SPEED * dt;

            // Axis-separated so you slide along walls instead of sticking.
            if (!this.blocked(nx, this.me.y)) this.me.x = nx;
            if (!this.blocked(this.me.x, ny)) this.me.y = ny;

            this.me.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 2 : 3) : (dy > 0 ? 0 : 1);

            if (now - this.lastSend > 1000 / JamriWorld.SEND_HZ) {
                this.lastSend = now;
                this.send('world.move', { x: this.me.x, y: this.me.y, dir: this.me.dir });
            }
        }

        // Smooth camera.
        this.cam.x += (this.me.x - this.cam.x) * Math.min(1, dt * 8);
        this.cam.y += (this.me.y - this.cam.y) * Math.min(1, dt * 8);

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
            av.rx += (av.x - av.rx) * t;
            av.ry += (av.y - av.ry) * t;
        }
    }

    // ------------------------------------------------------------------
    // Rendering (procedural pixel art)
    // ------------------------------------------------------------------
    render() {
        const ctx = this.ctx;
        if (!ctx || !this.map) return;

        const W = this.canvas.width;
        const H = this.canvas.height;
        const tile = this.map.tile || JamriWorld.TILE;

        // Camera top-left in world space, clamped to map bounds.
        const mapW = this.map.w * tile;
        const mapH = this.map.h * tile;
        let camX = this.cam.x - W / 2;
        let camY = this.cam.y - H / 2;
        camX = Math.max(0, Math.min(camX, Math.max(0, mapW - W)));
        camY = Math.max(0, Math.min(camY, Math.max(0, mapH - H)));

        ctx.imageSmoothingEnabled = false;

        // Background void.
        ctx.fillStyle = '#0b0f1a';
        ctx.fillRect(0, 0, W, H);

        // Floor tiles (checkerboard with subtle pixel noise).
        const startCol = Math.floor(camX / tile);
        const endCol = Math.ceil((camX + W) / tile);
        const startRow = Math.floor(camY / tile);
        const endRow = Math.ceil((camY + H) / tile);

        for (let ry = startRow; ry <= endRow; ry++) {
            for (let rx = startCol; rx <= endCol; rx++) {
                if (rx < 0 || ry < 0 || rx >= this.map.w || ry >= this.map.h) continue;
                const even = (rx + ry) % 2 === 0;
                ctx.fillStyle = even ? '#20263a' : '#1b2033';
                ctx.fillRect(Math.round(rx * tile - camX), Math.round(ry * tile - camY), tile, tile);
                // pixel speck
                if ((rx * 7 + ry * 13) % 5 === 0) {
                    ctx.fillStyle = even ? '#262d44' : '#222840';
                    ctx.fillRect(Math.round(rx * tile - camX) + 6, Math.round(ry * tile - camY) + 8, 3, 3);
                }
            }
        }

        // Colliders / walls.
        for (const c of this.map.colliders || []) {
            const x = Math.round(c.x * tile - camX);
            const y = Math.round(c.y * tile - camY);
            const w = c.w * tile;
            const h = c.h * tile;
            ctx.fillStyle = '#3b2c1e';
            ctx.fillRect(x, y, w, h);
            ctx.fillStyle = '#5a4430';
            ctx.fillRect(x, y, w, 6);
            ctx.fillStyle = '#2a1f15';
            ctx.fillRect(x, y + h - 5, w, 5);
        }

        // Mats (jamming boxes) drawn on the floor, under avatars.
        for (const b of this.boxes) {
            const sx = b.x - camX;
            const sy = b.y - camY;
            const r = b.r || 96;
            const isActive = this.activeBox && this.activeBox.id === b.id;

            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fillStyle = isActive ? 'rgba(99,102,241,0.20)' : 'rgba(148,163,184,0.12)';
            ctx.fill();
            ctx.lineWidth = isActive ? 4 : 2;
            ctx.strokeStyle = isActive ? '#818cf8' : 'rgba(148,163,184,0.55)';
            ctx.stroke();

            // Checkerboard mat pattern (pixel style).
            ctx.save();
            ctx.beginPath();
            ctx.arc(sx, sy, r - 3, 0, Math.PI * 2);
            ctx.clip();
            const cell = 16;
            for (let gy = -r; gy < r; gy += cell) {
                for (let gx = -r; gx < r; gx += cell) {
                    if (((gx / cell) + (gy / cell)) % 2 === 0) {
                        ctx.fillStyle = isActive ? 'rgba(129,140,248,0.12)' : 'rgba(148,163,184,0.07)';
                        ctx.fillRect(Math.round(sx + gx), Math.round(sy + gy), cell, cell);
                    }
                }
            }
            ctx.restore();

            // Label above the mat.
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            const label = `${b.label || 'Tikar'}${b.users ? ' (' + b.users + ')' : ''}`;
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(sx - tw / 2 - 5, sy - r - 20, tw + 10, 16);
            ctx.fillStyle = isActive ? '#c7d2fe' : '#cbd5e1';
            ctx.fillText(label, sx, sy - r - 8);
        }

        // Draw entities sorted by Y (painter's algorithm).
        const entities = [];
        for (const [id, av] of this.avatars.entries()) {
            entities.push({ id, x: av.rx, y: av.ry, emoji: av.emoji, nick: av.nick, me: false, owner: av.owner });
        }
        entities.push({ id: this.myId, x: this.me.x, y: this.me.y, emoji: this.user.emoji, nick: this.user.nickname, me: true, owner: !!this.iAmOwner });
        entities.sort((a, b) => a.y - b.y);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const now = performance.now();
        for (const e of entities) {
            const sx = Math.round(e.x - camX);
            const sy = Math.round(e.y - camY);

            // Shadow ellipse (pixel style).
            ctx.fillStyle = 'rgba(0,0,0,0.35)';
            ctx.fillRect(sx - 12, sy + 12, 24, 6);

            // Emoji avatar.
            ctx.font = '30px serif';
            ctx.fillText(e.emoji || '🎧', sx, sy);

            // Name label.
            ctx.font = 'bold 11px sans-serif';
            const label = e.nick || '';
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(sx - tw / 2 - 4, sy - 30, tw + 8, 14);
            ctx.fillStyle = e.me ? '#8ab4ff' : '#e5e7eb';
            ctx.fillText(label, sx, sy - 23);

            // Owner crown: the world host / mat owner is highlighted.
            if (e.owner) {
                ctx.font = '13px serif';
                ctx.fillText('👑', sx + tw / 2 + 10, sy - 23);
            }

            // Floating emote above the avatar (fades + rises).
            const em = this.emotes.find(x => x.id === e.id);
            if (em) {
                const age = (now - em.t) / 1000;
                if (age < 2.2) {
                    ctx.globalAlpha = Math.max(0, 1 - age / 2.2);
                    ctx.font = '24px serif';
                    ctx.fillText(em.emote, sx, sy - 44 - age * 18);
                    ctx.globalAlpha = 1;
                }
            }
        }

        // Drop expired emotes.
        this.emotes = this.emotes.filter(x => (now - x.t) < 2200);

        this.renderMinimap(camX, camY, W, H);
    }

    /** Small corner minimap: world bounds, walls, mats and every avatar. */
    renderMinimap(camX, camY, W, H) {
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
        mctx.fillStyle = 'rgba(11,15,26,0.75)';
        mctx.fillRect(0, 0, mw, mh);

        // Walls.
        mctx.fillStyle = 'rgba(120,110,90,0.8)';
        for (const c of this.map.colliders || []) {
            mctx.fillRect(c.x * (this.map.tile || 32) * sx, c.y * (this.map.tile || 32) * sy,
                c.w * (this.map.tile || 32) * sx, c.h * (this.map.tile || 32) * sy);
        }

        // Mats.
        for (const b of this.boxes) {
            mctx.beginPath();
            mctx.arc(b.x * sx, b.y * sy, Math.max(3, (b.r || 96) * sx), 0, Math.PI * 2);
            mctx.strokeStyle = (this.activeBox && this.activeBox.id === b.id) ? '#818cf8' : 'rgba(148,163,184,0.7)';
            mctx.lineWidth = 1.5;
            mctx.stroke();
        }

        // Avatars.
        for (const av of this.avatars.values()) {
            mctx.fillStyle = '#94a3b8';
            mctx.fillRect(av.rx * sx - 1.5, av.ry * sy - 1.5, 3, 3);
        }
        mctx.fillStyle = '#8ab4ff';
        mctx.fillRect(this.me.x * sx - 2.5, this.me.y * sy - 2.5, 5, 5);

        // Camera viewport rectangle.
        mctx.strokeStyle = 'rgba(255,255,255,0.25)';
        mctx.lineWidth = 1;
        mctx.strokeRect(camX * sx, camY * sy, W * sx, H * sy);
    }
}

window.JamriWorld = JamriWorld;
