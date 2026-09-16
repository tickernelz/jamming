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

        this.initKeyListeners();
    }

    attach(player, ws) {
        this.player = player;
        this.ws = ws;

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
                            nextEl.scrollIntoView({
                                behavior: 'smooth',
                                block: 'center'
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
            if (el) this.renderEmbedded(el);
        });
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

    renderEmbedded(container) {
        if (!container) return;

        const track = this.currentTrack || (this.player && this.player.currentTrack);
        const title = track ? track.title : 'Tidak Ada Lagu';
        const artist = track ? (track.channel || track.artist || 'Artis Tidak Diketahui') : '';
        const thumb = track ? (track.thumbnail_url || track.thumbnail || 'public/img/default-thumb.png') : 'public/img/default-thumb.png';

        const isSynced = this.lyricsData && this.lyricsData.synced && this.parsedLines.length > 0;
        const isPlain = this.lyricsData && this.lyricsData.found && !isSynced && !!this.lyricsData.plain_lyrics;
        const notFound = this.lyricsData && !this.lyricsData.found;

        container.innerHTML = `
            <div class="embedded-lyrics-box">
                <!-- Header -->
                <div class="embedded-lyrics-header">
                    <div style="display:flex; align-items:center; gap:10px; min-width:0;">
                        <img src="${this.escape(thumb)}" alt="Cover" style="width:36px; height:36px; border-radius:var(--radius-sm); object-fit:cover; flex-shrink:0; border:1px solid var(--border-subtle);" />
                        <div style="min-width:0;">
                            <div style="font-size:13px; font-weight:700; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${this.escape(title)}">
                                ${this.escape(title)}
                            </div>
                            <div style="font-size:11px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                ${this.escape(artist)}
                            </div>
                        </div>
                    </div>

                    <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                        <!-- Dedicated Karaoke PTT Button -->
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

                        ${isSynced ? `
                            <span style="font-size:10px; font-weight:700; padding:2px 8px; border-radius:12px; background:var(--success-light); color:var(--success); border:1px solid rgba(22,163,74,0.3);">
                                Sinkron Real-Time
                            </span>
                        ` : (isPlain ? `
                            <span style="font-size:10px; font-weight:700; padding:2px 8px; border-radius:12px; background:var(--primary-light); color:var(--primary); border:1px solid rgba(37,99,235,0.3);">
                                Teks Polos
                            </span>
                        ` : '')}

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

                <!-- Active Karaoke Singers Bar -->
                <div class="karaoke-active-singers-bar" style="display:none; margin:8px 16px 0 16px;"></div>

                <!-- Search Bar (Collapsible) -->
                <div class="embedded-lyrics-search-bar" style="display:none; padding:10px 16px; background:var(--bg-surface-elevated); border-bottom:1px solid var(--border-subtle);">
                    <form class="embedded-lyrics-search-form" style="display:flex; gap:8px;">
                        <input type="text" class="embedded-lyrics-search-input" placeholder="Masukkan judul lagu / artis..." style="flex:1; background:var(--bg-surface); border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:6px 12px; color:var(--text-primary); font-size:12px; outline:none;" />
                        <button type="submit" class="btn btn-primary btn-sm">Cari</button>
                    </form>
                </div>

                <!-- Scrollable Karaoke Lyrics -->
                <div class="embedded-lyrics-scroll">
                    ${this.renderLyricsBody(isSynced, isPlain, notFound)}
                </div>

                <!-- Footer -->
                <div class="embedded-lyrics-footer">
                    <span>Klik baris lirik untuk melompat (seek). Tahan <strong>[V]</strong> untuk bernyanyi bareng via PTT.</span>
                    <span>Basis data: <a href="https://lrclib.net" target="_blank" rel="noopener" style="color:var(--primary); text-decoration:none; font-weight:600;">LRCLIB</a></span>
                </div>
            </div>
        `;

        this.bindEmbeddedEvents(container);
    }

    bindEmbeddedEvents(container) {
        const searchToggle = container.querySelector('.btn-embedded-search-toggle');
        const searchBar = container.querySelector('.embedded-lyrics-search-bar');
        const searchForm = container.querySelector('.embedded-lyrics-search-form');
        const searchInput = container.querySelector('.embedded-lyrics-search-input');
        const btnFullscreen = container.querySelector('.btn-embedded-fullscreen');
        const btnKaraokePtt = container.querySelector('.btn-karaoke-ptt');

        if (btnKaraokePtt && window.JAMRI_APP && window.JAMRI_APP.voicePTT) {
            window.JAMRI_APP.voicePTT.bindKaraokePTTButton(btnKaraokePtt);
        }

        if (btnFullscreen) {
            btnFullscreen.addEventListener('click', () => this.openModal());
        }

        if (searchToggle && searchBar) {
            searchToggle.addEventListener('click', () => {
                const isHidden = searchBar.style.display === 'none';
                searchBar.style.display = isHidden ? 'block' : 'none';
                if (isHidden && searchInput) searchInput.focus();
            });
        }

        if (searchForm && searchInput) {
            searchForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const q = searchInput.value.trim();
                if (q) {
                    this.fetchAndRenderLyrics(this.currentTrack, q);
                }
            });
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
        const thumb = track ? (track.thumbnail_url || track.thumbnail || 'public/img/default-thumb.png') : 'public/img/default-thumb.png';

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
                <!-- Header -->
                <div class="lyrics-header" style="
                    padding: 18px 22px;
                    border-bottom: 1px solid var(--border-subtle);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    background: var(--bg-surface-elevated);
                    gap: 14px;
                ">
                    <div style="display:flex; align-items:center; gap:12px; min-width:0;">
                        <img src="${this.escape(thumb)}" alt="Cover" style="width:42px; height:42px; border-radius:var(--radius-sm); object-fit:cover; flex-shrink:0; border:1px solid var(--border-subtle);" />
                        <div style="min-width:0;">
                            <div style="font-size:15px; font-weight:700; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${this.escape(title)}">
                                ${this.escape(title)}
                            </div>
                            <div style="font-size:12px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                ${this.escape(artist)}
                            </div>
                        </div>
                    </div>

                    <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                        <!-- Dedicated Karaoke PTT Button -->
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

                        ${isSynced ? `
                            <span style="display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:700; padding:3px 8px; border-radius:12px; background:var(--success-light); color:var(--success); border:1px solid rgba(22,163,74,0.3);">
                                <span style="width:6px; height:6px; border-radius:50%; background:var(--success);"></span>
                                Sinkron Real-Time
                            </span>
                        ` : (isPlain ? `
                            <span style="font-size:11px; font-weight:700; padding:3px 8px; border-radius:12px; background:var(--primary-light); color:var(--primary); border:1px solid rgba(37,99,235,0.3);">
                                Teks Polos
                            </span>
                        ` : '')}

                        <button type="button" id="btn-lyrics-search-toggle" class="btn btn-ghost btn-icon btn-sm" title="Cari Lirik Berdasarkan Kata Kunci">
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

                <!-- Active Karaoke Singers Bar -->
                <div class="karaoke-active-singers-bar" style="display:none; margin:8px 22px 0 22px;"></div>

                <!-- Search Bar -->
                <div id="lyrics-search-bar" style="display:none; padding:12px 20px; background:var(--bg-surface-elevated); border-bottom:1px solid var(--border-subtle);">
                    <form id="lyrics-search-form" style="display:flex; gap:8px;">
                        <input type="text" id="lyrics-search-input" placeholder="Masukkan judul lagu / artis (cth: Queen Bohemian Rhapsody)..." style="flex:1; background:var(--bg-surface); border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:7px 12px; color:var(--text-primary); font-size:13px; outline:none;" />
                        <button type="submit" class="btn btn-primary btn-sm">Cari</button>
                    </form>
                </div>

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

                <!-- Footer -->
                <div style="padding:12px 22px; border-top:1px solid var(--border-subtle); display:flex; align-items:center; justify-content:space-between; font-size:11px; color:var(--text-muted); background:var(--bg-surface-elevated);">
                    <div>Klik baris lirik mana saja untuk melompat (seek) ke menit lagu tersebut.</div>
                    <div style="display:flex; align-items:center; gap:4px;">
                        Basis Data: <a href="https://lrclib.net" target="_blank" rel="noopener" style="color:var(--primary); text-decoration:none; font-weight:600;">LRCLIB Open-Source</a>
                    </div>
                </div>
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
            </div>
        `;
    }

    bindModalEvents() {
        const btnClose = this.modalEl.querySelector('#btn-close-lyrics');
        if (btnClose) {
            btnClose.addEventListener('click', () => this.closeModal());
        }

        const btnKaraokePtt = this.modalEl.querySelector('.btn-karaoke-ptt');
        if (btnKaraokePtt && window.JAMRI_APP && window.JAMRI_APP.voicePTT) {
            window.JAMRI_APP.voicePTT.bindKaraokePTTButton(btnKaraokePtt);
        }

        const searchToggle = this.modalEl.querySelector('#btn-lyrics-search-toggle');
        const searchBar = this.modalEl.querySelector('#lyrics-search-bar');
        const searchForm = this.modalEl.querySelector('#lyrics-search-form');
        const searchInput = this.modalEl.querySelector('#lyrics-search-input');

        if (searchToggle && searchBar) {
            searchToggle.addEventListener('click', () => {
                const isHidden = searchBar.style.display === 'none';
                searchBar.style.display = isHidden ? 'block' : 'none';
                if (isHidden && searchInput) searchInput.focus();
            });
        }

        if (searchForm && searchInput) {
            searchForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const q = searchInput.value.trim();
                if (q) {
                    this.fetchAndRenderLyrics(this.currentTrack, q);
                }
            });
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

    escape(str) {
        return (str || '').replace(/[&<>"']/g, m => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[m]));
    }
}

window.JamriLyricsManager = JamriLyricsManager;
