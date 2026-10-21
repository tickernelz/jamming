// Guard: in world mode a player standing on a mat must be treated as a SHARED
// session, otherwise "Cari Musik" routes songs into the local solo queue and the
// mat queue looks like it "never syncs".
//
// Bug: every call site tested `player.mode === 'jamming' || activeRoomId`.
// World mode never sets activeRoomId (the socket id is the world id), so adding
// a song played it locally while the mat queue stayed empty for everyone else.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const search = readFileSync(new URL('../public/js/search.js', import.meta.url), 'utf8');

// 1) The helper must exist and understand world mode.
const helper = search.slice(search.indexOf('isSharedSession() {'), search.indexOf('addTracksToBankMusik(tracks) {'));
assert.ok(helper.includes('activeWorldId'), 'isSharedSession must check activeWorldId');
assert.ok(/world\.activeBox/.test(helper), 'isSharedSession must require standing on a mat');
assert.ok(helper.includes('activeRoomId'), 'isSharedSession must keep legacy room support');

// 2) No call site may keep the old room-only check.
const legacyChecks = search.match(/player\.mode === 'jamming' \|\| !!\(window\.JAMRI_APP && window\.JAMRI_APP\.activeRoomId\)/g) || [];
assert.strictEqual(legacyChecks.length, 0,
    'all shared-session checks must use isSharedSession() (found the legacy room-only check)');

const calls = search.match(/this\.isSharedSession\(\)/g) || [];
assert.ok(calls.length >= 4, `expected every entry point to use the helper, found ${calls.length}`);

// 3) world.js must mirror the mat queue so duplicate detection works, and clear
//    it on zone.exit.
const world = readFileSync(new URL('../public/js/world.js', import.meta.url), 'utf8');
assert.ok(/window\.JAMRI_APP\.roomQueue = this\._queue/.test(world),
    'renderQueue must mirror the mat queue into JAMRI_APP.roomQueue');
const zoneExit = world.slice(world.indexOf("case 'zone.exit'"), world.indexOf("case 'zone.choice_required'"));
assert.ok(/window\.JAMRI_APP\.roomQueue = \[\]/.test(zoneExit),
    'zone.exit must clear the mirrored queue');

console.log('world_queue_sync_check: OK');
