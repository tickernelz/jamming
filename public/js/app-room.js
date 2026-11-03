/* ==========================================================================
   JOIN & MANAGE JAMMING ROOM
   ========================================================================== */
// End whichever live session (world or room) is active. Navigation used to
// only check activeRoomId, so leaving a world via the nav tabs/logo left its
// socket and render loop running hidden, and re-entering stacked another one.
// Returns true when a session was left.
function leaveActiveSession() {
    // Clear both ids (no early return): world and room share one socket whose
    // ?mode= is fixed at connect time, so a leftover id from either side would
    // let the next entry overlap the previous session.
    let left = false;
    if (window.JAMRI_APP.activeWorldId) {
        leaveWorld();
        left = true;
    }
    if (window.JAMRI_APP.activeRoomId) {
        leaveRoom();
        left = true;
    }
    return left;
}

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
    // Release the lyrics PiP/modal listeners and timers for this session.
    if (window.JAMRI_APP.lyrics) {
        window.JAMRI_APP.lyrics.teardown();
    }
    const player = window.JAMRI_APP.player;
    // Hentikan musik di device saat keluar dari room jamming
    player.stop();
    player.setMode('solo', null);
    // Drop the room's mirrored lists. They are what search.js consults to decide
    // whether a track goes to a shared queue, so a stale copy must not outlive
    // the session (a fresh join re-renders both from room_detail).
    window.JAMRI_APP.roomQueue = [];
    window.JAMRI_APP.roomPlaylist = [];
    if (window.JAMRI_APP.searchModule) {
        window.JAMRI_APP.searchModule.setWebSocket(null);
    }
    switchView('lobby');
}

async function joinRoom(roomId, passcode = '') {
    // Hangatkan audio bridge langsung dari gesture klik pengguna agar browser mengizinkan autoplay
    if (window.JAMRI_APP && window.JAMRI_APP.player) {
        window.JAMRI_APP.player.warmup();
    }

    try {
        const url = `api/room_detail.php?room_id=${encodeURIComponent(roomId)}`;
        const res = passcode
            ? await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) })
            : await fetch(url);
        const data = await res.json();

        if (!data.success) {
            if (data.error === 'invalid_passcode') {
                if (passcode) alert(data.message || 'Passcode room salah.');
                promptPasscodeModal((data.room && data.room.name) || 'Private Jamming', (code) => joinRoom(roomId, code));
                return;
            }
            alert(data.message || data.error || 'Gagal masuk ke room.');
            return;
        }

        const roomDetail = data.data;

        // Entering a room must end any live world session: the shared socket is
        // connected with a single ?mode=, so room and world cannot both be live.
        if (window.JAMRI_APP.activeWorldId) {
            leaveWorld();
        }

        window.JAMRI_APP.activeRoomId = roomId;

        const player = window.JAMRI_APP.player;
        const ws = window.JAMRI_APP.wsClient;
        const search = window.JAMRI_APP.searchModule;

        player.setMode('jamming', ws);
        search.setWebSocket(ws);

        // Leaving world mode: drop world bindings so room events are handled by
        // the app-level room handlers only.
        if (window.JAMRI_APP.world) {
            ws.listeners = {};
        }

        // Render Room UI Shell
        renderRoomShell(roomDetail);

        // Setup WS Event Listeners for this room BEFORE connecting!
        bindRoomWebSocketEvents(ws, player, roomDetail);

        // Connect WebSocket
        ws.connect(roomId, window.JAMRI_USER, 'room');

        switchView('room');
    } catch (err) {
        console.error('Join room error:', err);
        alert('Gagal menghubungi server room.');
    }
}

function enterWorld(worldId) {
    // Entering a world must end any live room session for the same reason as
    // joinRoom(): one shared socket, one mode. Prevents the two views from
    // overwriting each other's active id and leaving a hidden socket behind.
    if (window.JAMRI_APP.activeRoomId) {
        leaveRoom();
    }

    // The socket handshake sends nickname/emoji/device_id, so a world cannot be
    // entered before the profile exists. Bail out instead of half-entering (the
    // player used to be flipped to 'world' mode with a dead socket).
    if (!window.JAMRI_USER) {
        if (typeof JamriAuth !== 'undefined' && JamriAuth.showProfileModal) {
            JamriAuth.showProfileModal({ nickname: '', emoji: '🎧' }, false);
        }
        return;
    }

    const player = window.JAMRI_APP.player;
    const ws = window.JAMRI_APP.wsClient;

    // Playback inside a world is server-driven (via the mat room), exactly like a
    // legacy jamming room. This used to be setMode('solo', null), which silently
    // disabled every sync branch in player.js (server timeline, ping resync,
    // play/pause routing) — the mat looked like "everyone playing separately".
    player.setMode('world', ws);
    if (window.JAMRI_APP.searchModule) window.JAMRI_APP.searchModule.setWebSocket(window.JAMRI_APP.wsClient);

    window.JAMRI_APP.activeWorldId = worldId;

    if (!window.JAMRI_APP.world) {
        window.JAMRI_APP.world = new JamriWorld(player);
    }
    window.JAMRI_APP.world.enter(worldId, window.JAMRI_USER);
    switchView('world');
}

function leaveWorld() {
    if (window.JAMRI_APP.lyrics) {
        window.JAMRI_APP.lyrics.teardown();
    }
    if (window.JAMRI_APP.world) {
        window.JAMRI_APP.world.leave();
    }
    // Back to a plain local player once the world (and its mat) is gone.
    if (window.JAMRI_APP.player) window.JAMRI_APP.player.setMode('solo', null);
    window.JAMRI_APP.activeWorldId = null;
    switchView('lobby');
}

function renderRoomControl(controlMode, isHost) {
    window.JAMRI_APP.roomControlMode = controlMode;
    const label = document.getElementById('room-control-label');
    if (!label) return;
    const shared = controlMode === 'everyone';
    label.textContent = shared ? 'Kontrol: Bersama' : 'Kontrol: Host';
    const btn = document.getElementById('btn-room-control');
    if (btn) {
        btn.classList.toggle('btn-primary', shared);
        btn.classList.toggle('btn-outline', !shared);
        btn.title = isHost
            ? (shared ? 'Klik untuk mengembalikan kontrol musik ke host saja' : 'Klik untuk mengizinkan semua peserta mengatur musik')
            : (shared ? 'Semua peserta boleh mengatur musik' : 'Hanya host yang mengatur musik');
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
                        Host: ${safeEmoji(room.host_emoji)} ${escapeHtml(room.host_nickname || '')}
                        ${room.is_private ? ' • Private' : ''}
                    </div>
                </div>
            </div>
            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                <div id="room-ptt-slot"></div>
                <button type="button" id="btn-room-control" class="btn btn-outline btn-sm" title="Atur siapa yang boleh mengontrol musik">
                    <span id="room-control-label">Kontrol: Host</span>
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
            <!-- Kolom Kiri: Queue, Lyrics, Playlist & Soundboard Tabs -->
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
                    <button type="button" class="tab-nav-item" data-tab="room-lyrics">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M9 18V5l12-2v13"></path>
                            <circle cx="6" cy="18" r="3"></circle>
                            <circle cx="18" cy="16" r="3"></circle>
                        </svg>
                        <span>Lirik Karaoke</span>
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
                        <span>Soundboard</span>
                    </button>
                    <button type="button" class="tab-nav-item" data-tab="room-games">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect>
                            <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"></circle>
                            <circle cx="15.5" cy="15.5" r="1.5" fill="currentColor"></circle>
                        </svg>
                        <span>Mini Game</span>
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
                <div id="room-lyrics-tab-panel" class="tab-panel" style="display:none;">
                    <div id="room-embedded-lyrics-container"></div>
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
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle; margin-right:4px;">
                                    <rect x="4" y="4" width="16" height="16" rx="2"></rect>
                                </svg>
                                <span>Hentikan Suara</span>
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

    container.querySelector('#btn-room-control').addEventListener('click', () => {
        if (!window.JAMRI_USER || !window.JAMRI_USER.is_host) {
            if (typeof showToast === 'function') showToast('Hanya host yang bisa mengubah Kontrol Bersama.', 'warning');
            return;
        }
        const next = window.JAMRI_APP.roomControlMode === 'everyone' ? 'owner' : 'everyone';
        window.JAMRI_APP.wsClient.sendRoomControl(next);
    });
    renderRoomControl(room.box_control || 'owner', !!room.is_host);

    // Search trigger
    container.querySelector('#btn-room-search').addEventListener('click', () => {
        window.JAMRI_APP.searchModule.showModal();
    });

    // Shuffle queue
    const btnShuffleRoom = container.querySelector('#btn-shuffle-room-queue');
    if (btnShuffleRoom) {
        btnShuffleRoom.addEventListener('click', () => {
            if (window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
                window.JAMRI_APP.games.notifyPunishedAction('mengacak antrean');
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

    // Tabs switch
    const tabBtns = container.querySelectorAll('.tab-nav-item');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const target = btn.dataset.tab;
            container.querySelector('#room-queue-tab-panel').style.display = target === 'room-queue' ? 'block' : 'none';
            container.querySelector('#room-lyrics-tab-panel').style.display = target === 'room-lyrics' ? 'flex' : 'none';
            container.querySelector('#room-playlist-tab-panel').style.display = target === 'room-playlist' ? 'block' : 'none';
            container.querySelector('#room-soundboard-tab-panel').style.display = target === 'room-soundboard' ? 'block' : 'none';
            container.querySelector('#room-games-tab-panel').style.display = target === 'room-games' ? 'block' : 'none';

            if (target === 'room-lyrics' && window.JAMRI_APP.lyrics) {
                window.JAMRI_APP.lyrics.registerEmbeddedContainer('room-embedded-lyrics-container');
            }
            if (target === 'room-games' && window.JAMRI_APP.games) {
                window.JAMRI_APP.games.renderPanel(container.querySelector('#room-games-tab-panel'));
            }

            if (window.JAMRI_APP.voicePTT) {
                if (window.JAMRI_APP.voicePTT.isSpeaking && window.JAMRI_APP.voicePTT.currentChannel === 'karaoke' && target !== 'room-lyrics') {
                    window.JAMRI_APP.voicePTT.stopSpeaking();
                }
                if (target === 'room-lyrics') {
                    window.JAMRI_APP.voicePTT.updateKaraokeSpeakerIndicator();
                } else {
                    window.JAMRI_APP.voicePTT.updateSpeakerIndicator();
                }
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
    ws.on('room_not_found', (data) => {
        alert(data.message || 'Room ini sudah tidak aktif atau telah dihapus karena tidak ada aktivitas.');
        leaveRoom();
    });

    ws.on('error', (data) => {
        if (!data || !data.code) return;
        ws.disconnect();
        alert(data.message || 'Koneksi room ditolak server.');
        leaveRoom();
        if (data.code === 'auth_required' && typeof JamriAuth !== 'undefined') {
            window.JAMRI_USER = null;
            JamriAuth.showProfileModal({ nickname: '', emoji: '🎧' }, false);
        }
    });

    ws.on('control_mode_changed', (data) => {
        renderRoomControl(data.control_mode, !!(window.JAMRI_USER && window.JAMRI_USER.is_host));
        if (window.JAMRI_APP.currentChat) {
            const label = data.control_mode === 'everyone' ? 'menyalakan Kontrol Bersama' : 'mengembalikan kontrol musik ke host';
            window.JAMRI_APP.currentChat.appendActivityNotice(label, '', data.triggered_by);
        }
    });

    ws.on('room_init', (data) => {
        if (window.JAMRI_USER) window.JAMRI_USER.is_host = !!data.is_host;
        renderRoomControl(data.control_mode || 'owner', !!data.is_host);
        if (data.queue) renderRoomQueue(data.queue);
        // A reconnect re-sends room_init without re-fetching room_detail, so the
        // Bank Musik tab would keep whatever it rendered on first join.
        if (Array.isArray(data.playlist)) renderRoomPlaylist(data.playlist);
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
            const isSameTrack = player.currentTrack && player.currentTrack.youtube_id === data.current_track.youtube_id;
            if (isSameTrack && (player.isPlaying || player.isSynced())) {
                // Audio is ALREADY loaded/playing for this track (e.g. Server restart / reconnect)!
                // Smoothly sync time without interrupting or reloading the video
                player.syncJammingState(data.current_track, data.state, data.position, data.server_time);
            } else {
                player.playTrack(data.current_track, data.position || 0);
                if (data.state === 'paused') {
                    player.pause();
                }
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
                const modeLabel = data.loop_mode === 'one' ? 'Ulangi 1 Lagu' : (data.loop_mode === 'all' ? 'Ulangi Semua' : 'Nonaktifkan Pengulangan');
                window.JAMRI_APP.currentChat.appendActivityNotice(`mengubah mode putar menjadi ${modeLabel}`, '', data.triggered_by);
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
            window.JAMRI_APP.currentChat.appendActivityNotice('bergabung ke room', '', data.user.nickname);
        }
    });

    ws.on('game_started', (data) => {
        if (window.JAMRI_APP.games) {
            window.JAMRI_APP.games.openGameArena(data);
        }
        if (data.started_by && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice(`memulai permainan ${data.game_name}`, '', data.started_by);
        }
    });

    ws.on('karaoke_mute_toggle', (data) => {
        if (window.JAMRI_APP.currentChat && data.user) {
            const isMe = window.JAMRI_USER && window.JAMRI_USER.nickname === data.user;
            const actionText = data.muted 
                ? (isMe ? 'mematikan suara karaoke peserta lain (telinga butuh istirahat)' : 'mematikan suara karaoke peserta lain')
                : (isMe ? 'mengaktifkan kembali suara karaoke peserta lain' : 'mengaktifkan kembali suara karaoke peserta lain');
            window.JAMRI_APP.currentChat.appendActivityNotice(actionText, '', data.user);
        }
    });

    ws.on('punishments_updated', (data) => {
        if (window.JAMRI_APP.games) {
            window.JAMRI_APP.games.setPunishments(data.punishments || []);
        }
        if (data.cleared_user && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice(`sanksi untuk ${data.cleared_user} telah diampuni oleh ${data.triggered_by || 'Host'}`, '', 'Sistem');
        }
    });

    ws.on('user_left', (data) => {
        if (data.online_users && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.setOnlineUsers(data.online_users);
        }
        if (data.user && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice('keluar dari room', '', data.user.nickname);
        }
    });

    ws.on('chat_message', (data) => {
        if (window.JAMRI_APP.currentChat && data.message) {
            window.JAMRI_APP.currentChat.appendMessage(data.message);
        }
    });

    ws.on('play', (data) => {
        if (player.isPreviewing) return;
        player.syncJammingState(data.track || null, 'playing', data.position, data.server_time, true);
        if (data.triggered_by && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice('memutar musik', '', data.triggered_by);
        }
    });

    ws.on('pause', (data) => {
        if (player.isPreviewing) return;
        player.syncJammingState(data.track || null, 'paused', data.position, data.server_time, true);
        if (data.triggered_by && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice('menjeda musik', '', data.triggered_by);
        }
    });

    ws.on('seek', (data) => {
        if (player.isPreviewing) return;
        player.syncJammingState(data.track || null, data.state, data.position, data.server_time, true);
        if (data.triggered_by && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice('menggeser linimasa musik', '', data.triggered_by);
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
                window.JAMRI_APP.currentChat.appendActivityNotice(`memutar "${data.track.title}"`, '', data.triggered_by);
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
                window.JAMRI_APP.currentChat.appendActivityNotice('mengubah urutan antrean lagu', '', data.triggered_by);
            } else if (data.action === 'shuffle') {
                window.JAMRI_APP.currentChat.appendActivityNotice('mengacak antrean lagu', '', data.triggered_by);
            } else if (data.action === 'remove') {
                const title = data.removed_track_title ? `"${data.removed_track_title}"` : 'sebuah lagu';
                window.JAMRI_APP.currentChat.appendActivityNotice(`menghapus ${title} dari antrean`, '', data.triggered_by);
            } else if (data.added_track) {
                window.JAMRI_APP.currentChat.appendActivityNotice(`menambahkan "${data.added_track.title}" ke antrean`, '', data.triggered_by);
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
                window.JAMRI_APP.currentChat.appendActivityNotice(`menghapus ${title} dari Bank Musik`, '', data.triggered_by);
            } else if (data.added_count && data.added_count > 1) {
                window.JAMRI_APP.currentChat.appendActivityNotice(`menambahkan ${data.added_count} lagu dari playlist ke Bank Musik`, '', data.triggered_by);
            } else if (data.added_track) {
                window.JAMRI_APP.currentChat.appendActivityNotice(`menambahkan "${data.added_track.title}" ke Bank Musik`, '', data.triggered_by);
            }
        }
    });

    ws.on('soundboard_play', (data) => {
        if (data.triggered_by && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.appendActivityNotice(`membunyikan soundboard: ${data.title}`, '', data.triggered_by);
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
                <img src="${safeImageUrl(track.thumbnail_url || track.thumbnail)}" alt="" class="track-thumb-img" />
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
                window.JAMRI_APP.games.notifyPunishedAction('mengubah urutan antrean');
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
                            window.JAMRI_APP.games.notifyPunishedAction('mengubah urutan antrean');
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
                window.JAMRI_APP.games.notifyPunishedAction('memutar lagu');
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
                window.JAMRI_APP.games.notifyPunishedAction('menghapus lagu dari antrean');
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

    list.innerHTML = '';

    if (!playlist || playlist.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>Bank musik room masih kosong. Cari lagu dan klik tombol bookmark untuk menyimpan ke sini.</p></div>';
        return;
    }

    playlist.forEach((track) => {
        const item = document.createElement('div');
        item.className = 'track-item-card';
        item.innerHTML = `
            <div class="track-thumb-box">
                <img src="${safeImageUrl(track.thumbnail_url || track.thumbnail)}" alt="" class="track-thumb-img" />
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
                window.JAMRI_APP.games.notifyPunishedAction('menambah lagu ke antrean');
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
                    window.JAMRI_APP.games.notifyPunishedAction('menghapus lagu dari Bank Musik');
                    return;
                }
                window.JAMRI_APP.wsClient.sendPlaylistRemove(track.id);
            });
        }

        list.appendChild(item);
    });
}
