/**
 * voice-ptt.js
 * Real-Time Push-to-Talk (PTT) Engine for Jamri Jamming Rooms
 * Low-latency audio streaming over WebSocket with visual speaking indicators
 */

class JamriVoicePTT {
    constructor() {
        this.roomId = null;
        this.user = null;
        this.ws = null;
        this.isSpeaking = false;
        this.mediaStream = null;
        this.mediaRecorder = null;
        this.activeSpeakers = new Map(); // nickname -> timestamp
        this.speakerTimer = null;
        this.isKeyHeld = false;

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

        // Receiving real-time voice chunk from another user
        this.ws.on('voice_chunk', (data) => {
            if (!data.audio) return;
            this.playVoiceChunk(data);
        });

        // Receiving speaker state change
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
        this.isSpeaking = true;

        this.updateButtonUI(true);

        try {
            // Request microphone access
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            // Determine best supported audio mime type
            let mimeType = 'audio/webm;codecs=opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                if (MediaRecorder.isTypeSupported('audio/mp4')) {
                    mimeType = 'audio/mp4';
                } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
                    mimeType = 'audio/ogg';
                } else {
                    mimeType = '';
                }
            }

            const options = mimeType ? { mimeType } : {};
            this.mediaRecorder = new MediaRecorder(this.mediaStream, options);

            this.mediaRecorder.ondataavailable = async (event) => {
                if (event.data && event.data.size > 0 && this.ws && this.isSpeaking) {
                    const base64 = await this.blobToBase64(event.data);
                    this.ws.sendVoiceChunk(base64, this.mediaRecorder.mimeType);
                }
            };

            // Start sending in 250ms chunks for near real-time transmission
            this.mediaRecorder.start(250);

            // Notify room that this user is speaking
            if (this.ws) {
                this.ws.sendVoiceState(true);
            }

            // Show self speaking indicator
            this.activeSpeakers.set(this.user.nickname, {
                emoji: this.user.emoji || '🎧',
                time: Date.now()
            });
            this.updateSpeakerIndicator();

        } catch (err) {
            console.warn('[PTT] Mic access error:', err);
            this.stopSpeaking();
            if (window.showToast) {
                window.showToast('Gagal mengakses mikrofon. Pastikan izin mic diizinkan!', 'error');
            }
        }
    }

    stopSpeaking() {
        if (!this.isSpeaking) return;
        this.isSpeaking = false;

        this.updateButtonUI(false);

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try { this.mediaRecorder.stop(); } catch (e) {}
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
            // Duck volume slightly or play at normal speech volume
            audio.volume = 1.0;
            const playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise.catch(() => {});
            }

            // Refresh active speaker timeout
            this.activeSpeakers.set(data.sender_nickname, {
                emoji: data.sender_emoji || '🎧',
                time: Date.now()
            });
            this.updateSpeakerIndicator();

            if (!this.speakerTimer) {
                this.speakerTimer = setInterval(() => {
                    const now = Date.now();
                    let changed = false;
                    for (const [nick, info] of this.activeSpeakers.entries()) {
                        if (nick !== this.user.nickname && now - info.time > 1200) {
                            this.activeSpeakers.delete(nick);
                            changed = true;
                        }
                    }
                    if (changed) this.updateSpeakerIndicator();
                    if (this.activeSpeakers.size === 0) {
                        clearInterval(this.speakerTimer);
                        this.speakerTimer = null;
                    }
                }, 500);
            }
        } catch (e) {
            console.warn('[PTT] Failed to play chunk:', e);
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
