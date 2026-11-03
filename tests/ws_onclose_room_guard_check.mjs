// Guard (static, PHP not runnable in CI): onClose() must not touch a room that
// was never attached. A client that joined an unknown/purged room has meta set
// but no $this->rooms entry; count() on it throws a TypeError that Ratchet's
// catch(\Exception) does not catch, killing the daemon.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('../src/WebSocketHandler.php', import.meta.url), 'utf8');
const close = src.slice(src.indexOf('public function onClose'), src.indexOf('public function onError'));

// The world branch returns before the room branch; assert the room branch
// guards the room's existence before indexing/delegating it.
const guardIdx = close.indexOf("if (!isset($this->rooms[$roomId]))");
const detachIdx = close.indexOf("$this->detachFromRoom($roomId, $resId, $meta)");
assert.ok(guardIdx !== -1, 'onClose room branch must guard !isset($this->rooms[$roomId])');
assert.ok(detachIdx !== -1, 'onClose room branch must delegate the detach bookkeeping');
assert.ok(guardIdx < detachIdx, 'the room-existence guard must precede the detach delegation');

// The legacy detach must share the mat's pause bookkeeping instead of keeping a
// second copy: the duplicate copy paused first and then read the position, so an
// emptied legacy room always resumed at 0:00.
assert.ok(!close.includes("count($this->rooms[$roomId]['clients'])"),
    'onClose must not re-implement the client count (it must delegate to detachFromRoom)');
assert.ok(!close.includes("'playback_state'] = 'paused'"),
    'onClose must not pause the room itself (pauseRoom owns the ordering)');

console.log('ws_onclose_room_guard_check: OK');
