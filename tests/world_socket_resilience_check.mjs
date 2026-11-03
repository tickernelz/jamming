// Guard (static, PHP not runnable in CI): a world action must never be able to
// close the player's socket.
//
// Bug: onMessage() dispatched world messages BEFORE its try/catch, so a single
// exception inside handleWorldMessage() (FK violation when the world row was
// gone, DB busy, bad payload...) propagated into Ratchet, which closed the
// connection with code 1000. From the UI that looked like "gelar tikar langsung
// disconnect".
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('../src/WebSocketHandler.php', import.meta.url), 'utf8');

// 1) handleWorldMessage must be a try/catch wrapper around a dispatch method.
const handle = src.slice(
    src.indexOf('private function handleWorldMessage'),
    src.indexOf('private function dispatchWorldMessage')
);
assert.ok(handle.includes('try {'), 'handleWorldMessage must wrap dispatch in try');
assert.ok(handle.includes('catch (\\Throwable $e)'), 'handleWorldMessage must catch Throwable');
assert.ok(handle.includes('dispatchWorldMessage('), 'handleWorldMessage must delegate to dispatchWorldMessage');

// The wrapper must NOT rethrow — a rethrow would reach Ratchet and close again.
assert.ok(!/throw\s+\$e/.test(handle), 'handleWorldMessage must not rethrow');

// 2) tickWorlds must isolate each world and the maintenance pass.
const tick = src.slice(
    src.indexOf('public function tickWorlds'),
    src.indexOf('private function tickWorld')
);
assert.ok(/try\s*\{\s*\$this->tickWorld\(/.test(tick),
    'tickWorlds must wrap each world tick so one bad world cannot kill the 15 Hz timer');
assert.ok(/try\s*\{\s*\$this->maintainMats\(\)/.test(tick),
    'tickWorlds must guard maintainMats()');

console.log('world_socket_resilience_check: OK');
