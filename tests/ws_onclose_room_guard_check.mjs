// Guard (static, PHP not runnable in CI): onClose() must not touch a room that
// was never attached. A client that joined an unknown/purged room has meta set
// but no $this->rooms entry; count() on it throws a TypeError that Ratchet's
// catch(\Exception) does not catch, killing the daemon.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('../src/WebSocketHandler.php', import.meta.url), 'utf8');
const close = src.slice(src.indexOf('public function onClose'), src.indexOf('public function onError'));

// The world branch returns before the room branch; assert the room branch
// guards the room's existence before indexing it.
const guardIdx = close.indexOf("if (!isset($this->rooms[$roomId]))");
const countIdx = close.indexOf("count($this->rooms[$roomId]['clients'])");
assert.ok(guardIdx !== -1, 'onClose room branch must guard !isset($this->rooms[$roomId])');
assert.ok(guardIdx < countIdx, 'the room-existence guard must precede count() on the room');

console.log('ws_onclose_room_guard_check: OK');
