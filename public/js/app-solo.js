/* ==========================================================================
   SOLO MODE & .JAMRI OFFLINE BANK
   ========================================================================== */
function renderSoloView() {
    const container = document.getElementById('solo-view');
    if (!container) return;

    container.innerHTML = `
        <div class="room-header">
            <div class="room-title-area">
                <h1 class="lobby-title" style="font-size:20px;">Mode Individual (Solo Player)</h1>
                <span class="badge badge-primary">100% Local & Offline</span>
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                <input type="file" id="input-import-jamri" accept=".jamri" style="display:none;" />
                <button type="button" id="btn-import-jamri" class="btn btn-outline btn-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="17 8 12 3 7 8"></polyline>
                        <line x1="12" y1="3" x2="12" y2="15"></line>
                    </svg>
                    <span>Import File .jamri</span>
                </button>
                <button type="button" id="btn-solo-search" class="btn btn-primary btn-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    <span>Cari Musik YouTube</span>
                </button>
            </div>
        </div>

        <div class="room-main-layout solo-layout">
            <div>
                <div class="tabs-nav-bar">
                    <button type="button" class="tab-nav-item active" data-tab="solo-queue">
                        <span>Antrean Putar</span>
                    </button>
                    <button type="button" class="tab-nav-item" data-tab="solo-lyrics">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M9 18V5l12-2v13"></path>
                            <circle cx="6" cy="18" r="3"></circle>
                            <circle cx="18" cy="16" r="3"></circle>
                        </svg>
                        <span>Lirik Karaoke</span>
                    </button>
                    <button type="button" class="tab-nav-item" data-tab="solo-playlist">
                        <span>Bank Musik Saya</span>
                    </button>
                    <button type="button" class="tab-nav-item" data-tab="solo-offline">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                            <line x1="8" y1="21" x2="16" y2="21"></line>
                            <line x1="12" y1="17" x2="12" y2="21"></line>
                        </svg>
                        <span>Cache Offline .jamri</span>
                    </button>
                    <button type="button" id="btn-shuffle-solo" class="btn btn-ghost btn-sm" style="margin-left:auto;" title="Acak Antrean">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="16 3 21 3 21 8"></polyline>
                            <line x1="4" y1="20" x2="21" y2="3"></line>
                            <polyline points="21 16 21 21 16 21"></polyline>
                            <line x1="15" y1="15" x2="21" y2="21"></line>
                            <line x1="4" y1="4" x2="9" y2="9"></line>
                        </svg>
                        <span>Acak</span>
                    </button>
                </div>

                <div id="solo-queue-panel" class="tab-panel">
                    <div class="track-list-box" id="solo-queue-list"></div>
                </div>
                <div id="solo-lyrics-panel" class="tab-panel" style="display:none; height:100%;">
                    <div id="solo-embedded-lyrics-container" style="height:100%;"></div>
                </div>
                <div id="solo-playlist-panel" class="tab-panel" style="display:none;">
                    <div class="track-list-box" id="solo-playlist-list"></div>
                </div>
                <div id="solo-offline-panel" class="tab-panel" style="display:none;">
                    <div class="track-list-box" id="solo-offline-list"></div>
                </div>
            </div>
        </div>
    `;

    const player = window.JAMRI_APP.player;

    // Search trigger
    container.querySelector('#btn-solo-search').addEventListener('click', () => {
        window.JAMRI_APP.searchModule.showModal();
    });

    // Shuffle solo queue
    const btnShuffleSolo = container.querySelector('#btn-shuffle-solo');
    if (btnShuffleSolo) {
        btnShuffleSolo.addEventListener('click', () => {
            player.toggleShuffle();
        });
        player.on('shuffle_change', (isShuffled) => {
            btnShuffleSolo.classList.toggle('active-control', isShuffled);
            btnShuffleSolo.classList.toggle('btn-primary', isShuffled);
            btnShuffleSolo.classList.toggle('btn-ghost', !isShuffled);
            btnShuffleSolo.title = isShuffled ? 'Acak Antrean: AKTIF' : 'Acak Antrean: NON-AKTIF';
        });
    }

    // Import .jamri file input
    const fileInput = container.querySelector('#input-import-jamri');
    container.querySelector('#btn-import-jamri').addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const unpacked = await JamriFormat.unpack(file);
            const meta = unpacked.metadata;

            // Save to IndexedDB
            await JamriOfflineDB.saveTrack(meta, file);

            // Add to solo queue and play
            const playableTrack = {
                youtube_id: meta.youtube_id,
                title: meta.title,
                channel: meta.channel,
                duration: meta.duration,
                duration_formatted: meta.duration_formatted,
                thumbnail: meta.thumbnail,
                stream_url: unpacked.blobUrl,
                is_blob: true,
            };

            player.addToSoloQueue(playableTrack);
            player.playTrack(playableTrack, 0, true);

            alert(`File .jamri "${meta.title}" berhasil di-import dan disimpan ke cache offline!`);
            renderSoloOfflineList();
        } catch (err) {
            console.error('Import .jamri failed:', err);
            alert('Gagal mendekompresi file .jamri. Pastikan file valid.');
        } finally {
            fileInput.value = '';
        }
    });

    // Tab switching
    const tabBtns = container.querySelectorAll('.tab-nav-item');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const t = btn.dataset.tab;
            container.querySelector('#solo-queue-panel').style.display = t === 'solo-queue' ? 'block' : 'none';
            container.querySelector('#solo-lyrics-panel').style.display = t === 'solo-lyrics' ? 'block' : 'none';
            container.querySelector('#solo-playlist-panel').style.display = t === 'solo-playlist' ? 'block' : 'none';
            container.querySelector('#solo-offline-panel').style.display = t === 'solo-offline' ? 'block' : 'none';

            if (t === 'solo-lyrics' && window.JAMRI_APP.lyrics) {
                window.JAMRI_APP.lyrics.registerEmbeddedContainer('solo-embedded-lyrics-container');
            }
            if (t === 'solo-offline') {
                renderSoloOfflineList();
            }
        });
    });

    renderSoloQueueList();
    renderSoloPlaylistList();

    player.on('solo_queue_updated', () => renderSoloQueueList());
    player.on('solo_playlist_updated', () => renderSoloPlaylistList());
}

function renderSoloQueueList() {
    const list = document.getElementById('solo-queue-list');
    if (!list) return;

    const player = window.JAMRI_APP.player;
    const queue = player.soloQueue;

    if (queue.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>Antrean putar kosong. Cari musik atau import file .jamri.</p></div>';
        return;
    }

    list.innerHTML = '';
    queue.forEach((track, idx) => {
        const item = document.createElement('div');
        item.className = 'track-item-card';
        item.setAttribute('draggable', 'true');
        item.setAttribute('data-index', idx.toString());
        item.innerHTML = `
            <div class="drag-handle-grip" title="Tahan dan geser untuk memindahkan urutan antrean">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="6" r="1.5"></circle>
                    <circle cx="15" cy="6" r="1.5"></circle>
                    <circle cx="9" cy="12" r="1.5"></circle>
                    <circle cx="15" cy="12" r="1.5"></circle>
                    <circle cx="9" cy="18" r="1.5"></circle>
                    <circle cx="15" cy="18" r="1.5"></circle>
                </svg>
            </div>
            <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted); width:18px;">${idx + 1}</span>
            <div class="track-thumb-box" style="cursor:pointer;" title="Klik untuk putar">
                <img src="${safeImageUrl(track.thumbnail)}" alt="" class="track-thumb-img" />
                <span class="track-duration-pill">${track.duration_formatted || formatSeconds(track.duration)}</span>
            </div>
            <div class="track-info-box" style="cursor:pointer;" title="Klik untuk putar">
                <div class="track-title">${escapeHtml(track.title)}</div>
                <div class="track-channel">oleh ${escapeHtml(track.channel)} ${track.is_blob ? '• [Offline .jamri]' : ''}</div>
            </div>
            <div class="track-actions-box">
                <button type="button" class="btn btn-ghost btn-icon btn-play-sq" title="Putar lagu ini sekarang" style="color:var(--primary);">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                </button>
                <button type="button" class="btn btn-ghost btn-icon btn-remove-sq" title="Hapus dari antrean">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        `;

        // Drag & Drop Desktop Events
        item.addEventListener('dragstart', (e) => {
            list._draggedIdx = idx;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', idx.toString());
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            item.classList.add('drag-over');
        });

        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over');
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            list.querySelectorAll('.track-item-card').forEach(c => c.classList.remove('drag-over'));
        });

        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            const fromIdx = list._draggedIdx;
            const toIdx = idx;
            if (fromIdx !== undefined && fromIdx !== null && fromIdx !== toIdx) {
                player.reorderSoloQueue(fromIdx, toIdx);
            }
            list._draggedIdx = null;
        });

        // Mobile Touch Drag Support
        const grip = item.querySelector('.drag-handle-grip');
        if (grip) {
            grip.addEventListener('touchstart', (e) => {
                list._touchFromIdx = idx;
                item.classList.add('dragging');
            }, { passive: true });

            grip.addEventListener('touchmove', (e) => {
                const touch = e.touches[0];
                const elem = document.elementFromPoint(touch.clientX, touch.clientY);
                const card = elem ? elem.closest('.track-item-card') : null;
                list.querySelectorAll('.track-item-card').forEach(c => c.classList.remove('drag-over'));
                if (card && card !== item) {
                    card.classList.add('drag-over');
                    list._touchTargetCard = card;
                }
            }, { passive: true });

            grip.addEventListener('touchend', () => {
                item.classList.remove('dragging');
                const targetCard = list._touchTargetCard;
                if (targetCard) {
                    targetCard.classList.remove('drag-over');
                    const toIdx = parseInt(targetCard.getAttribute('data-index'), 10);
                    const fromIdx = list._touchFromIdx;
                    if (!isNaN(toIdx) && fromIdx !== undefined && fromIdx !== toIdx) {
                        player.reorderSoloQueue(fromIdx, toIdx);
                    }
                }
                list._touchTargetCard = null;
                list._touchFromIdx = null;
            });
        }

        const playSoloTrackFn = () => {
            player.playTrack(track, 0);
        };

        item.querySelector('.btn-play-sq').addEventListener('click', (e) => {
            e.stopPropagation();
            playSoloTrackFn();
        });

        item.querySelector('.track-thumb-box').addEventListener('click', () => {
            playSoloTrackFn();
        });

        item.querySelector('.track-info-box').addEventListener('click', () => {
            playSoloTrackFn();
        });

        item.querySelector('.btn-remove-sq').addEventListener('click', (e) => {
            e.stopPropagation();
            player.removeFromSoloQueue(track.queue_id);
        });

        list.appendChild(item);
    });
}

function renderSoloPlaylistList() {
    const list = document.getElementById('solo-playlist-list');
    if (!list) return;

    const player = window.JAMRI_APP.player;
    const playlist = player.soloPlaylist;

    if (playlist.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>Bank musik solo Anda masih kosong. Simpan lagu favorit saat mencari musik.</p></div>';
        return;
    }

    list.innerHTML = '';
    playlist.forEach((track) => {
        const item = document.createElement('div');
        item.className = 'track-item-card';
        item.innerHTML = `
            <div class="track-thumb-box">
                <img src="${safeImageUrl(track.thumbnail)}" alt="" class="track-thumb-img" />
                <span class="track-duration-pill">${track.duration_formatted || formatSeconds(track.duration)}</span>
            </div>
            <div class="track-info-box">
                <div class="track-title">${escapeHtml(track.title)}</div>
                <div class="track-channel">oleh ${escapeHtml(track.channel)}</div>
            </div>
            <div class="track-actions-box">
                <button type="button" class="btn btn-outline btn-sm btn-enqueue-sp" title="Masukkan ke Antrean">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                    <span>Antrekan</span>
                </button>
                <button type="button" class="btn btn-ghost btn-icon btn-remove-sp" title="Hapus dari bank musik">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        `;

        item.querySelector('.btn-enqueue-sp').addEventListener('click', () => {
            const added = player.addToSoloQueue(track);
            if (!added) {
                showToast('Lagu ini sudah ada di antrean.', 'warning');
            } else {
                showToast('Lagu dimasukkan ke antrean.', 'success');
            }
        });

        item.querySelector('.btn-remove-sp').addEventListener('click', () => {
            player.removeFromSoloPlaylist(track.youtube_id);
        });

        list.appendChild(item);
    });
}

async function renderSoloOfflineList() {
    const list = document.getElementById('solo-offline-list');
    if (!list) return;

    list.innerHTML = '<div class="loading-spinner-box"><div class="spinner"></div><span>Membaca IndexedDB...</span></div>';

    try {
        const tracks = await JamriOfflineDB.getAllTracks();
        if (tracks.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <p>Belum ada file .jamri yang disimpan di browser Anda.</p>
                    <p style="font-size:12px; color:var(--text-muted); margin-top:4px;">Putar lagu dan klik tombol "Unduh .jamri" di player dock, atau klik "Import File .jamri".</p>
                </div>
            `;
            return;
        }

        list.innerHTML = '';
        tracks.forEach(t => {
            const sizeKb = Math.round(t.file_size / 1024);
            const item = document.createElement('div');
            item.className = 'track-item-card';
            item.innerHTML = `
                <div class="track-thumb-box">
                    <img src="${safeImageUrl(t.thumbnail)}" alt="" class="track-thumb-img" />
                    <span class="track-duration-pill">${t.duration_formatted || formatSeconds(t.duration)}</span>
                </div>
                <div class="track-info-box">
                    <div class="track-title">${escapeHtml(t.title)}</div>
                    <div class="track-channel">${escapeHtml(t.channel)} • Cache .jamri (${sizeKb} KB)</div>
                </div>
                <div class="track-actions-box">
                    <button type="button" class="btn btn-primary btn-sm btn-play-offline" title="Putar Offline">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                        <span>Putar</span>
                    </button>
                    <button type="button" class="btn btn-outline btn-sm btn-export-offline" title="Unduh File .jamri ke Komputer">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        <span>Unduh</span>
                    </button>
                    <button type="button" class="btn btn-ghost btn-icon btn-delete-offline" title="Hapus dari cache">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            `;

            // Play offline
            item.querySelector('.btn-play-offline').addEventListener('click', async () => {
                const unpacked = await JamriFormat.unpack(t.blob);
                const playableTrack = {
                    ...t,
                    stream_url: unpacked.blobUrl,
                    is_blob: true,
                };
                window.JAMRI_APP.player.playTrack(playableTrack, 0, true);
            });

            // Re-export file .jamri
            item.querySelector('.btn-export-offline').addEventListener('click', () => {
                const link = document.createElement('a');
                link.href = URL.createObjectURL(t.blob);
                const safeName = (t.title || 'jamri_music').replace(/[^a-zA-Z0-9_-]/g, '_');
                link.download = `${safeName}.jamri`;
                link.click();
            });

            // Delete offline
            item.querySelector('.btn-delete-offline').addEventListener('click', async () => {
                if (confirm(`Hapus "${t.title}" dari cache offline?`)) {
                    await JamriOfflineDB.deleteTrack(t.youtube_id);
                    renderSoloOfflineList();
                }
            });

            list.appendChild(item);
        });
    } catch (err) {
        console.error('Error reading offline tracks:', err);
    }
}
