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
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------
    enter(worldId, user) {
        this.worldId = worldId;
        this.user = user;
        this.buildDom();
        this.bindInput();
        this.connect();
    }

    leave() {
        this.unbindInput();
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
                    <div class="world-hint">Gerak: WASD / panah</div>
                </div>

                <div class="world-stage" id="world-stage">
                    <canvas id="world-canvas"></canvas>
                    <div class="world-loading" id="world-loading">
                        <div class="spinner"></div>
                        <span>Memasuki world...</span>
                    </div>
                </div>

                <div class="world-joystick" id="world-joystick">
                    <div class="world-joystick-knob" id="world-joystick-knob"></div>
                </div>
            </div>
        `;

        this.canvas = container.querySelector('#world-canvas');
        this.ctx = this.canvas.getContext('2d');

        const leaveBtn = container.querySelector('#btn-leave-world');
        if (leaveBtn) leaveBtn.addEventListener('click', () => leaveWorld());

        window.addEventListener('resize', this._bound.resize = () => this.resize());
        this.resize();
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
                (data.avatars || []).forEach(a => this.upsertAvatar(a, true));
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
            av = { x: a.x, y: a.y, rx: a.x, ry: a.y, dir: a.d, emoji: a.e, nick: a.n };
            this.avatars.set(id, av);
        } else {
            av.x = a.x;
            av.y = a.y;
            av.dir = a.d;
            av.emoji = a.e;
            av.nick = a.n;
            if (immediate) { av.rx = a.x; av.ry = a.y; }
        }
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

        // Draw entities sorted by Y (painter's algorithm).
        const entities = [];
        for (const av of this.avatars.values()) {
            entities.push({ x: av.rx, y: av.ry, emoji: av.emoji, nick: av.nick, me: false });
        }
        entities.push({ x: this.me.x, y: this.me.y, emoji: this.user.emoji, nick: this.user.nickname, me: true });
        entities.sort((a, b) => a.y - b.y);

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
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
        }
    }
}

window.JamriWorld = JamriWorld;
