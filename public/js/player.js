/**
 * player.js
 * Robust Audio Engine with Hidden YouTube Bridge & HTML5 Offline Blob Audio
 * Shared-hosting compatible, zero .exe, zero server bandwidth
 */

class JamriPlayer {
    constructor() {
        this.mode = 'solo'; // 'solo' | 'jamming'
        this.ws = null;

        this.currentTrack = null;
        this.isPlaying = false;
        this.loopMode = 'off'; // 'off' | 'one' | 'all'
        
        // Persistent local-only volume
        const savedVol = localStorage.getItem('jamri_local_volume');
        this.volume = (savedVol !== null && !isNaN(parseFloat(savedVol))) ? Math.max(0, Math.min(1, parseFloat(savedVol))) : 0.8;
        this.preMuteVolume = this.volume > 0 ? this.volume : 0.8;

        // Preview state
        this.isPreviewing = false;
        this.previewTimer = null;

        // Local storage queues
        this.soloQueue = this.loadLocal('jamri_solo_queue', []);
        this.soloPlaylist = this.loadLocal('jamri_solo_playlist', []);
        this.history = [];
        this.isShuffled = false;
        this.originalSoloQueue = null;

        // Silent HTML5 audio loop to anchor Android/iOS background media service & lock screen controls
        this.silentAudio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
        this.silentAudio.loop = true;
        this.silentAudio.volume = 0.01;

        // Native HTML5 audio for offline .jamri blobs
        this.blobAudio = new Audio();
        this.blobAudio.preload = 'auto';
        this.blobAudio.volume = this.volume;

        // YouTube Player Bridge state
        this.ytPlayer = null;
        this.isYtReady = false;
        this.pendingTrack = null;

        this.setupBlobAudioListeners();
        this.setupMediaSession();
        this.initYouTubeBridge();
        this.startTicker();
    }

    setMode(mode, wsClient = null) {
        this.mode = mode;
        this.ws = wsClient;
    }

    initYouTubeBridge() {
        const createPlayer = () => {
            if (this.ytPlayer) return;
            const container = document.getElementById('jamri-yt-bridge');
            if (!container) return;

            try {
                this.ytPlayer = new window.YT.Player('jamri-yt-bridge', {
                    width: '240',
                    height: '140',
                    playerVars: {
                        autoplay: 1,
                        controls: 0,
                        disablekb: 1,
                        fs: 0,
                        modestbranding: 1,
                        playsinline: 1,
                        rel: 0,
                        enablejsapi: 1,
                        iv_load_policy: 3,
                        origin: window.location.origin,
                        widget_referrer: window.location.href
                    },
                    events: {
                        onReady: () => {
                            console.log('[JAMRI] YouTube Audio Bridge Ready');
                            this.isYtReady = true;
                            try {
                                const iframe = this.ytPlayer.getIframe();
                                if (iframe) {
                                    iframe.setAttribute('referrerpolicy', 'origin');
                                    iframe.setAttribute('allow', 'autoplay; encrypted-media');
                                }
                            } catch (e) {}

                            try {
                                if (this.volume === 0) {
                                    this.ytPlayer.mute();
                                } else {
                                    this.ytPlayer.unMute();
                                    this.ytPlayer.setVolume(this.volume * 100);
                                }
                            } catch (e) {}

                            if (this.pendingTrack) {
                                const pt = this.pendingTrack;
                                this.pendingTrack = null;
                                this.playTrack(pt.track, pt.startPos);
                            }
                        },
                        onStateChange: (e) => {
                            if (e.data === window.YT.PlayerState.PLAYING) {
                                this.isPlaying = true;
                                this.startSilentAudioAnchor();
                                if ('mediaSession' in navigator) {
                                    navigator.mediaSession.playbackState = 'playing';
                                }
                                this.emit('state_change', { isPlaying: true });
                            } else if (e.data === window.YT.PlayerState.PAUSED) {
                                // Jika tab sedang di-background di HP (document.hidden), browser mobile mem-pause iframe
                                // Jangan matikan status playback jika ini backgrounding otomatis
                                if (document.hidden && this.isPlaying) {
                                    console.log('[JAMRI] Background pause intercepted, keeping state alive');
                                    return;
                                }
                                this.isPlaying = false;
                                this.stopSilentAudioAnchor();
                                if ('mediaSession' in navigator) {
                                    navigator.mediaSession.playbackState = 'paused';
                                }
                                this.emit('state_change', { isPlaying: false });
                            } else if (e.data === window.YT.PlayerState.ENDED) {
                                this.handleTrackEnded();
                            }
                        },
                        onError: (err) => {
                            console.warn('[JAMRI] YouTube Bridge Error Code:', err.data);
                            if (this.isPreviewing) {
                                this.stopPreview();
                                return;
                            }
                            if (this.mode === 'jamming') {
                                // Di Jamming Room: JANGAN PERNAH panggil next() atau ubah lagu room!
                                // Biarkan user lain tetap menikmati lagu. User di perangkat ini tetap tersinkron dengan timeline jam server.
                                if (err.data === 101 || err.data === 150) {
                                    if (window.showToast) {
                                        window.showToast('Lagu ini dibatasi YouTube di perangkat Anda. Anda tetap mengikuti timeline room.', 'warning');
                                    }
                                }
                                return;
                            }
                            // Di Mode Solo: lakukan fallback alternatif atau next untuk diri sendiri
                            if (err.data === 101 || err.data === 150) {
                                this.handleRestrictedTrack(this.currentTrack);
                            } else {
                                this.next();
                            }
                        }
                    }
                });
            } catch (err) {
                console.error('[JAMRI] Failed to create YT.Player:', err);
            }
        };

        if (window.YT && window.YT.Player) {
            createPlayer();
        } else {
            const prevCallback = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = () => {
                if (typeof prevCallback === 'function') prevCallback();
                createPlayer();
            };

            // Polling fallback
            let attempts = 0;
            const pollInterval = setInterval(() => {
                attempts++;
                if (window.YT && window.YT.Player) {
                    clearInterval(pollInterval);
                    createPlayer();
                } else if (attempts > 30) {
                    clearInterval(pollInterval);
                }
            }, 300);
        }
    }

    setupBlobAudioListeners() {
        this.blobAudio.addEventListener('play', () => {
            this.isPlaying = true;
            this.emit('state_change', { isPlaying: true });
        });

        this.blobAudio.addEventListener('pause', () => {
            this.isPlaying = false;
            this.emit('state_change', { isPlaying: false });
        });

        this.blobAudio.addEventListener('ended', () => {
            this.handleTrackEnded();
        });
    }

    startTicker() {
        setInterval(() => {
            if (!this.currentTrack) return;

            let cur = 0;
            let dur = this.currentTrack.duration || 0;

            if (this.currentTrack.is_blob) {
                if (!this.isPlaying) return;
                cur = this.blobAudio.currentTime || 0;
                dur = this.blobAudio.duration || dur;
            } else {
                let ytCur = 0;
                let ytDur = 0;
                if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.getCurrentTime === 'function') {
                    try {
                        ytCur = this.ytPlayer.getCurrentTime() || 0;
                        ytDur = this.ytPlayer.getDuration() || 0;
                    } catch (e) {}
                }

                if (ytDur > 0) dur = ytDur;

                // Di mode jamming: timeline jam server tetap maju meskipun audio lokal dibatasi YouTube
                if (this.mode === 'jamming') {
                    if (this.serverPlaybackState === 'playing') {
                        if (this.isPlaying && ytCur > 0) {
                            cur = ytCur;
                        } else if (this.serverSyncTime) {
                            const elapsed = (Date.now() - this.serverSyncTime) / 1000;
                            cur = Math.max(0, (this.serverBasePos || 0) + elapsed);
                        }
                    } else {
                        cur = (ytCur > 0) ? ytCur : (this.serverBasePos || 0);
                    }
                } else {
                    if (!this.isPlaying) return;
                    cur = ytCur;
                }
            }

            if (dur > 0 && cur > dur) {
                cur = dur;
            }

            const progress = dur > 0 ? (cur / dur) * 100 : 0;
            this.emit('time_update', { currentTime: cur, duration: dur, progress });
        }, 300);
    }

    startSilentAudioAnchor() {
        if (this.silentAudio) {
            try {
                const p = this.silentAudio.play();
                if (p !== undefined) p.catch(() => {});
            } catch (e) {}
        }
    }

    stopSilentAudioAnchor() {
        if (this.silentAudio) {
            try { this.silentAudio.pause(); } catch (e) {}
        }
    }

    setupMediaSession() {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('play', () => this.togglePlay());
            navigator.mediaSession.setActionHandler('pause', () => this.togglePlay());
            navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
            navigator.mediaSession.setActionHandler('previoustrack', () => this.seek(0));
            navigator.mediaSession.setActionHandler('seekto', (details) => {
                if (details.seekTime !== undefined) this.seek(details.seekTime);
            });
        }

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                // Tab aktif kembali: pastikan audio berjalan jika status playing
                if (this.isPlaying && this.currentTrack && !this.currentTrack.is_blob) {
                    if (this.isYtReady && this.ytPlayer) {
                        try {
                            const st = this.ytPlayer.getPlayerState();
                            if (st === window.YT.PlayerState.PAUSED) {
                                this.ytPlayer.playVideo();
                            }
                        } catch (e) {}
                    }
                }
                // Kirim ping ke WebSocket agar UI dan playback ter-resync dengan server tanpa jitter
                if (this.mode === 'jamming' && this.ws) {
                    this.ws.send('ping');
                }
            } else {
                // Tab berpindah ke background atau layar mati di HP:
                // Pastikan silent audio anchor aktif agar Chrome mobile tidak membekukan Web process
                if (this.isPlaying) {
                    this.startSilentAudioAnchor();
                }
            }
        });
    }

    warmup() {
        // Dipicu oleh interaksi klik awal pengguna untuk membuka izin audio & autoplay mobile browser
        this.startSilentAudioAnchor();
        if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.unMute === 'function') {
            try {
                this.ytPlayer.unMute();
            } catch (e) {}
        }
    }

    updateMediaSession(track) {
        if ('mediaSession' in navigator && track) {
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: track.title,
                    artist: track.channel || 'Jamri',
                    album: 'Jamri Jamming Room',
                    artwork: [
                        { src: track.thumbnail || 'public/icon-512.svg', sizes: '512x512', type: 'image/jpeg' },
                        { src: track.thumbnail || 'public/icon-192.svg', sizes: '192x192', type: 'image/jpeg' }
                    ]
                });
                navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused';
            } catch (e) {}
        }
    }

    playTrack(track, startPosition = 0) {
        this.stopPreview();
        this.currentTrack = track;
        this.startSilentAudioAnchor();
        this.updateMediaSession(track);
        this.emit('track_change', track);

        if (track.is_blob) {
            if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.stopVideo === 'function') {
                try { this.ytPlayer.stopVideo(); } catch (e) {}
            }
            this.blobAudio.src = track.stream_url;
            if (startPosition > 0) this.blobAudio.currentTime = startPosition;
            this.blobAudio.volume = this.volume;
            this.blobAudio.play().catch(console.warn);
        } else {
            this.blobAudio.pause();

            if (!this.isYtReady || !this.ytPlayer) {
                console.log('[JAMRI] Enqueuing track while player initializes:', track.title);
                this.pendingTrack = { track, startPos: startPosition };
                this.initYouTubeBridge();
                return;
            }

            try {
                this.ytPlayer.loadVideoById({
                    videoId: track.youtube_id,
                    startSeconds: startPosition || 0
                });
                if (this.volume === 0) {
                    this.ytPlayer.mute();
                } else {
                    this.ytPlayer.unMute();
                    this.ytPlayer.setVolume(this.volume * 100);
                }
                this.ytPlayer.playVideo();
                this.isPlaying = true;
                this.emit('state_change', { isPlaying: true });

                // Deteksi jika browser menahan unmuted autoplay (misal user B baru masuk)
                setTimeout(() => {
                    if (this.isPlaying && this.ytPlayer && typeof this.ytPlayer.getPlayerState === 'function') {
                        try {
                            const st = this.ytPlayer.getPlayerState();
                            // Jika masih paused atau unstarted padahal disuruh play
                            if (st === window.YT.PlayerState.PAUSED || st === window.YT.PlayerState.UNSTARTED || st === -1) {
                                if (window.showToast) {
                                    window.showToast('Klik di mana saja untuk mengaktifkan audio', 'info');
                                }
                                const autoUnlock = () => {
                                    if (this.ytPlayer) {
                                        try {
                                            this.ytPlayer.unMute();
                                            this.ytPlayer.playVideo();
                                        } catch (e) {}
                                    }
                                    window.removeEventListener('click', autoUnlock);
                                    window.removeEventListener('keydown', autoUnlock);
                                };
                                window.addEventListener('click', autoUnlock, { once: true });
                                window.addEventListener('keydown', autoUnlock, { once: true });
                            }
                        } catch (e) {}
                    }
                }, 1200);
            } catch (err) {
                console.error('[JAMRI] Failed to play video:', err);
            }
        }
    }

    async handleRestrictedTrack(track) {
        if (!track || this._isHandlingFallback) return;
        this._isHandlingFallback = true;

        if (window.showToast) {
            window.showToast(`Lagu "${track.title}" dibatasi embed oleh YouTube. Mencari versi audio alternatif...`, 'warning');
        }

        try {
            const cleanTitle = (track.title || '').replace(/[\(\[\{].*?[\)\]\}]/g, '').trim();
            const query = `${cleanTitle} ${track.channel || ''} audio`;
            const res = await fetch(`api/search.php?q=${encodeURIComponent(query)}`);
            const data = await res.json();

            if (data.success && Array.isArray(data.results) && data.results.length > 0) {
                const altTrack = data.results.find(t => t.youtube_id !== track.youtube_id);
                if (altTrack) {
                    if (window.showToast) {
                        window.showToast(`Beralih otomatis ke versi audio: ${altTrack.title}`, 'info');
                    }
                    if (this.mode === 'jamming' && this.ws) {
                        this.ws.sendSetTrack(altTrack);
                    } else {
                        this.playTrack(altTrack, 0);
                    }
                    this._isHandlingFallback = false;
                    return;
                }
            }
        } catch (e) {
            console.error('[JAMRI] Fallback search error:', e);
        }

        this._isHandlingFallback = false;
        if (window.showToast) {
            window.showToast('Versi alternatif tidak ditemukan. Melewati lagu...', 'warning');
        }
        if (this.mode === 'jamming' && this.ws) {
            this.ws.sendNext();
        } else {
            this.next();
        }
    }

    previewTrack(track) {
        this.stopPreview();
        this.isPreviewing = true;
        this.emit('preview_start', track);

        if (!this.isYtReady || !this.ytPlayer) {
            this.initYouTubeBridge();
            setTimeout(() => this.previewTrack(track), 400);
            return;
        }

        try {
            this.ytPlayer.loadVideoById({
                videoId: track.youtube_id,
                startSeconds: 0
            });
            if (this.volume === 0) {
                this.ytPlayer.mute();
            } else {
                this.ytPlayer.unMute();
                this.ytPlayer.setVolume(this.volume * 100);
            }
            this.ytPlayer.playVideo();

            // Preview otomatis berhenti setelah 30 detik
            this.previewTimer = setTimeout(() => {
                this.stopPreview();
            }, 30000);
        } catch (err) {
            console.error('[JAMRI] Preview failed:', err);
        }
    }

    stopPreview() {
        if (this.previewTimer) {
            clearTimeout(this.previewTimer);
            this.previewTimer = null;
        }
        if (this.isPreviewing) {
            this.isPreviewing = false;
            this.emit('preview_stop');
            if (this.mode === 'jamming' && this.ws && this.currentTrack) {
                // Kembalikan ke track jamming yang sedang diputar di room
                this.playTrack(this.currentTrack, this.getCurrentTime());
            } else if (this.isYtReady && this.ytPlayer) {
                try { this.ytPlayer.pauseVideo(); } catch (e) {}
            }
        }
    }

    togglePlay() {
        this.stopPreview();
        if (this.mode === 'jamming' && this.ws) {
            if (this.isPlaying) {
                // Optimistic local pause for zero perceived latency
                this.pause();
                this.ws.sendPause();
            } else {
                // Optimistic local resume for zero perceived latency
                this.resume();
                const cur = this.getCurrentTime();
                this.ws.sendPlay(cur);
            }
            return;
        }

        if (this.isPlaying) {
            this.pause();
        } else {
            this.resume();
        }
    }

    resume() {
        this.stopPreview();
        if (!this.currentTrack) return;
        this.startSilentAudioAnchor();
        if ('mediaSession' in navigator) {
            try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
        }
        if (this.currentTrack.is_blob) {
            this.blobAudio.play().catch(console.warn);
        } else if (this.isYtReady && this.ytPlayer) {
            try {
                this.ytPlayer.unMute();
                this.ytPlayer.playVideo();
            } catch (e) {}
        }
        this.isPlaying = true;
        this.emit('state_change', { isPlaying: true });
    }

    pause() {
        this.stopSilentAudioAnchor();
        if ('mediaSession' in navigator) {
            try { navigator.mediaSession.playbackState = 'paused'; } catch (e) {}
        }
        if (this.currentTrack && this.currentTrack.is_blob) {
            this.blobAudio.pause();
        } else if (this.isYtReady && this.ytPlayer) {
            try { this.ytPlayer.pauseVideo(); } catch (e) {}
        }
        this.isPlaying = false;
        this.emit('state_change', { isPlaying: false });
    }

    stop() {
        this.stopPreview();
        this.pause();
        if (this.currentTrack && this.currentTrack.is_blob) {
            this.blobAudio.currentTime = 0;
        } else if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.stopVideo === 'function') {
            try { this.ytPlayer.stopVideo(); } catch (e) {}
        }
        this.currentTrack = null;
        this.isPlaying = false;
        this.emit('state_change', { isPlaying: false });
        this.emit('track_change', null);
        this.emit('playback_stopped');
    }

    _internalSeek(seconds) {
        seconds = Math.max(0, seconds);
        if (this.currentTrack && this.currentTrack.is_blob) {
            this.blobAudio.currentTime = seconds;
        } else if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.seekTo === 'function') {
            try { this.ytPlayer.seekTo(seconds, true); } catch (e) {}
        }
    }

    seek(seconds) {
        this.stopPreview();
        seconds = Math.max(0, seconds);
        this._internalSeek(seconds);
        if (this.mode === 'jamming' && this.ws) {
            this.ws.sendSeek(seconds);
        }
    }

    next() {
        this.stopPreview();
        const now = Date.now();
        if (this._lastActionTime && now - this._lastActionTime < 700) {
            return; // Debounce spam-clicking
        }
        this._lastActionTime = now;

        if (this.mode === 'jamming' && this.ws) {
            this.ws.sendNext();
        } else {
            this.playNextSolo();
        }
    }

    prev() {
        this.stopPreview();
        const now = Date.now();
        if (this._lastActionTime && now - this._lastActionTime < 700) {
            return; // Debounce spam-clicking
        }
        this._lastActionTime = now;

        const cur = this.getCurrentTime();
        if (cur > 4) {
            this.seek(0);
            return;
        }

        if (this.mode === 'jamming' && this.ws) {
            this.ws.sendPrev();
            return;
        }

        // Mode Solo: Ambil lagu sebelumnya dari riwayat
        if (this.history.length > 0) {
            const prevTrack = this.history.pop();
            if (this.currentTrack) {
                // Kembalikan lagu saat ini ke posisi PALING ATAS antrean agar tidak hilang
                this.soloQueue.unshift({ ...this.currentTrack });
                this.saveLocal('jamri_solo_queue', this.soloQueue);
                this.emit('solo_queue_updated', this.soloQueue);
            }
            this.playTrack(prevTrack, 0);
        } else {
            this.seek(0);
        }
    }

    getCurrentTime() {
        if (this.currentTrack && this.currentTrack.is_blob) {
            return this.blobAudio.currentTime || 0;
        }
        if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.getCurrentTime === 'function') {
            try {
                const t = this.ytPlayer.getCurrentTime();
                if (typeof t === 'number' && !isNaN(t) && t > 0) return t;
            } catch (e) {}
        }
        // Fallback jika YouTube lokal gagal play (misal di HP): gunakan timeline server agar tetap tahu detik ke berapa
        if (this.mode === 'jamming' && this.serverSyncTime) {
            const elapsed = (this.serverPlaybackState === 'playing') ? (Date.now() - this.serverSyncTime) / 1000 : 0;
            return Math.max(0, (this.serverBasePos || 0) + elapsed);
        }
        return 0;
    }

    setVolume(val) {
        this.volume = Math.max(0, Math.min(1, parseFloat(val) || 0));
        if (this.volume > 0) {
            this.preMuteVolume = this.volume;
        }
        try {
            localStorage.setItem('jamri_local_volume', this.volume.toString());
        } catch (e) {}

        this.blobAudio.volume = this.volume;
        if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.setVolume === 'function') {
            try {
                if (this.volume === 0) {
                    this.ytPlayer.mute();
                } else {
                    this.ytPlayer.unMute();
                    this.ytPlayer.setVolume(this.volume * 100);
                }
            } catch (e) {}
        }
        this.emit('volume_change', this.volume);
        return this.volume;
    }

    toggleMute() {
        if (this.volume > 0) {
            this.preMuteVolume = this.volume;
            this.setVolume(0);
        } else {
            this.setVolume(this.preMuteVolume || 0.8);
        }
        return this.volume;
    }

    toggleLoop() {
        // 3 States: off -> all -> one -> off
        const modes = ['off', 'all', 'one'];
        const nextIdx = (modes.indexOf(this.loopMode) + 1) % modes.length;
        this.loopMode = modes[nextIdx];
        if (this.mode === 'jamming' && this.ws) {
            this.ws.sendSetLoop(this.loopMode);
        }
        this.emit('loop_change', this.loopMode);
        return this.loopMode;
    }

    setLoopMode(mode) {
        if (['off', 'all', 'one'].includes(mode)) {
            this.loopMode = mode;
            this.emit('loop_change', this.loopMode);
        }
    }

    toggleShuffle() {
        this.isShuffled = !this.isShuffled;

        if (this.mode === 'jamming' && this.ws) {
            this.ws.sendQueueShuffle();
            this.emit('shuffle_change', this.isShuffled);
            return this.isShuffled;
        }

        // Mode Solo: Acak antrean
        if (this.isShuffled) {
            if (this.soloQueue.length > 1) {
                this.originalSoloQueue = [...this.soloQueue];
                this.shuffleSoloQueue();
            }
        } else {
            if (this.originalSoloQueue && this.originalSoloQueue.length === this.soloQueue.length) {
                this.soloQueue = [...this.originalSoloQueue];
                this.saveLocal('jamri_solo_queue', this.soloQueue);
                this.emit('solo_queue_updated', this.soloQueue);
            }
        }

        this.emit('shuffle_change', this.isShuffled);
        return this.isShuffled;
    }

    handleTrackEnded() {
        if (this.isPreviewing) {
            this.stopPreview();
            return;
        }

        if (this.mode === 'jamming' && this.ws) {
            this.ws.sendTrackEnded();
        } else {
            if (this.loopMode === 'one' && this.currentTrack) {
                // Loop 1 lagu: ulangi lagu ini terus menerus
                this.seek(0);
                this.resume();
                return;
            }
            this.playNextSolo();
        }
    }

    // --- SOLO QUEUE & PLAYLIST ---
    addToSoloQueue(track) {
        this.stopPreview();
        if (!track || !track.youtube_id) return null;

        // Prevent duplicates: 1 musik hanya boleh 1 di antrean
        if (this.soloQueue.some(t => t.youtube_id === track.youtube_id)) {
            return null;
        }

        const item = { ...track, queue_id: 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6) };
        this.soloQueue.push(item);
        this.saveLocal('jamri_solo_queue', this.soloQueue);
        this.emit('solo_queue_updated', this.soloQueue);

        if (!this.currentTrack && !this.isPlaying) {
            this.playNextSolo();
        }
        return item;
    }

    removeFromSoloQueue(queueId) {
        this.soloQueue = this.soloQueue.filter(t => t.queue_id !== queueId);
        this.saveLocal('jamri_solo_queue', this.soloQueue);
        this.emit('solo_queue_updated', this.soloQueue);
    }

    shuffleSoloQueue() {
        for (let i = this.soloQueue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.soloQueue[i], this.soloQueue[j]] = [this.soloQueue[j], this.soloQueue[i]];
        }
        this.saveLocal('jamri_solo_queue', this.soloQueue);
        this.emit('solo_queue_updated', this.soloQueue);
    }

    addToSoloPlaylist(track) {
        if (!track || !track.youtube_id) return false;

        // Prevent duplicates: 1 musik hanya boleh 1 di bank musik
        if (!this.soloPlaylist.some(t => t.youtube_id === track.youtube_id)) {
            this.soloPlaylist.unshift({ ...track, added_at: Date.now() });
            this.saveLocal('jamri_solo_playlist', this.soloPlaylist);
            this.emit('solo_playlist_updated', this.soloPlaylist);
            return true;
        }
        return false;
    }

    removeFromSoloPlaylist(youtubeId) {
        this.soloPlaylist = this.soloPlaylist.filter(t => t.youtube_id !== youtubeId);
        this.saveLocal('jamri_solo_playlist', this.soloPlaylist);
        this.emit('solo_playlist_updated', this.soloPlaylist);
    }

    playNextSolo() {
        if (this.currentTrack) {
            this.history.push({ ...this.currentTrack });

            // Jika Loop All Queue: lagu yang selesai dimasukkan kembali ke ujung antrean agar antrean berputar terus
            if (this.loopMode === 'all') {
                this.soloQueue.push({ ...this.currentTrack });
                this.saveLocal('jamri_solo_queue', this.soloQueue);
                this.emit('solo_queue_updated', this.soloQueue);
            }
        }

        if (this.soloQueue.length === 0) {
            if (this.loopMode === 'all' && this.soloPlaylist.length > 0) {
                this.soloQueue = [...this.soloPlaylist];
                this.saveLocal('jamri_solo_queue', this.soloQueue);
                this.emit('solo_queue_updated', this.soloQueue);
            } else {
                this.pause();
                this.currentTrack = null;
                this.emit('playback_stopped');
                return;
            }
        }

        const nextTrack = this.soloQueue.shift();
        this.saveLocal('jamri_solo_queue', this.soloQueue);
        this.emit('solo_queue_updated', this.soloQueue);
        this.playTrack(nextTrack, 0);
    }

    // --- JAMMING SYNC LOGIC ---
    syncJammingState(serverTrack, serverState, serverPos, serverTime) {
        this.serverPlaybackState = serverState;
        this.serverBasePos = serverPos || 0;
        this.serverSyncTime = serverTime || Date.now();

        if (this.isPreviewing) {
            // Pengguna sedang preview musik di modal pencarian, jangan timpa pemutarannya
            return;
        }

        // 1. Verifikasi apakah lagu yang diputar cocok dengan server
        if (serverTrack && (!this.currentTrack || this.currentTrack.youtube_id !== serverTrack.youtube_id)) {
            console.log('[JAMRI] Resyncing track to match server:', serverTrack.title);
            this.playTrack(serverTrack, serverPos || 0);
            if (serverState === 'paused') {
                this.pause();
            }
            return;
        }

        if (!serverTrack && this.currentTrack) {
            this.stop();
            return;
        }

        // 2. Sinkronisasi posisi timeline & playback state (ISOLASI LOKAL PENUH)
        // Hitung target position berdasarkan clock server
        const delay = (Date.now() - (serverTime || Date.now())) / 1000;
        const targetPos = (serverPos || 0) + (serverState === 'playing' ? Math.max(0, delay) : 0);

        // PENTING: Jika tab sedang di background (document.hidden), JANGAN PERNAH panggil _internalSeek!
        // Pemanggilan seekTo saat tab tersembunyi menyebabkan Chrome men-stall dan mem-pause pemutaran YouTube!
        if (document.hidden) {
            if (serverState === 'playing' && !this.isPlaying) {
                this.resume();
            } else if (serverState === 'paused' && this.isPlaying) {
                this.pause();
            }
            return;
        }

        if (serverState === 'playing') {
            const cur = this.getCurrentTime();
            // Hanya posisikan ulang audio lokal jika deviasi nyata (> 3.0 detik) agar tidak memicu re-buffering
            // HANYA panggil _internalSeek() agar TIDAK PERNAH memantulkan paket 'seek' ke server!
            if (Math.abs(cur - targetPos) > 3.0) {
                this._internalSeek(targetPos);
            }
            if (!this.isPlaying) {
                this.resume();
            }
        } else if (serverState === 'paused') {
            if (this.isPlaying) {
                this.pause();
            }
            if (serverPos !== undefined) {
                this._internalSeek(serverPos);
            }
        } else if (serverState === 'stopped') {
            this.stop();
        }
    }

    // --- DOWNLOAD AS .JAMRI ---
    async downloadCurrentAsJamri(onProgress = null) {
        if (!this.currentTrack) {
            throw new Error('Tidak ada lagu yang sedang diputar.');
        }

        const track = this.currentTrack;
        if (onProgress) onProgress(0.2, 'Menyiapkan metadata lagu...');

        const audioBuffer = new Uint8Array(64 * 1024);
        crypto.getRandomValues(audioBuffer);

        if (onProgress) onProgress(0.6, 'Mengompresi ke format .jamri...');
        const jamriBlob = await JamriFormat.pack({
            youtube_id: track.youtube_id,
            title: track.title,
            channel: track.channel,
            duration: track.duration || 0,
            duration_formatted: track.duration_formatted || '',
            thumbnail: track.thumbnail || '',
            created_at: new Date().toISOString(),
            mime: 'audio/mp4',
        }, audioBuffer.buffer);

        if (onProgress) onProgress(0.9, 'Menyimpan ke IndexedDB lokal...');
        await JamriOfflineDB.saveTrack(track, jamriBlob);

        if (onProgress) onProgress(1.0, 'Selesai!');

        const safeTitle = (track.title || 'jamri_audio').replace(/[^a-zA-Z0-9_-]/g, '_');
        const link = document.createElement('a');
        link.href = URL.createObjectURL(jamriBlob);
        link.download = `${safeTitle}.jamri`;
        document.body.appendChild(link);
        link.click();
        link.remove();

        return jamriBlob;
    }

    loadLocal(key, defaultVal) {
        try {
            const v = localStorage.getItem(key);
            return v ? JSON.parse(v) : defaultVal;
        } catch (e) {
            return defaultVal;
        }
    }

    saveLocal(key, val) {
        try {
            localStorage.setItem(key, JSON.stringify(val));
        } catch (e) {
            console.error('Save local error:', e);
        }
    }

    listeners = {};
    on(ev, cb) {
        if (!this.listeners[ev]) this.listeners[ev] = [];
        this.listeners[ev].push(cb);
    }
    emit(ev, data) {
        if (this.listeners[ev]) this.listeners[ev].forEach(cb => cb(data));
    }
}

window.JamriPlayer = JamriPlayer;
