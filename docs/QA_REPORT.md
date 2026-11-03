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
| Legacy mendalam (per-room) | 50 | ✅ 0 gagal |
| Guard statis `tests/*.mjs` | 23 file | ✅ 0 gagal |
| **Total** | **290** | **✅ 0 gagal** |

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

### 11. 🟠 Keluar tikar tidak mengosongkan playlist / current play

**Repro:** main lagu di tikar → jalan keluar → dock masih menampilkan judul lagu
tikar, `getCurrentTime()` terus maju, Bank Musik + daftar user + chat tikar masih
terisi, dan "Putar"/"Antrean" dari Cari Musik masih menarget room tikar lama.
Masuk lagi menampilkan campuran data lama/baru, bukan snapshot terkini.

**Akar:** `zone.exit` hanya `player.pause()` + mengosongkan antrean. `currentTrack`,
anchor timeline, `roomPlaylist`, `roomState` dan panel lain tidak disentuh;
`search.js` masih memakai cek lama yang tidak melihat tikar.

**Fix:** `player.resetSharedSession()` + `world._resetMatLists()` dipanggil dari
`zone.exit`, `leave()` dan `enter()`; `room_init` sekarang membawa `playlist` dan
`onRoomInit()` meng-hydrate panelnya; `playlist_updated` di-listen; semua tulis
antrean/Bank Musik dirutekan lewat `search.hasSharedTarget()`.

### 12. 🟠 Tikar yang kosong kehilangan posisi (restart 0:00)

**Repro:** putar lagu 6 detik → keluar tikar sampai room kosong → masuk lagi →
mulai dari 0:00, bukan dari 6 detik.

**Akar:** `detachFromRoom()` mengubah `playback_state` ke `paused` **sebelum**
memanggil `getCurrentPosition()`, dan fungsi itu hanya menambah delta waktu saat
state masih `playing`. Posisi jadi membeku di anchor play/seek terakhir.

**Fix:** hitung posisi dulu, baru pause, lalu simpan `position` +
`last_sync_timestamp` di room in-memory.

**Verifikasi:** `tests/e2e/qa_mat_position.mjs` → 6.00 s → keluar → masuk →
**6.55 s** (POSITION OK).

## Audit regresi mode legacy (lanjutan)

Fokus: memastikan pekerjaan mode world **tidak** merusak room legacy, dan
mencari bug legacy yang selama ini tidak terdeteksi. Semua temuan direproduksi
dulu lewat probe WebSocket mentah, baru diperbaiki.

### 13. 🔴 Rate limiter menulis file di hot path daemon (semua room lag)

**Repro:** `tests/e2e/qa_ratelimiter_perf.php` — 200 panggilan `allow()` dengan
key berbeda.

**Akar:** perbaikan #4 (HTTP rate limit tidak pernah aktif) membuat
`maybePersist()` menulis ulang **seluruh** map bucket ke
`data/rate_limit.json` dengan `LOCK_EX` pada setiap perubahan. Di HTTP itu benar
(satu proses per request), tapi daemon Ratchet hidup lama: 10 device × tick
15 Hz = **19.6 ms file I/O per tick** yang memblokir event loop, sehingga
**semua** room (legacy termasuk) terasa lag.

**Fix:** `RateLimiter` sekarang punya flag `persist` (default
`PHP_SAPI !== 'cli'`); `WebSocketHandler` memakai `new RateLimiter(null, false)`.
HTTP tetap persisten, daemon murni in-memory.

**Verifikasi:** 10.244 ms → **0.0025 ms** per panggilan (distinct key), 19.65 ms
→ **0.005 ms** per tick. Rate limit HTTP tetap aktif (5× 200 lalu 429).

### 14. 🟠 Aksi legacy jatuh ke antrean solo saat socket putus

**Repro:** di room legacy, putuskan socket sesaat (tab sleep/ngrok), lalu klik
"Antrean" pada hasil pencarian.

**Akar:** `search.hasWritableSharedTarget()` mensyaratkan `isConnected`. Saat
reconnect, lagu diam-diam masuk ke antrean **pribadi** dan tidak pernah sampai
ke room.

**Fix:** satu helper `search.hasSharedTarget()` (hanya `activeRoomId` atau
`activeWorldId && world.activeBox`, **tanpa** cek socket) dipakai semua jalur
routing; kalau socket sedang turun, muncul toast "Menyambung ulang ke sesi."

### 15. 🟠 Room legacy yang kosong kehilangan posisi (varian #12)

**Repro:** `qa_legacy_deep.mjs` → putar 3.6 s → tutup semua socket → join lagi →
`room_init.position` = **0**.

**Akar:** `onClose()` punya salinan sendiri dari logika pause, dan salinan itu
mengulang bug urutan yang sama seperti #12 (pause dulu, baru hitung posisi).
Perbaikan #12 hanya menyentuh `detachFromRoom()` (jalur tikar).

**Fix:** logika dipindah ke satu helper `pauseRoom()`; `detachFromRoom()` dan
`onClose()` sama-sama memanggilnya. Room tanpa track tetap `stopped` (bukan
`paused` palsu).

**Verifikasi:** 3.61 s → keluar → masuk → **4.02 s**, state `paused`.

### 16. 🟡 Lagu yang sedang diputar bisa dimasukkan ulang ke antrean

**Akar:** `addTrackToQueue()` hanya menolak duplikat baris `is_played = 0`, jadi
track yang sedang diputar lolos dan akan berbunyi dua kali beruntun.

**Fix:** `queue_add` menolak bila `youtube_id` sama dengan `current_track`
(notice "Lagu ini sedang diputar.").

### 17. 🟡 `box_control = 'owner'` tidak ditegakkan di room legacy

**Akar:** pengecekan owner di `onMessage()` digerbangi
`mode === 'world'`, padahal flag-nya ada di baris `rooms`. Room legacy ber-flag
`owner` jadi bisa dikendalikan siapa saja lewat socket.

**Fix:** gerbang mode dihapus; policy berlaku untuk room mana pun yang flag-nya
`owner`. Pesan diubah jadi "Sesi ini hanya bisa dikontrol oleh pemiliknya."

### 18. 🟡 `pause` pada room kosong membuat state `paused` palsu

**Akar:** `pause` tanpa `current_track` tetap menulis `paused`, sehingga UI
menampilkan track yang tidak ada.

**Fix:** tanpa track, state dipertahankan `stopped` + posisi 0.

### 19. 🟡 Bank Musik tidak ter-refresh saat reconnect

**Akar:** `room_init` sudah membawa `playlist` (fix #11), tapi handler
`ws.on('room_init')` di `app.js` hanya memakai `queue`. Reconnect tidak
memanggil `room_detail`, jadi tab Bank Musik tetap menampilkan data lama.

**Fix:** `renderRoomPlaylist(data.playlist)` bila array; `leaveRoom()` juga
mengosongkan `roomQueue`/`roomPlaylist` agar tidak ada salinan basi yang dipakai
`search.js`.

**Verifikasi (UI nyata, Playwright):** peer menambah 1 lagu Bank Musik + 1
antrean + pause → tab Bank Musik & Antrean langsung terisi, footer 0:27,
`isPlaying=false`; keluar → mirror kosong (`0/0`, `hasSharedTarget=false`);
masuk lagi → lagu, antrean, playlist, dan posisi 27.44 s kembali.
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
node tests/e2e/qa_legacy_deep.mjs      # 50 checks (tiap skenario = room baru)
node tests/e2e/qa_ratelimiter_perf.php # biaya allow() (hot path daemon)
node tests/e2e/qa_world_pair.mjs <worldId>    # sinkronisasi mat (1 browser + 2 peer)
node tests/e2e/qa_mat_position.mjs <worldId>  # posisi tikar bertahan saat kosong
node tests/e2e/qa_mat_peer.mjs <worldId> seed  # peer lain mengubah antrean/Bank Musik
```

`qa_legacy_deep.mjs` membuat satu room baru per skenario. Ini penting: versi
awal memakai satu room untuk semua skenario dan menghasilkan 13 kegagalan palsu
karena sisa `youtube_id` di antrean, debounce `track_ended` 3 s, dan
`control_mode` yang sudah di-cache daemon.

