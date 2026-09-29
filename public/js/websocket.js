/**
 * websocket.js
 * Client wrapper untuk koneksi real-time jamming room ke PHP Ratchet Daemon
 */

class JamriWebSocket {
    constructor() {
        this.ws = null;
        this.roomId = null;
        this.user = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.reconnectTimeout = null;
        this.listeners = {};
        this._setupVisibilityListeners();
    }

    _setupVisibilityListeners() {
        if (typeof document !== 'undefined' && !this._visibilityBound) {
            this._visibilityBound = true;
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && !this.isConnected && this.roomId && this.user) {
                    console.log('[Jamri WS] Tab active, reconnecting immediately...');
                    this.attemptReconnect(true);
                }
            });
            window.addEventListener('online', () => {
                if (!this.isConnected && this.roomId && this.user) {
                    console.log('[Jamri WS] Network restored, reconnecting immediately...');
                    this.attemptReconnect(true);
                }
            });
        }
    }

    connect(roomId, user) {
        this.roomId = roomId;
        this.user = user;

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        const isHttps = window.location.protocol === 'https:';
        const protocol = isHttps ? 'wss:' : 'ws:';
        let endpoint;
        if (isHttps) {
            // Through a tunnel (ngrok) the gateway proxies /ws to the daemon.
            endpoint = `${protocol}//${window.location.host}/ws`;
        } else if (window.location.port === '3000') {
            endpoint = `${protocol}//${window.location.host}/ws`;
        } else if (window.JAMRI_WS_URL) {
            endpoint = window.JAMRI_WS_URL;
        } else {
            // Local direct connection. Keep in sync with config/app.php ws_port.
            endpoint = `${protocol}//${window.location.hostname || 'localhost'}:8081/`;
        }

        const url = `${endpoint}?room_id=${encodeURIComponent(roomId)}&device_id=${encodeURIComponent(user.device_id)}&nickname=${encodeURIComponent(user.nickname)}&emoji=${encodeURIComponent(user.emoji)}`;

        try {
            if (this.ws) {
                try { this.ws.close(); } catch (e) {}
            }
            this.ws = new WebSocket(url);
        } catch (e) {
            console.error('WS Connection initiation error:', e);
            this.attemptReconnect();
            return;
        }

        this.ws.onopen = () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.emit('connection_change', { connected: true });

            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
                if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.send('ping');
                }
            }, 5000);
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.emit(data.type, data);
            } catch (err) {
                console.error('WS Parse Error:', err);
            }
        };

        this.ws.onclose = () => {
            this.isConnected = false;
            this.emit('connection_change', { connected: false });
            this.attemptReconnect();
        };

        this.ws.onerror = (err) => {
            console.error('WS Error:', err);
            this.emit('error', err);
        };
    }

    attemptReconnect(immediate = false) {
        if (!this.roomId || !this.user) return;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        this.reconnectAttempts++;
        const delay = immediate 
            ? 100 
            : (this.reconnectAttempts === 1 ? 500 : Math.min(3000, 800 * Math.pow(1.25, Math.min(this.reconnectAttempts, 6))));

        this.reconnectTimeout = setTimeout(() => {
            if (!this.isConnected && this.roomId && this.user) {
                this.connect(this.roomId, this.user);
            }
        }, delay);
    }

    send(type, payload = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        this.ws.send(JSON.stringify({ type, ...payload }));
        return true;
    }

    // Playback events
    sendPlay(position) {
        this.send('play', { position });
    }

    sendPause() {
        this.send('pause');
    }

    sendSeek(position) {
        this.send('seek', { position });
    }

    sendNext() {
        this.send('next');
    }

    sendPrev() {
        this.send('prev');
    }

    sendSetTrack(track) {
        this.send('set_track', { track });
    }

    sendTrackEnded() {
        this.send('track_ended');
    }

    sendSetLoop(mode) {
        this.send('set_loop', { mode });
    }

    // Queue events
    sendQueueAdd(track) {
        this.send('queue_add', { track });
    }

    sendQueueRemove(queueId) {
        this.send('queue_remove', { queue_id: queueId });
    }

    sendQueueShuffle() {
        this.send('queue_shuffle');
    }

    sendQueueReorder(orderedIds) {
        this.send('queue_reorder', { ordered_ids: orderedIds });
    }

    // Playlist (Bank Musik) events
    sendPlaylistAdd(track) {
        this.send('playlist_add', { track });
    }

    sendPlaylistAddBulk(tracks) {
        this.send('playlist_add', { tracks });
    }

    sendPlaylistRemove(playlistId) {
        this.send('playlist_remove', { playlist_id: playlistId });
    }

    // Chat
    sendChatMessage(message) {
        this.send('chat', { message });
    }

    // Soundboard
    sendSoundboardPlay(sound) {
        this.send('soundboard_play', {
            sound_id: sound.id || sound.sound_id || '',
            title: sound.title || 'Soundboard',
            emoji: sound.emoji || '🔊',
            audio: sound.audio || '',
            file_url: sound.file_url || ''
        });
    }

    // Push to Talk (Voice: General vs Karaoke)
    sendVoiceChunk(audioBase64, mime = 'pcm16', sampleRate = 16000, seq = 0, channel = 'general') {
        this.send('voice_chunk', { audio: audioBase64, mime, sample_rate: sampleRate, seq, channel });
    }

    sendVoiceState(isSpeaking, channel = 'general') {
        this.send('voice_state', { speaking: !!isSpeaking, channel });
    }

    sendKaraokeMuteToggle(muted) {
        this.send('karaoke_mute_toggle', { muted: !!muted });
    }

    sendGameStart(gameType, penaltyMinutes = 2, options = {}) {
        return this.send('game_start', {
            game_type: gameType,
            penalty_minutes: parseInt(penaltyMinutes, 10) || 2,
            options: options
        });
    }

    sendPunishmentClear(deviceId) {
        this.send('punishment_clear', {
            device_id: deviceId
        });
    }

    disconnect() {
        this.roomId = null;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
            this.ws = null;
        }
        this.isConnected = false;
        this.listeners = {};
    }

    // Event listener system
    on(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    }

    off(event, callback) {
        if (!this.listeners[event]) return;
        this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }

    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => cb(data));
        }
    }
}

window.JamriWebSocket = JamriWebSocket;
