// Guard (static, PHP not runnable in CI): the server must
//  1. detach a world client from its MAT's room on close (not the world id), and
//  2. ask the "which mat?" question only once, not every 15 Hz tick.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('../src/WebSocketHandler.php', import.meta.url), 'utf8');

// 1) onClose detaches via the box's room_id, never $roomId (the world id).
const closeBlock = src.slice(src.indexOf('public function onClose'), src.indexOf('public function onError'));
assert.ok(closeBlock.includes("$this->worldManager->getBox($roomId, $activeBox)"),
    'world onClose must resolve the mat box before detaching');
assert.ok(closeBlock.includes("$this->detachFromRoom($box['room_id'], $resId, $meta)"),
    'world onClose must detach the mat room, not the world id');
assert.ok(!closeBlock.includes("$this->detachFromRoom($roomId, $resId, $meta)"),
    'world onClose must not detach the world id as if it were a room');

// 2) resolveZones sends zone.choice_required at most once per pending choice.
const rz = src.slice(src.indexOf('private function resolveZones'));
assert.ok(rz.includes('if (isset($this->pendingChoice[$worldId][$resId])) {'),
    'resolveZones must short-circuit when a choice prompt is already pending');
const sends = (rz.match(/'type' => 'zone\.choice_required'/g) || []).length;
assert.strictEqual(sends, 1, 'zone.choice_required must be emitted from exactly one guarded site');

// 3) Answering (zone.select) and applying a zone clear the pending flag.
assert.ok(src.includes('unset($this->pendingChoice[$worldId][$resId]);'),
    'pendingChoice must be cleared when a choice is resolved');

console.log('world_zone_choice_check: OK');
