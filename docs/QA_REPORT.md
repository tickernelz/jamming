# QA REPORT — End-to-End (2026-10-21)

> Scope: seluruh fitur Jamri (API, WebSocket legacy room, World mode, Solo,
> Lirik/PiP, keamanan, ketahanan). Basis: commit `0fd2e85`.
> Metode: probe protokol mentah (Node WebSocket), request HTTP langsung, dan
> otomasi browser 2 konteks terpisah (2 user sungguhan).

## Ringkasan

| Area | Checks | Hasil |
|---|---|---|
| API (10 endpoint) | 59 | ✅ 0 gagal |
| WebSocket room legacy | 55 | ✅ 0 gagal |
| WebSocket world | 54 | ✅ 0 gagal |
| Ketahanan (resilience) | 14 | ✅ 0 gagal |
| Keamanan (hardening/XSS) | 58 | ✅ 0 gagal |
| Guard statis `tests/*.mjs` | 22 file | ✅ 0 gagal |
| **Total** | **240** | **✅ 0 gagal** |

Log daemon: **0 error** setelah perbaikan (`onMessage Error` = 0).

## Bug ditemukan & diperbaiki

### 1. 🔴 Private room bisa dibobol lewat WebSocket

**Repro:** `api/room_detail.php` menolak room private tanpa passcode (403), tapi
menyambung langsung ke `ws://localhost:8081/?mode=room&room_id=<private>` memberi
`room_init` penuh — penyerang bisa chat dan mengubah antrean.

**Akar:** `WebSocketHandler::onOpen()` tidak pernah memeriksa `is_private` /
passcode; proteksi hanya ada di jalur HTTP UI.

**Fix:** `RoomManager::canAccessRoom()` (baru) + verifikasi di `onOpen()`;
passcode diteruskan client (`websocket.js` menyimpannya agar reconnect tetap
lolos, `app.js` mengoper passcode dari modal).

**Verifikasi:** join tanpa passcode → `room_not_found` + socket ditutup; dengan
passcode benar → `room_init`.

### 2. 🟠 `next` memutar ulang lagu yang sedang diputar

**Repro:** `queue_add` pada antrean kosong → lagu langsung diputar, tapi tetap
tertinggal di antrean `is_played = 0`. Tekan `next` → lagu yang sama diputar lagi.

**Akar:** `case 'queue_add'` memanggil `setRoomTrack()` tanpa `markTrackPlayed()`.

**Fix:** tandai `is_played = 1` sebelum `setRoomTrack()`, lalu ambil ulang antrean
untuk payload broadcast.

**Verifikasi:** antrean kosong setelah auto-start; `next` pindah ke lagu ke-2.

### 3. 🟠 TypeError di daemon saat payload bukan string

**Repro:** kirim `{"type":"chat","message":12345}` → `Validator::chatMessage():
Argument #1 must be of type ?string, int given` tercatat di log daemon.

**Akar:** semua method `Validator` bertipe `?string`, sedangkan klien JSON bebas
mengirim angka/array/objek.

**Fix:** parameter diubah ke `mixed` + helper `Validator::str()` yang melakukan
koersi aman (array/objek → `''`), dipakai di semua entry point.

**Verifikasi:** 26 payload hostile (angka, array, objek, `<script>`, NaN,
Infinity, 200 KB garbage, nested 200 level) → socket tetap hidup, log bersih.

### 4. 🟠 Rate limit HTTP tidak pernah aktif

**Repro:** 10× `POST api/rooms.php` berturut-turut dari device yang sama → tidak
pernah 429, padahal limitnya 5/300 s.

**Akar:** `RateLimiter` menyimpan bucket **hanya di memori**. PHP HTTP membuat
proses baru tiap request, jadi setiap request mulai dari bucket kosong. Ditambah
lagi `maybePersist()` hanya menulis setiap 50 bucket.

**Fix:** `load()` di konstruktor (restore dari `data/rate_limit.json`), persist
setiap perubahan, `gc()` sebelum tulis, guard file rusak/oversized.

**Verifikasi:** percobaan ke-6 mengembalikan 429.

### 5. 🟠 `.git/config` dapat diakses dari web (HTTP 200)

**Repro:** `GET /jamri/.git/config` → 200 + isi konfigurasi repo.

**Akar:** `.htaccess` hanya memblokir folder bernama (`vendor|src|config|...`),
tidak dot-directory.

**Fix:** `RedirectMatch 404 ^/\.(git|github|svn|hg|...)(/|$)` + aturan
`/\.(git|svn|hg)/` dan blokir ekstensi SQLite/WAL/SHM di mana pun.

**Verifikasi:** `.git/config` → 404, `data/jamri.sqlite` → 403,
`config/database.php` → 403.

### 6. 🟡 Inline `onerror` diblokir CSP + Escape tidak menutup modal lirik

**Repro:** cover art yang gagal dimuat tetap menampilkan ikon rusak, dan console
mencatat *"Executing inline event handler violates the following Content Security
Policy directive"*. Tombol tutup berlabel "Tutup (Esc)" tapi tombol Escape tidak
melakukan apa pun.

**Akar:** `lyrics.js` memakai `onerror="..."` inline (CSP app melarang
`unsafe-inline` untuk script), dan tidak ada handler `Escape`.

**Fix:** atribut `data-fallback="1"` + satu listener `error` terdelegasi di
`initKeyListeners()`; handler `Escape` menutup overlay; PiP jatuh ke popup bila
`documentPictureInPicture.requestWindow()` gagal (bukan error keras).

### 7. 🟡 Snapshot join yang tertunda menimpa state terbaru

**Repro:** masuk tikar → pause → keluar-masuk tikar beberapa kali → resume.
Perangkat kedua tetap `paused` pada posisi lama sementara yang lain `playing`.

**Akar:** `onRoomInit()` memasang `setTimeout(apply, 900)` dan `2200` tanpa
pernah membatalkannya, sehingga snapshot lama diterapkan ulang setelah state
baru tiba.

**Fix:** timer dilacak (`_matApplyTimers`), dibatalkan di `onRoomInit()`,
`zone.exit`, dan `leave()`; `apply()` batal bila `serverSyncTime > wantTime`.

### 8. 🟡 FK violation berisik saat room dihapus di tengah sesi

**Repro:** hapus row room saat user masih terhubung → setiap aksi berikutnya
mencatat `SQLSTATE[23000]: FOREIGN KEY constraint failed` di log.

**Fix:** `onMessage()` menerjemahkan FK violation menjadi `handleRoomGone()`:
kirim `room_not_found` sekali, lepaskan sesi, tutup socket dengan kode 1000
(client kembali ke lobby). Untuk world, cukup lepas ikatan tikar.

### 9. 🟡 `enterWorld()` bisa masuk setengah jalan tanpa profil

**Repro:** klik kartu world sebelum `window.JAMRI_USER` ada → `mode` jadi
`world`, socket mati, dan `TypeError: Cannot read properties of null (reading
'device_id')`.

**Fix:** guard di awal `enterWorld()` yang membuka modal profil dan berhenti.

### 10. 🟡 Test `roommanager_concurrency_check.mjs` selalu gagal di Windows

**Akar:** `new URL('..', import.meta.url).pathname` menghasilkan `/C:/xampp/...`
sehingga PHP membaca path dari root drive.

**Fix:** `fileURLToPath()`. Suite kini 22/22 hijau (sebelumnya 1 selalu merah).

## Yang diverifikasi bekerja (tanpa perubahan)

- **API**: auth GET/POST, validasi & clamp nickname (25), emoji whitelist,
  create room public/private, pencarian (termasuk input SQL-ish), `room_detail`
  dengan/tanpa/kode salah, worlds list+create, chat history + clamp limit,
  playlist add/duplikat/remove, guard method (405), header keamanan.
- **Room legacy**: handshake, `user_joined`/`user_left`, antrean
  add/reorder/remove/shuffle, play/pause/seek/next/prev/track_ended, loop
  off→all→one, chat (escape, clamp 300, anti-spam), soundboard, mini game,
  voice, reconnect (state + posisi + antrean dipulihkan), room private.
- **World**: `world_init` (peta, spawn, boxes, avatars, max_users), gerak +
  collision + clamp out-of-bounds, snapshot 15 Hz, mat place/pickup (owner-only),
  `zone.select` anti-spoof, chat world, emote, playback mat (pause tetap pause,
  late join di posisi yang sama, drift 0.00–0.01 s), limit user, world hilang.
- **UI**: onboarding + edit profil, lobby + pencarian + create (legacy/world,
  public/private), tab room (Antrean/Lirik/Bank Musik/Soundboard/Mini Game),
  tab solo (Antrean/Lirik/Bank Musik/Cache Offline), volume/mute/shuffle/loop,
  modal cari musik + preview/putar/antrean/simpan, lirik otomatis + pencarian
  manual LRCLIB (51 baris termuat), tab chat world (Tikar vs World terpisah),
  XSS di nama room/nickname/chat dirender sebagai teks.

## Batasan pengujian

- **YouTube iframe** diblokir di environment otomasi, jadi audio tidak benarbenar
  berbunyi; sinkronisasi diverifikasi lewat timeline server (`getCurrentTime()`,
  `pong`, `room_init`) yang merupakan sumber kebenaran.
- **Document Picture-in-Picture** tidak tersedia di konteks otomasi
  (`requestWindow` → `InvalidStateError`); fallback popup juga diblokir, dan app
  kini menanganinya dengan toast, bukan crash.
- **Rate limit & purge** menggunakan state file/SQLite nyata; data uji dibersihkan
  setelah setiap putaran.

## Cara menjalankan ulang

```bash
# daemon (wajib untuk room & world)
php bin/websocket.php 8081

# guard statis
node tests/<nama>_check.mjs          # 22 file, semua harus OK

# QA protokol end-to-end
node tests/e2e/qa_api.mjs              # 59 checks
node tests/e2e/qa_room_ws.mjs          # 55 checks
node tests/e2e/qa_world_ws.mjs         # 54 checks
node tests/e2e/qa_resilience.mjs       # 14 checks
node tests/e2e/qa_security.mjs         # 58 checks
node tests/e2e/qa_world_pair.mjs <worldId>   # sinkronisasi mat
```
