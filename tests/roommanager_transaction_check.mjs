// Guard (DEV-99): RoomManager playlist/queue mutations must be atomic.
// PHP is not available on the runner, so this is a static source-scan guard:
// every multi-statement mutation that reads then writes queue_order (or checks
// for a duplicate before inserting) must run inside beginTransaction()/commit()
// with a rollBack() on failure, otherwise concurrent room/HTTP writers race.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('../src/RoomManager.php', import.meta.url), 'utf8');

assert.ok(src.includes('private function runAtomically('),
    'RoomManager must expose a runAtomically() transaction helper');
assert.ok(src.includes('$this->pdo->beginTransaction();'), 'runAtomically must begin a transaction');
assert.ok(src.includes('$this->pdo->commit();'), 'runAtomically must commit');
assert.ok(src.includes('$this->pdo->rollBack();'), 'runAtomically must roll back on failure');

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
    const body = methodBody(name);
    assert.ok(body.includes('runAtomically('),
        `${name} mutates queue/playlist state and must be wrapped in runAtomically()`);
}

console.log('roommanager_transaction_check: OK');
