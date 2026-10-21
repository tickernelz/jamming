// Guard (DEV-99 / D1): concurrent queue writers must not lose writes.
//
// RoomManager.runAtomically() must take the SQLite write lock UP FRONT
// (BEGIN IMMEDIATE). A deferred BEGIN reads first and only upgrades to a write
// lock on the first write; when another process (HTTP api/rooms.php vs the
// Ratchet daemon, same SQLite file) already holds that lock, the upgrade fails
// at once with SQLITE_BUSY_SNAPSHOT -- which bypasses busy_timeout -- and the
// write is silently lost.
//
// Static part always runs (fails on the old deferred/beginTransaction shape).
// When a php binary with pdo_sqlite is available, a real two-process race is
// executed and asserted: 0 errors, exactly 1 row, no duplicate queue_order.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const src = readFileSync(new URL('../src/RoomManager.php', import.meta.url), 'utf8');
assert.ok(src.includes("exec('BEGIN IMMEDIATE')"),
    'runAtomically must take the write lock up front with BEGIN IMMEDIATE');
assert.ok(!src.includes('$this->pdo->beginTransaction()'),
    'runAtomically must not use a deferred beginTransaction() (SQLITE_BUSY_SNAPSHOT loses writes)');

// Every read-then-write queue/playlist mutation must go through runAtomically().
const methodBody = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `${name} must exist`);
    const next = src.indexOf('\n    public function ', start + 1);
    const nextPriv = src.indexOf('\n    private function ', start + 1);
    const end = Math.min(...[next, nextPriv].filter((i) => i !== -1));
    return src.slice(start, end === -1 ? undefined : end);
};

for (const name of [
    'addTrackToQueue',
    'addTrackToPlaylist',
    'reorderQueue',
    'shuffleQueue',
    'prependTrackToQueue',
    'moveTrackToEndOfQueue',
]) {
    assert.ok(methodBody(name).includes('runAtomically('),
        `${name} mutates queue/playlist state and must be wrapped in runAtomically()`);
}

const findPhp = () => {
    if (process.env.PHP_BIN) return process.env.PHP_BIN;
    for (const candidate of ['/tmp/php', 'php']) {
        try {
            execFileSync(candidate, ['-r', "exit(in_array('sqlite', PDO::getAvailableDrivers(), true) ? 0 : 1);"], { stdio: 'ignore' });
            return candidate;
        } catch { /* keep looking */ }
    }
    return null;
};

const php = findPhp();
if (!php) {
    console.log('roommanager_concurrency_check: OK (static only -- no php/pdo_sqlite found)');
    process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'jamri-race-'));
const db = join(dir, 't.sqlite');
// new URL(...).pathname yields "/C:/xampp/..." on Windows, which PHP then reads
// as a path relative to the drive root. fileURLToPath() gives a native path.
const repo = fileURLToPath(new URL('..', import.meta.url));

writeFileSync(join(dir, 'setup.php'), `<?php
$db = $argv[1];
@unlink($db); @unlink($db.'-wal'); @unlink($db.'-shm');
$pdo = new PDO('sqlite:' . $db);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('PRAGMA journal_mode = WAL;');
$pdo->exec('CREATE TABLE rooms (id TEXT PRIMARY KEY);');
$pdo->exec('CREATE TABLE room_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, youtube_id TEXT NOT NULL, title TEXT NOT NULL, channel TEXT NOT NULL, duration_seconds INTEGER NOT NULL, thumbnail_url TEXT NULL, added_by_nickname TEXT NOT NULL, queue_order INTEGER NOT NULL, is_played INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);');
$pdo->exec("INSERT INTO rooms (id) VALUES ('r1');");
`);

writeFileSync(join(dir, 'worker.php'), `<?php
require '${repo}src/Validator.php';
require '${repo}src/RoomManager.php';
$db = $argv[1]; $n = (int)$argv[2];
$pdo = new PDO('sqlite:' . $db);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('PRAGMA journal_mode = WAL;');
$pdo->exec('PRAGMA busy_timeout = 5000;');
$rm = new Jamri\\RoomManager($pdo);
$ok = 0; $dup = 0; $errs = 0;
for ($i = 0; $i < $n; $i++) {
    try {
        $r = $rm->addTrackToQueue('r1', ['youtube_id' => 'dQw4w9WgXcQ', 'title' => 'T', 'channel' => 'C', 'duration_seconds' => 3, 'thumbnail_url' => ''], 'w');
        $r === null ? $dup++ : $ok++;
    } catch (\\Throwable $e) { $errs++; }
}
echo json_encode(['ok' => $ok, 'dup' => $dup, 'errs' => $errs]);
`);

const runWorker = () => new Promise((resolve, reject) => {
    const child = spawn(php, [join(dir, 'worker.php'), db, '60'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', () => (err ? reject(new Error(err)) : resolve(JSON.parse(out))));
});

try {
    execFileSync(php, [join(dir, 'setup.php'), db], { stdio: 'ignore' });
    const [a, b] = await Promise.all([runWorker(), runWorker()]);

    assert.strictEqual(a.errs + b.errs, 0,
        `concurrent writers must not hit "database is locked" (A=${JSON.stringify(a)} B=${JSON.stringify(b)})`);

    const rows = JSON.parse(execFileSync(php, ['-r',
        `$p = new PDO('sqlite:${db}'); $p->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION); echo json_encode($p->query('SELECT COUNT(*) c, COUNT(DISTINCT queue_order) d FROM room_queue')->fetch(PDO::FETCH_ASSOC));`,
    ], { encoding: 'utf8' }));
    assert.strictEqual(rows.c, 1, 'the duplicate youtube_id must be stored exactly once');
    assert.strictEqual(rows.d, 1, 'queue_order must not be duplicated by concurrent writers');

    console.log('roommanager_concurrency_check: OK');
} finally {
    rmSync(dir, { recursive: true, force: true });
}
