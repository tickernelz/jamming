/**
 * voice-ptt.js
 * Real-Time Push-to-Talk (PTT) Engine for Jamri Jamming Rooms
 * Dual-Channel System:
 * 1. General PTT (Talking channel): ducks background music, heard by everyone except karaoke listeners
 * 2. Karaoke PTT (Singing channel): dedicated to lyrics menu/modal, does NOT duck music, only heard by users in karaoke mode
 * Mobile-compatible audio playback with unlocked AudioContext and clean human UI
 */

class JamriVoicePTT {
    constructor() {
        this.roomId = null;
        this.user = null;
        this.ws = null;
        this.isSpeaking = false;
        this.currentChannel = null; // 'general' | 'karaoke'
        this.mediaStream = null;
        this.micSource = null;
        this.micProcessor = null;
        this.silentGain = null;
        this.chunkSeq = 0;

        // Channel-separated active speakers
        this.generalSpeakers = new Map(); // nickname -> { emoji, time }
        this.karaokeSpeakers = new Map(); // nickname -> { emoji, time }
        this.generalFadeTimers = new Map();
        this.karaokeFadeTimers = new Map();

        this.isKeyHeld = false;
        this.maxSpeechTimeout = null;
        this.karaokeButtons = new Set();

        // Audio Context & Playback
        this.audioCtx = null;
        this.playbackAudio = null;
        this.audioUnlocked = false;
        this.originalMusicVolume = null;
        this.nextPlayTime = 0;

        this.initMobileAudioUnlocker();
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
        this.generalSpeakers.clear();
        this.karaokeSpeakers.clear();
        this.updateSpeakerIndicator();
        this.updateKaraokeSpeakerIndicator();
        this.restoreMusic();
    }

    isKaraokeActive() {
        if (!window.JAMRI_APP) return false;
        // 1. Check if lyrics modal is open
        if (window.JAMRI_APP.lyrics && window.JAMRI_APP.lyrics.isOpen) {
            return true;
        }
        // 2. Check if user is in room view and viewing room-lyrics tab
        if (window.JAMRI_APP.currentView === 'room') {
            const lyricsPanel = document.getElementById('room-lyrics-tab-panel');
            if (lyricsPanel && lyricsPanel.style.display !== 'none') {
                return true;
            }
        }
        // 3. Check if user is in solo view and viewing solo-lyrics tab
        if (window.JAMRI_APP.currentView === 'solo') {
            const soloPanel = document.getElementById('solo-lyrics-panel');
            if (soloPanel && soloPanel.style.display !== 'none') {
                return true;
            }
        }
        return false;
    }

    initMobileAudioUnlocker() {
        const unlock = () => {
            if (this.audioUnlocked) return;
            try {
                this.ensureAudioContext();
                if (this.audioCtx && this.audioCtx.state === 'suspended') {
                    this.audioCtx.resume();
                }

                if (!this.playbackAudio) {
                    this.playbackAudio = document.createElement('audio');
                    this.playbackAudio.id = 'jamri-ptt-playback';
                    this.playbackAudio.style.display = 'none';
                    // Silent 1-sample WAV to bless the element for iOS/Android
                    this.playbackAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
                    document.body.appendChild(this.playbackAudio);

                    const p = this.playbackAudio.play();
                    if (p !== undefined) {
                        p.then(() => {
                            this.audioUnlocked = true;
                        }).catch(() => {});
                    }
                } else {
                    this.audioUnlocked = true;
                }
            } catch (e) {}
        };

        window.addEventListener('touchstart', unlock, { passive: true });
        window.addEventListener('touchend', unlock, { passive: true });
        window.addEventListener('click', unlock, { passive: true });
    }

    ensureAudioContext() {
        if (!this.audioCtx) {
            const AudioClass = window.AudioContext || window.webkitAudioContext;
            if (AudioClass) {
                this.audioCtx = new AudioClass();
            }
        }
        return this.audioCtx;
    }

    checkInsecureContext() {
        const hostname = window.location.hostname;
        const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
        return (!window.isSecureContext && !isLocal);
    }

    showInsecureContextGuide() {
        let existing = document.querySelector('.jamri-insecure-guide-backdrop');
        if (existing) return;

        const guideModal = document.createElement('div');
        guideModal.className = 'jamri-insecure-guide-backdrop';
        guideModal.style.cssText = 'position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,0.65); display:flex; align-items:center; justify-content:center; padding:16px; backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);';
        guideModal.innerHTML = `
            <div style="background:var(--bg-surface); border:1px solid var(--border-color); border-radius:var(--radius-lg); max-width:440px; width:100%; padding:20px; box-shadow:var(--shadow-lg); color:var(--text-primary); font-family:inherit;">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
                    <div style="width:32px; height:32px; border-radius:var(--radius-sm); background:var(--primary-light); display:flex; align-items:center; justify-content:center; color:var(--primary);">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                            <line x1="12" y1="19" x2="12" y2="23"></line>
                            <line x1="8" y1="23" x2="16" y2="23"></line>
                        </svg>
                    </div>
                    <div>
                        <h3 style="margin:0; font-size:15px; font-weight:700; color:var(--text-primary);">Izin Mikrofon Diperlukan</h3>
                        <p style="margin:0; font-size:12px; color:var(--text-muted);">Akses Mic di Jaringan Tunnel / Lokal</p>
                    </div>
                </div>
                <div style="font-size:13px; line-height:1.5; color:var(--text-secondary); margin-bottom:16px;">
                    Browser membatasi mikrofon pada koneksi HTTP non-localhost. Untuk menggunakan Push-to-Talk via HP, silakan akses melalui URL HTTPS Ngrok atau berikan izin mikrofon pada browser Anda.
                </div>
                <button type="button" id="btn-close-insecure-guide" class="btn btn-primary" style="width:100%; padding:10px 0; border-radius:var(--radius-sm); font-size:13px; font-weight:600;">
                    Saya Mengerti
                </button>
            </div>
        `;
        document.body.appendChild(guideModal);
        guideModal.querySelector('#btn-close-insecure-guide').addEventListener('click', () => {
            guideModal.remove();
        });
    }

    initKeyListeners() {
        window.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 'v' && !this.isKeyHeld) {
                const target = e.target;
                if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                    return;
                }
                this.isKeyHeld = true;
                // If user is currently in karaoke mode (lyrics tab or modal), use karaoke channel!
                const ch = this.isKaraokeActive() ? 'karaoke' : 'general';
                this.startSpeaking(ch);
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.key.toLowerCase() === 'v' && this.isKeyHeld) {
                this.isKeyHeld = false;
                this.stopSpeaking();
            }
        });
    }

    setupWebSocketListeners() {
        if (!this.ws) return;

        this.ws.on('voice_chunk', (data) => {
            if (!data.audio) return;
            this.playVoiceChunk(data);
        });

        this.ws.on('voice_state', (data) => {
            const nickname = data.sender_nickname;
            if (!nickname) return;
            const channel = data.channel || 'general';
            const inKaraoke = this.isKaraokeActive();

            if (channel === 'karaoke') {
                // Karaoke channel: ONLY heard & seen by users currently in karaoke mode
                if (!inKaraoke) return;

                if (data.speaking) {
                    this.karaokeSpeakers.set(nickname, {
                        emoji: data.sender_emoji || '',
                        time: Date.now()
                    });
                } else {
                    if (this.karaokeFadeTimers.has(nickname)) {
                        clearTimeout(this.karaokeFadeTimers.get(nickname));
                    }
                    this.karaokeFadeTimers.set(nickname, setTimeout(() => {
                        this.karaokeSpeakers.delete(nickname);
                        this.updateKaraokeSpeakerIndicator();
                    }, 350));
                }
                this.updateKaraokeSpeakerIndicator();
            } else {
                // General channel: ONLY heard & seen by users NOT in karaoke mode
                if (inKaraoke) return;

                if (data.speaking) {
                    this.generalSpeakers.set(nickname, {
                        emoji: data.sender_emoji || '',
                        time: Date.now()
                    });
                    this.duckMusic();
                } else {
                    if (this.generalFadeTimers.has(nickname)) {
                        clearTimeout(this.generalFadeTimers.get(nickname));
                    }
                    this.generalFadeTimers.set(nickname, setTimeout(() => {
                        this.generalSpeakers.delete(nickname);
                        this.updateSpeakerIndicator();
                        if (this.generalSpeakers.size === 0) {
                            this.restoreMusic();
                        }
                    }, 350));
                }
                this.updateSpeakerIndicator();
            }
        });
    }

    async startSpeaking(requestedChannel = null) {
        if (this.isSpeaking || !this.roomId) return;

        // Determine channel
        let channel = requestedChannel;
        if (!channel) {
            channel = this.isKaraokeActive() ? 'karaoke' : 'general';
        }

        // Strict guardrail: Karaoke PTT can only be used when in lyrics / karaoke menu
        if (channel === 'karaoke' && !this.isKaraokeActive()) {
            if (window.showToast) {
                window.showToast('PTT Karaoke hanya dapat digunakan saat berada di menu lirik/karaoke.', 'warning');
            }
            return;
        }

        if (this.checkInsecureContext() && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) {
            this.showInsecureContextGuide();
            return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            if (window.showToast) {
                window.showToast('Browser tidak mendukung akses mikrofon pada koneksi ini.', 'error');
            }
            return;
        }

        this.isSpeaking = true;
        this.currentChannel = channel;
        this.chunkSeq = 0;
        this.updateButtonUI(true, channel);

        try {
            this.ensureAudioContext();
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                await this.audioCtx.resume();
            }

            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            if (this.ws) {
                this.ws.sendVoiceState(true, channel);
            }

            if (channel === 'karaoke') {
                this.karaokeSpeakers.set(this.user.nickname, {
                    emoji: this.user.emoji || '',
                    time: Date.now()
                });
                this.updateKaraokeSpeakerIndicator();
                // NO DUCKING FOR KARAOKE! Music continues at full volume!
            } else {
                this.generalSpeakers.set(this.user.nickname, {
                    emoji: this.user.emoji || '',
                    time: Date.now()
                });
                this.updateSpeakerIndicator();
                this.duckMusic();
            }

            // Real-time Audio Processor (Low latency streaming)
            this.micSource = this.audioCtx.createMediaStreamSource(this.mediaStream);
            const bufferSize = 2048; // ~128ms per chunk at 16kHz
            this.micProcessor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);

            const inputSampleRate = this.audioCtx.sampleRate;
            const targetSampleRate = 16000;

            this.micProcessor.onaudioprocess = (e) => {
                if (!this.isSpeaking) return;
                const inputData = e.inputBuffer.getChannelData(0);

                // Downsample to 16kHz for lean, fast streaming
                const downsampled = this.downsampleBuffer(inputData, inputSampleRate, targetSampleRate);
                const pcm16 = this.floatToInt16(downsampled);
                const base64 = this.pcmToBase64(pcm16);

                if (this.ws && base64.length > 0) {
                    this.ws.sendVoiceChunk(base64, 'pcm16', targetSampleRate, this.chunkSeq++, this.currentChannel);
                }
            };

            // Connect mic to processor, and processor to silent gain to keep audio pump running
            this.silentGain = this.audioCtx.createGain();
            this.silentGain.gain.value = 0;
            this.micSource.connect(this.micProcessor);
            this.micProcessor.connect(this.silentGain);
            this.silentGain.connect(this.audioCtx.destination);

            if (this.maxSpeechTimeout) clearTimeout(this.maxSpeechTimeout);
            this.maxSpeechTimeout = setTimeout(() => {
                if (this.isSpeaking) {
                    this.stopSpeaking();
                }
            }, 30000); // 30 seconds limit

        } catch (err) {
            console.warn('[PTT] Mic access error:', err);
            this.stopSpeaking();
            if (this.checkInsecureContext()) {
                this.showInsecureContextGuide();
            } else if (window.showToast) {
                window.showToast('Gagal mengakses mikrofon. Pastikan izin mic telah diberikan.', 'error');
            }
        }
    }

    stopSpeaking() {
        if (!this.isSpeaking) return;
        this.isSpeaking = false;
        const channel = this.currentChannel;

        if (this.maxSpeechTimeout) {
            clearTimeout(this.maxSpeechTimeout);
            this.maxSpeechTimeout = null;
        }

        this.updateButtonUI(false, channel);

        if (this.micProcessor) {
            try {
                this.micProcessor.disconnect();
            } catch (e) {}
            this.micProcessor = null;
        }

        if (this.silentGain) {
            try {
                this.silentGain.disconnect();
            } catch (e) {}
            this.silentGain = null;
        }

        if (this.micSource) {
            try {
                this.micSource.disconnect();
            } catch (e) {}
            this.micSource = null;
        }

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        if (this.ws) {
            this.ws.sendVoiceState(false, channel || 'general');
        }

        if (this.user) {
            if (channel === 'karaoke') {
                this.karaokeSpeakers.delete(this.user.nickname);
                this.updateKaraokeSpeakerIndicator();
            } else {
                this.generalSpeakers.delete(this.user.nickname);
                this.updateSpeakerIndicator();
                if (this.generalSpeakers.size === 0) {
                    this.restoreMusic();
                }
            }
        }

        this.currentChannel = null;
    }

    duckMusic() {
        try {
            if (window.JAMRI_APP && window.JAMRI_APP.player && window.JAMRI_APP.player.isPlaying) {
                const pl = window.JAMRI_APP.player;
                if (this.originalMusicVolume === null) {
                    this.originalMusicVolume = pl.volume !== undefined ? pl.volume : 0.8;
                }
                pl.setVolume(Math.max(0.1, this.originalMusicVolume * 0.25));
            }
        } catch (e) {}
    }

    restoreMusic() {
        try {
            if (window.JAMRI_APP && window.JAMRI_APP.player && this.originalMusicVolume !== null) {
                window.JAMRI_APP.player.setVolume(this.originalMusicVolume);
                this.originalMusicVolume = null;
            }
        } catch (e) {}
    }

    async playVoiceChunk(data) {
        if (!data || !data.audio) return;
        const channel = data.channel || 'general';
        const inKaraoke = this.isKaraokeActive();

        // 1. Channel Separation Filtering
        if (channel === 'karaoke') {
            // Karaoke channel: ONLY heard by users currently in karaoke mode
            if (!inKaraoke) return;

            // NO DUCKING for karaoke: real karaoke singing experience over full music!
            this.karaokeSpeakers.set(data.sender_nickname, {
                emoji: data.sender_emoji || '',
                time: Date.now()
            });
            this.updateKaraokeSpeakerIndicator();
        } else {
            // General channel: ONLY heard by users NOT in karaoke mode
            if (inKaraoke) return;

            // Duck background music for general speech clarity
            this.duckMusic();
            this.generalSpeakers.set(data.sender_nickname, {
                emoji: data.sender_emoji || '',
                time: Date.now()
            });
            this.updateSpeakerIndicator();
        }

        this.ensureAudioContext();
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            try { await this.audioCtx.resume(); } catch (e) {}
        }

        // Live Real-Time PCM16 Stream Playback (Discord Style)
        if (data.mime === 'pcm16' || !data.mime || data.mime === 'audio/pcm') {
            try {
                const float32 = this.base64ToFloat32(data.audio);
                const sampleRate = data.sample_rate || 16000;
                const buffer = this.audioCtx.createBuffer(1, float32.length, sampleRate);
                buffer.getChannelData(0).set(float32);

                const source = this.audioCtx.createBufferSource();
                source.buffer = buffer;
                source.connect(this.audioCtx.destination);

                const now = this.audioCtx.currentTime;
                // Maintain smooth continuous playhead with 20ms jitter margin
                if (!this.nextPlayTime || this.nextPlayTime < now || (this.nextPlayTime - now) > 0.4) {
                    this.nextPlayTime = now + 0.02;
                }
                source.start(this.nextPlayTime);
                this.nextPlayTime += buffer.duration;

                if (channel === 'karaoke') {
                    if (this.karaokeFadeTimers.has(data.sender_nickname)) {
                        clearTimeout(this.karaokeFadeTimers.get(data.sender_nickname));
                    }
                    this.karaokeFadeTimers.set(data.sender_nickname, setTimeout(() => {
                        this.karaokeSpeakers.delete(data.sender_nickname);
                        this.updateKaraokeSpeakerIndicator();
                    }, 500));
                } else {
                    if (this.generalFadeTimers.has(data.sender_nickname)) {
                        clearTimeout(this.generalFadeTimers.get(data.sender_nickname));
                    }
                    this.generalFadeTimers.set(data.sender_nickname, setTimeout(() => {
                        this.generalSpeakers.delete(data.sender_nickname);
                        this.updateSpeakerIndicator();
                        if (this.generalSpeakers.size === 0) {
                            this.restoreMusic();
                        }
                    }, 500));
                }
                return;
            } catch (err) {
                console.warn('[PTT] PCM stream decode failed:', err);
            }
        }

        // Fallback for full blob audio
        this.playViaAudioElementOrWebAudio(data, channel);
    }

    async playViaAudioElementOrWebAudio(data, channel = 'general') {
        const onFinished = () => {
            if (channel === 'karaoke') {
                this.karaokeSpeakers.delete(data.sender_nickname);
                this.updateKaraokeSpeakerIndicator();
            } else {
                this.generalSpeakers.delete(data.sender_nickname);
                this.updateSpeakerIndicator();
                if (this.generalSpeakers.size === 0) {
                    this.restoreMusic();
                }
            }
        };

        let played = false;
        try {
            const audioEl = this.playbackAudio || new Audio();
            audioEl.src = data.audio;
            audioEl.volume = 1.0;
            audioEl.onended = onFinished;
            audioEl.onerror = () => {
                if (!played) this.playViaWebAudio(data.audio, onFinished);
            };

            const p = audioEl.play();
            if (p !== undefined) {
                p.then(() => { played = true; }).catch(() => {
                    this.playViaWebAudio(data.audio, onFinished);
                });
            } else {
                played = true;
            }
        } catch (e) {
            this.playViaWebAudio(data.audio, onFinished);
        }
    }

    async playViaWebAudio(dataUri, onFinished) {
        try {
            this.ensureAudioContext();
            if (!this.audioCtx) return;

            if (this.audioCtx.state === 'suspended') {
                await this.audioCtx.resume();
            }

            const resp = await fetch(dataUri);
            const arrayBuffer = await resp.arrayBuffer();
            const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);

            const source = this.audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.audioCtx.destination);
            source.onended = onFinished;
            source.start(0);
        } catch (err) {
            console.warn('[PTT] WebAudio decode failed:', err);
            onFinished();
        }
    }

    // Audio Conversion & DSP Helpers for Real-Time Streaming
    downsampleBuffer(buffer, inputRate, outputRate) {
        if (outputRate === inputRate) return buffer;
        const ratio = inputRate / outputRate;
        const newLength = Math.round(buffer.length / ratio);
        const result = new Float32Array(newLength);
        let offsetResult = 0;
        let offsetBuffer = 0;
        while (offsetResult < result.length) {
            const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
            let accum = 0, count = 0;
            for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
                accum += buffer[i];
                count++;
            }
            result[offsetResult] = count > 0 ? accum / count : buffer[offsetBuffer];
            offsetResult++;
            offsetBuffer = nextOffsetBuffer;
        }
        return result;
    }

    floatToInt16(floatArr) {
        const pcm16 = new Int16Array(floatArr.length);
        for (let i = 0; i < floatArr.length; i++) {
            const s = Math.max(-1, Math.min(1, floatArr[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16;
    }

    pcmToBase64(int16Array) {
        let binary = '';
        const bytes = new Uint8Array(int16Array.buffer, int16Array.byteOffset, int16Array.byteLength);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    base64ToFloat32(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        const pcm16 = new Int16Array(bytes.buffer);
        const float32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) {
            float32[i] = pcm16[i] < 0 ? pcm16[i] / 0x8000 : pcm16[i] / 0x7FFF;
        }
        return float32;
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
            <button type="button" id="btn-push-to-talk" class="btn-ptt" title="Tahan tombol ini atau tombol [V] di keyboard untuk berbicara umum">
                <span class="ptt-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                        <line x1="12" y1="19" x2="12" y2="23"></line>
                        <line x1="8" y1="23" x2="16" y2="23"></line>
                    </svg>
                </span>
                <span class="ptt-text">Bicara <kbd>V</kbd></span>
                <span class="ptt-waves">
                    <span></span><span></span><span></span>
                </span>
            </button>
        `;

        const btn = slot.querySelector('#btn-push-to-talk');
        if (!btn) return;

        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.startSpeaking('general');
        });
        btn.addEventListener('mouseup', () => this.stopSpeaking());
        btn.addEventListener('mouseleave', () => this.stopSpeaking());

        btn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.startSpeaking('general');
        }, { passive: false });
        btn.addEventListener('touchend', () => this.stopSpeaking());
        btn.addEventListener('touchcancel', () => this.stopSpeaking());
    }

    bindKaraokePTTButton(btn) {
        if (!btn) return;
        this.karaokeButtons.add(btn);

        const start = (e) => {
            e.preventDefault();
            this.startSpeaking('karaoke');
        };

        const stop = () => {
            if (this.isSpeaking && this.currentChannel === 'karaoke') {
                this.stopSpeaking();
            }
        };

        btn.addEventListener('mousedown', start);
        btn.addEventListener('mouseup', stop);
        btn.addEventListener('mouseleave', stop);

        btn.addEventListener('touchstart', start, { passive: false });
        btn.addEventListener('touchend', stop);
        btn.addEventListener('touchcancel', stop);
    }

    updateButtonUI(isActive, channel = 'general') {
        const generalBtn = document.getElementById('btn-push-to-talk');
        if (generalBtn) {
            if (isActive && channel === 'general') {
                generalBtn.classList.add('active');
                const text = generalBtn.querySelector('.ptt-text');
                if (text) text.innerHTML = '<strong>Bicara...</strong>';
            } else {
                generalBtn.classList.remove('active');
                const text = generalBtn.querySelector('.ptt-text');
                if (text) text.innerHTML = 'Bicara <kbd>V</kbd>';
            }
        }

        // Update all karaoke PTT buttons
        document.querySelectorAll('.btn-karaoke-ptt').forEach(btn => {
            if (isActive && channel === 'karaoke') {
                btn.classList.add('active');
                const text = btn.querySelector('.ptt-text');
                if (text) text.innerHTML = '<strong>Bernyanyi...</strong>';
            } else {
                btn.classList.remove('active');
                const text = btn.querySelector('.ptt-text');
                if (text) text.innerHTML = 'PTT Karaoke <kbd>V</kbd>';
            }
        });
    }

    updateSpeakerIndicator() {
        const container = document.getElementById('room-active-speakers-bar');
        if (!container) return;

        if (this.generalSpeakers.size === 0) {
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }

        container.style.display = 'flex';
        const speakerNames = [];
        for (const [nick, info] of this.generalSpeakers.entries()) {
            speakerNames.push(`
                <span class="speaker-pill" style="display:inline-flex; align-items:center; gap:6px; background:rgba(16,185,129,0.15); border:1px solid rgba(16,185,129,0.35); border-radius:16px; padding:3px 10px; font-size:12px; color:var(--text-primary);">
                    <span class="speaker-pulse" style="width:6px; height:6px; border-radius:50%; background:#10b981;"></span>
                    <span>${escapeHtml(nick)}</span>
                </span>
            `);
        }

        container.innerHTML = `
            <div class="active-speakers-label" style="display:flex; align-items:center; gap:6px; font-size:12px; color:#10b981;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                </svg>
                <span>Berbicara:</span>
            </div>
            <div class="active-speakers-list" style="display:flex; gap:6px; flex-wrap:wrap;">${speakerNames.join('')}</div>
        `;
    }

    updateKaraokeSpeakerIndicator() {
        const containers = document.querySelectorAll('.karaoke-active-singers-bar');
        if (!containers.length) return;

        if (this.karaokeSpeakers.size === 0) {
            containers.forEach(c => {
                c.style.display = 'none';
                c.innerHTML = '';
            });
            return;
        }

        const singerPills = [];
        for (const [nick, info] of this.karaokeSpeakers.entries()) {
            singerPills.push(`
                <span class="speaker-pill" style="display:inline-flex; align-items:center; gap:6px; background:rgba(236,72,153,0.18); border:1px solid rgba(236,72,153,0.4); border-radius:16px; padding:3px 10px; font-size:12px; color:var(--text-primary);">
                    <span class="speaker-pulse" style="width:6px; height:6px; border-radius:50%; background:#ec4899; box-shadow:0 0 8px #ec4899;"></span>
                    <span>${escapeHtml(nick)}</span>
                </span>
            `);
        }

        const html = `
            <div class="active-speakers-label" style="display:flex; align-items:center; gap:5px; font-size:12px; font-weight:700; color:#ec4899;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M9 18V5l12-2v13"></path>
                    <circle cx="6" cy="18" r="3"></circle>
                    <circle cx="18" cy="16" r="3"></circle>
                </svg>
                <span>Karaoke:</span>
            </div>
            <div class="active-speakers-list" style="display:flex; gap:6px; flex-wrap:wrap;">
                ${singerPills.join('')}
            </div>
        `;

        containers.forEach(c => {
            c.style.display = 'flex';
            c.innerHTML = html;
        });
    }
}

window.JamriVoicePTT = JamriVoicePTT;
