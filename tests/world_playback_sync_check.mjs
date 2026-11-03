// Guard: a player who joins a mat mid-song must continue from the SAME position
// as everyone else, exactly like a legacy jamming room does.
//
// Two bugs made world mode drift:
//   1. The world `ping` handler answered with only `server_time`, so there was no
//      playback heartbeat to correct against after the initial room_init.
//   2. world.js wipes `client.listeners = {}` on connect and never re-bound
//      'pong', so even a correct server reply was ignored.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const php = readFileSync(new URL('../src/WebSocketHandler.php', import.meta.url), 'utf8');
const world = readFileSync(new URL('../public/js/world.js', import.meta.url), 'utf8');

// 1) World ping must answer with the mat playback snapshot.
const worldPing = php.slice(
    php.lastIndexOf("case 'ping':"),
    php.lastIndexOf("case 'ping':") + 1400
);
for (const field of ['position', 'state', 'track']) {
    assert.ok(worldPing.includes(`'${field}'`),
        `world ping/pong must include ${field} so the client can re-sync`);
}
assert.ok(worldPing.includes('getActiveBox') && worldPing.includes('room_id'),
    'world pong must resolve the active mat room');

// 2) world.js must actually listen to pong and re-sync the player.
assert.ok(/ws\.on\('pong'/.test(world), "world.js must bind a 'pong' listener");
const pongHandler = world.slice(world.indexOf("ws.on('pong'"), world.indexOf("ws.on('pong'") + 400);
assert.ok(pongHandler.includes('syncJammingState'), 'pong must re-sync playback state');
assert.ok(pongHandler.includes('activeBox'), 'pong must only sync while standing on a mat');

// 3) Joining mid-song must push the server snapshot into the player and re-apply
//    it after the YouTube bridge initialises.
const roomInit = world.slice(world.indexOf('    onRoomInit(data) {'), world.indexOf('    appendRoomChat(msg) {'));
assert.ok(roomInit.includes('serverBasePos'), 'room_init must seed serverBasePos');
assert.ok(roomInit.includes('serverSyncTime'), 'room_init must seed serverSyncTime');
assert.ok(/setTimeout\(apply, 900\)/.test(roomInit),
    'room_init must re-apply the position once the player engine is ready');
assert.ok(roomInit.includes('playTrack(wantTrack, wantPos)'),
    'room_init must start the track at the server position, not 0');

// 4) The deferred re-apply must never undo newer playback state.
//    Leaving the 900ms/2200ms timers unguarded meant a play/pause that arrived
//    right after entering the mat was silently reverted to the join snapshot
//    ("keluar-masuk tikar bikin sinkronnya rusak").
assert.ok(roomInit.includes('_clearMatApplyTimers'), 'room_init must cancel stale re-apply timers');
assert.ok(/serverSyncTime \|\| 0\) > wantTime/.test(roomInit),
    'the deferred apply must bail out when a newer state has arrived');
assert.ok(/this\._matApplyTimers/.test(world), 'deferred timers must be tracked for cancellation');
const zoneExit = world.slice(world.indexOf("case 'zone.exit':"), world.indexOf("case 'zone.choice_required':"));
assert.ok(zoneExit.includes('_clearMatApplyTimers'),
    'leaving the mat must cancel deferred re-applies');
assert.ok(/leave\(\) \{\s*\n\s*this\.unbindInput\(\);\s*\n\s*this\._clearMatApplyTimers\(\);/.test(world),
    'leaving the world must cancel deferred re-applies');

console.log('world_playback_sync_check: OK');
