/**
 * search.js
 * YouTube music search modal with Instant Preview before play/queue
 * Fixed modal close button & reliable playback triggers
 * Guardrail: Zero AI emojis in UI, inline SVGs only.
 */

class JamriSearch {
    constructor(player, wsClient = null) {
        this.player = player;
        this.ws = wsClient;
        this.results = [];
        this.activePreviewId = null;

        // Listen for player preview events
        this.player.on('preview_start', (track) => {
            this.activePreviewId = track.youtube_id;
            this.updatePreviewButtons();
        });

        this.player.on('preview_stop', () => {
            this.activePreviewId = null;
            this.updatePreviewButtons();
        });
    }

    setWebSocket(ws) {
        this.ws = ws;
    }

    showModal() {
        let modal = document.getElementById('search-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'search-modal';
            modal.className = 'modal-backdrop';
            modal.innerHTML = `
                <div class="modal-card modal-lg">
                    <div class="modal-header">
                        <div class="modal-title-row">
                            <h2 class="modal-title">Cari Musik</h2>
                            <button type="button" class="btn-close-modal" id="btn-close-search" title="Tutup Modal (Esc)">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                </svg>
                            </button>
                        </div>
                        <form id="search-input-form" class="search-form-row">
                            <div class="search-input-wrapper">
                                <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="11" cy="11" r="8"></circle>
                                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                </svg>
                                <input type="text" id="search-keyword" class="search-input-main" placeholder="Ketik judul lagu, artis, link video, atau link playlist..." autocomplete="off" />
                            </div>
                            <button type="submit" class="btn btn-primary" id="btn-do-search">Cari</button>
                            <button type="button" class="btn btn-outline" id="btn-import-playlist" title="Import semua lagu dari link playlist YouTube ke Bank Musik">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                                </svg>
                                <span>Playlist</span>
                            </button>
                        </form>
                        <!-- Preview Active Banner -->
                        <div id="preview-active-bar" style="display:none; margin-top:10px; padding:8px 12px; background:var(--primary-light); border:1px solid var(--primary-border); border-radius:var(--radius-sm); font-size:12px; display:flex; align-items:center; justify-content:space-between;">
                            <div style="display:flex; align-items:center; gap:8px;">
                                <span class="status-dot playing"></span>
                                <span>Sedang preview: <strong id="preview-active-title"></strong></span>
                            </div>
                            <button type="button" id="btn-stop-preview-bar" class="btn btn-ghost btn-sm" style="padding:2px 8px;">Hentikan Preview</button>
                        </div>
                    </div>
                    <div class="modal-body search-results-body" id="search-results-box">
                        <div class="empty-state" id="search-empty-state">
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="empty-icon">
                                <circle cx="12" cy="12" r="10"></circle>
                                <polygon points="10 8 16 12 10 16 10 8"></polygon>
                            </svg>
                            <p>Ketik judul lagu atau artis untuk mencari musik.</p>
                        </div>
                        <div class="search-list" id="search-list-items" style="display:none;"></div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            // Close button handler (Reliable)
            const btnClose = modal.querySelector('#btn-close-search');
            btnClose.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.closeModal();
            });

            // Backdrop click handler
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeModal();
                }
            });

            // Escape key handler
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && modal.classList.contains('active')) {
                    this.closeModal();
                }
            });

            // Stop preview banner button
            modal.querySelector('#btn-stop-preview-bar').addEventListener('click', () => {
                this.player.stopPreview();
            });

            // Import YouTube playlist into Bank Musik (room or solo)
            const btnImport = modal.querySelector('#btn-import-playlist');
            if (btnImport) {
                btnImport.addEventListener('click', () => {
                    this.importPlaylist();
                });
            }

            const form = modal.querySelector('#search-input-form');
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const q = modal.querySelector('#search-keyword').value.trim();
                if (q !== '') {
                    this.executeSearch(q);
                }
            });
        }

        modal.classList.add('active');
        modal.style.display = 'flex';
        this.updatePreviewBanner();

        setTimeout(() => {
            const input = modal.querySelector('#search-keyword');
            if (input) input.focus();
        }, 100);
    }

    closeModal() {
        const modal = document.getElementById('search-modal');
        if (modal) {
            modal.classList.remove('active');
            modal.style.display = 'none';
        }
        this.player.stopPreview();
    }

    async executeSearch(query) {
        const modal = document.getElementById('search-modal');
        const emptyState = modal.querySelector('#search-empty-state');
        const listItems = modal.querySelector('#search-list-items');
        const btnSearch = modal.querySelector('#btn-do-search');

        btnSearch.disabled = true;
        btnSearch.textContent = 'Mencari...';
        emptyState.style.display = 'none';
        listItems.style.display = 'block';
        listItems.innerHTML = '<div class="loading-spinner-box"><div class="spinner"></div><span>Mencari musik...</span></div>';

        try {
            const res = await fetch(`api/search.php?q=${encodeURIComponent(query)}`);
            const data = await res.json();

            if (!data.success || !data.results || data.results.length === 0) {
                listItems.innerHTML = '<div class="empty-state"><p>Tidak ditemukan lagu untuk pencarian tersebut.</p></div>';
                return;
            }

            this.results = data.results;
            this.renderResults(listItems);
        } catch (e) {
            listItems.innerHTML = '<div class="empty-state text-danger"><p>Koneksi ke backend gagal. Periksa Apache.</p></div>';
        } finally {
            btnSearch.disabled = false;
            btnSearch.textContent = 'Cari';
        }
    }

    renderResults(container) {
        container.innerHTML = '';
        // Labels ("Antrean" vs "Antrean Lokal") follow the writable target, so a
        // user who walked off the mat sees local-mode actions, not mat actions.
        const isJamming = this.hasWritableSharedTarget();

        this.results.forEach((track, idx) => {
            const row = document.createElement('div');
            row.className = 'track-result-item';
            row.dataset.id = track.youtube_id;

            const isThisPreviewing = this.activePreviewId === track.youtube_id;

            row.innerHTML = `
                <div class="track-thumb-box">
                    <img src="${this.safeImageUrl(track.thumbnail)}" alt="" class="track-thumb-img" loading="lazy" />
                    <span class="track-duration-pill">${this.escape(track.duration_formatted || '')}</span>
                </div>
                <div class="track-info-box">
                    <div class="track-title" title="${this.escape(track.title)}">${this.escape(track.title)}</div>
                    <div class="track-channel">${this.escape(track.channel)}</div>
                </div>
                <div class="track-actions-box">
                    <!-- PREVIEW BUTTON -->
                    <button type="button" class="btn btn-sm btn-outline btn-preview-track ${isThisPreviewing ? 'btn-primary' : ''}" data-idx="${idx}" title="Dengarkan preview singkat">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="${isThisPreviewing ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                            ${isThisPreviewing
                                ? '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>'
                                : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>'
                            }
                        </svg>
                        <span>${isThisPreviewing ? 'Stop' : 'Preview'}</span>
                    </button>

                    <!-- PLAY NOW BUTTON -->
                    <button type="button" class="btn btn-sm btn-primary btn-play-now" data-idx="${idx}" title="Putar Sekarang">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                        <span>Putar</span>
                    </button>

                    <!-- ADD TO QUEUE BUTTON -->
                    <button type="button" class="btn btn-sm btn-outline btn-add-queue" data-idx="${idx}" title="Tambah ke Antrean">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        <span>Antrean</span>
                    </button>

                    <!-- ADD TO PLAYLIST BUTTON -->
                    <button type="button" class="btn btn-sm btn-outline btn-add-playlist" data-idx="${idx}" title="Simpan ke Bank Musik">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                        </svg>
                    </button>
                </div>
            `;

            // Preview Handler
            row.querySelector('.btn-preview-track').addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.activePreviewId === track.youtube_id) {
                    this.player.stopPreview();
                } else {
                    this.player.previewTrack(track);
                    this.updatePreviewBanner(track);
                }
            });

            // Play Now Handler
            row.querySelector('.btn-play-now').addEventListener('click', (e) => {
                e.stopPropagation();
                this.player.stopPreview();

                const activeWs = this.ws || (window.JAMRI_APP && window.JAMRI_APP.wsClient);
                const isCurrentlyJamming = this.hasWritableSharedTarget();

                if (isCurrentlyJamming && window.JAMRI_APP && window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
                    window.JAMRI_APP.games.notifyPunishedAction('memutar lagu');
                    return;
                }

                if (isCurrentlyJamming && activeWs && activeWs.isConnected) {
                    activeWs.sendSetTrack(track);
                } else {
                    this.player.playTrack(track, 0);
                }
                this.closeModal();
            });

            // Add to Queue Handler
            row.querySelector('.btn-add-queue').addEventListener('click', (e) => {
                e.stopPropagation();
                const activeWs = this.ws || (window.JAMRI_APP && window.JAMRI_APP.wsClient);
                const isCurrentlyJamming = this.hasWritableSharedTarget();

                if (isCurrentlyJamming && window.JAMRI_APP && window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
                    window.JAMRI_APP.games.notifyPunishedAction('menambah antrean');
                    return;
                }

                if (isCurrentlyJamming) {
                    if (window.JAMRI_APP && window.JAMRI_APP.roomQueue && window.JAMRI_APP.roomQueue.some(t => t.youtube_id === track.youtube_id)) {
                        if (window.showToast) window.showToast('Lagu ini sudah ada di antrean.', 'warning');
                        return;
                    }
                    if (activeWs && activeWs.isConnected) {
                        activeWs.sendQueueAdd(track);
                    }
                } else {
                    const added = this.player.addToSoloQueue(track);
                    if (!added) {
                        if (window.showToast) window.showToast('Lagu ini sudah ada di antrean.', 'warning');
                        return;
                    }
                }
                const btn = e.currentTarget;
                btn.classList.add('btn-success');
                btn.querySelector('span').textContent = 'Ditambah';
                setTimeout(() => {
                    btn.classList.remove('btn-success');
                    btn.querySelector('span').textContent = 'Antrean';
                }, 1200);
            });

            // Add to Playlist (Bank Musik) Handler
            row.querySelector('.btn-add-playlist').addEventListener('click', (e) => {
                e.stopPropagation();
                const activeWs = this.ws || (window.JAMRI_APP && window.JAMRI_APP.wsClient);
                const isCurrentlyJamming = this.hasWritableSharedTarget();

                if (isCurrentlyJamming && window.JAMRI_APP && window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
                    window.JAMRI_APP.games.notifyPunishedAction('menambah lagu ke Bank Musik');
                    return;
                }

                if (isCurrentlyJamming) {
                    if (window.JAMRI_APP && window.JAMRI_APP.roomPlaylist && window.JAMRI_APP.roomPlaylist.some(t => t.youtube_id === track.youtube_id)) {
                        if (window.showToast) window.showToast('Lagu ini sudah ada di Bank Musik.', 'warning');
                        return;
                    }
                    if (activeWs && activeWs.isConnected) {
                        activeWs.sendPlaylistAdd(track);
                    } else {
                        const roomId = (activeWs && activeWs.roomId) || (window.JAMRI_APP && window.JAMRI_APP.activeRoomId);
                        const deviceId = (window.JAMRI_USER && window.JAMRI_USER.device_id) || '';
                        fetch('api/rooms.php', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: 'add_playlist', track, room_id: roomId, device_id: deviceId })
                        }).then(r => r.json()).then(data => {
                            if (!data.success && data.message) {
                                if (window.showToast) window.showToast(data.message, 'warning');
                            }
                        }).catch(console.warn);
                    }
                } else {
                    const added = this.player.addToSoloPlaylist(track);
                    if (!added) {
                        if (window.showToast) window.showToast('Lagu ini sudah ada di Bank Musik.', 'warning');
                        return;
                    }
                }
                const btn = e.currentTarget;
                btn.classList.add('btn-success');
                btn.title = 'Tersimpan di Bank Musik';
                setTimeout(() => {
                    btn.classList.remove('btn-success');
                    btn.title = 'Simpan ke Bank Musik';
                }, 1400);
            });

            container.appendChild(row);
        });
    }

    /**
     * Import all tracks from a YouTube playlist into the Bank Musik
     * (room playlist when jamming, solo playlist otherwise).
     */
    async importPlaylist() {
        const modal = document.getElementById('search-modal');
        if (!modal) return;
        const input = modal.querySelector('#search-keyword');
        const btn = modal.querySelector('#btn-import-playlist');
        const listItems = modal.querySelector('#search-list-items');
        const emptyState = modal.querySelector('#search-empty-state');

        const raw = (input.value || '').trim();
        const playlistId = this.extractPlaylistId(raw);
        if (!playlistId) {
            if (window.showToast) {
                window.showToast('Tempelkan link playlist YouTube (mengandung "list=") terlebih dahulu.', 'warning');
            } else {
                alert('Tempelkan link playlist YouTube terlebih dahulu.');
            }
            if (input) input.focus();
            return;
        }

        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span>Mengambil...</span>';
        emptyState.style.display = 'none';
        listItems.style.display = 'block';
        listItems.innerHTML = '<div class="loading-spinner-box"><div class="spinner"></div><span>Membaca playlist YouTube...</span></div>';

        try {
            const res = await fetch(`api/playlist.php?url=${encodeURIComponent(playlistId)}&limit=100`);
            const data = await res.json();

            if (!data.success || !Array.isArray(data.tracks) || data.tracks.length === 0) {
                listItems.innerHTML = `<div class="empty-state"><p>${this.escape(data.message || 'Playlist kosong atau tidak dapat diakses.')}</p></div>`;
                return;
            }

            const added = this.addTracksToBankMusik(data.tracks);
            const skipped = data.tracks.length - added;

            let summary = `Berhasil menambahkan ${added} lagu ke Bank Musik.`;
            if (skipped > 0) summary += ` ${skipped} lagu dilewati (duplikat).`;

            listItems.innerHTML = `
                <div class="empty-state">
                    <p style="font-weight:600; margin-bottom:4px;">Playlist berhasil di-import!</p>
                    <p>${this.escape(summary)}</p>
                </div>
            `;
            if (window.showToast) window.showToast(summary, added > 0 ? 'success' : 'warning');
        } catch (e) {
            listItems.innerHTML = '<div class="empty-state text-danger"><p>Gagal mengambil playlist. Periksa koneksi ke backend.</p></div>';
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }

    /** Pull a playlist id out of a URL, or accept a raw id. */
    extractPlaylistId(str) {
        if (!str) return '';
        const m = str.match(/[?&]list=([A-Za-z0-9_-]+)/);
        if (m) return m[1];
        if (/^[A-Za-z0-9_-]{10,60}$/.test(str)) return str;
        return '';
    }

    /**
     * True when the user is listening together with other people — either a
     * legacy jamming room OR a world mat. World mode never sets activeRoomId
     * (the socket id is the world id), so checking only that flag silently sent
     * every "add to queue"/"play now" into the local solo queue instead of the
     * mat, which looked like the mat queue "not syncing".
     */
    isSharedSession() {
        if (this.player && this.player.isSynced && this.player.isSynced()) return true;
        const app = window.JAMRI_APP || {};
        if (app.activeRoomId) return true;
        // World mode: only a mat gives access to a shared queue.
        return !!(app.activeWorldId && app.world && app.world.activeBox);
    }

    /**
     * True when this player currently OWNS a shared target for queue/playlist
     * writes. isSharedSession() is broader (it also covers "socket is live"),
     * which is not enough after walking off a mat: the world socket is still
     * connected but there is no mat room behind it, so sending would silently
     * target the mat we just left.
     */
    hasWritableSharedTarget() {
        const app = window.JAMRI_APP || {};
        if (app.activeRoomId) {
            const ws = this.ws || app.wsClient;
            return !!(ws && ws.isConnected);
        }
        if (app.activeWorldId) {
            return !!(app.world && app.world.activeBox && app.wsClient && app.wsClient.isConnected);
        }
        return false;
    }

    /**
     * Route imported tracks to the correct Bank Musik:
     * - Jamming room -> WebSocket bulk playlist_add
     * - Solo -> local soloPlaylist
     * Returns the number actually added (not counting duplicates).
     */
    addTracksToBankMusik(tracks) {
        const activeWs = this.ws || (window.JAMRI_APP && window.JAMRI_APP.wsClient);
        const isCurrentlyJamming = this.hasWritableSharedTarget();

        if (isCurrentlyJamming && window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
            window.JAMRI_APP.games.notifyPunishedAction('menambah lagu ke Bank Musik');
            return 0;
        }

        if (isCurrentlyJamming) {
            const existing = (window.JAMRI_APP && window.JAMRI_APP.roomPlaylist) || [];
            const fresh = tracks.filter(t => !existing.some(e => e.youtube_id === t.youtube_id));
            if (fresh.length === 0) return 0;

            if (activeWs && activeWs.isConnected) {
                activeWs.sendPlaylistAddBulk(fresh);
            } else {
                const roomId = (activeWs && activeWs.roomId) || (window.JAMRI_APP && window.JAMRI_APP.activeRoomId);
                const deviceId = (window.JAMRI_USER && window.JAMRI_USER.device_id) || '';
                fresh.forEach(track => {
                    fetch('api/rooms.php', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'add_playlist', track, room_id: roomId, device_id: deviceId })
                    }).catch(console.warn);
                });
            }
            return fresh.length;
        }

        let added = 0;
        tracks.forEach(track => {
            if (this.player.addToSoloPlaylist(track)) added++;
        });
        return added;
    }

    updatePreviewButtons() {
        const rows = document.querySelectorAll('.track-result-item');
        rows.forEach(row => {
            const id = row.dataset.id;
            const btn = row.querySelector('.btn-preview-track');
            if (!btn) return;

            const isThis = this.activePreviewId === id;
            btn.classList.toggle('btn-primary', isThis);
            btn.querySelector('span').textContent = isThis ? 'Stop' : 'Preview';
        });

        this.updatePreviewBanner();
    }

    updatePreviewBanner(track = null) {
        const bar = document.getElementById('preview-active-bar');
        const titleEl = document.getElementById('preview-active-title');
        if (!bar) return;

        if (this.activePreviewId && (track || this.player.currentTrack)) {
            const t = track || this.results.find(r => r.youtube_id === this.activePreviewId);
            if (t && titleEl) titleEl.textContent = t.title;
            bar.style.display = 'flex';
        } else {
            bar.style.display = 'none';
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

window.JamriSearch = JamriSearch;
