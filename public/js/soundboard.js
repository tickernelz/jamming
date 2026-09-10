/**
 * soundboard.js
 * Discord-like Soundboard Engine for Jamri Jamming Rooms
 * Supports built-in synthesized/audio sound effects + custom user uploads (max 15s)
 * Synchronized across all users in the room in real-time
 */

class JamriSoundboard {
    constructor() {
        this.roomId = null;
        this.user = null;
        this.ws = null;
        this.audioCtx = null;
        this.customSounds = [];
        this.volume = parseFloat(localStorage.getItem('jamri_soundboard_vol') || '0.9');
        this.activeAudioElements = [];

        // Built-in high quality sound effects
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
        this.customSounds = [];
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
        if (!this.roomId) return;
        try {
            const res = await fetch(`api/soundboard.php?room_id=${encodeURIComponent(this.roomId)}`);
            const data = await res.json();
            if (data.success && Array.isArray(data.soundboards)) {
                this.customSounds = data.soundboards;
                this.renderSoundboardGrid();
            }
        } catch (err) {
            console.warn('[Soundboard] Failed to load custom sounds:', err);
        }
    }

    setupWebSocketListeners() {
        if (!this.ws) return;

        this.ws.on('soundboard_play', (data) => {
            this.handleIncomingSound(data);
        });

        this.ws.on('soundboard_added', (data) => {
            if (data.soundboard) {
                // Check if already in list
                const exists = this.customSounds.some(s => s.id === data.soundboard.id);
                if (!exists) {
                    this.customSounds.push(data.soundboard);
                    this.renderSoundboardGrid();
                    if (window.showToast && data.triggered_by !== this.user.nickname) {
                        window.showToast(`${data.triggered_by} menambahkan soundboard: ${data.soundboard.title} ${data.soundboard.emoji}`, 'info');
                    }
                }
            }
        });

        this.ws.on('soundboard_deleted', (data) => {
            if (data.soundboard_id) {
                this.customSounds = this.customSounds.filter(s => s.id !== data.soundboard_id);
                this.renderSoundboardGrid();
            }
        });
    }

    triggerSound(sound) {
        if (!this.roomId || !this.ws) return;

        // Broadcast to all room members via WebSocket
        this.ws.sendSoundboardPlay({
            id: sound.id,
            title: sound.title,
            emoji: sound.emoji,
            file_url: sound.file_url || ''
        });

        // Show click ripple / visual feedback on clicked card
        const card = document.querySelector(`.soundboard-card[data-id="${sound.id}"]`);
        if (card) {
            card.classList.add('playing');
            setTimeout(() => card.classList.remove('playing'), 600);
        }
    }

    handleIncomingSound(data) {
        this.ensureAudioContext();

        // 1. Play the audio locally
        if (data.file_url) {
            this.playAudioFile(data.file_url);
        } else {
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

    playAudioFile(url) {
        try {
            const audio = new Audio(url);
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
            console.warn('[Soundboard] Failed to play custom audio:', err);
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
                // Iconic reggae airhorn 3-frequency burst
                const freqs = [466.16, 523.25, 622.25]; // Bb4, C5, Eb5
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
                // Pitch drop sub-bass + noise hit
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

                // Distortion transient
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
                // Low vocalized pitch drop
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
                // Filtered noise bursts simulating applause
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
                // Ba-Dum-Tss
                // Hit 1
                const hit1 = ctx.createOscillator();
                const g1 = ctx.createGain();
                hit1.frequency.setValueAtTime(140, now);
                hit1.frequency.exponentialRampToValueAtTime(60, now + 0.1);
                g1.gain.setValueAtTime(0.5, now);
                g1.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
                hit1.connect(g1);
                g1.connect(masterVol);
                hit1.start(now);
                hit1.stop(now + 0.12);

                // Hit 2
                const hit2 = ctx.createOscillator();
                const g2 = ctx.createGain();
                hit2.frequency.setValueAtTime(120, now + 0.18);
                hit2.frequency.exponentialRampToValueAtTime(50, now + 0.3);
                g2.gain.setValueAtTime(0.5, now + 0.18);
                g2.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
                hit2.connect(g2);
                g2.connect(masterVol);
                hit2.start(now + 0.18);
                hit2.stop(now + 0.32);

                // Cymbal crash (Tss)
                const cDuration = 0.8;
                const cSize = ctx.sampleRate * cDuration;
                const cBuf = ctx.createBuffer(1, cSize, ctx.sampleRate);
                const cData = cBuf.getChannelData(0);
                for (let i = 0; i < cSize; i++) {
                    cData[i] = Math.random() * 2 - 1;
                }
                const cNoise = ctx.createBufferSource();
                cNoise.buffer = cBuf;
                const cFilter = ctx.createBiquadFilter();
                cFilter.type = 'highpass';
                cFilter.frequency.setValueAtTime(6000, now + 0.38);
                const cGain = ctx.createGain();
                cGain.gain.setValueAtTime(0.4, now + 0.38);
                cGain.gain.exponentialRampToValueAtTime(0.001, now + 0.38 + cDuration);
                cNoise.connect(cFilter);
                cFilter.connect(cGain);
                cGain.connect(masterVol);
                cNoise.start(now + 0.38);
                break;
            }

            case 'sad_trombone': {
                // Sad trombone notes: D4 -> C#4 -> C4 -> B3 (with vibrato)
                const notes = [
                    { f: 293.66, t: 0, d: 0.35 },
                    { f: 277.18, t: 0.38, d: 0.35 },
                    { f: 261.63, t: 0.76, d: 0.35 },
                    { f: 246.94, t: 1.14, d: 1.0, slide: 210 }
                ];
                notes.forEach(n => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sawtooth';
                    osc.frequency.setValueAtTime(n.f, now + n.t);
                    if (n.slide) {
                        osc.frequency.linearRampToValueAtTime(n.slide, now + n.t + n.d);
                    }
                    gain.gain.setValueAtTime(0.2, now + n.t);
                    gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + n.d);
                    osc.connect(gain);
                    gain.connect(masterVol);
                    osc.start(now + n.t);
                    osc.stop(now + n.t + n.d + 0.05);
                });
                break;
            }

            case 'level_up': {
                // Retro 8-bit victory arpeggio
                const notes = [261.63, 329.63, 392.00, 523.25, 659.25, 783.99, 1046.50];
                notes.forEach((f, idx) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'square';
                    const t = now + idx * 0.08;
                    osc.frequency.setValueAtTime(f, t);
                    gain.gain.setValueAtTime(0.15, t);
                    gain.gain.exponentialRampToValueAtTime(0.001, t + (idx === notes.length - 1 ? 0.4 : 0.1));
                    osc.connect(gain);
                    gain.connect(masterVol);
                    osc.start(t);
                    osc.stop(t + 0.45);
                });
                break;
            }

            case 'alarm': {
                // Siren alarm sound
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sawtooth';
                for (let i = 0; i < 4; i++) {
                    const t = now + i * 0.5;
                    osc.frequency.setValueAtTime(500, t);
                    osc.frequency.linearRampToValueAtTime(950, t + 0.25);
                    osc.frequency.linearRampToValueAtTime(500, t + 0.5);
                }
                gain.gain.setValueAtTime(0.25, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 2.1);
                osc.connect(gain);
                gain.connect(masterVol);
                osc.start(now);
                osc.stop(now + 2.2);
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
            <div class="bubble-info">
                <div class="bubble-title">${escapeHtml(data.title || 'Sound')}</div>
                <div class="bubble-sender">${escapeHtml(data.triggered_by || 'Seseorang')}</div>
            </div>
        `;

        // Random horizontal offset near center
        const randomX = (Math.random() - 0.5) * 160;
        el.style.transform = `translateX(${randomX}px)`;

        container.appendChild(el);

        setTimeout(() => {
            if (el.parentNode) el.parentNode.removeChild(el);
        }, 2500);
    }

    renderSoundboardGrid() {
        const grid = document.getElementById('soundboard-grid');
        if (!grid) return;

        const isHostOrUploader = (sound) => {
            return this.user && (sound.added_by_nickname === this.user.nickname);
        };

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

        // 2. Custom Section
        html += `<div class="soundboard-section-title" style="margin-top:20px;">
            <span>Suara Kustom Room</span>
            <span class="badge-count">${this.customSounds.length}</span>
            <button type="button" id="btn-open-upload-sound" class="btn btn-primary btn-xs" style="margin-left:auto;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span>Upload Sound</span>
            </button>
        </div>`;

        if (this.customSounds.length === 0) {
            html += `
                <div class="soundboard-empty-state">
                    <p>Belum ada soundboard kustom di room ini.</p>
                    <button type="button" class="btn btn-outline btn-sm" id="btn-empty-upload-sound">
                        + Tambah MP3 Kustom (Maks. 15 Detik)
                    </button>
                </div>
            `;
        } else {
            html += `<div class="soundboard-cards-grid">`;
            this.customSounds.forEach(sound => {
                html += `
                    <div class="soundboard-card custom-sound" data-id="${sound.id}" title="Klik untuk bunyikan ${escapeHtml(sound.title)}">
                        <button type="button" class="soundboard-play-area" data-id="${sound.id}">
                            <span class="sound-emoji">${sound.emoji || '🔊'}</span>
                            <span class="sound-name">${escapeHtml(sound.title)}</span>
                            <span class="sound-uploader">Oleh ${escapeHtml(sound.added_by_nickname || 'Anon')} • ${Math.round(sound.duration_seconds || 0)}s</span>
                        </button>
                        ${isHostOrUploader(sound) ? `
                            <button type="button" class="btn-delete-sound" data-id="${sound.id}" title="Hapus soundboard ini">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="3 6 5 6 21 6"></polyline>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                            </button>
                        ` : ''}
                    </div>
                `;
            });
            html += `</div>`;
        }

        grid.innerHTML = html;

        // Attach card click handlers
        grid.querySelectorAll('.soundboard-card:not(.custom-sound)').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-id');
                const sound = this.builtInSounds.find(s => s.id === id);
                if (sound) this.triggerSound(sound);
            });
        });

        grid.querySelectorAll('.soundboard-play-area').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = parseInt(btn.getAttribute('data-id'), 10);
                const sound = this.customSounds.find(s => s.id === id);
                if (sound) this.triggerSound(sound);
            });
        });

        // Delete buttons
        grid.querySelectorAll('.btn-delete-sound').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = parseInt(btn.getAttribute('data-id'), 10);
                if (confirm('Hapus soundboard ini dari room?')) {
                    this.deleteSound(id);
                }
            });
        });

        // Upload triggers
        const btnUpload = grid.querySelector('#btn-open-upload-sound');
        if (btnUpload) btnUpload.addEventListener('click', () => this.showUploadModal());
        const btnEmptyUpload = grid.querySelector('#btn-empty-upload-sound');
        if (btnEmptyUpload) btnEmptyUpload.addEventListener('click', () => this.showUploadModal());
    }

    showUploadModal() {
        let modal = document.getElementById('modal-upload-soundboard');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'modal-upload-soundboard';
            modal.className = 'jamri-modal-backdrop';
            modal.innerHTML = `
                <div class="jamri-modal-box">
                    <div class="jamri-modal-header">
                        <h3>Tambah Custom Soundboard</h3>
                        <button type="button" class="btn btn-ghost btn-icon btn-sm btn-close-modal">✕</button>
                    </div>
                    <div class="jamri-modal-body">
                        <p style="font-size:13px; color:var(--text-muted); margin-bottom:14px;">
                            Unggah file audio (MP3 / WAV / OGG) maksimal <strong>15 detik</strong>. Soundboard akan dapat dibunyikan oleh seluruh peserta di room ini!
                        </p>

                        <div class="form-group">
                            <label>Nama Soundboard</label>
                            <input type="text" id="input-sb-title" class="form-control" placeholder="Contoh: Ketawa Jahat / Huh?!" maxlength="30" />
                        </div>

                        <div class="form-group">
                            <label>Pilih Ikon Emoji</label>
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

                        <div class="form-group">
                            <label>File Audio (.mp3, .wav, .ogg, .m4a)</label>
                            <input type="file" id="input-sb-file" class="form-control" accept="audio/*" />
                            <div id="sb-file-status" class="file-status-info" style="display:none;"></div>
                        </div>
                    </div>
                    <div class="jamri-modal-footer">
                        <button type="button" class="btn btn-outline btn-sm btn-close-modal">Batal</button>
                        <button type="button" id="btn-submit-soundboard" class="btn btn-primary btn-sm">Unggah ke Room</button>
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

                // Autofill title if empty
                if (!titleInput.value) {
                    const cleanName = file.name.replace(/\.[^/.]+$/, "").substring(0, 25);
                    titleInput.value = cleanName;
                }

                statusDiv.style.display = 'block';
                statusDiv.innerHTML = '<span class="spinner-small"></span> Memeriksa durasi file audio...';
                statusDiv.className = 'file-status-info info';

                // Check duration using temporary Audio element
                const url = URL.createObjectURL(file);
                const tempAudio = new Audio();
                tempAudio.preload = 'metadata';
                tempAudio.src = url;

                tempAudio.onloadedmetadata = () => {
                    URL.revokeObjectURL(url);
                    const dur = tempAudio.duration;
                    modal._detectedDuration = dur;

                    if (dur > 15.5) {
                        statusDiv.className = 'file-status-info error';
                        statusDiv.innerHTML = `⚠️ Durasi audio <strong>${Math.round(dur)} detik</strong> melebihi batas maksimal 15 detik! Silakan potong audio Anda terlebih dahulu.`;
                    } else {
                        statusDiv.className = 'file-status-info success';
                        statusDiv.innerHTML = `✅ Durasi audio: <strong>${Math.round(dur * 10) / 10} detik</strong> (Valid). Siap diunggah!`;
                    }
                };

                tempAudio.onerror = () => {
                    URL.revokeObjectURL(url);
                    statusDiv.className = 'file-status-info warning';
                    statusDiv.innerHTML = '⚠️ Tidak dapat membaca durasi audio secara otomatis, pastikan durasi di bawah 15 detik.';
                    modal._detectedDuration = 0;
                };
            });

            // Submit handler
            modal.querySelector('#btn-submit-soundboard').addEventListener('click', () => {
                this.handleUploadSubmit(modal);
            });
        }

        // Reset form
        modal.querySelector('#input-sb-title').value = '';
        modal.querySelector('#input-sb-file').value = '';
        modal.querySelector('#sb-file-status').style.display = 'none';
        modal._detectedDuration = 0;
        modal.style.display = 'flex';
    }

    async handleUploadSubmit(modal) {
        const title = modal.querySelector('#input-sb-title').value.trim();
        const emoji = modal.querySelector('#input-sb-emoji').value.trim() || '🔊';
        const fileInput = modal.querySelector('#input-sb-file');
        const file = fileInput.files[0];
        const duration = modal._detectedDuration || 0;

        if (!title) {
            alert('Harap masukkan nama soundboard!');
            return;
        }

        if (!file) {
            alert('Harap pilih file audio terlebih dahulu!');
            return;
        }

        if (duration > 15.5) {
            alert('Durasi file melebihi 15 detik. Pilih audio yang lebih pendek!');
            return;
        }

        const btnSubmit = modal.querySelector('#btn-submit-soundboard');
        btnSubmit.disabled = true;
        btnSubmit.textContent = 'Mengunggah...';

        const formData = new FormData();
        formData.append('room_id', this.roomId);
        formData.append('title', title);
        formData.append('emoji', emoji);
        formData.append('duration', duration.toString());
        formData.append('nickname', this.user.nickname);
        formData.append('file', file);

        try {
            const res = await fetch('api/soundboard.php', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();

            if (data.success && data.soundboard) {
                // Add to local custom sounds
                this.customSounds.push(data.soundboard);
                this.renderSoundboardGrid();

                // Broadcast to room via WebSocket
                if (this.ws) {
                    this.ws.sendSoundboardAdd(data.soundboard);
                }

                modal.style.display = 'none';
                if (window.showToast) {
                    window.showToast('Soundboard berhasil diunggah dan dibagikan ke room!', 'success');
                }
            } else {
                alert(data.error || 'Gagal mengunggah file soundboard');
            }
        } catch (err) {
            console.error('[Soundboard] Upload error:', err);
            alert('Terjadi kesalahan saat mengunggah file.');
        } finally {
            btnSubmit.disabled = false;
            btnSubmit.textContent = 'Unggah ke Room';
        }
    }

    async deleteSound(soundboardId) {
        try {
            const formData = new FormData();
            formData.append('action', 'delete');
            formData.append('room_id', this.roomId);
            formData.append('id', soundboardId.toString());

            const res = await fetch('api/soundboard.php', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();

            if (data.success) {
                this.customSounds = this.customSounds.filter(s => s.id !== soundboardId);
                this.renderSoundboardGrid();

                if (this.ws) {
                    this.ws.sendSoundboardDelete(soundboardId);
                }
                if (window.showToast) {
                    window.showToast('Soundboard dihapus.', 'info');
                }
            }
        } catch (err) {
            console.error('[Soundboard] Delete error:', err);
        }
    }
}

window.JamriSoundboard = JamriSoundboard;
