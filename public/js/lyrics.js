/**
 * lyrics.js
 * Synchronized & Plain Lyrics Engine for Jamri powered by open-source LRCLIB
 * Supports both Front-View Karaoke Tab and Fullscreen Modal View
 * 100% Theme Adaptive (Day & Night Mode) with zero AI artifacts
 */

class JamriLyricsManager {
    constructor() {
        this.player = null;
        this.ws = null;
        this.isOpen = false;
        this.currentTrack = null;
        this.currentTrackId = null;
        this.lyricsData = null;
        this.parsedLines = [];
        this.activeLineIdx = -1;
        this.isLoading = false;
        this.isUserScrolling = false;
        this.scrollDebounceTimer = null;
        this.modalEl = null;
        this.embeddedContainers = new Set();

        // Picture-in-Picture state
        this.pipWindow = null;
        this.pipCloseHandler = null;
        this.pipMode = localStorage.getItem('jamri_pip_mode') || 'full'; // 'full' (Lengkap) | 'lyrics' (Lirik Saja)
        this.pipIsDraggingSeek = false;

        this.initKeyListeners();
        this.initPiPListeners();
    }

    attach(player, ws) {
        this.player = player;
        this.ws = ws;

        // Bind dock PiP button directly (dock-pip-wrapper IS itself the dropdown wrapper,
        // so we can't use bindPiPDropdown which does querySelectorAll('.lyrics-pip-dropdown-wrapper') inside)
        const dockPipWrapper = document.getElementById('dock-pip-wrapper');
        if (dockPipWrapper) {
            const pipBtn = dockPipWrapper.querySelector('.btn-lyrics-pip');
            const pipMenu = dockPipWrapper.querySelector('.lyrics-pip-menu');
            if (pipBtn && pipMenu) {
                pipBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const isShowing = pipMenu.style.display === 'flex';
                    document.querySelectorAll('.lyrics-pip-menu').forEach(m => m.style.display = 'none');
                    pipMenu.style.display = isShowing ? 'none' : 'flex';
                });
                pipMenu.querySelectorAll('.pip-menu-item').forEach(item => {
                    item.addEventListener('click', (e) => {
                        e.stopPropagation();
                        pipMenu.style.display = 'none';
                        const mode = item.dataset.pipMode || 'full';
                        this.openPiP(mode);
                    });
                });
            }
        }

        if (this.player) {
            this.player.on('track_change', (track) => {
                this.onTrackChange(track);
            });

            this.player.on('time_update', (data) => {
                const cur = (data && typeof data === 'object') ? data.currentTime : data;
                this.onTimeUpdate(cur || 0);
            });

            this.player.on('timeupdate', (data) => {
                const cur = (data && typeof data === 'object') ? data.currentTime : data;
                this.onTimeUpdate(cur || 0);
            });

            this.player.on('state_change', () => {
                this.updatePiPPlaybackState();
            });

            this.player.on('volume_change', (vol) => {
                this.updatePiPVolume(vol);
            });
        }
    }

    initPiPListeners() {
        // Close any active PiP dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.lyrics-pip-dropdown-wrapper')) {
                document.querySelectorAll('.lyrics-pip-menu').forEach(m => m.style.display = 'none');
            }
        });

        // Mirror Day / Night theme changes to the floating PiP document
        if (typeof MutationObserver !== 'undefined') {
            const themeObserver = new MutationObserver(() => {
                if (this.pipWindow && !this.pipWindow.closed) {
                    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
                    try {
                        this.pipWindow.document.documentElement.setAttribute('data-theme', currentTheme);
                    } catch (e) {}
                }
            });
            themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        }
    }

    initKeyListeners() {
        window.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 'l' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                const target = e.target;
                if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                    return;
                }
                this.toggleModal();
            }
        });
    }

    onTrackChange(track) {
        if (!track) return;
        const newId = track.youtube_id || track.id;
        if (this.currentTrackId === newId) return;

        this.currentTrack = track;
        this.currentTrackId = newId;
        this.lyricsData = null;
        this.parsedLines = [];
        this.activeLineIdx = -1;

        this.fetchAndRenderLyrics(track);
    }

    onTimeUpdate(currentTime) {
        // Sync PiP scrubber and time label if PiP is open in Full or Mini mode
        if (this.pipWindow && !this.pipWindow.closed && (this.pipMode === 'full' || this.pipMode === 'mini')) {
            const curEl = this.pipWindow.document.getElementById('pip-current-time');
            if (curEl) curEl.textContent = this.formatTime(currentTime);
            const slider = this.pipWindow.document.getElementById('pip-seek-slider');
            if (slider && !this.pipIsDraggingSeek) {
                const track = this.currentTrack || (this.player && this.player.currentTrack);
                const dur = track ? (track.duration_seconds || track.duration || 0) : 0;
                slider.value = dur > 0 ? (currentTime / dur) * 100 : 0;
            }
        }

        if (this.parsedLines.length === 0) return;
        this.highlightActiveLine(currentTime);
    }

    async fetchAndRenderLyrics(track, customQuery = null) {
        if (!track && !customQuery) return;

        this.isLoading = true;
        this.renderAllViews();

        try {
            const params = new URLSearchParams();
            if (customQuery) {
                params.append('q', customQuery);
            } else {
                params.append('title', track.title || '');
                params.append('artist', track.channel || track.artist || '');
                if (track.duration_seconds || track.duration) {
                    params.append('duration', Math.round(track.duration_seconds || track.duration));
                }
            }

            const res = await fetch(`api/lyrics.php?${params.toString()}`);
            const data = await res.json();

            this.isLoading = false;
            this.lyricsData = data;

            if (data.found && data.synced && data.synced_lyrics) {
                this.parsedLines = this.parseLrc(data.synced_lyrics);
            } else {
                this.parsedLines = [];
            }

            this.renderAllViews();

            if (this.player && this.parsedLines.length > 0) {
                const cur = this.player.currentTime || 0;
                this.highlightActiveLine(cur, true);
            }
        } catch (err) {
            console.error('[Lyrics] Fetch error:', err);
            this.isLoading = false;
            this.lyricsData = {
                found: false,
                message: 'Gagal memuat lirik dari server.'
            };
            this.renderAllViews();
        }
    }

    parseLrc(lrcText) {
        if (!lrcText) return [];
        const lines = lrcText.split('\n');
        const parsed = [];
        const lrcRegex = /\[(\d{2}):(\d{2}(?:\.\d+)?)\](.*)/;

        for (const line of lines) {
            const match = lrcRegex.exec(line.trim());
            if (match) {
                const minutes = parseInt(match[1], 10);
                const seconds = parseFloat(match[2]);
                const text = match[3].trim();
                const totalSeconds = minutes * 60 + seconds;
                if (text !== '') {
                    parsed.push({
                        time: totalSeconds,
                        text: text
                    });
                }
            }
        }

        parsed.sort((a, b) => a.time - b.time);
        return parsed;
    }

    highlightActiveLine(currentTime, forceScroll = false) {
        if (this.parsedLines.length === 0) return;

        let activeIdx = -1;
        for (let i = 0; i < this.parsedLines.length; i++) {
            if (currentTime >= this.parsedLines[i].time) {
                activeIdx = i;
            } else {
                break;
            }
        }

        if (activeIdx !== this.activeLineIdx || forceScroll) {
            const containers = [
                document.getElementById('jamri-lyrics-scroll-box'),
                ...Array.from(this.embeddedContainers).map(id => {
                    const parent = document.getElementById(id);
                    return parent ? parent.querySelector('.embedded-lyrics-scroll') : null;
                }).filter(Boolean)
            ];

            if (this.pipWindow && !this.pipWindow.closed) {
                const pipScroll = this.pipWindow.document.querySelector('.pip-lyrics-scroll');
                if (pipScroll) containers.push(pipScroll);
            }

            containers.forEach(container => {
                if (!container) return;

                if (this.activeLineIdx >= 0) {
                    const prevEl = container.querySelector(`[data-idx="${this.activeLineIdx}"]`);
                    if (prevEl) {
                        prevEl.classList.remove('active-line');
                    }
                }

                if (activeIdx >= 0) {
                    const nextEl = container.querySelector(`[data-idx="${activeIdx}"]`);
                    if (nextEl) {
                        nextEl.classList.add('active-line');
                        if (!this.isUserScrolling || forceScroll) {
                            const relTop = nextEl.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
                            const targetScrollTop = relTop - (container.clientHeight / 2) + (nextEl.clientHeight / 2);
                            container.scrollTo({
                                top: Math.max(0, targetScrollTop),
                                behavior: 'smooth'
                            });
                        }
                    }
                }
            });

            this.activeLineIdx = activeIdx;
        }
    }

    renderAllViews() {
        if (this.isOpen) {
            this.renderModalContent();
        }
        this.embeddedContainers.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                this.renderEmbedded(el);
            } else {
                // Container was removed by a room/solo re-render: forget it so
                // the registry does not grow without bound.
                this.embeddedContainers.delete(id);
            }
        });
        if (this.pipWindow && !this.pipWindow.closed) {
            this.renderPiPContent();
        }
    }

    registerEmbeddedContainer(containerId) {
        this.embeddedContainers.add(containerId);
        const el = document.getElementById(containerId);
        if (el) {
            this.renderEmbedded(el);
            if (this.player && this.parsedLines.length > 0) {
                this.highlightActiveLine(this.player.currentTime || 0, true);
            }
        }
    }

    getCoverHtml(thumb, size = 36) {
        if (thumb && thumb.trim() && !thumb.includes('default-thumb.png')) {
            return `
                <div class="lyrics-thumb-wrapper" style="width:${size}px; height:${size}px; flex-shrink:0;">
                    <img src="${this.escape(thumb)}" alt="Cover" class="lyrics-track-thumb" style="width:${size}px; height:${size}px;" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" />
                    <div class="lyrics-track-thumb-placeholder" style="display:none; width:${size}px; height:${size}px;">
                        <svg width="${Math.round(size * 0.45)}" height="${Math.round(size * 0.45)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M9 18V5l12-2v13"></path>
                            <circle cx="6" cy="18" r="3"></circle>
                            <circle cx="18" cy="16" r="3"></circle>
                        </svg>
                    </div>
                </div>
            `;
        }
        return `
            <div class="lyrics-track-thumb-placeholder" style="width:${size}px; height:${size}px; flex-shrink:0;">
                <svg width="${Math.round(size * 0.45)}" height="${Math.round(size * 0.45)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 18V5l12-2v13"></path>
                    <circle cx="6" cy="18" r="3"></circle>
                    <circle cx="18" cy="16" r="3"></circle>
                </svg>
            </div>
        `;
    }

    renderEmbedded(container) {
        if (!container) return;

        const track = this.currentTrack || (this.player && this.player.currentTrack);
        const title = track ? track.title : 'Tidak Ada Lagu';
        const artist = track ? (track.channel || track.artist || 'Artis Tidak Diketahui') : '';
        const thumb = track ? (track.thumbnail_url || track.thumbnail || '') : '';

        const isSynced = this.lyricsData && this.lyricsData.synced && this.parsedLines.length > 0;
        const isPlain = this.lyricsData && this.lyricsData.found && !isSynced && !!this.lyricsData.plain_lyrics;
        const notFound = this.lyricsData && !this.lyricsData.found;

        container.innerHTML = `
            <div class="embedded-lyrics-box">
                <!-- Header (Sticky, 2 Structured Rows) -->
                <div class="embedded-lyrics-header">
                    <!-- Row 1: Track Info, Sync Badge, & Actions -->
                    <div class="lyrics-header-main-row">
                        <div class="lyrics-track-info">
                            ${this.getCoverHtml(thumb, 34)}
                            <div class="lyrics-track-meta">
                                <div class="lyrics-track-title" title="${this.escape(title)}">${this.escape(title)}</div>
                                <div class="lyrics-track-artist">${this.escape(artist)}</div>
                            </div>
                            ${isSynced ? `
                                <span class="lyrics-sync-badge synced" title="Lirik disinkronkan secara otomatis secara realtime">
                                    <span class="sync-dot"></span>
                                    <span class="sync-text">Sinkron</span>
                                </span>
                            ` : (isPlain ? `
                                <span class="lyrics-sync-badge plain" title="Lirik teks biasa tanpa sinkronisasi waktu">
                                    <span class="sync-text">Teks Polos</span>
                                </span>
                            ` : '')}
                        </div>

                        <div class="lyrics-header-actions">
                            ${this.getPiPDropdownHtml()}
                            <button type="button" class="btn btn-ghost btn-icon btn-sm btn-embedded-search-toggle" title="Cari Lirik Manual">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="11" cy="11" r="8"></circle>
                                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                </svg>
                            </button>
                            <button type="button" class="btn btn-ghost btn-icon btn-sm btn-embedded-fullscreen" title="Buka Layar Penuh (L)">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="15 3 21 3 21 9"></polyline>
                                    <polyline points="9 21 3 21 3 15"></polyline>
                                    <line x1="21" y1="3" x2="14" y2="10"></line>
                                    <line x1="3" y1="21" x2="10" y2="14"></line>
                                </svg>
                            </button>
                        </div>
                    </div>

                    <!-- Row 2: Dedicated Karaoke Voice & Hearing Controls (Full-width, Touch-friendly) -->
                    <div class="lyrics-header-controls-row">
                        <button type="button" class="btn-karaoke-ptt" title="Tahan tombol ini atau tombol [V] di keyboard untuk bernyanyi karaoke bareng">
                            <span class="ptt-icon">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                                    <line x1="12" y1="19" x2="12" y2="23"></line>
                                    <line x1="8" y1="23" x2="16" y2="23"></line>
                                </svg>
                            </span>
                            <span class="ptt-text">PTT Karaoke <kbd>V</kbd></span>
                            <span class="ptt-waves"><span></span><span></span><span></span></span>
                        </button>

                        <button type="button" class="btn btn-outline btn-sm btn-hear-karaoke" title="Dengarkan atau bisukan suara karaoke dari peserta lain">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
                                <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
                            </svg>
                            <span class="hear-karaoke-label">Karaoke: Dengar</span>
                        </button>
                    </div>
                </div>

                <!-- Active Karaoke Singers Bar -->
                <div class="karaoke-active-singers-bar" style="display:none; margin:8px 16px 0 16px;"></div>

                <!-- Search Panel with Candidate Selector (Collapsible) -->
                ${this.getSearchPanelHtml(title !== 'Tidak Ada Lagu' ? `${title} ${artist}`.trim() : '')}

                <!-- Scrollable Karaoke Lyrics -->
                <div class="embedded-lyrics-scroll">
                    ${this.renderLyricsBody(isSynced, isPlain, notFound)}
                </div>

                <!-- Footer with Bottom-Right Floating PiP Button -->
                ${this.getFooterHtml(false)}
            </div>
        `;

        this.bindEmbeddedEvents(container);
    }

    bindEmbeddedEvents(container) {
        this.bindPiPDropdown(container);
        this.bindSearchEvents(container);
        const btnFullscreen = container.querySelector('.btn-embedded-fullscreen');
        const btnKaraokePtt = container.querySelector('.btn-karaoke-ptt');

        if (btnKaraokePtt && window.JAMRI_APP && window.JAMRI_APP.voicePTT) {
            window.JAMRI_APP.voicePTT.bindKaraokePTTButton(btnKaraokePtt);
        }

        const btnHearKaraoke = container.querySelector('.btn-hear-karaoke');
        if (btnHearKaraoke) {
            btnHearKaraoke.addEventListener('click', () => {
                if (window.JAMRI_APP && window.JAMRI_APP.voicePTT) {
                    window.JAMRI_APP.voicePTT.toggleKaraokeMuted();
                }
            });
            if (window.JAMRI_APP && window.JAMRI_APP.voicePTT) {
                window.JAMRI_APP.voicePTT.updateKaraokeMuteUI();
            }
        }

        if (btnFullscreen) {
            btnFullscreen.addEventListener('click', () => this.openModal());
        }

        const scrollBox = container.querySelector('.embedded-lyrics-scroll');
        if (scrollBox) {
            scrollBox.addEventListener('wheel', () => this.registerUserScroll(), { passive: true });
            scrollBox.addEventListener('touchmove', () => this.registerUserScroll(), { passive: true });

            scrollBox.querySelectorAll('.lyric-line-item').forEach(el => {
                el.addEventListener('click', () => {
                    const time = parseFloat(el.getAttribute('data-time'));
                    this.handleSeekClick(time);
                });
            });
        }
    }

    toggleModal() {
        if (this.isOpen) {
            this.closeModal();
        } else {
            this.openModal();
        }
    }

    openModal() {
        this.ensureModal();
        this.isOpen = true;
        this.modalEl.style.display = 'flex';
        document.body.style.overflow = 'hidden';

        const activeTrack = this.currentTrack || (this.player && this.player.currentTrack);
        if (activeTrack) {
            const trackId = activeTrack.youtube_id || activeTrack.id;
            if (trackId !== this.currentTrackId || !this.lyricsData) {
                this.currentTrack = activeTrack;
                this.currentTrackId = trackId;
                this.fetchAndRenderLyrics(activeTrack);
            } else {
                this.renderModalContent();
                if (this.player && this.parsedLines.length > 0) {
                    this.highlightActiveLine(this.player.currentTime || 0, true);
                }
            }
        } else {
            this.renderModalContent();
        }

        if (window.JAMRI_APP && window.JAMRI_APP.voicePTT) {
            window.JAMRI_APP.voicePTT.updateKaraokeSpeakerIndicator();
        }
    }

    closeModal() {
        this.isOpen = false;
        if (this.modalEl) {
            this.modalEl.style.display = 'none';
        }
        document.body.style.overflow = '';

        if (window.JAMRI_APP && window.JAMRI_APP.voicePTT) {
            if (window.JAMRI_APP.voicePTT.isSpeaking && window.JAMRI_APP.voicePTT.currentChannel === 'karaoke') {
                window.JAMRI_APP.voicePTT.stopSpeaking();
            }
        }
    }

    ensureModal() {
        if (this.modalEl) return;

        this.modalEl = document.createElement('div');
        this.modalEl.id = 'jamri-lyrics-modal';
        this.modalEl.className = 'modal-backdrop jamri-lyrics-overlay';
        this.modalEl.style.cssText = `
            display: none;
            position: fixed;
            inset: 0;
            z-index: 10000;
            background: rgba(0, 0, 0, 0.72);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            align-items: center;
            justify-content: center;
            padding: 16px;
        `;

        this.modalEl.addEventListener('click', (e) => {
            if (e.target === this.modalEl) {
                this.closeModal();
            }
        });

        document.body.appendChild(this.modalEl);
    }

    renderModalContent() {
        if (!this.modalEl) return;

        const track = this.currentTrack || (this.player && this.player.currentTrack);
        const title = track ? track.title : 'Tidak Ada Lagu';
        const artist = track ? (track.channel || track.artist || 'Artis Tidak Diketahui') : '';
        const thumb = track ? (track.thumbnail_url || track.thumbnail || '') : '';

        const isSynced = this.lyricsData && this.lyricsData.synced && this.parsedLines.length > 0;
        const isPlain = this.lyricsData && this.lyricsData.found && !isSynced && !!this.lyricsData.plain_lyrics;
        const notFound = this.lyricsData && !this.lyricsData.found;

        this.modalEl.innerHTML = `
            <div class="lyrics-modal-card" style="
                max-width: 680px;
                width: 100%;
                height: 86vh;
                max-height: 820px;
                border-radius: var(--radius-lg);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                position: relative;
            ">
                <!-- Header (Sticky, 2 Structured Rows) -->
                <div class="lyrics-header">
                    <!-- Row 1: Track Info, Sync Badge, & Actions -->
                    <div class="lyrics-header-main-row">
                        <div class="lyrics-track-info">
                            ${this.getCoverHtml(thumb, 40)}
                            <div class="lyrics-track-meta">
                                <div class="lyrics-track-title" title="${this.escape(title)}">${this.escape(title)}</div>
                                <div class="lyrics-track-artist">${this.escape(artist)}</div>
                            </div>
                            ${isSynced ? `
                                <span class="lyrics-sync-badge synced" title="Lirik disinkronkan secara otomatis secara realtime">
                                    <span class="sync-dot"></span>
                                    <span class="sync-text">Sinkron</span>
                                </span>
                            ` : (isPlain ? `
                                <span class="lyrics-sync-badge plain" title="Lirik teks biasa tanpa sinkronisasi waktu">
                                    <span class="sync-text">Teks Polos</span>
                                </span>
                            ` : '')}
                        </div>

                        <div class="lyrics-header-actions">
                            ${this.getPiPDropdownHtml()}
                            <button type="button" id="btn-lyrics-search-toggle" class="btn btn-ghost btn-icon btn-sm" title="Cari Lirik Manual">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="11" cy="11" r="8"></circle>
                                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                </svg>
                            </button>
                            <button type="button" id="btn-close-lyrics" class="btn btn-ghost btn-icon btn-sm" title="Tutup (Esc)">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                </svg>
                            </button>
                        </div>
                    </div>

                    <!-- Row 2: Dedicated Karaoke Voice & Hearing Controls (Full-width, Touch-friendly) -->
                    <div class="lyrics-header-controls-row">
                        <button type="button" class="btn-karaoke-ptt" title="Tahan tombol ini atau tombol [V] di keyboard untuk bernyanyi karaoke bareng">
                            <span class="ptt-icon">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                                    <line x1="12" y1="19" x2="12" y2="23"></line>
                                    <line x1="8" y1="23" x2="16" y2="23"></line>
                                </svg>
                            </span>
                            <span class="ptt-text">PTT Karaoke <kbd>V</kbd></span>
                            <span class="ptt-waves"><span></span><span></span><span></span></span>
                        </button>

                        <button type="button" class="btn btn-outline btn-sm btn-hear-karaoke" title="Dengarkan atau bisukan suara karaoke dari peserta lain">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
                                <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
                            </svg>
                            <span class="hear-karaoke-label">Karaoke Lain: Terdengar</span>
                        </button>
                    </div>
                </div>

                <!-- Active Karaoke Singers Bar -->
                <div class="karaoke-active-singers-bar" style="display:none; margin:8px 22px 0 22px;"></div>

                <!-- Search Panel with Candidate Selector (Collapsible) -->
                ${this.getSearchPanelHtml(title !== 'Tidak Ada Lagu' ? `${title} ${artist}`.trim() : '')}

                <!-- Lyrics Content Area -->
                <div id="jamri-lyrics-scroll-box" style="
                    flex: 1;
                    overflow-y: auto;
                    padding: 36px 28px;
                    scroll-behavior: smooth;
                    text-align: center;
                    background: var(--bg-surface);
                ">
                    ${this.renderLyricsBody(isSynced, isPlain, notFound)}
                </div>

                <!-- Footer with Bottom-Right Floating PiP Button -->
                ${this.getFooterHtml(true)}
            </div>
        `;

        this.bindModalEvents();
    }

    renderLyricsBody(isSynced, isPlain, notFound) {
        if (this.isLoading) {
            return `
                <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:14px; color:var(--text-muted);">
                    <div style="width:32px; height:32px; border:3px solid var(--border-subtle); border-top-color:var(--primary); border-radius:50%; animation:spin 0.8s linear infinite;"></div>
                    <div style="font-size:13px; font-weight:600;">Mencari lirik lagu di LRCLIB...</div>
                </div>
                <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
            `;
        }

        if (isSynced) {
            return this.parsedLines.map((line, idx) => `
                <div class="lyric-line-item ${idx === this.activeLineIdx ? 'active-line' : ''}" 
                     data-idx="${idx}" 
                     data-time="${line.time}">
                    ${this.escape(line.text)}
                </div>
            `).join('');
        }

        if (isPlain) {
            const formatted = this.escape(this.lyricsData.plain_lyrics)
                .split('\n')
                .map(line => line.trim() === '' ? '<br/>' : `<div style="margin:6px 0; font-size:16px; line-height:1.7; color:var(--text-primary); font-weight:500;">${line}</div>`)
                .join('');

            return `
                <div style="max-width:520px; margin:0 auto; text-align:center; padding:10px 0;">
                    ${formatted}
                </div>
            `;
        }

        return `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:12px; color:var(--text-muted); padding:30px 16px;">
                <div style="width:48px; height:48px; border-radius:50%; background:var(--bg-surface-elevated); border:1px solid var(--border-subtle); display:flex; align-items:center; justify-content:center; color:var(--text-secondary);">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 18V5l12-2v13"></path>
                        <circle cx="6" cy="18" r="3"></circle>
                        <circle cx="18" cy="16" r="3"></circle>
                    </svg>
                </div>
                <div style="font-size:15px; font-weight:700; color:var(--text-primary);">Lirik Belum Tersedia</div>
                <div style="font-size:13px; max-width:360px; line-height:1.5; color:var(--text-secondary);">
                    ${this.escape(this.lyricsData ? this.lyricsData.message : 'Lirik untuk lagu ini tidak ditemukan otomatis.')}
                </div>
                <button type="button" class="btn btn-primary btn-sm btn-trigger-search" style="margin-top:6px; display:inline-flex; align-items:center; gap:6px;">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    <span>Cari & Pilih Lirik di LRCLIB</span>
                </button>
            </div>
        `;
    }

    bindModalEvents() {
        this.bindPiPDropdown(this.modalEl);
        this.bindSearchEvents(this.modalEl);
        const btnClose = this.modalEl.querySelector('#btn-close-lyrics');
        if (btnClose) {
            btnClose.addEventListener('click', () => this.closeModal());
        }

        const btnKaraokePtt = this.modalEl.querySelector('.btn-karaoke-ptt');
        if (btnKaraokePtt && window.JAMRI_APP && window.JAMRI_APP.voicePTT) {
            window.JAMRI_APP.voicePTT.bindKaraokePTTButton(btnKaraokePtt);
        }

        const btnHearKaraoke = this.modalEl.querySelector('.btn-hear-karaoke');
        if (btnHearKaraoke) {
            btnHearKaraoke.addEventListener('click', () => {
                if (window.JAMRI_APP && window.JAMRI_APP.voicePTT) {
                    window.JAMRI_APP.voicePTT.toggleKaraokeMuted();
                }
            });
            if (window.JAMRI_APP && window.JAMRI_APP.voicePTT) {
                window.JAMRI_APP.voicePTT.updateKaraokeMuteUI();
            }
        }

        const container = document.getElementById('jamri-lyrics-scroll-box');
        if (container) {
            container.addEventListener('wheel', () => this.registerUserScroll(), { passive: true });
            container.addEventListener('touchmove', () => this.registerUserScroll(), { passive: true });

            container.querySelectorAll('.lyric-line-item').forEach(el => {
                el.addEventListener('click', () => {
                    const time = parseFloat(el.getAttribute('data-time'));
                    this.handleSeekClick(time);
                });
            });
        }
    }

    handleSeekClick(time) {
        if (isNaN(time) || !this.player) return;

        if (window.JAMRI_APP && window.JAMRI_APP.currentView === 'room' && window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
            window.JAMRI_APP.games.notifyPunishedAction('melompat (seek) ke menit lirik');
            return;
        }

        if (this.player.mode === 'jamming' && this.ws && this.ws.isConnected) {
            this.ws.sendSeek(time);
        } else {
            this.player.seek(time);
        }
    }

    registerUserScroll() {
        this.isUserScrolling = true;
        if (this.scrollDebounceTimer) clearTimeout(this.scrollDebounceTimer);
        this.scrollDebounceTimer = setTimeout(() => {
            this.isUserScrolling = false;
        }, 3200);
    }

    formatTime(sec) {
        if (!sec || isNaN(sec) || sec < 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    getPiPDropdownHtml() {
        const isOpen = !!(this.pipWindow && !this.pipWindow.closed);
        return `
            <div class="lyrics-pip-dropdown-wrapper">
                <button type="button" class="btn btn-ghost btn-icon btn-sm btn-lyrics-pip ${isOpen ? 'btn-primary' : ''}" title="Buka Floating Picture-in-Picture (Desktop)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="2" y="3" width="20" height="14" rx="2"></rect>
                        <rect x="11" y="9" width="9" height="7" rx="1" fill="currentColor" opacity="0.35"></rect>
                        <rect x="11" y="9" width="9" height="7" rx="1"></rect>
                    </svg>
                </button>
                <div class="lyrics-pip-menu" style="display:none;">
                    <button type="button" class="pip-menu-item" data-pip-mode="mini">
                        <span class="pip-menu-badge">Minimalis</span>
                        <div class="pip-menu-text">
                            <strong>Thumbnail + Navigasi</strong>
                            <small>Tanpa lirik, kontrol musik ringkas</small>
                        </div>
                    </button>
                    <button type="button" class="pip-menu-item" data-pip-mode="full">
                        <span class="pip-menu-badge">Lengkap</span>
                        <div class="pip-menu-text">
                            <strong>Navigasi + Lirik</strong>
                            <small>Judul, seek, play/pause &amp; lirik</small>
                        </div>
                    </button>
                    <button type="button" class="pip-menu-item" data-pip-mode="lyrics">
                        <span class="pip-menu-badge">Lirik Saja</span>
                        <div class="pip-menu-text">
                            <strong>Teks Lirik Minimalis</strong>
                            <small>Fokus lirik auto-scroll</small>
                        </div>
                    </button>
                </div>
            </div>
        `;
    }

    getFooterHtml(isModal = false) {
        return `
            <div class="embedded-lyrics-footer">
                <span>Klik lirik untuk melompat (seek)</span>
                <span>Sumber: <a href="https://lrclib.net" target="_blank" rel="noopener" style="color:var(--primary); text-decoration:none; font-weight:600;">LRCLIB</a></span>
            </div>
        `;
    }

    getSearchPanelHtml(defaultQuery = '') {
        return `
            <div class="embedded-lyrics-search-panel" style="display:none;">
                <form class="embedded-lyrics-search-form">
                    <div class="lyrics-search-input-wrapper">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"></circle>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                        </svg>
                        <input type="text" class="embedded-lyrics-search-input" placeholder="Ketik judul lagu atau nama artis di LRCLIB..." value="${this.escape(defaultQuery)}" />
                    </div>
                    <button type="submit" class="btn btn-primary btn-sm">Cari</button>
                    <button type="button" class="btn btn-ghost btn-sm btn-close-search" title="Tutup Pencarian">✕</button>
                </form>
                <div class="lyrics-search-results-box" style="display:none;">
                    <div class="lyrics-search-status"></div>
                    <div class="lyrics-search-results-list"></div>
                </div>
            </div>
        `;
    }

    bindSearchEvents(container) {
        const searchToggle = container.querySelector('.btn-embedded-search-toggle') || container.querySelector('#btn-lyrics-search-toggle');
        const searchPanel = container.querySelector('.embedded-lyrics-search-panel');
        const searchForm = container.querySelector('.embedded-lyrics-search-form');
        const searchInput = container.querySelector('.embedded-lyrics-search-input');
        const btnCloseSearch = container.querySelector('.btn-close-search');
        const triggerBtns = container.querySelectorAll('.btn-trigger-search');

        const openSearch = (autoSubmit = false) => {
            if (!searchPanel) return;
            searchPanel.style.display = 'flex';
            if (searchInput) {
                if (!searchInput.value.trim() && this.currentTrack) {
                    const t = this.currentTrack;
                    searchInput.value = `${t.title || ''} ${t.channel || t.artist || ''}`.trim();
                }
                searchInput.focus();
                if (autoSubmit && searchInput.value.trim()) {
                    this.executeLyricsSearch(container, searchInput.value.trim());
                }
            }
        };

        if (searchToggle && searchPanel) {
            searchToggle.addEventListener('click', () => {
                if (searchPanel.style.display === 'none') {
                    openSearch();
                } else {
                    searchPanel.style.display = 'none';
                }
            });
        }

        if (btnCloseSearch && searchPanel) {
            btnCloseSearch.addEventListener('click', () => {
                searchPanel.style.display = 'none';
            });
        }

        triggerBtns.forEach(btn => {
            btn.addEventListener('click', () => openSearch(true));
        });

        if (searchForm && searchInput) {
            searchForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const q = searchInput.value.trim();
                if (q) {
                    this.executeLyricsSearch(container, q);
                }
            });
        }
    }

    async executeLyricsSearch(container, query) {
        const resultsBox = container.querySelector('.lyrics-search-results-box');
        const statusEl = container.querySelector('.lyrics-search-status');
        const listEl = container.querySelector('.lyrics-search-results-list');
        if (!resultsBox || !statusEl || !listEl) return;

        resultsBox.style.display = 'block';
        statusEl.innerHTML = `<span style="display:inline-flex; align-items:center; gap:6px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> Mencari lirik untuk "${this.escape(query)}"...</span>`;
        listEl.innerHTML = '';

        try {
            const res = await fetch(`api/lyrics.php?action=search&q=${encodeURIComponent(query)}`);
            const data = await res.json();

            if (!data.success || !data.results || data.results.length === 0) {
                statusEl.textContent = `Tidak ada hasil lirik untuk "${query}". Coba sederhanakan judul atau nama artis.`;
                return;
            }

            statusEl.innerHTML = `Ditemukan <strong>${data.results.length}</strong> pilihan. Klik lagu yang sesuai untuk diterapkan:`;
            listEl.innerHTML = data.results.map(item => `
                <div class="lyrics-result-item" data-id="${item.id}" title="Klik untuk menerapkan lirik ini">
                    <div class="lyrics-result-info">
                        <div class="lyrics-result-title">${this.escape(item.track_name)}</div>
                        <div class="lyrics-result-artist">${this.escape(item.artist_name)} ${item.album_name ? `• ${this.escape(item.album_name)}` : ''}</div>
                    </div>
                    <div class="lyrics-result-badges">
                        ${item.synced ? `<span class="badge-synced">🟢 Sinkron (${this.formatTime(item.duration)})</span>` : (item.plain ? `<span class="badge-plain">🔵 Teks Polos</span>` : (item.instrumental ? `<span class="badge-plain">⚪ Instrumental</span>` : ''))}
                        <button type="button" class="btn btn-primary btn-xs" style="pointer-events:none;">Pilih</button>
                    </div>
                </div>
            `).join('');

            listEl.querySelectorAll('.lyrics-result-item').forEach(itemEl => {
                itemEl.addEventListener('click', async () => {
                    const id = parseInt(itemEl.dataset.id, 10);
                    itemEl.style.opacity = '0.5';
                    await this.loadLyricById(id);
                    const searchPanel = container.querySelector('.embedded-lyrics-search-panel');
                    if (searchPanel) searchPanel.style.display = 'none';
                });
            });
        } catch (err) {
            console.error('[Lyrics Search] Error:', err);
            statusEl.textContent = 'Gagal melakukan pencarian lirik ke server.';
        }
    }

    async loadLyricById(id) {
        if (!id) return;
        this.isLoading = true;
        this.renderAllViews();

        try {
            const res = await fetch(`api/lyrics.php?action=get&id=${id}`);
            const data = await res.json();
            this.isLoading = false;

            if (data.found) {
                this.lyricsData = data;
                if (data.synced && data.synced_lyrics) {
                    this.parsedLines = this.parseLrc(data.synced_lyrics);
                } else {
                    this.parsedLines = [];
                }
                this.activeLineIdx = -1;
                this.renderAllViews();

                if (this.player) {
                    const cur = this.player.currentTime || 0;
                    this.highlightActiveLine(cur, true);
                }

                if (window.JAMRI_APP && window.JAMRI_APP.showToast) {
                    window.JAMRI_APP.showToast(`Lirik "${data.track_name}" berhasil diterapkan!`, 'success');
                }
            } else {
                alert(data.message || 'Gagal memuat lirik untuk ID tersebut.');
            }
        } catch (err) {
            console.error('[Lyrics] loadLyricById error:', err);
            this.isLoading = false;
            this.renderAllViews();
        }
    }

    bindPiPDropdown(container) {
        container.querySelectorAll('.lyrics-pip-dropdown-wrapper').forEach(wrapper => {
            const pipBtn = wrapper.querySelector('.btn-lyrics-pip');
            const pipMenu = wrapper.querySelector('.lyrics-pip-menu');
            if (!pipBtn || !pipMenu) return;

            pipBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isShowing = pipMenu.style.display === 'flex';
                document.querySelectorAll('.lyrics-pip-menu').forEach(m => m.style.display = 'none');
                pipMenu.style.display = isShowing ? 'none' : 'flex';
            });

            pipMenu.querySelectorAll('.pip-menu-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    pipMenu.style.display = 'none';
                    const mode = item.dataset.pipMode || 'full';
                    this.openPiP(mode);
                });
            });
        });
    }

    async openPiP(mode = 'full') {
        this.pipMode = mode;
        try {
            localStorage.setItem('jamri_pip_mode', mode);
        } catch (e) {}

        if (this.pipWindow && !this.pipWindow.closed) {
            this.renderPiPContent();
            try { this.pipWindow.focus(); } catch (e) {}
            return;
        }

        const width = mode === 'full' ? 420 : (mode === 'mini' ? 340 : 360);
        const height = mode === 'full' ? 560 : (mode === 'mini' ? 200 : 460);

        try {
            if ('documentPictureInPicture' in window && typeof window.documentPictureInPicture.requestWindow === 'function') {
                this.pipWindow = await window.documentPictureInPicture.requestWindow({
                    width: width,
                    height: height
                });
            } else {
                // Fallback popup window for browsers without Document PiP (e.g. Firefox)
                const left = Math.max(0, (window.screen.width || 1200) - width - 30);
                const top = 50;
                this.pipWindow = window.open('', 'JamriLyricsPiP', `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no,status=no,toolbar=no,menubar=no`);
            }
        } catch (err) {
            console.error('[Lyrics PiP] Failed to open PiP window:', err);
            if (window.JAMRI_APP && window.JAMRI_APP.showToast) {
                window.JAMRI_APP.showToast('Gagal membuka Picture-in-Picture: ' + (err.message || err), 'error');
            }
            return;
        }

        if (!this.pipWindow) {
            if (window.JAMRI_APP && window.JAMRI_APP.showToast) {
                window.JAMRI_APP.showToast('Popup Picture-in-Picture diblokir browser. Mohon izinkan pop-up.', 'warning');
            }
            return;
        }

        this.setupPiPStyles(this.pipWindow);
        this.renderPiPContent();

        const handleClose = () => {
            this.pipWindow = null;
            this.updatePiPButtonState();
        };
        this.pipCloseHandler = handleClose;
        this.pipWindow.addEventListener('pagehide', handleClose);
        this.pipWindow.addEventListener('unload', handleClose);

        this.updatePiPButtonState();
    }

    /**
     * Release every listener/timer the lyrics engine holds for the PiP window
     * and the modal. Called when a room/solo session is torn down so the
     * pagehide/unload handlers, the scroll debounce timer and the embedded
     * container registry do not accumulate across re-renders.
     */
    teardown() {
        if (this.pipWindow) {
            if (this.pipCloseHandler) {
                try {
                    this.pipWindow.removeEventListener('pagehide', this.pipCloseHandler);
                    this.pipWindow.removeEventListener('unload', this.pipCloseHandler);
                } catch (e) {}
            }
            try {
                if (!this.pipWindow.closed) this.pipWindow.close();
            } catch (e) {}
        }
        this.pipWindow = null;
        this.pipCloseHandler = null;

        if (this.scrollDebounceTimer) {
            clearTimeout(this.scrollDebounceTimer);
            this.scrollDebounceTimer = null;
        }
        this.isUserScrolling = false;

        this.embeddedContainers.clear();

        if (this.isOpen) {
            this.closeModal();
        }
        this.updatePiPButtonState();
    }

    setupPiPStyles(pipWin) {
        const doc = pipWin.document;
        doc.title = 'Jamri Karaoke PiP';

        const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
        doc.documentElement.setAttribute('data-theme', currentTheme);

        document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
            const newLink = doc.createElement('link');
            newLink.rel = 'stylesheet';
            newLink.href = link.href;
            doc.head.appendChild(newLink);
        });

        document.querySelectorAll('style').forEach(style => {
            const newStyle = doc.createElement('style');
            newStyle.textContent = style.textContent;
            doc.head.appendChild(newStyle);
        });

        const pipStyle = doc.createElement('style');
        pipStyle.textContent = `
            html, body {
                margin: 0;
                padding: 0;
                width: 100%;
                height: 100%;
                overflow: hidden;
                background: var(--bg-surface, #0f172a);
                color: var(--text-primary, #f8fafc);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                display: flex;
                flex-direction: column;
                user-select: none;
            }
            * { box-sizing: border-box; }
            .pip-container {
                display: flex;
                flex-direction: column;
                height: 100%;
                width: 100%;
                overflow: hidden;
            }
            .pip-top-bar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 12px;
                background: var(--bg-surface-elevated, #1e293b);
                border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
                flex-shrink: 0;
                gap: 8px;
            }
            .pip-brand {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
                font-weight: 700;
                color: var(--primary, #3b82f6);
                letter-spacing: 0.5px;
            }
            .pip-mode-badge {
                font-size: 10px;
                padding: 3px 8px;
                border-radius: 12px;
                background: var(--primary-light, rgba(59,130,246,0.15));
                color: var(--primary, #3b82f6);
                cursor: pointer;
                border: 1px solid rgba(59,130,246,0.3);
                font-weight: 600;
                transition: all 0.2s ease;
            }
            .pip-mode-badge:hover {
                background: var(--primary, #3b82f6);
                color: #ffffff;
            }
            .pip-track-card {
                padding: 8px 12px;
                display: flex;
                align-items: center;
                gap: 10px;
                background: var(--bg-surface, #0f172a);
                border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
                flex-shrink: 0;
            }
            .pip-track-meta {
                min-width: 0;
                flex: 1;
            }
            .pip-track-title {
                font-size: 13px;
                font-weight: 700;
                color: var(--text-primary, #f8fafc);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .pip-track-artist {
                font-size: 11px;
                color: var(--text-secondary, #94a3b8);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                margin-top: 1px;
            }
            .pip-controls-card {
                padding: 8px 12px 10px;
                background: var(--bg-surface-elevated, #1e293b);
                border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
                display: flex;
                flex-direction: column;
                gap: 6px;
                flex-shrink: 0;
            }
            .pip-progress-row {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 10px;
                color: var(--text-muted, #64748b);
                font-variant-numeric: tabular-nums;
            }
            .pip-slider {
                flex: 1;
                height: 4px;
                border-radius: 2px;
                accent-color: var(--primary, #3b82f6);
                cursor: pointer;
            }
            .pip-nav-row {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 12px;
                padding: 4px 0;
            }
            .pip-vol-row {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                padding: 4px 0 2px;
                color: var(--text-muted, #64748b);
            }
            .pip-vol-slider-wide {
                width: 100px;
            }
            .pip-btn {
                background: transparent;
                border: none;
                color: var(--text-primary, #f8fafc);
                cursor: pointer;
                padding: 6px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.15s ease;
            }
            .pip-btn:hover {
                background: var(--bg-surface-hover, rgba(255,255,255,0.08));
                color: var(--primary, #3b82f6);
            }
            .pip-btn-play {
                background: var(--primary, #3b82f6);
                color: #ffffff !important;
                border-radius: 50%;
                width: 34px;
                height: 34px;
                padding: 0;
            }
            .pip-btn-play:hover {
                opacity: 0.9;
                transform: scale(1.05);
            }
            .pip-vol-box {
                display: flex;
                align-items: center;
                gap: 6px;
                color: var(--text-muted, #64748b);
            }
            .pip-vol-slider {
                width: 55px;
                height: 4px;
                border-radius: 2px;
                accent-color: var(--primary, #3b82f6);
                cursor: pointer;
            }
            .pip-lyrics-scroll {
                flex: 1;
                overflow-y: auto;
                overflow-x: hidden;
                padding: 16px 14px;
                text-align: center;
                scroll-behavior: smooth;
                background: var(--bg-surface, #0f172a);
            }
            .pip-lyrics-scroll::-webkit-scrollbar {
                width: 5px;
            }
            .pip-lyrics-scroll::-webkit-scrollbar-thumb {
                background: var(--border-color, rgba(255,255,255,0.15));
                border-radius: 3px;
            }
            .pip-lyric-line {
                padding: 6px 10px;
                font-size: 16px;
                line-height: 1.5;
                font-weight: 600;
                color: var(--text-muted, #64748b);
                opacity: 0.45;
                cursor: pointer;
                border-radius: 6px;
                margin: 6px 0;
                transition: all 0.22s ease;
            }
            .pip-lyric-line:hover {
                opacity: 0.85;
                background: var(--bg-surface-hover, rgba(255,255,255,0.06));
            }
            .pip-lyric-line.active-line {
                color: var(--primary, #3b82f6) !important;
                opacity: 1 !important;
                font-weight: 800 !important;
                transform: scale(1.03);
                background: var(--primary-light, rgba(59,130,246,0.15));
            }
            .pip-empty-state {
                padding: 40px 16px;
                color: var(--text-muted, #64748b);
                font-size: 13px;
                text-align: center;
            }
            /* === Mini Mode === */
            .pip-container-mini {
                display: flex;
                flex-direction: column;
                height: 100%;
                width: 100%;
                overflow: hidden;
                gap: 4px;
                padding-bottom: 6px;
            }
            .pip-mini-card {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 8px 12px 6px;
                background: var(--bg-surface-elevated, #1e293b);
                border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
                flex-shrink: 0;
            }
            .pip-mini-thumb {
                width: 36px;
                height: 36px;
                border-radius: 6px;
                object-fit: cover;
                flex-shrink: 0;
            }
            .pip-mini-thumb-placeholder {
                width: 36px;
                height: 36px;
                border-radius: 6px;
                background: var(--bg-surface-hover, rgba(255,255,255,0.06));
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 16px;
                flex-shrink: 0;
            }
            .pip-mini-meta {
                flex: 1;
                min-width: 0;
            }
            .pip-btn-play-lg {
                width: 38px !important;
                height: 38px !important;
            }
            @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
        `;
        doc.head.appendChild(pipStyle);
    }

    renderPiPContent() {
        if (!this.pipWindow || this.pipWindow.closed) return;

        const doc = this.pipWindow.document;
        const track = this.currentTrack || (this.player && this.player.currentTrack);
        const title = track ? track.title : 'Tidak Ada Lagu';
        const artist = track ? (track.channel || track.artist || 'Artis Tidak Diketahui') : '';
        const thumb = track ? (track.thumbnail_url || track.thumbnail || '') : '';
        const isPlaying = !!(this.player && this.player.isPlaying);
        const duration = track ? (track.duration_seconds || track.duration || 0) : 0;
        const currentTime = (this.player && this.player.currentTime) || 0;
        const volume = (this.player && this.player.volume !== undefined) ? this.player.volume : 0.8;
        const isSynced = this.lyricsData && this.lyricsData.synced && this.parsedLines.length > 0;
        const isPlain = this.lyricsData && this.lyricsData.found && !isSynced && !!this.lyricsData.plain_lyrics;
        const notFound = !this.lyricsData || !this.lyricsData.found;

        let lyricsHtml = '';
        if (this.isLoading) {
            lyricsHtml = `
                <div class="pip-empty-state">
                    <div style="display:inline-block; animation:spin 1s linear infinite; margin-bottom:8px;">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
                    </div>
                    <div>Mencari lirik lagu...</div>
                </div>
            `;
        } else if (isSynced) {
            lyricsHtml = this.parsedLines.map((line, idx) => `
                <div class="pip-lyric-line ${idx === this.activeLineIdx ? 'active-line' : ''}" data-idx="${idx}" data-time="${line.time}">
                    ${this.escape(line.text)}
                </div>
            `).join('');
        } else if (isPlain) {
            lyricsHtml = `
                <div style="font-size:14px; line-height:1.7; white-space:pre-wrap; opacity:0.8; text-align:center; padding:10px;">
                    ${this.escape(this.lyricsData.plain_lyrics)}
                </div>
            `;
        } else {
            lyricsHtml = `
                <div class="pip-empty-state">
                    <div style="font-size:24px; margin-bottom:8px;">🎵</div>
                    <div style="font-weight:600; color:var(--text-primary); margin-bottom:4px;">Lirik Belum Tersedia</div>
                    <div>${this.escape(this.lyricsData && this.lyricsData.message ? this.lyricsData.message : 'Lirik tidak ditemukan di basis data')}</div>
                </div>
            `;
        }

        if (this.pipMode === 'mini') {
            // Minimalist mode: big thumbnail + title/artist + nav controls, no lyrics
            doc.body.innerHTML = `
                <div class="pip-container pip-container-mini">
                    <!-- Mini Track Card -->
                    <div class="pip-mini-card">
                        ${thumb ? `<img src="${this.safeImageUrl(thumb)}" alt="" class="pip-mini-thumb" onerror="this.style.display='none'" />` : `<div class="pip-mini-thumb-placeholder">🎵</div>`}
                        <div class="pip-mini-meta">
                            <div class="pip-track-title" title="${this.escape(title)}">${this.escape(title)}</div>
                            <div class="pip-track-artist">${this.escape(artist)}</div>
                        </div>
                        <button type="button" class="pip-mode-badge" id="pip-btn-toggle-mode" title="Beralih ke mode Lengkap">🎵 Lirik</button>
                    </div>

                    <!-- Progress bar -->
                    <div class="pip-progress-row" style="padding: 0 12px;">
                        <span id="pip-current-time">${this.formatTime(currentTime)}</span>
                        <input type="range" id="pip-seek-slider" class="pip-slider" min="0" max="100" value="${duration > 0 ? (currentTime / duration) * 100 : 0}" />
                        <span id="pip-duration">${this.formatTime(duration)}</span>
                    </div>

                    <!-- Navigation Controls centered -->
                    <div class="pip-nav-row" style="padding: 0 12px;">
                        <button type="button" class="pip-btn" id="pip-btn-prev" title="Lagu Sebelumnya">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2.5"></line></svg>
                        </button>
                        <button type="button" class="pip-btn pip-btn-play pip-btn-play-lg" id="pip-btn-play" title="${isPlaying ? 'Jeda' : 'Putar'}">
                            ${isPlaying
                                ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`
                                : `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>`}
                        </button>
                        <button type="button" class="pip-btn" id="pip-btn-next" title="Lagu Berikutnya">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2.5"></line></svg>
                        </button>
                        <div class="pip-vol-box" title="Volume Suara" style="margin-left:8px;">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                            <input type="range" id="pip-vol-slider" class="pip-vol-slider" min="0" max="1" step="0.05" value="${volume}" />
                        </div>
                    </div>
                </div>
            `;
        } else if (this.pipMode === 'full') {
            doc.body.innerHTML = `
                <div class="pip-container">
                    <!-- Top Bar -->
                    <div class="pip-top-bar">
                        <div class="pip-brand">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
                            <span>JAMRI PiP</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:6px;">
                            ${isSynced ? `<span style="font-size:9px; font-weight:700; background:rgba(34,197,94,0.15); color:#22c55e; border:1px solid rgba(34,197,94,0.3); border-radius:10px; padding:1px 6px;">Sinkron</span>` : ''}
                            <button type="button" class="pip-mode-badge" id="pip-btn-toggle-mode" title="Klik untuk beralih ke mode lirik saja">
                                📄 Lirik Saja
                            </button>
                        </div>
                    </div>

                    <!-- Track Info -->
                    <div class="pip-track-card">
                        ${this.getCoverHtml(thumb, 38)}
                        <div class="pip-track-meta">
                            <div class="pip-track-title" title="${this.escape(title)}">${this.escape(title)}</div>
                            <div class="pip-track-artist">${this.escape(artist)}</div>
                        </div>
                    </div>

                    <!-- Player Navigation & Controls -->
                    <div class="pip-controls-card">
                        <div class="pip-progress-row">
                            <span id="pip-current-time">${this.formatTime(currentTime)}</span>
                            <input type="range" id="pip-seek-slider" class="pip-slider" min="0" max="100" value="${duration > 0 ? (currentTime / duration) * 100 : 0}" />
                            <span id="pip-duration">${this.formatTime(duration)}</span>
                        </div>
                        <div class="pip-nav-row">
                            <button type="button" class="pip-btn" id="pip-btn-prev" title="Lagu Sebelumnya">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2.5"></line></svg>
                            </button>
                            <button type="button" class="pip-btn pip-btn-play" id="pip-btn-play" title="${isPlaying ? 'Jeda' : 'Putar'}">
                                ${isPlaying
                                    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`
                                    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>`}
                            </button>
                            <button type="button" class="pip-btn" id="pip-btn-next" title="Lagu Berikutnya">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2.5"></line></svg>
                            </button>
                        </div>
                        <div class="pip-vol-row">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                            <input type="range" id="pip-vol-slider" class="pip-vol-slider pip-vol-slider-wide" min="0" max="1" step="0.05" value="${volume}" />
                        </div>
                    </div>

                    <!-- Lyrics Scroll -->
                    <div class="pip-lyrics-scroll">
                        ${lyricsHtml}
                    </div>
                </div>
            `;
        } else {
            // Lyrics-only mode
            doc.body.innerHTML = `
                <div class="pip-container">
                    <!-- Compact Top Bar -->
                    <div class="pip-top-bar">
                        <div style="min-width:0; flex:1; display:flex; align-items:center; gap:6px;">
                            <div style="font-size:12px; font-weight:700; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px;" title="${this.escape(title)}">
                                ${this.escape(title)}
                            </div>
                            <span style="font-size:10px; color:var(--text-muted); white-space:nowrap;">• ${this.escape(artist)}</span>
                        </div>
                        <button type="button" class="pip-mode-badge" id="pip-btn-toggle-mode" title="Klik untuk beralih ke mode lengkap dengan kontrol navigasi">
                            🎛️ Lengkap
                        </button>
                    </div>

                    <!-- Lyrics Scroll Area -->
                    <div class="pip-lyrics-scroll" style="font-size:18px;">
                        ${lyricsHtml}
                    </div>
                </div>
            `;
        }

        this.bindPiPEvents();

        if (this.parsedLines.length > 0 && currentTime > 0) {
            this.highlightActiveLine(currentTime, true);
        }
    }

    bindPiPEvents() {
        if (!this.pipWindow || this.pipWindow.closed) return;
        const doc = this.pipWindow.document;

        const btnToggleMode = doc.getElementById('pip-btn-toggle-mode');
        if (btnToggleMode) {
            btnToggleMode.addEventListener('click', () => this.togglePiPMode());
        }

        const checkPerm = () => {
            if (window.JAMRI_APP && window.JAMRI_APP.currentView === 'room' && window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
                window.JAMRI_APP.games.notifyPunishedAction('mengontrol pemutaran musik');
                return false;
            }
            return true;
        };

        const btnPlay = doc.getElementById('pip-btn-play');
        if (btnPlay) {
            btnPlay.addEventListener('click', () => {
                if (!checkPerm()) return;
                if (this.player) this.player.togglePlay();
            });
        }

        const btnPrev = doc.getElementById('pip-btn-prev');
        if (btnPrev) {
            btnPrev.addEventListener('click', () => {
                if (!checkPerm()) return;
                if (this.player) this.player.prev();
            });
        }

        const btnNext = doc.getElementById('pip-btn-next');
        if (btnNext) {
            btnNext.addEventListener('click', () => {
                if (!checkPerm()) return;
                if (this.player) this.player.next();
            });
        }

        const seekSlider = doc.getElementById('pip-seek-slider');
        const curTimeEl = doc.getElementById('pip-current-time');
        if (seekSlider) {
            seekSlider.addEventListener('input', () => {
                this.pipIsDraggingSeek = true;
                const dur = (this.player && typeof this.player.getDuration === 'function') ? this.player.getDuration() : 0;
                const previewSec = (parseFloat(seekSlider.value) / 100) * dur;
                if (curTimeEl) curTimeEl.textContent = this.formatTime(previewSec);
            });
            seekSlider.addEventListener('change', () => {
                this.pipIsDraggingSeek = false;
                if (!checkPerm()) return;
                const dur = (this.player && typeof this.player.getDuration === 'function') ? this.player.getDuration() : 0;
                const targetSec = (parseFloat(seekSlider.value) / 100) * dur;
                this.handleSeekClick(targetSec);
            });
        }

        const volSlider = doc.getElementById('pip-vol-slider');
        if (volSlider) {
            volSlider.addEventListener('input', () => {
                const vol = parseFloat(volSlider.value);
                if (this.player) this.player.setVolume(vol);
            });
        }

        doc.querySelectorAll('.pip-lyric-line').forEach(line => {
            line.addEventListener('click', () => {
                const sec = parseFloat(line.dataset.time);
                if (!isNaN(sec)) {
                    this.handleSeekClick(sec);
                }
            });
        });
    }

    togglePiPMode() {
        // Cycle: full -> lyrics -> mini -> full
        if (this.pipMode === 'full') this.pipMode = 'lyrics';
        else if (this.pipMode === 'lyrics') this.pipMode = 'mini';
        else this.pipMode = 'full';
        try {
            localStorage.setItem('jamri_pip_mode', this.pipMode);
        } catch (e) {}

        if (this.pipWindow && !this.pipWindow.closed) {
            try {
                if (this.pipMode === 'full') {
                    this.pipWindow.resizeTo(420, 560);
                } else if (this.pipMode === 'mini') {
                    this.pipWindow.resizeTo(340, 200);
                } else {
                    this.pipWindow.resizeTo(360, 460);
                }
            } catch (e) {}
            this.renderPiPContent();
        }
    }

    updatePiPButtonState() {
        const isOpen = !!(this.pipWindow && !this.pipWindow.closed);
        document.querySelectorAll('.btn-lyrics-pip').forEach(btn => {
            btn.classList.toggle('btn-primary', isOpen);
            btn.classList.toggle('btn-ghost', !isOpen);
            btn.title = isOpen ? 'Picture-in-Picture Aktif (Klik untuk opsi / fokus)' : 'Buka Floating Picture-in-Picture (Desktop)';
        });
    }

    updatePiPPlaybackState() {
        if (!this.pipWindow || this.pipWindow.closed) return;
        const playBtn = this.pipWindow.document.getElementById('pip-btn-play');
        if (playBtn && this.player) {
            const isPlaying = !!this.player.isPlaying;
            playBtn.innerHTML = isPlaying
                ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`
                : `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>`;
            playBtn.title = isPlaying ? 'Jeda' : 'Putar';
        }
    }

    updatePiPVolume(vol) {
        if (!this.pipWindow || this.pipWindow.closed) return;
        const volSlider = this.pipWindow.document.getElementById('pip-vol-slider');
        if (volSlider && !isNaN(vol)) {
            volSlider.value = vol;
        }
    }

    escape(str) {
        return (str || '').replace(/[&<>"']/g, m => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[m]));
    }

    /** Restrict artwork to YouTube image hosts (blocks javascript:/data: srcs). */
    safeImageUrl(url) {
        if (typeof url !== 'string' || url.length === 0 || url.length > 512) return '';
        if (/[<>"'\s]/.test(url)) return '';
        try {
            const u = new URL(url, window.location.origin);
            if (u.protocol !== 'https:') return '';
            const allowed = ['i.ytimg.com', 'img.youtube.com', 'yt3.ggpht.com', 'i9.ytimg.com'];
            return allowed.includes(u.hostname.toLowerCase()) ? u.href : '';
        } catch (e) {
            return '';
        }
    }
}

window.JamriLyricsManager = JamriLyricsManager;
