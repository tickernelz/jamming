/**
 * voice-ptt.js
 * Real-Time Push-to-Talk (PTT) Engine for Jamri Jamming Rooms
 * Crystal clear voice audio transmission with live speaking indicators and LAN context guide
 */

class JamriVoicePTT {
    constructor() {
        this.roomId = null;
        this.user = null;
        this.ws = null;
        this.isSpeaking = false;
        this.mediaStream = null;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.activeSpeakers = new Map(); // nickname -> { emoji, time }
        this.speakerTimer = null;
        this.isKeyHeld = false;
        this.maxSpeechTimeout = null;

        this.initKeyListeners();
    }

    attach(roomId, user, ws) {
        this.roomId = roomId;
        this.user = user;
        this.ws = ws;

        this.setupWebSocketListeners();
        this.renderPTTButton();
    }

    detach() {
        this.stopSpeaking();
        this.roomId = null;
        this.activeSpeakers.clear();
        this.updateSpeakerIndicator();
    }

    checkInsecureContext() {
        const hostname = window.location.hostname;
        const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
        return (!window.isSecureContext && !isLocal);
    }

    showInsecureContextGuide() {
        let modal = document.getElementById('jamri-mic-permission-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'jamri-mic-permission-modal';
            modal.className = 'game-arena-backdrop';
            document.body.appendChild(modal);
        }

        const currentHost = window.location.host;
        modal.innerHTML = `
            <div class="game-arena-box" style="max-width: 520px; padding: 24px; text-align: left;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 26px;">🎙️</span>
                        <h3 style="margin: 0; font-size: 18px; color: var(--text-main);">Izin Mikrofon Dibutuhkan</h3>
                    </div>
                    <button type="button" class="btn btn-ghost btn-icon btn-sm btn-close-mic-guide">✕</button>
                </div>
                <div style="font-size: 14px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 16px;">
                    Anda mengakses Jamri melalui alamat IP lokal (<strong>http://${currentHost}</strong>).
                    Browser modern (Chrome/Android) secara default memblokir mikrofon pada protokol HTTP biasa demi keamanan.
                </div>
                <div style="background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; padding: 14px; margin-bottom: 18px;">
                    <div style="font-weight: 600; font-size: 13px; color: var(--accent-primary, #6366f1); margin-bottom: 8px;">
                        💡 Cara mengaktifkan mikrofon di Chrome (Android / PC):
                    </div>
                    <ol style="margin: 0; padding-left: 20px; font-size: 13px; color: var(--text-muted); display: flex; flex-direction: column; gap: 8px; line-height: 1.5;">
                        <li>Buka tab baru di browser Anda, ketik:<br><code style="background: rgba(0,0,0,0.5); padding: 3px 6px; border-radius: 4px; color: #38bdf8; word-break: break-all;">chrome://flags/#unsafely-treat-insecure-origin-as-secure</code></li>
                        <li>Masukkan alamat URL Jamri Anda:<br><code style="background: rgba(0,0,0,0.5); padding: 3px 6px; border-radius: 4px; color: #38bdf8;">http://${currentHost}</code></li>
                        <li>Ubah pilihan dropdown dari <strong>Disabled</strong> menjadi <strong>Enabled</strong>.</li>
                        <li>Klik tombol <strong>Relaunch</strong> di sudut bawah browser. Selesai!</li>
                    </ol>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 10px;">
                    <button type="button" class="btn btn-primary btn-close-mic-guide">Saya Mengerti</button>
                </div>
            </div>
        `;

        modal.querySelectorAll('.btn-close-mic-guide').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.style.display = 'none';
            });
        });
        modal.style.display = 'flex';
    }

    initKeyListeners() {
        // Keyboard shortcut: Hold 'V' key to speak
        window.addEventListener('keydown', (e) => {
            if (!this.roomId || this.isKeyHeld) return;
            if (e.key === 'v' || e.key === 'V') {
                const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
                const isEditable = document.activeElement && document.activeElement.isContentEditable;
                if (tag === 'input' || tag === 'textarea' || isEditable) {
                    return; // Ignore if user is typing in chat or input
                }
                e.preventDefault();
                this.isKeyHeld = true;
                this.startSpeaking();
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.key === 'v' || e.key === 'V') {
                if (this.isKeyHeld) {
                    this.isKeyHeld = false;
                    this.stopSpeaking();
                }
            }
        });
    }

    setupWebSocketListeners() {
        if (!this.ws) return;

        // Receiving real-time voice transmission from another user
        this.ws.on('voice_chunk', (data) => {
            if (!data.audio) return;
            this.playVoiceChunk(data);
        });

        // Receiving speaker state change (instant visual feedback)
        this.ws.on('voice_state', (data) => {
            const nickname = data.sender_nickname;
            if (!nickname) return;

            if (data.speaking) {
                this.activeSpeakers.set(nickname, {
                    emoji: data.sender_emoji || '🎧',
                    time: Date.now()
                });
            } else {
                this.activeSpeakers.delete(nickname);
            }
            this.updateSpeakerIndicator();
        });
    }

    async startSpeaking() {
        if (this.isSpeaking || !this.roomId) return;

        // Check insecure context (HTTP on LAN IP)
        if (this.checkInsecureContext() && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) {
            this.showInsecureContextGuide();
            return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            if (window.showToast) {
                window.showToast('Browser tidak mendukung akses mikrofon pada koneksi ini.', 'error');
            } else {
                alert('Browser tidak mendukung akses mikrofon pada koneksi ini.');
            }
            return;
        }

        this.isSpeaking = true;
        this.updateButtonUI(true);

        try {
            // Request microphone stream
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            // Determine best supported audio mime type
            let mimeType = 'audio/webm;codecs=opus';
            if (typeof MediaRecorder !== 'undefined') {
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    if (MediaRecorder.isTypeSupported('audio/webm')) {
                        mimeType = 'audio/webm';
                    } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
                        mimeType = 'audio/mp4';
                    } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
                        mimeType = 'audio/ogg';
                    } else {
                        mimeType = '';
                    }
                }
            }

            const options = mimeType ? { mimeType } : {};
            this.mediaRecorder = new MediaRecorder(this.mediaStream, options);
            this.recordedChunks = [];

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    this.recordedChunks.push(event.data);
                }
            };

            this.mediaRecorder.onstop = async () => {
                const chunks = this.recordedChunks;
                this.recordedChunks = [];
                if (chunks.length === 0) return;

                const actualMime = (this.mediaRecorder && this.mediaRecorder.mimeType) || mimeType || 'audio/webm';
                const completeBlob = new Blob(chunks, { type: actualMime });

                // Transmit only if user actually spoke (> 250 bytes)
                if (completeBlob.size > 250 && this.ws) {
                    try {
                        const base64 = await this.blobToBase64(completeBlob);
                        this.ws.sendVoiceChunk(base64, actualMime);
                    } catch (e) {
                        console.error('[PTT] Encode voice message failed:', e);
                    }
                }
            };

            // Collect slices during speech
            this.mediaRecorder.start(100);

            // Immediately broadcast visual speaking state to all users
            if (this.ws) {
                this.ws.sendVoiceState(true);
            }

            // Show self speaking indicator
            this.activeSpeakers.set(this.user.nickname, {
                emoji: this.user.emoji || '🎧',
                time: Date.now()
            });
            this.updateSpeakerIndicator();

            // Auto cutoff after 15 seconds
            if (this.maxSpeechTimeout) clearTimeout(this.maxSpeechTimeout);
            this.maxSpeechTimeout = setTimeout(() => {
                if (this.isSpeaking) {
                    this.stopSpeaking();
                }
            }, 15000);

        } catch (err) {
            console.warn('[PTT] Mic access error:', err);
            this.stopSpeaking();
            if (this.checkInsecureContext()) {
                this.showInsecureContextGuide();
            } else if (window.showToast) {
                window.showToast('Gagal mengakses mikrofon. Pastikan izin mic telah diberikan!', 'error');
            }
        }
    }

    stopSpeaking() {
        if (!this.isSpeaking) return;
        this.isSpeaking = false;

        if (this.maxSpeechTimeout) {
            clearTimeout(this.maxSpeechTimeout);
            this.maxSpeechTimeout = null;
        }

        this.updateButtonUI(false);

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try {
                this.mediaRecorder.stop();
            } catch (e) {}
        }
        this.mediaRecorder = null;

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        if (this.ws) {
            this.ws.sendVoiceState(false);
        }

        if (this.user) {
            this.activeSpeakers.delete(this.user.nickname);
        }
        this.updateSpeakerIndicator();
    }

    playVoiceChunk(data) {
        try {
            const audio = new Audio(data.audio);
            audio.volume = 1.0;

            const playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise.catch(err => {
                    console.warn('[PTT] Playback blocked or failed:', err);
                });
            }

            // Show active speaker indicator while audio is playing
            this.activeSpeakers.set(data.sender_nickname, {
                emoji: data.sender_emoji || '🎧',
                time: Date.now()
            });
            this.updateSpeakerIndicator();

            audio.onended = () => {
                this.activeSpeakers.delete(data.sender_nickname);
                this.updateSpeakerIndicator();
            };

            // Fallback timeout to clear indicator
            setTimeout(() => {
                if (this.activeSpeakers.has(data.sender_nickname)) {
                    this.activeSpeakers.delete(data.sender_nickname);
                    this.updateSpeakerIndicator();
                }
            }, 12000);

        } catch (e) {
            console.warn('[PTT] Failed to play voice:', e);
        }
    }

    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    renderPTTButton() {
        const slot = document.getElementById('room-ptt-slot');
        if (!slot) return;

        slot.innerHTML = `
            <button type="button" id="btn-push-to-talk" class="btn-ptt" title="Tahan tombol ini atau tahan tombol [V] di keyboard untuk berbicara">
                <span class="ptt-icon">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                        <line x1="12" y1="19" x2="12" y2="23"></line>
                        <line x1="8" y1="23" x2="16" y2="23"></line>
                    </svg>
                </span>
                <span class="ptt-text">Tahan Bicara <kbd>V</kbd></span>
                <span class="ptt-waves">
                    <span></span><span></span><span></span>
                </span>
            </button>
        `;

        const btn = slot.querySelector('#btn-push-to-talk');
        if (!btn) return;

        // Mouse events
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.startSpeaking();
        });
        btn.addEventListener('mouseup', () => this.stopSpeaking());
        btn.addEventListener('mouseleave', () => this.stopSpeaking());

        // Touch events for Mobile
        btn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.startSpeaking();
        }, { passive: false });
        btn.addEventListener('touchend', () => this.stopSpeaking());
        btn.addEventListener('touchcancel', () => this.stopSpeaking());
    }

    updateButtonUI(isActive) {
        const btn = document.getElementById('btn-push-to-talk');
        if (!btn) return;

        if (isActive) {
            btn.classList.add('active');
            const text = btn.querySelector('.ptt-text');
            if (text) text.innerHTML = '<strong>Sedang Bicara...</strong>';
        } else {
            btn.classList.remove('active');
            const text = btn.querySelector('.ptt-text');
            if (text) text.innerHTML = 'Tahan Bicara <kbd>V</kbd>';
        }
    }

    updateSpeakerIndicator() {
        const container = document.getElementById('room-active-speakers-bar');
        if (!container) return;

        if (this.activeSpeakers.size === 0) {
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }

        container.style.display = 'flex';
        const speakerNames = [];
        for (const [nick, info] of this.activeSpeakers.entries()) {
            speakerNames.push(`<span class="speaker-pill"><span class="speaker-pulse"></span> ${info.emoji} ${escapeHtml(nick)}</span>`);
        }

        container.innerHTML = `
            <div class="active-speakers-label">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                </svg>
                <span>Berbicara:</span>
            </div>
            <div class="active-speakers-list">${speakerNames.join('')}</div>
        `;
    }
}

window.JamriVoicePTT = JamriVoicePTT;
