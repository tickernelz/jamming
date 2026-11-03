<?php
declare(strict_types=1);

require_once __DIR__ . '/vendor/autoload.php';

Jamri\Http::securityHeaders(false);

// Content-hash cache-busting: assets are cached by the browser & service worker
// and only invalidated when the file actually changes (no more ?v=time()).
$assetVersion = static function (string $relativePath): string {
    $abs = __DIR__ . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativePath);
    $mtime = @filemtime($abs);
    return $mtime !== false ? (string)$mtime : '1';
};
?>
<!DOCTYPE html>
<html lang="id" data-theme="dark">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <title>Jamri - Collaborative Music Jamming & Solo Player</title>
    <meta name="description" content="Platform musik jamming kantor tanpa iklan dan solo audio player dengan dukungan cache offline .jamri." />
    <meta name="referrer" content="origin" />
    
    <!-- PWA Setup -->
    <link rel="manifest" href="public/manifest.json" />
    <meta name="theme-color" content="#2563eb" />
    <link rel="icon" type="image/svg+xml" href="public/icon-192.svg" />
    <link rel="apple-touch-icon" href="public/icon-192.svg" />

    <!-- Stylesheets -->
    <link rel="stylesheet" href="public/css/main.css?v=<?= $assetVersion('public/css/main.css') ?>" />
    <link rel="stylesheet" href="public/css/components.css?v=<?= $assetVersion('public/css/components.css') ?>" />
    <link rel="stylesheet" href="public/css/world.css?v=<?= $assetVersion('public/css/world.css') ?>" />
</head>
<body>

    <!-- NAVBAR HEADER -->
    <header class="app-navbar">
        <div class="brand-wrapper">
            <div class="brand-logo" style="cursor:pointer;" title="Kembali ke Beranda">
                <div class="brand-icon-box">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                    </svg>
                </div>
                <span>JAMRI</span>
            </div>
        </div>

        <nav class="nav-center-tabs">
            <button type="button" class="nav-tab-btn active" data-view="lobby">Lobby Jamming</button>
            <button type="button" class="nav-tab-btn" data-view="solo">Mode Solo (Offline)</button>
        </nav>

        <div class="nav-actions">
            <!-- User Profile Avatar Emoji Badge (Satu-satunya tempat penggunaan emoji) -->
            <div id="user-profile-badge" class="user-profile-pill">
                <span class="user-emoji">🎧</span>
                <span class="user-nickname">Menghubungkan...</span>
            </div>

            <!-- Dark / Day Mode Toggle -->
            <button type="button" id="btn-toggle-theme" class="btn btn-ghost btn-icon" title="Ganti Mode Tampilan">
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
            </button>
        </div>
    </header>

    <!-- MAIN APPLICATION CONTAINER -->
    <main class="main-content">
        
        <!-- VIEW 1: LOBBY & ROOM LIST -->
        <section id="lobby-view">
            <div class="lobby-header-row">
                <div>
                    <h1 class="lobby-title">Lobby Jamming Kantor</h1>
                    <p class="lobby-subtitle">Dengarkan musik bersama rekan kerja secara tersinkronisasi via WebSocket.</p>
                </div>
                <div class="lobby-toolbar">
                    <input type="text" id="input-search-room" class="search-room-input" placeholder="Cari nama room..." autocomplete="off" />
                    <button type="button" id="btn-create-room" class="btn btn-primary">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        <span>Buat Room Jamming</span>
                    </button>
                    <button type="button" id="btn-enter-solo" class="btn btn-outline">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M9 18V5l12-2v13"></path>
                            <circle cx="6" cy="18" r="3"></circle>
                            <circle cx="18" cy="16" r="3"></circle>
                        </svg>
                        <span>Dengar Sendirian (Solo)</span>
                    </button>
                </div>
            </div>

            <!-- List of Jamming Rooms -->
            <div id="rooms-grid-container" class="rooms-grid">
                <div class="loading-spinner-box">
                    <div class="spinner"></div>
                    <span>Memuat daftar room...</span>
                </div>
            </div>
        </section>

        <!-- VIEW 2: JAMMING ROOM VIEW -->
        <section id="room-view" style="display:none;"></section>

        <!-- VIEW 3: SOLO INDIVIDUAL PLAYER VIEW -->
        <section id="solo-view" style="display:none;"></section>

        <!-- VIEW 4: PIXEL WORLD (WORLD MODE) -->
        <section id="world-view" style="display:none;"></section>

    </main>

    <!-- STICKY BOTTOM AUDIO PLAYER DOCK -->
    <footer class="player-dock-bar" id="player-dock">
        <!-- Left: Track info -->
        <div class="dock-track-info">
            <img id="dock-track-thumb" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' fill='%231a202c'></svg>" alt="" class="dock-thumb-img" />
            <div class="dock-titles">
                <div id="dock-track-title" class="dock-song-title">Tidak ada lagu yang diputar</div>
                <div id="dock-track-artist" class="dock-song-artist">Pilih musik untuk mulai</div>
            </div>
            <!-- Mobile Volume Controller (Button + Slider + Percentage) -->
            <div class="dock-mobile-vol-wrapper mobile-only-vol" title="Volume Lokal (Hanya di perangkat Anda)">
                <button type="button" id="btn-dock-mobile-mute" class="btn btn-ghost btn-icon btn-sm" title="Mute / Unmute (Lokal)">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                    </svg>
                </button>
                <input type="range" id="dock-mobile-volume-slider" class="mobile-volume-slider" min="0" max="1" step="0.01" value="0.8" title="Atur Volume Lokal" />
                <span id="dock-mobile-volume-val" class="volume-val-label">80%</span>
            </div>
        </div>

        <!-- Center: Controls & Scrubber -->
        <div class="dock-center-controls">
            <div class="dock-buttons-row">
                <button type="button" id="btn-dock-shuffle" class="btn btn-ghost btn-icon" title="Acak Antrean (Shuffle): MATI">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="16 3 21 3 21 8"></polyline>
                        <line x1="4" y1="20" x2="21" y2="3"></line>
                        <polyline points="21 16 21 21 16 21"></polyline>
                        <line x1="15" y1="15" x2="21" y2="21"></line>
                        <line x1="4" y1="4" x2="9" y2="9"></line>
                    </svg>
                </button>

                <button type="button" id="btn-dock-prev" class="btn btn-ghost btn-icon" title="Lagu Sebelumnya">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="19 20 9 12 19 4 19 20"></polygon>
                        <line x1="5" y1="19" x2="5" y2="5"></line>
                    </svg>
                </button>

                <button type="button" id="btn-dock-play" class="btn-circle-play" title="Putar">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="6 4 20 12 6 20 6 4"></polygon>
                    </svg>
                </button>

                <button type="button" id="btn-dock-next" class="btn btn-ghost btn-icon" title="Lagu Berikutnya">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="5 4 15 12 5 20 5 4"></polygon>
                        <line x1="19" y1="5" x2="19" y2="19"></line>
                    </svg>
                </button>

                <button type="button" id="btn-dock-loop" class="btn btn-ghost btn-icon" title="Looping: OFF">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="17 1 21 5 17 9"></polyline>
                        <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                        <polyline points="7 23 3 19 7 15"></polyline>
                        <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                    </svg>
                </button>
            </div>

            <!-- Scrubber timeline -->
            <div class="dock-scrubber-row">
                <span class="time-label" id="dock-current-time">0:00</span>
                <div class="progress-track" id="dock-progress-bar">
                    <div class="progress-fill" id="dock-progress-fill"></div>
                </div>
                <span class="time-label" id="dock-total-time">0:00</span>
            </div>
        </div>

        <!-- Right: Actions & Volume -->
        <div class="dock-right-controls">
            <!-- Download / Cache .jamri button -->
            <!-- Download / Cache .jamri button -->
            <button type="button" id="btn-dock-download-jamri" class="btn btn-outline btn-sm" title="Simpan sebagai file kompresi .jamri untuk diputar offline">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                <span>Unduh .jamri</span>
            </button>

            <!-- Synchronized Lyrics button in dock -->
            <button type="button" id="btn-dock-lyrics" class="btn btn-outline btn-sm" title="Tampilkan Lirik Lagu (Tekan 'L' untuk Buka/Tutup)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 18V5l12-2v13"></path>
                    <circle cx="6" cy="18" r="3"></circle>
                    <circle cx="18" cy="16" r="3"></circle>
                </svg>
                <span>Lirik</span>
            </button>

            <!-- Search button in dock -->
            <button type="button" id="btn-dock-search" class="btn btn-primary btn-sm" title="Cari Musik">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                </svg>
                <span>Cari Musik</span>
            </button>

            <!-- PiP Button (Desktop Only, Icon-only) -->
            <div class="lyrics-pip-dropdown-wrapper dock-pip-wrapper" id="dock-pip-wrapper">
                <button type="button" class="btn btn-ghost btn-icon btn-sm btn-lyrics-pip" id="btn-dock-pip" title="Floating Picture-in-Picture Karaoke (Desktop)">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="2" y="3" width="20" height="14" rx="2"></rect>
                        <rect x="11" y="9" width="9" height="7" rx="1" fill="currentColor" opacity="0.35"></rect>
                        <rect x="11" y="9" width="9" height="7" rx="1"></rect>
                    </svg>
                </button>
                <div class="lyrics-pip-menu lyrics-pip-menu-up" style="display:none;">
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

            <!-- Local Volume Controller Group (Strictly client-side) -->
            <div class="dock-volume-group" title="Volume Suara Lokal (Hanya di perangkat Anda, tidak mengubah volume orang lain)">
                <button type="button" id="btn-dock-mute" class="btn btn-ghost btn-icon btn-sm" title="Mute / Unmute Volume Lokal">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                    </svg>
                </button>
                <input type="range" id="dock-volume-slider" class="volume-slider" min="0" max="1" step="0.01" value="0.8" title="Volume Lokal (Hanya untuk Anda)" />
                <span id="dock-volume-val" class="volume-val-label">80%</span>
            </div>
        </div>
    </footer>

    <!-- YOUTUBE AUDIO BRIDGE (Positioned behind player dock at bottom:0 with opacity:1 so Chromium does not suspend/pause in background tabs) -->
    <div id="jamri-yt-wrapper" style="position:fixed; bottom:0; left:0; width:240px; height:60px; z-index:50; overflow:hidden; opacity:1; pointer-events:none;">
        <div id="jamri-yt-bridge"></div>
    </div>

    <!-- YOUTUBE IFRAME API -->
    <script src="https://www.youtube.com/iframe_api"></script>

    <!-- JAVASCRIPT LIBRARIES & CLIENT SCRIPTS -->
    <script src="public/js/jamri-format.js?v=<?= $assetVersion('public/js/jamri-format.js') ?>"></script>
    <script src="public/js/identity.js?v=<?= $assetVersion('public/js/identity.js') ?>"></script>
    <script src="public/js/websocket.js?v=<?= $assetVersion('public/js/websocket.js') ?>"></script>
    <script src="public/js/player.js?v=<?= $assetVersion('public/js/player.js') ?>"></script>
    <script src="public/js/chat.js?v=<?= $assetVersion('public/js/chat.js') ?>"></script>
    <script src="public/js/search.js?v=<?= $assetVersion('public/js/search.js') ?>"></script>
    <script src="public/js/soundboard.js?v=<?= $assetVersion('public/js/soundboard.js') ?>"></script>
    <script src="public/js/voice-ptt.js?v=<?= $assetVersion('public/js/voice-ptt.js') ?>"></script>
    <script src="public/js/games.js?v=<?= $assetVersion('public/js/games.js') ?>"></script>
    <script src="public/js/lyrics.js?v=<?= $assetVersion('public/js/lyrics.js') ?>"></script>
    <script src="public/js/world.js?v=<?= $assetVersion('public/js/world.js') ?>"></script>
    <script src="public/js/app-util.js?v=<?= $assetVersion('public/js/app-util.js') ?>"></script>
    <script src="public/js/app-room.js?v=<?= $assetVersion('public/js/app-room.js') ?>"></script>
    <script src="public/js/app-solo.js?v=<?= $assetVersion('public/js/app-solo.js') ?>"></script>
    <script src="public/js/app-dock.js?v=<?= $assetVersion('public/js/app-dock.js') ?>"></script>
    <script src="public/js/app.js?v=<?= $assetVersion('public/js/app.js') ?>"></script>
</body>
</html>
