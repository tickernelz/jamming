/**
 * app.js
 * Main Application Controller & Router for Jamri
 * Strict Guardrail: Zero AI Emojis in UI elements. All icons are inline SVGs.
 */

document.addEventListener('DOMContentLoaded', async () => {
    // 0. Service-worker self-heal: if a controller change happens (a new SW
    //    activated), reload once so the page never runs against mixed versions
    //    of cached/new JS. Guarded so it can never loop.
    if (!window.__jamriSwBound && 'serviceWorker' in navigator) {
        window.__jamriSwBound = true;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!window.__jamriReloading) {
                window.__jamriReloading = true;
                window.location.reload();
            }
        });
    }

    // 1. Inisialisasi Tema (Dark / Light)
    initTheme();

    // 2. Inisialisasi Core Engines
    const player = new JamriPlayer();
    const wsClient = new JamriWebSocket();
    const searchModule = new JamriSearch(player, null);
    const lyricsManager = new JamriLyricsManager();
    lyricsManager.attach(player, wsClient);

    window.JAMRI_APP = {
        player,
        wsClient,
        searchModule,
        lyrics: lyricsManager,
        currentView: 'lobby',
        activeRoomId: null,
    };

    // 3. Setup Auth & Device Fingerprinting
    JamriAuth.init();
    document.addEventListener('jamri:user_ready', (e) => {
        const user = e.detail;
        console.log('User identity active:', user.nickname);
        refreshLobbyRooms();
    });

    // 4. Setup PWA Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./public/sw.js')
            .then((reg) => {
                // Ask the browser to check for an updated service worker each load
                // so stale caches are replaced promptly.
                if (reg.update) reg.update();
            })
            .catch(console.warn);
    }

    // 5. Setup Player Dock Listeners & UI Binding
    bindPlayerDock(player);

    // 6. Setup Global Navigation
    bindNavigation(player, wsClient, searchModule);

    // 7. Load Initial View (Lobby)
    switchView('lobby');
    refreshLobbyRooms();
});

/* ==========================================================================
   TEMA (DARK / LIGHT MODE)
   ========================================================================== */
function initTheme() {
    const savedTheme = localStorage.getItem('jamri_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeButton(savedTheme);

    const btnTheme = document.getElementById('btn-toggle-theme');
    if (btnTheme) {
        btnTheme.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme') || 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('jamri_theme', next);
            updateThemeButton(next);
        });
    }
}

function updateThemeButton(theme) {
    const btnTheme = document.getElementById('btn-toggle-theme');
    if (!btnTheme) return;
    if (theme === 'dark') {
        // Icon Sun untuk beralih ke light
        btnTheme.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line>
                <line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line>
                <line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
            </svg>
        `;
        btnTheme.title = 'Beralih ke Day Mode';
    } else {
        // Icon Moon untuk beralih ke dark
        btnTheme.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
            </svg>
        `;
        btnTheme.title = 'Beralih ke Dark Mode';
    }
}

/* ==========================================================================
   ROUTING & VIEW SWITCHER
   ========================================================================== */
function switchView(viewName) {
    window.JAMRI_APP.currentView = viewName;
    const views = ['lobby-view', 'room-view', 'solo-view', 'world-view'];
    views.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    const activeEl = document.getElementById(`${viewName}-view`);
    if (activeEl) activeEl.style.display = 'block';

    // Update Nav Tab Buttons
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    // Rigid viewport lock untuk jamming room / world di desktop
    if (viewName === 'room' || viewName === 'world') {
        document.body.classList.add('in-room');
    } else {
        document.body.classList.remove('in-room');
    }

    if (viewName === 'solo') {
        renderSoloView();
    } else if (viewName === 'lobby') {
        refreshLobbyRooms();
    }
}

function bindNavigation(player, wsClient, searchModule) {
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.view;
            if (target === 'lobby') {
                if (!leaveActiveSession()) {
                    player.setMode('solo', null);
                    switchView('lobby');
                }
            } else if (target === 'solo') {
                leaveActiveSession();
                player.setMode('solo', null);
                searchModule.setWebSocket(null);
                switchView('solo');
            }
        });
    });

    // Logo brand click -> Lobby
    document.querySelector('.brand-logo').addEventListener('click', () => {
        if (!leaveActiveSession()) {
            player.setMode('solo', null);
            switchView('lobby');
        }
    });

    // Search trigger button in dock
    document.getElementById('btn-dock-search').addEventListener('click', () => {
        searchModule.showModal();
    });

    // Create Room Button
    const btnCreateRoom = document.getElementById('btn-create-room');
    if (btnCreateRoom) {
        btnCreateRoom.addEventListener('click', () => {
            showCreateRoomModal();
        });
    }

    // Enter Solo Button in Lobby Banner
    const btnEnterSolo = document.getElementById('btn-enter-solo');
    if (btnEnterSolo) {
        btnEnterSolo.addEventListener('click', () => {
            player.setMode('solo', null);
            switchView('solo');
        });
    }

    // Search Rooms input
    const inputSearchRoom = document.getElementById('input-search-room');
    if (inputSearchRoom) {
        let timer;
        inputSearchRoom.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                refreshLobbyRooms(inputSearchRoom.value.trim());
            }, 300);
        });
    }
}

/* ==========================================================================
   LOBBY ROOMS
   ========================================================================== */
async function refreshLobbyRooms(searchQuery = '') {
    const grid = document.getElementById('rooms-grid-container');
    if (!grid) return;

    try {
        const res = await fetch(`api/rooms.php?search=${encodeURIComponent(searchQuery)}`);
        const data = await res.json();

        if (!data.success || !data.rooms || data.rooms.length === 0) {
            grid.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1;">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                    <p>Belum ada room jamming yang aktif saat ini.</p>
                    <button type="button" id="btn-empty-create-room" class="btn btn-primary btn-sm" style="margin-top:8px;">
                        Buat Room Sekarang
                    </button>
                </div>
            `;
            const emptyBtn = grid.querySelector('#btn-empty-create-room');
            if (emptyBtn) emptyBtn.addEventListener('click', () => showCreateRoomModal());
            return;
        }

        grid.innerHTML = '';
        data.rooms.forEach(room => {
            const card = document.createElement('div');
            card.className = 'room-card';
            const isPlaying = room.playback_state === 'playing';
            const isWorld = room.mode === 'world';

            card.innerHTML = `
                <div class="room-card-top">
                    <div>
                        <div class="room-card-name">${escapeHtml(room.name)}</div>
                        <div class="room-card-host">
                            <span>Host:</span>
                            <span>${safeEmoji(room.host_emoji)}</span>
                            <span>${escapeHtml(room.host_nickname || 'Member')}</span>
                        </div>
                    </div>
                    <span class="badge ${isWorld ? 'badge-primary' : (room.is_private ? 'badge-private' : 'badge-primary')}" style="display:inline-flex; align-items:center; gap:4px;">
                        ${isWorld ? `
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                                <path d="M3 9h18M9 21V9"></path>
                            </svg>
                            World
                        ` : (room.is_private ? `
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                            </svg>
                            Private
                        ` : 'Public')}
                    </span>
                </div>
                <div class="room-card-meta">
                    <div class="room-card-status">
                        <span class="status-dot ${isPlaying ? 'playing' : ''}"></span>
                        <span>${isWorld ? 'Peta Pixel' : (isPlaying ? 'Sedang Memutar' : 'Standby')}</span>
                    </div>
                    <div>${isWorld ? 'Jalan & gelar tikar' : (room.queue_count || 0) + ' lagu di antrean'}</div>
                </div>
            `;

            card.addEventListener('click', () => {
                if (isWorld) {
                    enterWorld(room.id);
                } else {
                    joinRoom(room.id);
                }
            });

            grid.appendChild(card);
        });
    } catch (err) {
        console.error('Failed to load rooms:', err);
    }
}

function promptPasscodeModal(roomName, onConfirm) {
    let existing = document.getElementById('passcode-prompt-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'passcode-prompt-modal';
    modal.className = 'modal-backdrop active';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-card" style="max-width: 380px;">
            <div class="modal-header">
                <h3 class="modal-title" style="display:flex; align-items:center; gap:6px;">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                    </svg>
                    <span>Room Private</span>
                </h3>
                <button type="button" class="btn-modal-close" id="btn-close-passcode">&times;</button>
            </div>
            <form id="form-passcode-prompt" class="modal-form" style="padding:16px;">
                <p style="font-size:13px; color:var(--text-secondary); margin-bottom:14px;">
                    Room <strong>${escapeHtml(roomName)}</strong> bersifat private. Masukkan passcode untuk bergabung:
                </p>
                <div class="form-group" style="margin-bottom:16px;">
                    <label class="form-label" for="input-room-passcode">Passcode Room</label>
                    <input type="password" id="input-room-passcode" class="form-input" placeholder="Masukkan passcode..." required autofocus />
                </div>
                <div class="modal-actions" style="display:flex; justify-content:flex-end; gap:8px;">
                    <button type="button" class="btn btn-outline" id="btn-cancel-passcode">Batal</button>
                    <button type="submit" class="btn btn-primary" id="btn-submit-passcode">Masuk Room</button>
                </div>
            </form>
        </div>
    `;

    document.body.appendChild(modal);
    const input = modal.querySelector('#input-room-passcode');
    input.focus();

    const close = () => modal.remove();
    modal.querySelector('#btn-close-passcode').addEventListener('click', close);
    modal.querySelector('#btn-cancel-passcode').addEventListener('click', close);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) close();
    });

    modal.querySelector('#form-passcode-prompt').addEventListener('submit', (e) => {
        e.preventDefault();
        const code = input.value.trim();
        if (code) {
            close();
            onConfirm(code);
        }
    });
}

function showCreateRoomModal() {
    let existing = document.getElementById('create-room-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'create-room-modal';
    modal.className = 'modal-backdrop active';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-card">
            <div class="modal-header">
                <div class="modal-title-row">
                    <h2 class="modal-title">Buat Room Jamming Baru</h2>
                    <button type="button" class="btn-close-modal" id="btn-close-create-room" title="Tutup (Esc)">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
                <p class="modal-subtitle">Room akan otomatis dihapus jika kosong selama 10 menit.</p>
            </div>
            <form id="create-room-form">
                <div class="modal-body">
                    <div class="form-group">
                        <label class="form-label" for="new-room-name">Nama Room</label>
                        <input type="text" id="new-room-name" class="form-input" placeholder="contoh: Jamming Santai Sore" required maxlength="50" autocomplete="off" />
                    </div>
                    <div class="form-group">
                        <label class="form-label">Mode Room</label>
                        <div style="display:flex; gap:16px; margin-top:6px; flex-wrap:wrap;">
                            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                                <input type="radio" name="room_mode" value="legacy" checked /> Legacy (Room musik biasa)
                            </label>
                            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                                <input type="radio" name="room_mode" value="world" /> World (Peta pixel + avatar)
                            </label>
                        </div>
                        <div class="input-hint" id="mode-hint" style="margin-top:6px;">Room musik klasik: antrean lagu, chat, dan Bank Musik seperti biasa.</div>
                    </div>
                    <div class="form-group" id="room-access-group">
                        <label class="form-label">Tipe Akses Room</label>
                        <div style="display:flex; gap:16px; margin-top:6px;">
                            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                                <input type="radio" name="room_access" value="public" checked /> Public (Muncul di Lobby)
                            </label>
                            <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                                <input type="radio" name="room_access" value="private" /> Private (Kode Sandi)
                            </label>
                        </div>
                    </div>
                    <div class="form-group" id="passcode-group" style="display:none;">
                        <label class="form-label" for="new-room-passcode">Kode Akses Room (Passcode)</label>
                        <input type="text" id="new-room-passcode" class="form-input" placeholder="contoh: 123456" maxlength="20" autocomplete="off" />
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-outline" id="btn-cancel-create">Batal</button>
                    <button type="submit" class="btn btn-primary" id="btn-submit-create">Buat Room</button>
                </div>
            </form>
        </div>
    `;

    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('#btn-close-create-room');
    const cancelBtn = modal.querySelector('#btn-cancel-create');
    const closeModal = () => modal.remove();
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    const escHandler = (e) => {
        if (e.key === 'Escape' && document.body.contains(modal)) {
            closeModal();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);

    // Focus input
    setTimeout(() => {
        const input = modal.querySelector('#new-room-name');
        if (input) input.focus();
    }, 100);

    const radios = modal.querySelectorAll('input[name="room_access"]');
    const passGroup = modal.querySelector('#passcode-group');
    radios.forEach(r => {
        r.addEventListener('change', () => {
            passGroup.style.display = (r.value === 'private') ? 'block' : 'none';
        });
    });

    // Room mode (legacy vs world) toggles access options and hint text.
    const modeRadios = modal.querySelectorAll('input[name="room_mode"]');
    const accessGroup = modal.querySelector('#room-access-group');
    const modeHint = modal.querySelector('#mode-hint');
    modeRadios.forEach(r => {
        r.addEventListener('change', () => {
            const isWorld = r.value === 'world';
            accessGroup.style.display = isWorld ? 'none' : 'block';
            if (isWorld) passGroup.style.display = 'none';
            if (modeHint) {
                modeHint.textContent = isWorld
                    ? 'World pixel-game: avatar jalan bebas. Musik dimainkan lewat "tikar" yang digelar pemain (fitur musik tikar menyusul).'
                    : 'Room musik klasik: antrean lagu, chat, dan Bank Musik seperti biasa.';
            }
        });
    });

    const form = modal.querySelector('#create-room-form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = modal.querySelector('#new-room-name').value.trim();
        const roomMode = modal.querySelector('input[name="room_mode"]:checked').value;
        const isWorld = roomMode === 'world';
        const isPrivate = !isWorld && modal.querySelector('input[name="room_access"]:checked').value === 'private';
        const passcode = modal.querySelector('#new-room-passcode').value.trim();

        const submitBtn = modal.querySelector('#btn-submit-create');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Membuat...';

        try {
            if (isWorld) {
                const res = await fetch('api/worlds.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
                const data = await res.json();
                if (data.success && data.world) {
                    closeModal();
                    enterWorld(data.world.id);
                } else {
                    alert(data.error || 'Gagal membuat world.');
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Buat Room';
                }
                return;
            }

            const res = await fetch('api/rooms.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    is_private: isPrivate ? 1 : 0,
                    passcode: isPrivate ? passcode : ''
                })
            });

            const data = await res.json();
            if (data.success && data.room) {
                closeModal();
                joinRoom(data.room.id);
            } else {
                alert(data.error || 'Gagal membuat room.');
                submitBtn.disabled = false;
                submitBtn.textContent = 'Buat Room';
            }
        } catch (err) {
            alert('Koneksi bermasalah saat membuat room.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Buat Room';
        }
    });
}
