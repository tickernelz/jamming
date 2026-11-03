# Jamri

Collaborative music jamming platform: rooms with a synchronized YouTube player, queue, playlist ("Bank Musik"), chat, soundboard, push-to-talk voice, lyrics/karaoke, and mini games. PHP 8.1+ with SQLite for the REST API and a Ratchet WebSocket daemon for real-time room state.

Original author: Richie Imani. Published here with his permission after the original deployment (jamming.rici.my.id) went offline.

Live: https://jamming.zhafron.my.id

## Layout

| Path | Purpose |
|---|---|
| `index.php` | Single-page shell |
| `api/*.php` | REST endpoints (auth, rooms, room_detail, chat, search, stream, lyrics, soundboard) |
| `bin/websocket.php` | WebSocket daemon (Ratchet), listens on 127.0.0.1:8080 |
| `src/` | `RoomManager`, `UserManager`, `WebSocketHandler`, `YouTubeService` |
| `config/database.php` | SQLite connection; creates the schema on first use |
| `public/` | CSS, JS modules, PWA manifest and service worker |
| `data/` | Runtime SQLite database and lyrics cache (not committed) |
| `deploy/` | nginx vhost, php-fpm pool and systemd unit used in production |

## Run locally

```bash
composer install
php -S 127.0.0.1:3000 &
php bin/websocket.php 8080
```

Open http://127.0.0.1:3000. The browser connects to `ws://<host>:8080/` over plain HTTP and to `wss://<host>/ws` over HTTPS.

## Production (Fedora + nginx + php-fpm)

1. Copy the app to `/opt/jamri` and run `composer install --no-dev --optimize-autoloader` there, owned by a `jamri` system user.
2. Install `deploy/php-fpm-jamri.conf` to `/etc/php-fpm.d/jamri.conf`, `deploy/nginx-jamri.conf` to `/etc/nginx/conf.d/jamri.conf`, and `deploy/jamri-ws.service` to `/etc/systemd/system/`.
3. With SELinux enforcing: label `/opt/jamri` as `httpd_sys_content_t`, `/opt/jamri/data` as `httpd_sys_rw_content_t`, and set `httpd_can_network_connect=1` so nginx can proxy `/ws`.
4. `systemctl enable --now php-fpm nginx jamri-ws`.

nginx proxies `/ws` to the daemon and returns 404 for `/data/` and dotfiles.

## Known security issues

A penetration test on the original deployment found open issues that are not fixed yet: client-supplied identity with no authentication, stored XSS through the WebSocket `emoji` parameter, no host check on WebSocket playback control, private rooms readable without the passcode, plaintext passcodes, no rate limiting, and unbounded request bodies. They are tracked for the next round of work.
