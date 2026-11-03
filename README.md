# Jamri

Collaborative music jamming platform: rooms with a synchronized YouTube player, queue, playlist ("Bank Musik"), chat, soundboard, push-to-talk voice, lyrics/karaoke, mini games, and a pixel "World" mode with jamming mats. PHP 8.1+ with SQLite for the REST API and a Ratchet WebSocket daemon for real-time state.

Original author: Richie Imani ([richies55/jamri](https://github.com/richies55/jamri)). Published here with his permission after the original deployment (jamming.rici.my.id) went offline; his history is merged into this repository.

Live: https://jamming.zhafron.my.id

## Layout

| Path | Purpose |
|---|---|
| `index.php` | Single-page shell |
| `api/*.php` | REST endpoints (auth, rooms, room_detail, chat, worlds, search, playlist, stream, lyrics, health) |
| `bin/websocket.php` | WebSocket daemon (Ratchet), listens on 127.0.0.1 |
| `src/` | `RoomManager`, `UserManager`, `WorldManager`, `WebSocketHandler`, `BoundedWsServer`, `Validator`, `RateLimiter`, `Http`, `YouTubeService` |
| `config/` | SQLite connection and schema/migrations, runtime config |
| `public/` | CSS, JS modules, PWA manifest and service worker |
| `data/` | Runtime SQLite database, rate-limit state, lyrics cache (not committed) |
| `deploy/` | nginx vhost, php-fpm pool, systemd units, backup script |
| `tests/` | PHPUnit suite (`*Test.php`) and static source checks (`*.mjs`) |

## Run locally

```bash
composer install
php -S 127.0.0.1:8000 &
php bin/websocket.php
```

Open http://127.0.0.1:8000. Over plain HTTP the browser connects to `ws://<host>:8081/` (`JAMRI_WS_PORT`, see `config/app.php`); over HTTPS to `wss://<host>/ws`. `JAMRI_DATA_DIR` moves the database and rate-limit state out of `data/`.

## Tests

```bash
vendor/bin/phpunit
for f in tests/*.mjs; do node "$f"; done
```

`tests/ApiTest.php` starts `php -S` against a temporary data directory and drives the HTTP API; `tests/WebSocketHandlerTest.php` drives the socket handler with fake connections. CI (`.github/workflows/ci.yml`) runs lint, PHPUnit on PHP 8.1, 8.4 and 8.5 (production), `composer audit`, the JS syntax and source checks, and shellcheck.

## Production (Fedora + nginx + php-fpm)

1. Copy the app to `/opt/jamri` and run `composer install --no-dev --optimize-autoloader` there, owned by a `jamri` system user.
2. Install `deploy/php-fpm-jamri.conf` to `/etc/php-fpm.d/jamri.conf`, `deploy/nginx-jamri.conf` to `/etc/nginx/conf.d/jamri.conf`, `deploy/nginx-cloudflare-realip.conf` to `/etc/nginx/jamri-cloudflare-realip.conf`, and `deploy/jamri-ws.service`, `deploy/jamri-backup.service`, `deploy/jamri-backup.timer` to `/etc/systemd/system/`.
3. With SELinux enforcing: label `/opt/jamri` as `httpd_sys_content_t`, `/opt/jamri/data` as `httpd_sys_rw_content_t`, and set `httpd_can_network_connect=1` so nginx can proxy `/ws`.
4. `install -d -o jamri -g jamri -m 700 /var/backups/jamri && systemctl enable --now php-fpm nginx jamri-ws jamri-backup.timer`. The backup unit runs as `jamri`, the same account that owns `/opt/jamri`, so root never executes a file the service account can write.

nginx serves only `/`, `index.php`, `api/*.php`, `public/` and the `/ws` proxy; everything else (source, vendor, composer files, data, dotfiles) returns 404. It trusts `CF-Connecting-IP` only from Cloudflare ranges (refresh `nginx-cloudflare-realip.conf` from https://www.cloudflare.com/ips/ when they change), rate-limits `api/*.php` per client (IPv4 address or IPv6 /64), caps request bodies at 1 MB, and sends HSTS. `api/health.php` returns 200 when the database and the WebSocket port answer, 503 otherwise.

Backups: `jamri-backup.timer` runs `deploy/jamri-backup.sh` daily, writing an integrity-checked `VACUUM INTO` copy to `/var/backups/jamri/jamri-<timestamp>.sqlite.gz` and keeping 14 days. Logs: nginx writes `/var/log/nginx/jamri.{access,error}.log`; PHP errors from the pool reach the php-fpm master log `/var/log/php-fpm/error.log` through `catch_workers_output` (the pool user cannot write inside `/var/log/php-fpm`); both are rotated by the stock `/etc/logrotate.d/nginx` and `/etc/logrotate.d/php-fpm` rules. The daemon logs to the journal.

## Security model

- Requests: every request body must be same-origin JSON (`Sec-Fetch-Site`/`Origin` checked, form and text/plain bodies refused), so another site cannot replace a visitor's session by posting to `api/auth.php`.
- Identity is a server session: `api/auth.php` creates the user with a server-chosen id and sets `jamri_session` (HttpOnly, SameSite=Strict, Secure over HTTPS). Only the token's SHA-256 is stored. A client-supplied `device_id` is ignored everywhere, including the WebSocket handshake, which also checks `Origin` and caps connections per IP.
- Private rooms: passcodes are stored with `password_hash` and never serialized. A correct passcode (POST to `api/room_detail.php`) records a grant for that session; attempts are throttled per client network (IPv4 address or IPv6 /64), per room and network, and failures per room across all networks; chat history, playlist actions and the socket require the grant or host status.
- Room control: only the host can play, pause, seek, skip, change the queue or Bank Musik, start games, or clear penalties, until the host switches on "Kontrol Bersama". A guest's `track_ended` only advances the queue near the end of the track.
- Output: nickname, emoji, chat, track fields and thumbnails are validated server-side and escaped client-side; `index.php` and the API send a CSP without `unsafe-inline` scripts whose `connect-src` allows only this origin's WebSocket.
- Limits: per-endpoint and per-socket rate limits (HTTP buckets are atomic upserts in `data/rate_limits.sqlite`, shared by every php-fpm worker and recreated empty if it becomes unreadable, so deleting it at any time only resets counters; the daemon keeps its own in memory), 16 KB JSON request bodies, 256 KB WebSocket messages enforced before buffering.

## Known security issues

- The cap of 30 failed passcodes per room per 10 minutes counts every network, so anyone who sees a private room in the public list can keep new guests from joining it by sending wrong passcodes; the host and guests already granted are not affected. The cap can overshoot by the number of concurrent php-fpm workers (6), since the check happens before the password is verified.
- Losing the browser's cookie means losing the identity (no account recovery); a new profile is created instead.
- Rooms created before the session migration keep their old host id, which no new session can claim; such rooms expire after 10 minutes empty.
- The `.htaccess` files only protect Apache setups (Richie's XAMPP); nginx relies on the location rules in `deploy/nginx-jamri.conf`.
