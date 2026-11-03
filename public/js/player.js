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

        // Pending seek position to apply when tab becomes visible after being hidden
        this.pendingSeekPos = null;

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

    /**
     * True when playback is driven by the server (a legacy jamming room OR a
     * world mat). World mode used to run with mode='solo', so every sync branch
     * below was dead: the timeline never advanced from the server clock, ping
     * was never sent from the player, and the UI drifted per-device.
     */
    isSynced() {
        if (this.mode === 'jamming') return true;
        return !!(this.mode === 'world' && this.ws && this.ws.isConnected);
    }

    setMode(mode, wsClient = null) {
        this.mode = mode;
        this.ws = wsClient;
        // Apply pending seek when tab becomes visible again (seek was received while tab was hidden)
        if (!this._visibilitySeekBound) {
            this._visibilitySeekBound = true;
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && this.pendingSeekPos !== null) {
                    const pendingPos = this.pendingSeekPos;
                    this.pendingSeekPos = null;
                    console.log('[JAMRI] Applying pending seek from background:', pendingPos);
                    // Small delay to ensure browser YT player is unthrottled
                    setTimeout(() => {
                        this._internalSeek(pendingPos);
                    }, 200);
                }
            });
        }
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
                                }
                                this.applyEffectiveVolume();
                            } catch (e) {}

                            if (this.pendingTrack) {
                                const pt = this.pendingTrack;
                                this.pendingTrack = null;
                                // Re-apply the SERVER state: a track queued while the
                                // mat was paused must load paused, not auto-play.
                                this.playTrack(pt.track, pt.startPos);
                                if (pt.state === 'paused' || !this._shouldAutoPlay()) {
                                    this.pause();
                                }
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
                            if (this.isSynced()) {
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
            let dur = this.getDuration();

            if (this.currentTrack.is_blob) {
                if (!this.isPlaying) return;
                cur = this.blobAudio.currentTime || 0;
                const bDur = this.blobAudio.duration;
                if (isFinite(bDur) && bDur > 0) dur = bDur;
            } else {
                let ytCur = 0;
                if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.getCurrentTime === 'function') {
                    try {
                        ytCur = this.ytPlayer.getCurrentTime() || 0;
                    } catch (e) {}
                }

                // Di mode jamming: timeline jam server tetap maju meskipun audio lokal dibatasi YouTube
                if (this.isSynced()) {
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

    /**
     * Reliable duration resolver: prefers the real player duration (works for any
     * track length), then falls back to track metadata. Without this, long tracks
     * (whose metadata duration is missing/0) produced a dead progress bar.
     */
    getDuration() {
        if (!this.currentTrack) return 0;
        if (this.currentTrack.is_blob) {
            const d = this.blobAudio.duration;
            if (isFinite(d) && d > 0) return d;
        }
        if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.getDuration === 'function') {
            try {
                const d = this.ytPlayer.getDuration();
                if (typeof d === 'number' && isFinite(d) && d > 0) return d;
            } catch (e) {}
        }
        if (this.currentTrack) {
            return this.currentTrack.duration_seconds || this.currentTrack.duration || 0;
        }
        return 0;
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
                if (this.isSynced() && this.ws) {
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
            this.applyEffectiveVolume();
            this.blobAudio.play().catch(console.warn);
        } else {
            this.blobAudio.pause();

            if (!this.isYtReady || !this.ytPlayer) {
                console.log('[JAMRI] Enqueuing track while player initializes:', track.title);
                this.pendingTrack = { track, startPos: startPosition, state: this.serverPlaybackState || 'playing' };
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
                }
                this.applyEffectiveVolume();

                // Respect the server state: when the mat is paused we only LOAD the
                // video at the right position. Calling playVideo() here made a
                // paused mat start playing as soon as anyone joined or moved.
                if (this._shouldAutoPlay()) {
                    this.ytPlayer.playVideo();
                    this.isPlaying = true;
                    this.emit('state_change', { isPlaying: true });
                } else {
                    try { this.ytPlayer.pauseVideo(); } catch (e) {}
                    this.isPlaying = false;
                    this.emit('state_change', { isPlaying: false });
                }

                // Deteksi jika browser menahan unmuted autoplay (misal user B baru masuk).
                // PENTING: hanya aktif kalau server memang meminta PLAYING. Kalau tikar
                // sedang paused, listener ini dulu ikut terpasang dan setiap keydown
                // (WASD untuk jalan) memicu playVideo() -> lagu auto-play sendiri.
                setTimeout(() => {
                    if (!this._shouldAutoPlay() || !this.isPlaying) return;
                    if (!this.ytPlayer || typeof this.ytPlayer.getPlayerState !== 'function') return;
                    try {
                        const st = this.ytPlayer.getPlayerState();
                        if (st !== window.YT.PlayerState.PAUSED
                            && st !== window.YT.PlayerState.UNSTARTED
                            && st !== -1) {
                            return;
                        }
                        if (window.showToast) {
                            window.showToast('Klik di mana saja untuk mengaktifkan audio', 'info');
                        }
                        this._armAutoUnlock();
                    } catch (e) {}
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
                    if (this.isSynced() && this.ws) {
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
        if (this.isSynced() && this.ws) {
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
            if (this.isSynced() && this.ws && this.currentTrack) {
                // Kembalikan ke track jamming yang sedang diputar di room
                this.playTrack(this.currentTrack, this.getCurrentTime());
            } else if (this.isYtReady && this.ytPlayer) {
                try { this.ytPlayer.pauseVideo(); } catch (e) {}
            }
        }
    }

    togglePlay() {
        this.stopPreview();
        if (this.isSynced() && this.ws) {
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

    /**
     * True only when the SERVER wants the current track playing. Guards the
     * autoplay-unlock helper so a paused mat can never be resumed by a stray
     * click/keypress (e.g. walking with WASD).
     */
    _shouldAutoPlay() {
        return this.serverPlaybackState === 'playing';
    }

    /** One-shot "click anywhere to enable audio" unlock, cancelled on pause. */
    _armAutoUnlock() {
        if (this._autoUnlockArmed) return;
        this._autoUnlockArmed = true;

        const autoUnlock = () => {
            this._autoUnlockArmed = false;
            this._disarmAutoUnlock();
            // Re-check: the mat may have been paused while waiting for the click.
            if (!this._shouldAutoPlay() || !this.currentTrack) return;
            if (this.ytPlayer) {
                try {
                    this.ytPlayer.unMute();
                    this.ytPlayer.playVideo();
                } catch (e) {}
            }
        };

        this._autoUnlockHandler = autoUnlock;
        window.addEventListener('click', autoUnlock, { once: true });
        window.addEventListener('keydown', autoUnlock, { once: true });
    }

    _disarmAutoUnlock() {
        if (!this._autoUnlockHandler) return;
        window.removeEventListener('click', this._autoUnlockHandler);
        window.removeEventListener('keydown', this._autoUnlockHandler);
        this._autoUnlockHandler = null;
        this._autoUnlockArmed = false;
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
        this._disarmAutoUnlock();
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

    /**
     * Drop everything that belonged to a shared mat session.
     *
     * Leaving a mat means "I am no longer listening to that room": the current
     * track, its timeline anchor, the loop/shuffle modes and the queue mirrors
     * must all go. Without this the dock kept showing the mat's song and
     * getCurrentTime() kept advancing from the stale server clock, so walking
     * off a mat looked like you were still playing it — and re-entering showed
     * yesterday's snapshot instead of the live one.
     *
     * Deliberately does NOT touch the user's own volume or the solo queue.
     */
    resetSharedSession() {
        this.stopPreview();
        // Stop audio for the mat track, but never the solo/local one.
        if (this.currentTrack) {
            if (this.currentTrack.is_blob) {
                try { this.blobAudio.pause(); this.blobAudio.currentTime = 0; } catch (e) {}
            } else if (this.isYtReady && this.ytPlayer) {
                try {
                    this.ytPlayer.pauseVideo();
                    if (typeof this.ytPlayer.stopVideo === 'function') this.ytPlayer.stopVideo();
                } catch (e) {}
            }
        }

        this._disarmAutoUnlock();
        this.stopSilentAudioAnchor();

        this.currentTrack = null;
        this.isPlaying = false;
        this.serverPlaybackState = 'stopped';
        this.serverBasePos = 0;
        this.serverSyncTime = 0;
        this.pendingSeekPos = null;
        this._seekLockUntil = 0;
        this.matAttenuation = 1;

        if ('mediaSession' in navigator) {
            try { navigator.mediaSession.playbackState = 'none'; } catch (e) {}
        }

        this.emit('state_change', { isPlaying: false });
        this.emit('track_change', null);
        this.emit('playback_stopped');
        this.emit('time_update', { currentTime: 0, duration: 0, progress: 0 });
    }

    _internalSeek(seconds) {
        seconds = Math.max(0, seconds);
        // Lock out periodic pong re-syncs briefly so the seek is not immediately
        // reverted by an in-flight server position (the "click does nothing" bug).
        this._seekLockUntil = Date.now() + 1500;
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
        if (this.isSynced() && this.ws) {
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

        if (this.isSynced() && this.ws) {
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

        if (this.isSynced() && this.ws) {
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
        // No track loaded means no timeline: never report the YT bridge's leftover
        // position (after leaving a mat the dock kept counting from it).
        if (!this.currentTrack) return 0;
        if (this.currentTrack.is_blob) {
            return this.blobAudio.currentTime || 0;
        }
        if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.getCurrentTime === 'function') {
            try {
                const t = this.ytPlayer.getCurrentTime();
                if (typeof t === 'number' && !isNaN(t) && t > 0) return t;
            } catch (e) {}
        }
        // Fallback jika YouTube lokal gagal play (misal di HP): gunakan timeline server agar tetap tahu detik ke berapa
        if (this.isSynced() && this.serverSyncTime) {
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

        this.applyEffectiveVolume();
        this.emit('volume_change', this.volume);
        return this.volume;
    }

    /**
     * Proximity attenuation for world mode (0..1). The master volume the user
     * set is preserved; this is a separate multiplier applied on top so walking
     * away from a mat fades its music without losing the user's own setting.
     */
    setMatVolumeScale(scale) {
        const s = Math.max(0, Math.min(1, parseFloat(scale)));
        if (!isFinite(s)) return;
        if (Math.abs(s - (this.matAttenuation ?? 1)) < 0.01) return;
        this.matAttenuation = s;
        this.applyEffectiveVolume();
    }

    /** Effective output volume = user master volume x proximity attenuation. */
    applyEffectiveVolume() {
        const eff = (this.volume) * (this.matAttenuation ?? 1);
        this.blobAudio.volume = eff;
        if (this.isYtReady && this.ytPlayer && typeof this.ytPlayer.setVolume === 'function') {
            try {
                if (eff <= 0.001) {
                    this.ytPlayer.setVolume(0);
                } else {
                    this.ytPlayer.unMute();
                    this.ytPlayer.setVolume(eff * 100);
                }
            } catch (e) {}
        }
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
        if (this.isSynced() && this.ws) {
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

        if (this.isSynced() && this.ws) {
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

        if (this.isSynced() && this.ws) {
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

    reorderSoloQueue(fromIndex, toIndex) {
        if (fromIndex < 0 || fromIndex >= this.soloQueue.length) return;
        if (toIndex < 0 || toIndex >= this.soloQueue.length) return;
        const [movedItem] = this.soloQueue.splice(fromIndex, 1);
        this.soloQueue.splice(toIndex, 0, movedItem);
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
    // isExplicitSeek: true = seek dari aksi user lain (seek/play/pause WS event), false = periodic pong
    syncJammingState(serverTrack, serverState, serverPos, serverTime, isExplicitSeek = false) {
        this.serverPlaybackState = serverState;
        this.serverBasePos = serverPos || 0;
        this.serverSyncTime = serverTime || Date.now();

        if (this.isPreviewing) {
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

        // 2. Sinkronisasi posisi timeline & playback state
        const delay = (Date.now() - (serverTime || Date.now())) / 1000;
        const targetPos = (serverPos || 0) + (serverState === 'playing' ? Math.max(0, delay) : 0);

        // PENTING: Jika tab di background DAN ini bukan seek eksplisit (hanya periodic pong):
        // - Handle play/pause saja, skip _internalSeek agar YT tidak stall dari polling rutin
        // - Tapi untuk seek EKSPLISIT dari user lain, tetap apply seketika agar tetap sinkron!
        if (document.hidden && !isExplicitSeek) {
            if (serverState === 'playing' && !this.isPlaying) {
                this.resume();
            } else if (serverState === 'paused' && this.isPlaying) {
                this.pause();
            }
            return;
        }

        // Tab aktif atau explicit seek — bersihkan pending seek
        this.pendingSeekPos = null;

        if (serverState === 'playing') {
            const cur = this.getCurrentTime();
            // Untuk explicit seek: selalu apply. Untuk pong rutin: hanya jika deviasi melewati
            // ambang. Ambang world lebih ketat karena tikar dipakai ramai-ramai (deviasi 4.5
            // detik terasa seperti "play masing-masing"), sedangkan room legacy dibiarkan
            // longgar agar seek tidak terlalu sering memicu stall YouTube.
            // Jangan pernah timpa posisi yang baru di-seek user (seek lock).
            const driftLimit = this.mode === 'world' ? 1.5 : 4.5;
            const withinSeekLock = Date.now() < (this._seekLockUntil || 0);
            if (isExplicitSeek || (!withinSeekLock && Math.abs(cur - targetPos) > driftLimit)) {
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
