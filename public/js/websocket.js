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
        this.maxReconnectAttempts = 10;
        this.listeners = {};
    }

    connect(roomId, user) {
        this.roomId = roomId;
        this.user = user;

        const isHttps = window.location.protocol === 'https:';
        const host = window.location.hostname || 'localhost';
        const protocol = isHttps ? 'wss:' : 'ws:';
        // Di production (HTTPS) gunakan proxy path /ws tanpa port 8080
        const endpoint = isHttps ? `${protocol}//${host}/ws` : `${protocol}//${host}:8080/`;
        const url = `${endpoint}?room_id=${encodeURIComponent(roomId)}&device_id=${encodeURIComponent(user.device_id)}&nickname=${encodeURIComponent(user.nickname)}&emoji=${encodeURIComponent(user.emoji)}`;

        this.ws = new WebSocket(url);

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

    attemptReconnect() {
        if (!this.roomId || !this.user) return;
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(10000, 1500 * Math.pow(1.5, this.reconnectAttempts));
            setTimeout(() => {
                if (!this.isConnected) {
                    this.connect(this.roomId, this.user);
                }
            }, delay);
        }
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

    // Playlist (Bank Musik) events
    sendPlaylistAdd(track) {
        this.send('playlist_add', { track });
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
            file_url: sound.file_url || ''
        });
    }

    sendSoundboardAdd(soundboard) {
        this.send('soundboard_add', { soundboard });
    }

    sendSoundboardDelete(soundboardId) {
        this.send('soundboard_delete', { soundboard_id: soundboardId });
    }

    // Push to Talk (Voice)
    sendVoiceChunk(audioBase64, mime = 'audio/webm') {
        this.send('voice_chunk', { audio: audioBase64, mime });
    }

    sendVoiceState(isSpeaking) {
        this.send('voice_state', { speaking: !!isSpeaking });
    }

    disconnect() {
        this.roomId = null;
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
