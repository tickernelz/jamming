/**
 * app.js
 * Main Application Controller & Router for Jamri
 * Strict Guardrail: Zero AI Emojis in UI elements. All icons are inline SVGs.
 */

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Inisialisasi Tema (Dark / Light)
    initTheme();

    // 2. Inisialisasi Core Engines
    const player = new JamriPlayer();
    const wsClient = new JamriWebSocket();
    const searchModule = new JamriSearch(player, null);

    window.JAMRI_APP = {
        player,
        wsClient,
        searchModule,
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
        navigator.serviceWorker.register('./public/sw.js').catch(console.warn);
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
    const views = ['lobby-view', 'room-view', 'solo-view'];
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

    // Rigid viewport lock untuk jamming room di desktop
    if (viewName === 'room') {
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
                if (window.JAMRI_APP.activeRoomId) {
                    leaveRoom();
                } else {
                    player.setMode('solo', null);
                    switchView('lobby');
                }
            } else if (target === 'solo') {
                if (window.JAMRI_APP.activeRoomId) {
                    leaveRoom();
                }
                player.setMode('solo', null);
                searchModule.setWebSocket(null);
                switchView('solo');
            }
        });
    });

    // Logo brand click -> Lobby
    document.querySelector('.brand-logo').addEventListener('click', () => {
        if (window.JAMRI_APP.activeRoomId) {
            leaveRoom();
        } else {
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

            card.innerHTML = `
                <div class="room-card-top">
                    <div>
                        <div class="room-card-name">${escapeHtml(room.name)}</div>
                        <div class="room-card-host">
                            <span>Host:</span>
                            <span>${room.host_emoji || '🎧'}</span>
                            <span>${escapeHtml(room.host_nickname || 'Member')}</span>
                        </div>
                    </div>
                    <span class="badge ${room.is_private ? 'badge-private' : 'badge-primary'}" style="display:inline-flex; align-items:center; gap:4px;">
                        ${room.is_private ? `
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                            </svg>
                            Private
                        ` : 'Public'}
                    </span>
                </div>
                <div class="room-card-meta">
                    <div class="room-card-status">
                        <span class="status-dot ${isPlaying ? 'playing' : ''}"></span>
                        <span>${isPlaying ? 'Sedang Memutar' : 'Standby'}</span>
                    </div>
                    <div>${room.queue_count || 0} lagu di antrean</div>
                </div>
            `;

            card.addEventListener('click', () => {
                if (room.is_private) {
                    promptPasscodeModal(room.name, (enteredPasscode) => {
                        joinRoom(room.id, true, enteredPasscode);
                    });
                } else {
                    joinRoom(room.id, false, '');
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

    const form = modal.querySelector('#create-room-form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = modal.querySelector('#new-room-name').value.trim();
        const isPrivate = modal.querySelector('input[name="room_access"]:checked').value === 'private';
        const passcode = modal.querySelector('#new-room-passcode').value.trim();

        const deviceId = window.JAMRI_USER ? window.JAMRI_USER.device_id : JamriAuth.getOrCreateDeviceId();

        const submitBtn = modal.querySelector('#btn-submit-create');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Membuat...';

        try {
            const res = await fetch('api/rooms.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    is_private: isPrivate ? 1 : 0,
                    passcode: isPrivate ? passcode : '',
                    device_id: deviceId
                })
            });

            const data = await res.json();
            if (data.success && data.room) {
                closeModal();
                joinRoom(data.room.id, isPrivate, passcode);
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

/* ==========================================================================
   JOIN & MANAGE JAMMING ROOM
   ========================================================================== */
function leaveRoom() {
    if (window.JAMRI_APP.activeRoomId) {
        window.JAMRI_APP.wsClient.disconnect();
        window.JAMRI_APP.activeRoomId = null;
    }
    if (window.JAMRI_APP.soundboard) {
        window.JAMRI_APP.soundboard.detach();
    }
    if (window.JAMRI_APP.voicePTT) {
        window.JAMRI_APP.voicePTT.detach();
    }
    const player = window.JAMRI_APP.player;
    // Hentikan musik di device saat keluar dari room jamming
    player.stop();
    player.setMode('solo', null);
    if (window.JAMRI_APP.searchModule) {
        window.JAMRI_APP.searchModule.setWebSocket(null);
    }
    switchView('lobby');
}

async function joinRoom(roomId, isPrivate = false, passcode = '') {
    // Hangatkan audio bridge langsung dari gesture klik pengguna agar browser mengizinkan autoplay
    if (window.JAMRI_APP && window.JAMRI_APP.player) {
        window.JAMRI_APP.player.warmup();
    }

    if (isPrivate && !passcode) {
        promptPasscodeModal('Private Jamming', (code) => {
            joinRoom(roomId, true, code);
        });
        return;
    }

    try {
        const url = `api/room_detail.php?room_id=${encodeURIComponent(roomId)}${passcode ? '&passcode=' + encodeURIComponent(passcode) : ''}`;
        const res = await fetch(url);
        const data = await res.json();

        if (!data.success) {
            alert(data.message || 'Gagal masuk ke room. Pastikan passcode benar.');
            return;
        }

        const roomDetail = data.data;
        window.JAMRI_APP.activeRoomId = roomId;

        const player = window.JAMRI_APP.player;
        const ws = window.JAMRI_APP.wsClient;
        const search = window.JAMRI_APP.searchModule;

        player.setMode('jamming', ws);
        search.setWebSocket(ws);

        // Render Room UI Shell
        renderRoomShell(roomDetail);

        // Setup WS Event Listeners for this room BEFORE connecting!
        bindRoomWebSocketEvents(ws, player, roomDetail);

        // Connect WebSocket
        ws.connect(roomId, window.JAMRI_USER);

        switchView('room');
    } catch (err) {
        console.error('Join room error:', err);
        alert('Gagal menghubungi server room.');
    }
}

function renderRoomShell(roomDetail) {
    const room = roomDetail.room;
    const container = document.getElementById('room-view');
    if (!container) return;

    container.innerHTML = `
        <div class="room-header">
            <div class="room-title-area">
                <button type="button" id="btn-leave-room" class="btn btn-outline btn-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="19" y1="12" x2="5" y2="12"></line>
                        <polyline points="12 19 5 12 12 5"></polyline>
                    </svg>
                    <span>Keluar Room</span>
                </button>
                <div>
                    <h1 class="lobby-title" style="font-size:18px;">${escapeHtml(room.name)}</h1>
                    <div style="font-size:12px; color:var(--text-muted);">
                        Host: ${room.host_emoji || '🎧'} ${escapeHtml(room.host_nickname || '')}
                        ${room.is_private ? ' • Private (Kode: ' + escapeHtml(room.passcode) + ')' : ''}
                    </div>
                </div>
            </div>
            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                <div id="room-ptt-slot"></div>
                <button type="button" id="btn-room-minigames" class="btn btn-outline btn-sm" title="Mainkan Mini Games Realtime">
                    <span>Mini Games 🎲</span>
                </button>
                <button type="button" id="btn-room-search" class="btn btn-primary btn-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    <span>Cari Musik YouTube</span>
                </button>
            </div>
        </div>

        <!-- Indicator bar for active speakers (Push-to-Talk) -->
        <div id="room-active-speakers-bar" class="active-speakers-bar" style="display:none;"></div>

        <div class="room-main-layout">
            <!-- Kolom Kiri: Queue, Playlist & Soundboard Tabs -->
            <div class="room-left-col">
                <div class="tabs-nav-bar">
                    <button type="button" class="tab-nav-item active" data-tab="room-queue">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="8" y1="6" x2="21" y2="6"></line>
                            <line x1="8" y1="12" x2="21" y2="12"></line>
                            <line x1="8" y1="18" x2="21" y2="18"></line>
                            <line x1="3" y1="6" x2="3.01" y2="6"></line>
                            <line x1="3" y1="12" x2="3.01" y2="12"></line>
                            <line x1="3" y1="18" x2="3.01" y2="18"></line>
                        </svg>
                        <span>Antrean (<span id="room-queue-count">0</span>)</span>
                    </button>
                    <button type="button" class="tab-nav-item" data-tab="room-playlist">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <span>Bank Musik</span>
                    </button>
                    <button type="button" class="tab-nav-item" data-tab="room-soundboard">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        </svg>
                        <span>Soundboard 🔊</span>
                    </button>
                    <button type="button" class="tab-nav-item" data-tab="room-games">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect>
                            <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"></circle>
                            <circle cx="15.5" cy="15.5" r="1.5" fill="currentColor"></circle>
                        </svg>
                        <span>Games 🎲</span>
                    </button>
                    <button type="button" id="btn-shuffle-room-queue" class="btn btn-ghost btn-sm" style="margin-left:auto;" title="Acak Antrean">
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

                <div id="room-queue-tab-panel" class="tab-panel">
                    <div class="track-list-box" id="room-queue-list"></div>
                </div>
                <div id="room-playlist-tab-panel" class="tab-panel" style="display:none;">
                    <div class="track-list-box" id="room-playlist-list"></div>
                </div>
                <div id="room-soundboard-tab-panel" class="tab-panel" style="display:none;">
                    <div class="soundboard-container">
                        <div class="soundboard-header-toolbar">
                            <div class="soundboard-vol-wrapper" title="Volume Suara Soundboard (Lokal di perangkat Anda)">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                                </svg>
                                <span style="font-size:12px; color:var(--text-muted);">Vol Soundboard:</span>
                                <input type="range" id="soundboard-volume-slider" min="0" max="1" step="0.05" value="0.9" style="width:70px;" />
                            </div>
                            <button type="button" id="btn-soundboard-stop" class="btn btn-ghost btn-xs" title="Hentikan semua suara soundboard yang sedang berputar di perangkat Anda">
                                ⏹️ Hentikan Suara
                            </button>
                        </div>
                        <div id="soundboard-grid" class="soundboard-grid-wrapper"></div>
                    </div>
                </div>
                <div id="room-games-tab-panel" class="tab-panel" style="display:none;"></div>
            </div>

            <!-- Kolom Kanan: Live Chat & Peserta -->
            <div class="room-right-col" id="room-chat-slot"></div>
        </div>

        <!-- Floating container for Discord-like soundboard emoji reactions -->
        <div id="soundboard-floating-container" class="soundboard-floating-container"></div>
    `;

    // Leave room
    container.querySelector('#btn-leave-room').addEventListener('click', () => {
        leaveRoom();
    });

    // Search trigger
    container.querySelector('#btn-room-search').addEventListener('click', () => {
        window.JAMRI_APP.searchModule.showModal();
    });

    // Shuffle queue
    const btnShuffleRoom = container.querySelector('#btn-shuffle-room-queue');
    if (btnShuffleRoom) {
        btnShuffleRoom.addEventListener('click', () => {
            if (window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
                alert('🚫 Anda sedang dihukum kalah game! Tidak bisa mengacak antrean.');
                return;
            }
            window.JAMRI_APP.wsClient.sendQueueShuffle();
        });
        window.JAMRI_APP.player.on('shuffle_change', (isShuffled) => {
            btnShuffleRoom.classList.toggle('active-control', isShuffled);
            btnShuffleRoom.classList.toggle('btn-primary', isShuffled);
            btnShuffleRoom.classList.toggle('btn-ghost', !isShuffled);
            btnShuffleRoom.title = isShuffled ? 'Acak Antrean: AKTIF' : 'Acak Antrean: NON-AKTIF';
        });
    }

    // Quick Mini Games button in header
    const btnMiniGames = container.querySelector('#btn-room-minigames');
    if (btnMiniGames) {
        btnMiniGames.addEventListener('click', () => {
            const gamesTabBtn = container.querySelector('[data-tab="room-games"]');
            if (gamesTabBtn) gamesTabBtn.click();
        });
    }

    // Tabs switch
    const tabBtns = container.querySelectorAll('.tab-nav-item');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const target = btn.dataset.tab;
            container.querySelector('#room-queue-tab-panel').style.display = target === 'room-queue' ? 'block' : 'none';
            container.querySelector('#room-playlist-tab-panel').style.display = target === 'room-playlist' ? 'block' : 'none';
            container.querySelector('#room-soundboard-tab-panel').style.display = target === 'room-soundboard' ? 'block' : 'none';
            container.querySelector('#room-games-tab-panel').style.display = target === 'room-games' ? 'block' : 'none';

            if (target === 'room-games' && window.JAMRI_APP.games) {
                window.JAMRI_APP.games.renderPanel(container.querySelector('#room-games-tab-panel'));
            }
        });
    });

    // Render Chat
    const chatSlot = container.querySelector('#room-chat-slot');
    const chat = new JamriChat(chatSlot, room.id, window.JAMRI_APP.wsClient);
    chat.initMessages(roomDetail.chat || []);
    window.JAMRI_APP.currentChat = chat;

    // Render initial queue & playlist
    renderRoomQueue(roomDetail.queue || []);
    renderRoomPlaylist(roomDetail.playlist || []);

    // Initialize & Attach Soundboard
    if (!window.JAMRI_APP.soundboard) {
        window.JAMRI_APP.soundboard = new JamriSoundboard();
    }
    window.JAMRI_APP.soundboard.attach(room.id, window.JAMRI_USER, window.JAMRI_APP.wsClient);

    const sbVolSlider = container.querySelector('#soundboard-volume-slider');
    if (sbVolSlider && window.JAMRI_APP.soundboard) {
        sbVolSlider.value = window.JAMRI_APP.soundboard.volume;
        sbVolSlider.addEventListener('input', (e) => {
            window.JAMRI_APP.soundboard.setVolume(parseFloat(e.target.value));
        });
    }

    const btnSbStop = container.querySelector('#btn-soundboard-stop');
    if (btnSbStop && window.JAMRI_APP.soundboard) {
        btnSbStop.addEventListener('click', () => {
            window.JAMRI_APP.soundboard.stopAll();
        });
    }

    // Initialize & Attach Push-to-Talk (PTT)
    if (!window.JAMRI_APP.voicePTT) {
        window.JAMRI_APP.voicePTT = new JamriVoicePTT();
    }
    window.JAMRI_APP.voicePTT.attach(room.id, window.JAMRI_USER, window.JAMRI_APP.wsClient);

    // Initialize & Attach Mini Games
    if (!window.JAMRI_APP.games) {
        window.JAMRI_APP.games = new JamriGames();
    }
    window.JAMRI_APP.games.attach(room.id, window.JAMRI_USER, window.JAMRI_APP.wsClient);
}

function bindRoomWebSocketEvents(ws, player, roomDetail) {
    ws.on('room_init', (data) => {
        if (data.queue) renderRoomQueue(data.queue);
        if (data.loop_mode) player.setLoopMode(data.loop_mode);
        if (data.is_shuffled !== undefined) {
            player.isShuffled = !!data.is_shuffled;
            player.emit('shuffle_change', player.isShuffled);
        }
        if (data.online_users && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.setOnlineUsers(data.online_users);
        }
        if (data.punishments && window.JAMRI_APP.games) {
            window.JAMRI_APP.games.setPunishments(data.punishments);
        }
        player.serverPlaybackState = data.state || 'stopped';
        player.serverBasePos = data.position || 0;
        player.serverSyncTime = data.server_time || Date.now();
        if (data.current_track) {
            player.playTrack(data.current_track, data.position || 0);
            if (data.state === 'paused') {
                player.pause();
            }
        } else {
            player.stop();
        }
    });

    ws.on('pong', (data) => {
        // Saat tab di background (document.hidden), JANGAN pernah ganggu player agar audio terus berputar tanpa henti!
        if (document.hidden) return;
        player.syncJammingState(data.track || null, data.state, data.position, data.server_time);
    });

    ws.on('loop_changed', (data) => {
        if (data.loop_mode) {
            player.setLoopMode(data.loop_mode);
            if (data.triggered_by && window.JAMRI_APP.currentChat) {
                const modeLabel = data.loop_mode === 'one' ? 'Ulangi 1 Lagu 🔂' : (data.loop_mode === 'all' ? 'Ulangi Semua 🔁' : 'Matikan Ulangi ➡️');
                window.JAMRI_APP.currentChat.appendActivityNotice(`mengubah mode putar menjadi ${modeLabel}`, '🔁', data.triggered_by);
            }
        }
    });

    ws.on('user_joined', (data) => {
        if (data.online_users && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.setOnlineUsers(data.online_users);
        }
        if (data.punishments && window.JAMRI_APP.games) {
            window.JAMRI_APP.games.setPunishments(data.punishments);
        }
        if (data.user && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice('bergabung ke room 👋', '👋', data.user.nickname);
        }
    });

    ws.on('game_started', (data) => {
        if (data.started_by && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice(`memulai permainan ${data.game_name} 🎮`, '🎮', data.started_by);
        }
    });

    ws.on('punishments_updated', (data) => {
        if (window.JAMRI_APP.games) {
            window.JAMRI_APP.games.setPunishments(data.punishments || []);
        }
        if (data.cleared_user && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice(`hukuman untuk ${data.cleared_user} telah diampuni oleh ${data.triggered_by || 'Host'} 🕊️`, '🕊️', 'Sistem');
        }
    });

    ws.on('user_left', (data) => {
        if (data.online_users && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.setOnlineUsers(data.online_users);
        }
        if (data.user && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice('keluar dari room 🚪', '🚪', data.user.nickname);
        }
    });

    ws.on('chat_message', (data) => {
        if (window.JAMRI_APP.currentChat && data.message) {
            window.JAMRI_APP.currentChat.appendMessage(data.message);
        }
    });

    ws.on('play', (data) => {
        if (player.isPreviewing) return;
        player.syncJammingState(data.track || null, 'playing', data.position, data.server_time);
        if (data.triggered_by && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice('memutar musik ▶️', '▶️', data.triggered_by);
        }
    });

    ws.on('pause', (data) => {
        if (player.isPreviewing) return;
        player.syncJammingState(data.track || null, 'paused', data.position, data.server_time);
        if (data.triggered_by && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice('menjeda musik ⏸️', '⏸️', data.triggered_by);
        }
    });

    ws.on('seek', (data) => {
        if (player.isPreviewing) return;
        player.syncJammingState(data.track || null, data.state, data.position, data.server_time);
        if (data.triggered_by && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice('menggeser timeline musik ⏩', '⏩', data.triggered_by);
        }
    });

    ws.on('track_change', (data) => {
        if (player.isPreviewing) {
            player.currentTrack = data.track;
            return;
        }
        if (data.track) {
            player.serverPlaybackState = 'playing';
            player.serverBasePos = data.position || 0;
            player.serverSyncTime = data.server_time || Date.now();
            player.playTrack(data.track, data.position || 0);

            if (data.triggered_by && window.JAMRI_APP.currentChat) {
                window.JAMRI_APP.currentChat.appendActivityNotice(`memutar "${data.track.title}" 🎵`, '🎵', data.triggered_by);
            }
        }
    });

    ws.on('playback_stopped', () => {
        player.stop();
    });

    ws.on('queue_updated', (data) => {
        if (data.queue) renderRoomQueue(data.queue);
        if (data.is_shuffled !== undefined) {
            player.isShuffled = !!data.is_shuffled;
            player.emit('shuffle_change', player.isShuffled);
        }
        if (data.triggered_by && window.JAMRI_APP.currentChat) {
            if (data.action === 'reorder') {
                window.JAMRI_APP.currentChat.appendActivityNotice('mengubah urutan antrean lagu 🔀', '🔀', data.triggered_by);
            } else if (data.action === 'shuffle') {
                window.JAMRI_APP.currentChat.appendActivityNotice('mengacak antrean lagu 🎲', '🎲', data.triggered_by);
            } else if (data.action === 'remove') {
                const title = data.removed_track_title ? `"${data.removed_track_title}"` : 'sebuah lagu';
                window.JAMRI_APP.currentChat.appendActivityNotice(`menghapus ${title} dari antrean 🗑️`, '🗑️', data.triggered_by);
            } else if (data.added_track) {
                window.JAMRI_APP.currentChat.appendActivityNotice(`menambahkan "${data.added_track.title}" ke antrean ➕`, '➕', data.triggered_by);
            }
        }
    });

    ws.on('playlist_updated', (data) => {
        if (data.playlist) {
            renderRoomPlaylist(data.playlist);
        }
        if (data.triggered_by && window.JAMRI_APP.currentChat) {
            if (data.action === 'remove') {
                const title = data.removed_track_title ? `"${data.removed_track_title}"` : 'sebuah lagu';
                window.JAMRI_APP.currentChat.appendActivityNotice(`menghapus ${title} dari Bank Musik 🗑️`, '🗑️', data.triggered_by);
            } else if (data.added_track) {
                window.JAMRI_APP.currentChat.appendActivityNotice(`menambahkan "${data.added_track.title}" ke Bank Musik 💾`, '💾', data.triggered_by);
            }
        }
    });

    ws.on('soundboard_play', (data) => {
        if (data.triggered_by && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice(`membunyikan soundboard ${data.title} ${data.emoji || ''}`, data.emoji || '🔊', data.triggered_by);
        }
    });

    ws.on('notice', (data) => {
        if (data.message && typeof showToast === 'function') {
            showToast(data.message, data.level || 'info');
        }
    });
}

function renderRoomQueue(queue) {
    window.JAMRI_APP.roomQueue = queue || [];
    const list = document.getElementById('room-queue-list');
    const countEl = document.getElementById('room-queue-count');
    if (countEl) countEl.textContent = (queue || []).length;
    if (!list) return;

    if (!queue || queue.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>Antrean kosong. Cari lagu untuk ditambahkan.</p></div>';
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
                <img src="${track.thumbnail_url || track.thumbnail}" alt="" class="track-thumb-img" />
                <span class="track-duration-pill">${formatSeconds(track.duration_seconds || track.duration)}</span>
            </div>
            <div class="track-info-box" style="cursor:pointer;" title="Klik untuk putar">
                <div class="track-title">${escapeHtml(track.title)}</div>
                <div class="track-channel">oleh ${escapeHtml(track.channel)} • ditambahkan oleh ${escapeHtml(track.added_by_nickname)}</div>
            </div>
            <div class="track-actions-box">
                <button type="button" class="btn btn-ghost btn-icon btn-play-q" title="Putar lagu ini sekarang" style="color:var(--primary);">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                    </svg>
                </button>
                <button type="button" class="btn btn-ghost btn-icon btn-remove-q" title="Hapus dari antrean">
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
            if (window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
                alert('🚫 Anda sedang dihukum kalah game! Tidak bisa mengubah urutan antrean.');
                list._draggedIdx = null;
                return;
            }
            const fromIdx = list._draggedIdx;
            const toIdx = idx;
            if (fromIdx !== undefined && fromIdx !== null && fromIdx !== toIdx) {
                const newQueue = [...queue];
                const [moved] = newQueue.splice(fromIdx, 1);
                newQueue.splice(toIdx, 0, moved);
                renderRoomQueue(newQueue);
                window.JAMRI_APP.wsClient.sendQueueReorder(newQueue.map(t => t.id));
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
                        if (window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
                            alert('🚫 Anda sedang dihukum kalah game! Tidak bisa mengubah urutan antrean.');
                            list._touchTargetCard = null;
                            list._touchFromIdx = null;
                            return;
                        }
                        const newQueue = [...queue];
                        const [moved] = newQueue.splice(fromIdx, 1);
                        newQueue.splice(toIdx, 0, moved);
                        renderRoomQueue(newQueue);
                        window.JAMRI_APP.wsClient.sendQueueReorder(newQueue.map(t => t.id));
                    }
                }
                list._touchTargetCard = null;
                list._touchFromIdx = null;
            });
        }

        const playTrackFn = () => {
            if (window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
                alert('🚫 Anda sedang dihukum kalah game! Tidak bisa memutar lagu.');
                return;
            }
            window.JAMRI_APP.wsClient.sendSetTrack(track);
        };

        item.querySelector('.btn-play-q').addEventListener('click', (e) => {
            e.stopPropagation();
            playTrackFn();
        });

        item.querySelector('.track-thumb-box').addEventListener('click', () => {
            playTrackFn();
        });

        item.querySelector('.track-info-box').addEventListener('click', () => {
            playTrackFn();
        });

        item.querySelector('.btn-remove-q').addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
                alert('🚫 Anda sedang dihukum kalah game! Tidak bisa menghapus lagu dari antrean.');
                return;
            }
            window.JAMRI_APP.wsClient.sendQueueRemove(track.id);
        });

        list.appendChild(item);
    });
}

function renderRoomPlaylist(playlist) {
    window.JAMRI_APP.roomPlaylist = playlist || [];
    const list = document.getElementById('room-playlist-list');
    if (!list) return;

    if (!playlist || playlist.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>Bank musik room masih kosong. Cari lagu dan klik tombol bookmark untuk menyimpan ke sini.</p></div>';
        return;
    }

    list.innerHTML = '';
    playlist.forEach((track) => {
        const item = document.createElement('div');
        item.className = 'track-item-card';
        item.innerHTML = `
            <div class="track-thumb-box">
                <img src="${track.thumbnail_url || track.thumbnail}" alt="" class="track-thumb-img" />
                <span class="track-duration-pill">${formatSeconds(track.duration_seconds || track.duration)}</span>
            </div>
            <div class="track-info-box">
                <div class="track-title">${escapeHtml(track.title)}</div>
                <div class="track-channel">oleh ${escapeHtml(track.channel)}</div>
            </div>
            <div class="track-actions-box">
                <button type="button" class="btn btn-outline btn-sm btn-enqueue-p" title="Masukkan ke Antrean">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                    <span>Antrekan</span>
                </button>
                <button type="button" class="btn btn-ghost btn-icon btn-remove-p" title="Hapus dari Bank Musik">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
        `;

        item.querySelector('.btn-enqueue-p').addEventListener('click', () => {
            if (window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
                alert('🚫 Anda sedang dihukum kalah game! Tidak bisa menambah lagu ke antrean.');
                return;
            }
            if (window.JAMRI_APP.roomQueue && window.JAMRI_APP.roomQueue.some(t => t.youtube_id === track.youtube_id)) {
                showToast('Lagu ini sudah ada di antrean.', 'warning');
                return;
            }
            window.JAMRI_APP.wsClient.sendQueueAdd(track);
            showToast('Lagu dimasukkan ke antrean.', 'success');
        });

        const btnRemove = item.querySelector('.btn-remove-p');
        if (btnRemove) {
            btnRemove.addEventListener('click', () => {
                if (window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
                    alert('🚫 Anda sedang dihukum kalah game! Tidak bisa menghapus lagu dari Bank Musik.');
                    return;
                }
                window.JAMRI_APP.wsClient.sendPlaylistRemove(track.id);
            });
        }

        list.appendChild(item);
    });
}

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
            container.querySelector('#solo-playlist-panel').style.display = t === 'solo-playlist' ? 'block' : 'none';
            container.querySelector('#solo-offline-panel').style.display = t === 'solo-offline' ? 'block' : 'none';

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
                <img src="${track.thumbnail}" alt="" class="track-thumb-img" />
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
                <img src="${track.thumbnail}" alt="" class="track-thumb-img" />
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
                    <img src="${t.thumbnail}" alt="" class="track-thumb-img" />
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

/* ==========================================================================
   BOTTOM PLAYER DOCK CONTROLLER
   ========================================================================== */
function bindPlayerDock(player) {
    const btnPlay = document.getElementById('btn-dock-play');
    const btnPrev = document.getElementById('btn-dock-prev');
    const btnNext = document.getElementById('btn-dock-next');
    const btnLoop = document.getElementById('btn-dock-loop');
    const btnShuffle = document.getElementById('btn-dock-shuffle');
    const btnDownloadJamri = document.getElementById('btn-dock-download-jamri');
    const volumeSlider = document.getElementById('dock-volume-slider');
    const btnMute = document.getElementById('btn-dock-mute');
    const btnMobileMute = document.getElementById('btn-dock-mobile-mute');
    const volumeVal = document.getElementById('dock-volume-val');
    const mobileVolumeSlider = document.getElementById('dock-mobile-volume-slider');
    const mobileVolumeVal = document.getElementById('dock-mobile-volume-val');
    const progressBar = document.getElementById('dock-progress-bar');
    const progressFill = document.getElementById('dock-progress-fill');
    const currentTimeLabel = document.getElementById('dock-current-time');
    const totalTimeLabel = document.getElementById('dock-total-time');

    function getVolumeSvg(vol, size = 15) {
        if (vol === 0) {
            return `
                <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <line x1="23" y1="9" x2="17" y2="15"></line>
                    <line x1="17" y1="9" x2="23" y2="15"></line>
                </svg>
            `;
        } else if (vol <= 0.5) {
            return `
                <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>
            `;
        } else {
            return `
                <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>
            `;
        }
    }

    function updateVolumeUi(vol) {
        if (volumeSlider) {
            volumeSlider.value = vol;
        }
        if (volumeVal) {
            volumeVal.textContent = Math.round(vol * 100) + '%';
        }
        if (mobileVolumeSlider) {
            mobileVolumeSlider.value = vol;
        }
        if (mobileVolumeVal) {
            mobileVolumeVal.textContent = Math.round(vol * 100) + '%';
        }
        if (btnMute) {
            btnMute.innerHTML = getVolumeSvg(vol, 15);
            btnMute.title = vol === 0 ? 'Bunyikan (Unmute Lokal)' : `Bisukan (Mute Lokal) - Volume ${Math.round(vol * 100)}%`;
        }
        if (btnMobileMute) {
            btnMobileMute.innerHTML = getVolumeSvg(vol, 15);
            btnMobileMute.title = vol === 0 ? 'Bunyikan (Unmute Lokal)' : `Bisukan (Mute Lokal) - Volume ${Math.round(vol * 100)}%`;
        }
    }

    // Initialize local volume display
    updateVolumeUi(player.volume);

    function checkControlPermitted() {
        if (window.JAMRI_APP && window.JAMRI_APP.currentView === 'room' && window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
            const sec = window.JAMRI_APP.games.getPunishmentRemainingSeconds();
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            const timeStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            alert(`🚫 Anda sedang dihukum kalah game! Kontrol musik terkunci (sisa ${timeStr}).`);
            return false;
        }
        return true;
    }

    // Play / Pause Click
    btnPlay.addEventListener('click', () => {
        if (!checkControlPermitted()) return;
        player.togglePlay();
    });

    let isNavThrottled = false;
    btnPrev.addEventListener('click', () => {
        if (!checkControlPermitted()) return;
        if (isNavThrottled) return;
        isNavThrottled = true;
        btnPrev.style.opacity = '0.5';
        btnPrev.style.pointerEvents = 'none';
        player.prev();
        setTimeout(() => {
            isNavThrottled = false;
            btnPrev.style.opacity = '1';
            btnPrev.style.pointerEvents = 'auto';
        }, 650);
    });

    btnNext.addEventListener('click', () => {
        if (!checkControlPermitted()) return;
        if (isNavThrottled) return;
        isNavThrottled = true;
        btnNext.style.opacity = '0.5';
        btnNext.style.pointerEvents = 'none';
        player.next();
        setTimeout(() => {
            isNavThrottled = false;
            btnNext.style.opacity = '1';
            btnNext.style.pointerEvents = 'auto';
        }, 650);
    });

    btnLoop.addEventListener('click', () => {
        if (!checkControlPermitted()) return;
        player.toggleLoop();
    });

    if (btnShuffle) {
        btnShuffle.addEventListener('click', () => {
            if (!checkControlPermitted()) return;
            player.toggleShuffle();
        });
    }

    // Local-only volume slider (desktop)
    if (volumeSlider) {
        volumeSlider.addEventListener('input', (e) => {
            player.setVolume(parseFloat(e.target.value));
        });
    }

    // Local-only volume slider (mobile)
    if (mobileVolumeSlider) {
        mobileVolumeSlider.addEventListener('input', (e) => {
            player.setVolume(parseFloat(e.target.value));
        });
    }

    // Local mute toggle buttons
    if (btnMute) {
        btnMute.addEventListener('click', () => {
            player.toggleMute();
        });
    }
    if (btnMobileMute) {
        btnMobileMute.addEventListener('click', () => {
            player.toggleMute();
        });
    }

    // Listen to local volume change events
    player.on('volume_change', (vol) => {
        updateVolumeUi(vol);
    });

    // Progress Scrubber Click
    progressBar.addEventListener('click', (e) => {
        if (!checkControlPermitted()) return;
        const rect = progressBar.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const width = rect.width;
        let duration = 0;
        if (player.currentTrack) {
            duration = player.currentTrack.duration_seconds || player.currentTrack.duration || 0;
        }
        if (duration > 0 && width > 0) {
            const seekTo = (clickX / width) * duration;
            player.seek(seekTo);
        }
    });

    // Download as .jamri Click
    btnDownloadJamri.addEventListener('click', async () => {
        if (!player.currentTrack) {
            alert('Tidak ada lagu yang sedang diputar.');
            return;
        }

        btnDownloadJamri.disabled = true;
        const originalText = btnDownloadJamri.innerHTML;

        try {
            await player.downloadCurrentAsJamri((pct, msg) => {
                btnDownloadJamri.innerHTML = `<span>${Math.round(pct * 100)}%</span>`;
            });
            btnDownloadJamri.innerHTML = `<span>Tersimpan</span>`;
            setTimeout(() => {
                btnDownloadJamri.disabled = false;
                btnDownloadJamri.innerHTML = originalText;
            }, 1800);
        } catch (err) {
            alert(err.message || 'Gagal mengunduh file .jamri');
            btnDownloadJamri.disabled = false;
            btnDownloadJamri.innerHTML = originalText;
        }
    });

    // Player Events
    player.on('state_change', ({ isPlaying }) => {
        updateDockPlayButton(isPlaying);
    });

    player.on('track_change', (track) => {
        updateDockTrackDisplay(track);
    });

    player.on('time_update', ({ currentTime, duration, progress }) => {
        progressFill.style.width = `${progress}%`;
        currentTimeLabel.textContent = formatSeconds(currentTime);
        totalTimeLabel.textContent = formatSeconds(duration);
    });

    player.on('shuffle_change', (isShuffled) => {
        if (!btnShuffle) return;
        btnShuffle.classList.toggle('active-control', isShuffled);
        btnShuffle.classList.toggle('btn-primary', isShuffled);
        btnShuffle.classList.toggle('btn-ghost', !isShuffled);
        btnShuffle.title = isShuffled ? 'Acak Antrean (Shuffle): AKTIF' : 'Acak Antrean (Shuffle): NON-AKTIF';
    });

    player.on('loop_change', (mode) => {
        btnLoop.classList.remove('active-control', 'loop-one', 'loop-all', 'btn-primary');
        btnLoop.classList.add('btn-ghost');

        if (mode === 'one') {
            btnLoop.classList.add('active-control', 'loop-one', 'btn-primary');
            btnLoop.classList.remove('btn-ghost');
            btnLoop.title = 'Looping: ULANGI LAGU INI (1 Lagu terus-menerus)';
            btnLoop.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="17 1 21 5 17 9"></polyline>
                    <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                    <polyline points="7 23 3 19 7 15"></polyline>
                    <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                </svg>
            `;
        } else if (mode === 'all') {
            btnLoop.classList.add('active-control', 'loop-all', 'btn-primary');
            btnLoop.classList.remove('btn-ghost');
            btnLoop.title = 'Looping: PUTAR SEMUA ANTREAN (Antrean berputar terus tanpa habis)';
            btnLoop.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="17 1 21 5 17 9"></polyline>
                    <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                    <polyline points="7 23 3 19 7 15"></polyline>
                    <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                </svg>
            `;
        } else {
            btnLoop.title = 'Looping: NON-AKTIF (Mainkan antrean sampai habis)';
            btnLoop.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="17 1 21 5 17 9"></polyline>
                    <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                    <polyline points="7 23 3 19 7 15"></polyline>
                    <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                </svg>
            `;
        }
    });
}

function updateDockPlayButton(isPlaying) {
    const btn = document.getElementById('btn-dock-play');
    if (!btn) return;
    if (isPlaying) {
        btn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1"></rect>
                <rect x="14" y="4" width="4" height="16" rx="1"></rect>
            </svg>
        `;
        btn.title = 'Jeda';
    } else {
        btn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4"></polygon>
            </svg>
        `;
        btn.title = 'Putar';
    }
}

function updateDockTrackDisplay(track) {
    const titleEl = document.getElementById('dock-track-title');
    const artistEl = document.getElementById('dock-track-artist');
    const thumbEl = document.getElementById('dock-track-thumb');

    if (!track) {
        if (titleEl) titleEl.textContent = 'Tidak ada lagu yang diputar';
        if (artistEl) artistEl.textContent = 'Pilih musik untuk mulai';
        if (thumbEl) thumbEl.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="%231a202c"></svg>';
        return;
    }

    if (titleEl) titleEl.textContent = track.title;
    if (artistEl) artistEl.textContent = track.channel || 'Artis';
    if (thumbEl) thumbEl.src = track.thumbnail || track.thumbnail_url || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="%231a202c"></svg>';
}

/* ==========================================================================
   UTILITY HELPERS
   ========================================================================== */
function formatSeconds(sec) {
    sec = Math.floor(sec || 0);
    if (sec <= 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, m => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[m]));
}

function showToast(message, type = 'info') {
    let container = document.getElementById('jamri-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'jamri-toast-container';
        container.className = 'jamri-toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `jamri-toast jamri-toast-${type}`;

    let iconSvg = '';
    if (type === 'warning') {
        iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    } else if (type === 'success') {
        iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else {
        iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    toast.innerHTML = `
        <span class="toast-icon">${iconSvg}</span>
        <span class="toast-msg">${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);
    requestAnimationFrame(() => {
        toast.classList.add('toast-active');
    });

    setTimeout(() => {
        toast.classList.remove('toast-active');
        setTimeout(() => toast.remove(), 300);
    }, 2800);
}
window.showToast = showToast;

