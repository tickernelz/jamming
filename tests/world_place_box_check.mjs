// Guard: placing a mat must fail cleanly, never throw and never leave an orphan
// 'box' room behind.
//
// world_boxes.world_id has a FK to rooms(id). When the world row was already
// gone (purged / deleted from another tab / restart), the INSERT threw a
// PDOException that closed the socket. placeBox() must:
//   1. verify the world row exists before creating the backing room,
//   2. roll the backing room back if the mat row fails,
//   3. return null (the caller shows a notice) instead of throwing.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('../src/WorldManager.php', import.meta.url), 'utf8');
const place = src.slice(src.indexOf('public function placeBox'), src.indexOf('public function removeBox'));

assert.ok(/SELECT 1 FROM rooms WHERE id = :id/.test(place),
    'placeBox must verify the world row exists before inserting (FK safety)');

assert.ok(/try \{[\s\S]*?INSERT INTO world_boxes[\s\S]*?\} catch \(\\Throwable \$e\)/.test(place),
    'the world_boxes INSERT must be wrapped so a DB failure cannot escape');

assert.ok(/DELETE FROM rooms WHERE id = :id/.test(place.slice(place.indexOf('catch'))),
    'a failed mat insert must delete the already-created backing room (no orphans)');

assert.ok(/return null;/.test(place.slice(place.indexOf('catch'))),
    'a failed mat insert must return null, not throw');

console.log('world_place_box_check: OK');
