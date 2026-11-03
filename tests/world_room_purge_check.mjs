// Guard (static, PHP not runnable in CI): a world's backing room must be marked
// occupied while players are inside. createRoom() inserts empty_since = now and
// nothing else cleared it for worlds, so purgeInactiveRooms(600) deleted live
// worlds (and their mats, via ON DELETE CASCADE) 10 minutes after creation.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('../src/WebSocketHandler.php', import.meta.url), 'utf8');

const openWorld = src.slice(src.indexOf('private function openWorld'), src.indexOf('private function handleWorldMessage'));
assert.ok(/markEmptySince\(\$worldId, false\)/.test(openWorld),
    'openWorld must mark the world room non-empty while it has players');

const close = src.slice(src.indexOf('public function onClose'), src.indexOf('public function onError'));
const worldBranch = close.slice(0, close.indexOf("unset($this->rooms[$roomId]['clients'][$resId]);"));
assert.ok(/if \(\$online === 0\)/.test(worldBranch) && /markEmptySince\(\$roomId, true\)/.test(worldBranch),
    'onClose must start the world empty timer once the last player leaves');

console.log('world_room_purge_check: OK');
