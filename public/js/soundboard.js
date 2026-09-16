/**
 * soundboard.js
 * Discord-like Soundboard Engine for Jamri Jamming Rooms
 * 100% Client-Side Storage (IndexedDB) & Real-Time Audio Streaming (Zero Server Storage Attack Surface)
 * Supports built-in synthesized/audio sound effects + custom local sounds (max 15s)
 * Synchronized across all users in the room in real-time
 */

class JamriSoundboardDB {
    static DB_NAME = 'jamri_soundboard_db';
    static STORE_NAME = 'custom_soundboards';
    static DB_VERSION = 1;

    static async open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    static async getAll() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    static async save(soundItem) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            store.put(soundItem);
            tx.oncomplete = () => resolve(soundItem);
            tx.onerror = () => reject(tx.error);
        });
    }

    static async delete(id) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            store.delete(id);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }
}

class JamriSoundboard {
    constructor() {
        this.roomId = null;
        this.user = null;
        this.ws = null;
        this.audioCtx = null;
        this.customSounds = [];
        this.volume = parseFloat(localStorage.getItem('jamri_soundboard_vol') || '0.9');
        this.activeAudioElements = [];

        // Built-in sound effects (synthesized locally via WebAudio)
        this.builtInSounds = [
            { id: 'airhorn', title: 'Airhorn', emoji: '📢', duration: 1.6, type: 'builtin' },
            { id: 'vine_boom', title: 'Vine Boom', emoji: '💥', duration: 1.8, type: 'builtin' },
            { id: 'bruh', title: 'Bruh', emoji: '🗿', duration: 1.0, type: 'builtin' },
            { id: 'applause', title: 'Tepuk Tangan', emoji: '👏', duration: 2.8, type: 'builtin' },
            { id: 'rimshot', title: 'Ba-Dum-Tss', emoji: '🥁', duration: 1.5, type: 'builtin' },
            { id: 'sad_trombone', title: 'Sad Trombone', emoji: '🎺', duration: 2.6, type: 'builtin' },
            { id: 'level_up', title: 'Level Up', emoji: '✨', duration: 1.4, type: 'builtin' },
            { id: 'alarm', title: 'Panic Alarm', emoji: '🚨', duration: 2.2, type: 'builtin' }
        ];

        this.initAudioContext();
    }

    initAudioContext() {
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                this.audioCtx = new AudioContextClass();
            }
        } catch (e) {
            console.warn('[Soundboard] AudioContext not available:', e);
        }
    }

    ensureAudioContext() {
        if (!this.audioCtx) {
            this.initAudioContext();
        }
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }
    }

    attach(roomId, user, ws) {
        this.roomId = roomId;
        this.user = user;
        this.ws = ws;

        this.loadCustomSounds();
        this.setupWebSocketListeners();
    }

    detach() {
        this.roomId = null;
        this.stopAll();
    }

    stopAll() {
        this.activeAudioElements.forEach(audio => {
            try { audio.pause(); audio.currentTime = 0; } catch (e) {}
        });
        this.activeAudioElements = [];
    }

    setVolume(vol) {
        this.volume = Math.max(0, Math.min(1, vol));
        localStorage.setItem('jamri_soundboard_vol', this.volume.toString());
        this.activeAudioElements.forEach(audio => {
            try { audio.volume = this.volume; } catch (e) {}
        });
    }

    async loadCustomSounds() {
        try {
            this.customSounds = await JamriSoundboardDB.getAll();
            this.renderSoundboardGrid();
        } catch (err) {
            console.warn('[Soundboard] Failed to load custom sounds from IndexedDB:', err);
        }
    }

    setupWebSocketListeners() {
        if (!this.ws) return;

        this.ws.on('soundboard_play', (data) => {
            this.handleIncomingSound(data);
        });
    }

    triggerSound(sound) {
        if (!this.roomId || !this.ws) return;

        // Discord-style real-time audio broadcast
        this.ws.sendSoundboardPlay({
            id: sound.id,
            title: sound.title,
            emoji: sound.emoji || '🔊',
            audio: sound.audioData || '', // Client-side streamed audio
            file_url: ''
        });

        // Click feedback animation
        const card = document.querySelector(`.soundboard-card[data-id="${sound.id}"]`);
        if (card) {
            card.classList.add('playing');
            setTimeout(() => card.classList.remove('playing'), 600);
        }
    }

    handleIncomingSound(data) {
        this.ensureAudioContext();

        // 1. Play the audio
        if (data.audio) {
            // Real-time streamed audio from triggerer's IndexedDB
            this.playAudioData(data.audio);
        } else if (data.file_url) {
            this.playAudioData(data.file_url);
        } else {
            // Built-in synthesized sound
            this.playBuiltIn(data.sound_id || data.title);
        }

        // 2. Trigger floating reaction animation & highlight card
        this.showFloatingReaction(data);

        const card = document.querySelector(`.soundboard-card[data-id="${data.sound_id}"]`);
        if (card) {
            card.classList.add('playing');
            setTimeout(() => card.classList.remove('playing'), 800);
        }
    }

    playAudioData(audioSrc) {
        try {
            const audio = new Audio(audioSrc);
            audio.volume = this.volume;
            this.activeAudioElements.push(audio);

            audio.onended = () => {
                this.activeAudioElements = this.activeAudioElements.filter(a => a !== audio);
            };
            audio.onerror = () => {
                this.activeAudioElements = this.activeAudioElements.filter(a => a !== audio);
            };

            const playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise.catch(e => console.warn('[Soundboard] Play error:', e));
            }
        } catch (err) {
            console.warn('[Soundboard] Failed to play audio:', err);
        }
    }

    // High fidelity synthesized audio effects for instant built-in playback
    playBuiltIn(soundId) {
        if (!this.audioCtx) return;
        const ctx = this.audioCtx;
        const now = ctx.currentTime;
        const masterVol = ctx.createGain();
        masterVol.gain.setValueAtTime(this.volume, now);
        masterVol.connect(ctx.destination);

        switch (soundId) {
            case 'airhorn': {
                const freqs = [466.16, 523.25, 622.25];
                const bursts = [0, 0.18, 0.36, 0.60];
                bursts.forEach(t => {
                    freqs.forEach(f => {
                        const osc = ctx.createOscillator();
                        const gain = ctx.createGain();
                        osc.type = 'sawtooth';
                        osc.frequency.setValueAtTime(f, now + t);
                        gain.gain.setValueAtTime(0.12, now + t);
                        gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.14);
                        osc.connect(gain);
                        gain.connect(masterVol);
                        osc.start(now + t);
                        osc.stop(now + t + 0.15);
                    });
                });
                break;
            }

            case 'vine_boom': {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(130, now);
                osc.frequency.exponentialRampToValueAtTime(32, now + 0.8);

                gain.gain.setValueAtTime(0.9, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);

                osc.connect(gain);
                gain.connect(masterVol);
                osc.start(now);
                osc.stop(now + 1.3);

                const bufferSize = ctx.sampleRate * 0.1;
                const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
                const output = noiseBuffer.getChannelData(0);
                for (let i = 0; i < bufferSize; i++) {
                    output[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.02));
                }
                const whiteNoise = ctx.createBufferSource();
                whiteNoise.buffer = noiseBuffer;
                const noiseGain = ctx.createGain();
                noiseGain.gain.setValueAtTime(0.3, now);
                noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
                whiteNoise.connect(noiseGain);
                noiseGain.connect(masterVol);
                whiteNoise.start(now);
                break;
            }

            case 'bruh': {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                const filter = ctx.createBiquadFilter();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(110, now);
                osc.frequency.linearRampToValueAtTime(80, now + 0.4);

                filter.type = 'bandpass';
                filter.frequency.setValueAtTime(450, now);
                filter.Q.setValueAtTime(3, now);

                gain.gain.setValueAtTime(0.5, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

                osc.connect(filter);
                filter.connect(gain);
                gain.connect(masterVol);
                osc.start(now);
                osc.stop(now + 0.7);
                break;
            }

            case 'applause': {
                const duration = 2.5;
                const bufferSize = ctx.sampleRate * duration;
                const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < bufferSize; i++) {
                    const clap = Math.random() < 0.08 ? (Math.random() * 2 - 1) : (Math.random() * 0.05);
                    data[i] = clap;
                }
                const noise = ctx.createBufferSource();
                noise.buffer = buffer;

                const filter = ctx.createBiquadFilter();
                filter.type = 'bandpass';
                filter.frequency.setValueAtTime(1200, now);
                filter.Q.setValueAtTime(1.5, now);

                const gain = ctx.createGain();
                gain.gain.setValueAtTime(0.01, now);
                gain.gain.linearRampToValueAtTime(0.4, now + 0.3);
                gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

                noise.connect(filter);
                filter.connect(gain);
                gain.connect(masterVol);
                noise.start(now);
                break;
            }

            case 'rimshot': {
                // High snare click + rim knock
                const osc = ctx.createOscillator();
                const oscGain = ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(300, now);
                osc.frequency.exponentialRampToValueAtTime(120, now + 0.08);
                oscGain.gain.setValueAtTime(0.6, now);
                oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
                osc.connect(oscGain);
                oscGain.connect(masterVol);
                osc.start(now);
                osc.stop(now + 0.12);

                const cymbalOsc = ctx.createOscillator();
                const cymbalGain = ctx.createGain();
                cymbalOsc.type = 'square';
                cymbalOsc.frequency.setValueAtTime(8000, now + 0.12);
                cymbalGain.gain.setValueAtTime(0.3, now + 0.12);
                cymbalGain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
                cymbalOsc.connect(cymbalGain);
                cymbalGain.connect(masterVol);
                cymbalOsc.start(now + 0.12);
                cymbalOsc.stop(now + 1.0);
                break;
            }

            case 'sad_trombone': {
                const notes = [293.66, 277.18, 261.63, 246.94]; // D4, C#4, C4, B3
                const noteDuration = 0.45;
                notes.forEach((freq, idx) => {
                    const t = now + idx * noteDuration;
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sawtooth';

                    if (idx === notes.length - 1) {
                        osc.frequency.setValueAtTime(freq, t);
                        osc.frequency.linearRampToValueAtTime(freq - 30, t + 1.0);
                        gain.gain.setValueAtTime(0.35, t);
                        gain.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
                        osc.start(t);
                        osc.stop(t + 1.3);
                    } else {
                        osc.frequency.setValueAtTime(freq, t);
                        gain.gain.setValueAtTime(0.3, t);
                        gain.gain.exponentialRampToValueAtTime(0.001, t + noteDuration * 0.9);
                        osc.start(t);
                        osc.stop(t + noteDuration);
                    }

                    osc.connect(gain);
                    gain.connect(masterVol);
                });
                break;
            }

            case 'level_up': {
                const arpeggio = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
                arpeggio.forEach((f, idx) => {
                    const t = now + idx * 0.08;
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(f, t);
                    gain.gain.setValueAtTime(0.3, t);
                    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
                    osc.connect(gain);
                    gain.connect(masterVol);
                    osc.start(t);
                    osc.stop(t + 0.5);
                });
                break;
            }

            case 'alarm': {
                for (let i = 0; i < 4; i++) {
                    const t = now + i * 0.35;
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sawtooth';
                    osc.frequency.setValueAtTime(900, t);
                    osc.frequency.linearRampToValueAtTime(600, t + 0.25);
                    gain.gain.setValueAtTime(0.2, t);
                    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
                    osc.connect(gain);
                    gain.connect(masterVol);
                    osc.start(t);
                    osc.stop(t + 0.32);
                }
                break;
            }

            default:
                break;
        }
    }

    showFloatingReaction(data) {
        const container = document.getElementById('soundboard-floating-container');
        if (!container) return;

        const el = document.createElement('div');
        el.className = 'soundboard-floating-bubble';
        el.innerHTML = `
            <span class="bubble-emoji">${data.emoji || '🔊'}</span>
            <span class="bubble-title">${escapeHtml(data.title || 'Sound')}</span>
            <span class="bubble-author">${escapeHtml(data.triggered_by || 'Member')}</span>
        `;

        const posX = Math.floor(Math.random() * 60) + 20; // 20% to 80%
        el.style.left = `${posX}%`;
        container.appendChild(el);

        setTimeout(() => {
            if (el.parentNode) el.parentNode.removeChild(el);
        }, 3200);
    }

    renderSoundboardGrid() {
        const grid = document.getElementById('soundboard-grid');
        if (!grid) return;

        let html = '';

        // 1. Built-in section
        html += `<div class="soundboard-section-title">
            <span>Suara Bawaan</span>
            <span class="badge-count">${this.builtInSounds.length}</span>
        </div>
        <div class="soundboard-cards-grid">`;

        this.builtInSounds.forEach(sound => {
            html += `
                <button type="button" class="soundboard-card" data-id="${sound.id}" title="Klik untuk bunyikan ${escapeHtml(sound.title)}">
                    <span class="sound-emoji">${sound.emoji}</span>
                    <span class="sound-name">${escapeHtml(sound.title)}</span>
                    <span class="sound-duration">${sound.duration}s</span>
                </button>
            `;
        });
        html += `</div>`;

        // 2. Custom Section (Stored locally in IndexedDB)
        html += `<div class="soundboard-section-title" style="margin-top:20px;">
            <span>Soundboard Saya (Tersimpan di Perangkat Ini)</span>
            <span class="badge-count">${this.customSounds.length}</span>
            <button type="button" id="btn-open-upload-sound" class="btn btn-primary btn-xs" style="margin-left:auto;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span>Tambah Audio</span>
            </button>
        </div>`;

        if (this.customSounds.length === 0) {
            html += `
                <div class="soundboard-empty-state">
                    <p>Belum ada soundboard pribadi di browser Anda.</p>
                    <p style="font-size:11px; color:var(--text-muted); margin-bottom:12px;">Audio disimpan 100% di perangkat Anda (IndexedDB) dan di-stream secara instan saat dibunyikan. Nol penyimpanan di server.</p>
                    <button type="button" class="btn btn-outline btn-sm" id="btn-empty-upload-sound">
                        + Tambah Audio Kustom (Maks. 15 Detik)
                    </button>
                </div>
            `;
        } else {
            html += `<div class="soundboard-cards-grid">`;
            this.customSounds.forEach(sound => {
                html += `
                    <div class="soundboard-card custom-sound" data-id="${sound.id}" title="Klik untuk bunyikan ${escapeHtml(sound.title)} ke seluruh room">
                        <button type="button" class="soundboard-play-area" data-id="${sound.id}">
                            <span class="sound-emoji">${sound.emoji || '🔊'}</span>
                            <span class="sound-name">${escapeHtml(sound.title)}</span>
                            <span class="sound-uploader">Lokal • ${Math.round(sound.duration || 0)}s</span>
                        </button>
                        <button type="button" class="btn-delete-sound" data-id="${sound.id}" title="Hapus soundboard ini dari perangkat Anda">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    </div>
                `;
            });
            html += `</div>`;
        }

        grid.innerHTML = html;

        // Attach card click handlers for built-in sounds
        grid.querySelectorAll('.soundboard-card:not(.custom-sound)').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-id');
                const sound = this.builtInSounds.find(s => s.id === id);
                if (sound) this.triggerSound(sound);
            });
        });

        // Attach card click handlers for custom sounds
        grid.querySelectorAll('.soundboard-play-area').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-id');
                const sound = this.customSounds.find(s => s.id === id);
                if (sound) this.triggerSound(sound);
            });
        });

        // Delete buttons
        grid.querySelectorAll('.btn-delete-sound').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-id');
                if (confirm('Hapus soundboard ini dari perangkat Anda?')) {
                    this.deleteSound(id);
                }
            });
        });

        // Upload modal triggers
        const btnUpload = grid.querySelector('#btn-open-upload-sound');
        if (btnUpload) btnUpload.addEventListener('click', () => this.showAddSoundModal());
        const btnEmptyUpload = grid.querySelector('#btn-empty-upload-sound');
        if (btnEmptyUpload) btnEmptyUpload.addEventListener('click', () => this.showAddSoundModal());
    }

    showAddSoundModal() {
        let modal = document.getElementById('modal-upload-soundboard');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'modal-upload-soundboard';
            modal.className = 'jamri-modal-backdrop';
            modal.innerHTML = `
                <div class="jamri-modal-box" style="background:var(--bg-surface); border:1px solid var(--border-color); color:var(--text-primary); border-radius:var(--radius-md);">
                    <div class="jamri-modal-header" style="border-bottom:1px solid var(--border-subtle); padding:16px 20px;">
                        <h3 style="margin:0; font-size:16px; font-weight:700; color:var(--text-primary);">Tambah Soundboard Pribadi</h3>
                        <button type="button" class="btn btn-ghost btn-icon btn-sm btn-close-modal" style="margin-left:auto;">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>
                    <div class="jamri-modal-body" style="padding:18px 20px;">
                        <p style="font-size:12px; color:var(--text-secondary); line-height:1.5; margin-bottom:14px; background:var(--bg-surface-elevated); padding:10px 12px; border-radius:var(--radius-sm); border:1px solid var(--border-subtle);">
                            Audio disimpan <strong>100% di browser lokal Anda (IndexedDB)</strong> dan di-stream secara instan saat dibunyikan. Bebas risiko malware dan tanpa penyimpanan di server! Maksimal <strong>15 detik</strong>.
                        </p>

                        <div class="form-group" style="margin-bottom:14px;">
                            <label style="display:block; font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-primary);">Nama Soundboard</label>
                            <input type="text" id="input-sb-title" class="form-control" placeholder="Contoh: Ketawa Jahat / Huh?!" maxlength="30" style="width:100%; background:var(--bg-surface-elevated); border:1px solid var(--border-color); color:var(--text-primary); padding:8px 12px; border-radius:var(--radius-sm); font-size:13px; outline:none;" />
                        </div>

                        <div class="form-group" style="margin-bottom:14px;">
                            <label style="display:block; font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-primary);">Pilih Ikon Emoji</label>
                            <div class="emoji-quick-picker" id="sb-emoji-picker">
                                <span class="emoji-pill active">🔊</span>
                                <span class="emoji-pill">🤣</span>
                                <span class="emoji-pill">💀</span>
                                <span class="emoji-pill">🗿</span>
                                <span class="emoji-pill">🔥</span>
                                <span class="emoji-pill">⚡</span>
                                <span class="emoji-pill">🚀</span>
                                <span class="emoji-pill">🐶</span>
                                <span class="emoji-pill">🐱</span>
                                <span class="emoji-pill">🦆</span>
                                <span class="emoji-pill">🎸</span>
                                <span class="emoji-pill">💣</span>
                            </div>
                            <input type="hidden" id="input-sb-emoji" value="🔊" />
                        </div>

                        <div class="form-group" style="margin-bottom:14px;">
                            <label style="display:block; font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-primary);">File Audio (.mp3, .wav, .ogg, .m4a)</label>
                            <input type="file" id="input-sb-file" class="form-control" accept="audio/*" style="width:100%; font-size:12px;" />
                            <div id="sb-file-status" class="file-status-info" style="display:none; font-size:12px; margin-top:6px;"></div>
                        </div>
                    </div>
                    <div class="jamri-modal-footer" style="border-top:1px solid var(--border-subtle); padding:14px 20px; display:flex; justify-content:flex-end; gap:8px;">
                        <button type="button" class="btn btn-outline btn-sm btn-close-modal">Batal</button>
                        <button type="button" id="btn-submit-soundboard" class="btn btn-primary btn-sm">Simpan ke Perangkat</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            // Close events
            modal.querySelectorAll('.btn-close-modal').forEach(b => {
                b.addEventListener('click', () => { modal.style.display = 'none'; });
            });

            // Emoji selector
            modal.querySelectorAll('.emoji-pill').forEach(pill => {
                pill.addEventListener('click', () => {
                    modal.querySelectorAll('.emoji-pill').forEach(p => p.classList.remove('active'));
                    pill.classList.add('active');
                    modal.querySelector('#input-sb-emoji').value = pill.textContent.trim();
                });
            });

            // File selection & duration pre-validation
            const fileInput = modal.querySelector('#input-sb-file');
            const statusDiv = modal.querySelector('#sb-file-status');
            const titleInput = modal.querySelector('#input-sb-title');

            fileInput.addEventListener('change', () => {
                const file = fileInput.files[0];
                if (!file) {
                    statusDiv.style.display = 'none';
                    return;
                }

                if (!titleInput.value) {
                    const cleanName = file.name.replace(/\.[^/.]+$/, "").substring(0, 25);
                    titleInput.value = cleanName;
                }

                statusDiv.style.display = 'block';
                statusDiv.style.color = 'var(--text-muted)';
                statusDiv.innerHTML = 'Memeriksa durasi audio...';

                const tempAudio = new Audio();
                const objectUrl = URL.createObjectURL(file);
                tempAudio.src = objectUrl;

                tempAudio.onloadedmetadata = () => {
                    const dur = tempAudio.duration;
                    URL.revokeObjectURL(objectUrl);
                    modal._detectedDuration = dur;

                    if (dur > 15.5) {
                        statusDiv.style.color = 'var(--danger, #ef4444)';
                        statusDiv.innerHTML = `Durasi terlalu panjang: <strong>${dur.toFixed(1)}s</strong> (Maksimal 15 detik!)`;
                        modal.querySelector('#btn-submit-soundboard').disabled = true;
                    } else {
                        statusDiv.style.color = 'var(--success, #10b981)';
                        statusDiv.innerHTML = `Durasi valid: <strong>${dur.toFixed(1)}s</strong>`;
                        modal.querySelector('#btn-submit-soundboard').disabled = false;
                    }
                };

                tempAudio.onerror = () => {
                    URL.revokeObjectURL(objectUrl);
                    statusDiv.style.color = 'var(--text-secondary)';
                    statusDiv.innerHTML = 'Durasi tidak dapat diverifikasi otomatis. Pastikan <= 15s.';
                    modal._detectedDuration = 5.0;
                    modal.querySelector('#btn-submit-soundboard').disabled = false;
                };
            });

            modal.querySelector('#btn-submit-soundboard').addEventListener('click', () => {
                this.handleSaveSoundboard(modal);
            });
        }

        // Reset form
        modal.querySelector('#input-sb-title').value = '';
        modal.querySelector('#input-sb-file').value = '';
        modal.querySelector('#sb-file-status').style.display = 'none';
        modal._detectedDuration = 0;
        modal.querySelector('#btn-submit-soundboard').disabled = false;
        modal.style.display = 'flex';
    }

    async handleSaveSoundboard(modal) {
        const title = modal.querySelector('#input-sb-title').value.trim();
        const emoji = modal.querySelector('#input-sb-emoji').value.trim() || '🔊';
        const fileInput = modal.querySelector('#input-sb-file');
        const file = fileInput.files[0];
        const duration = modal._detectedDuration || 0;

        if (!title) {
            if (window.showToast) window.showToast('Harap masukkan nama soundboard!', 'warning');
            else alert('Harap masukkan nama soundboard!');
            return;
        }

        if (!file) {
            if (window.showToast) window.showToast('Harap pilih file audio terlebih dahulu!', 'warning');
            else alert('Harap pilih file audio terlebih dahulu!');
            return;
        }

        if (duration > 15.5) {
            if (window.showToast) window.showToast('Durasi file melebihi 15 detik. Pilih audio yang lebih pendek!', 'warning');
            else alert('Durasi file melebihi 15 detik. Pilih audio yang lebih pendek!');
            return;
        }

        const btnSubmit = modal.querySelector('#btn-submit-soundboard');
        btnSubmit.disabled = true;
        btnSubmit.textContent = 'Menyimpan...';

        try {
            // Read file as base64 Data URL (stored 100% locally in IndexedDB)
            const base64Data = await this.fileToBase64(file);

            const soundItem = {
                id: 'cust_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                title: title,
                emoji: emoji,
                duration: duration || 3.0,
                audioData: base64Data,
                createdAt: Date.now()
            };

            await JamriSoundboardDB.save(soundItem);
            await this.loadCustomSounds();

            modal.style.display = 'none';
            if (window.showToast) {
                window.showToast('Soundboard berhasil disimpan ke browser perangkat Anda!', 'success');
            }
        } catch (err) {
            console.error('[Soundboard] Save error:', err);
            if (window.showToast) window.showToast('Gagal menyimpan file soundboard ke IndexedDB.', 'error');
            else alert('Gagal menyimpan file soundboard.');
        } finally {
            btnSubmit.disabled = false;
            btnSubmit.textContent = 'Simpan ke Perangkat';
        }
    }

    async deleteSound(soundboardId) {
        try {
            await JamriSoundboardDB.delete(soundboardId);
            await this.loadCustomSounds();
            if (window.showToast) {
                window.showToast('Soundboard dihapus dari perangkat Anda.', 'info');
            }
        } catch (err) {
            console.error('[Soundboard] Delete error:', err);
        }
    }

    fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }
}

window.JamriSoundboard = JamriSoundboard;
window.JamriSoundboardDB = JamriSoundboardDB;
