// Guard: leaving a world mat must clear the shared session completely, and
// re-entering must hydrate from the CURRENT server snapshot.
//
// Reported bug: walking off a mat left the previous track in the player, the dock
// still showed its title and the timeline kept advancing from the stale server
// clock. The mat queue mirror was cleared but the Bank Musik, the users list, the
// mat chat and the playlist mirror were not, so re-entering rendered a mix of old
// and new data instead of the live snapshot.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const world = readFileSync(new URL('../public/js/world.js', import.meta.url), 'utf8');
const player = readFileSync(new URL('../public/js/player.js', import.meta.url), 'utf8');
const search = readFileSync(new URL('../public/js/search.js', import.meta.url), 'utf8');
const php = readFileSync(new URL('../src/WebSocketHandler.php', import.meta.url), 'utf8');

// 1) A dedicated reset exists and drops every piece of shared-session state.
const reset = player.slice(player.indexOf('resetSharedSession() {'), player.indexOf('    _internalSeek(seconds) {'));
for (const field of ['currentTrack', 'serverPlaybackState', 'serverBasePos', 'serverSyncTime', 'pendingSeekPos']) {
    assert.ok(reset.includes(`this.${field}`), `resetSharedSession must clear ${field}`);
}
assert.ok(/this\.currentTrack = null/.test(reset), 'resetSharedSession must null the track');
assert.ok(/serverPlaybackState = 'stopped'/.test(reset), 'resetSharedSession must stop the server state');
assert.ok(/emit\('track_change', null\)/.test(reset),
    'resetSharedSession must emit track_change(null) so the dock clears');
assert.ok(/emit\('time_update'/.test(reset),
    'resetSharedSession must emit a zeroed time_update so the progress bar clears');
assert.ok(!/this\.volume\s*=/.test(reset),
    'resetSharedSession must NOT touch the user volume (that is a local preference)');
assert.ok(!/soloQueue\s*=/.test(reset),
    'resetSharedSession must NOT wipe the local solo queue');

// 2) zone.exit uses it and clears the panel mirrors.
const zoneExit = world.slice(world.indexOf("case 'zone.exit':"), world.indexOf("case 'zone.choice_required':"));
assert.ok(zoneExit.includes('resetSharedSession'),
    'zone.exit must reset the shared session (it used to only pause)');
assert.ok(zoneExit.includes('_resetMatLists'),
    'zone.exit must clear the mat panel lists');
assert.ok(zoneExit.includes('roomState = null'),
    'zone.exit must drop the stale control mode');
const resetLists = world.slice(world.indexOf('_resetMatLists() {'), world.indexOf('renderPlaylist(playlist) {'));
for (const mirror of ['roomQueue', 'roomPlaylist']) {
    assert.ok(resetLists.includes(mirror), `_resetMatLists must clear ${mirror}`);
}
for (const id of ['mat-queue-list', 'mat-playlist-list', 'mat-users-list', 'mat-chat-list']) {
    assert.ok(resetLists.includes(id), `_resetMatLists must blank #${id}`);
}

// 3) Leaving the world does the same (no leak into lobby/solo).
const leaveFn = world.slice(world.indexOf('    leave() {'), world.indexOf('    buildDom() {'));
assert.ok(leaveFn.includes('resetSharedSession'), 'world.leave must reset the shared session');
assert.ok(leaveFn.includes('_resetMatLists'), 'world.leave must clear the mat panel lists');

// 4) Entering a world starts from a clean slate.
const enterFn = world.slice(world.indexOf('    enter(worldId, user) {'), world.indexOf('    bindRoomEvents() {'));
assert.ok(enterFn.includes('_resetMatLists'), 'world.enter must not inherit the previous session lists');
assert.ok(enterFn.includes('activeBox = null'), 'world.enter must start with no active mat');

// 5) room_init is the authoritative snapshot: it must carry the Bank Musik and
//    hydrate the panel from it (so re-entering shows the live playlist).
assert.ok(/getPlaylist\(\$roomId\)/.test(php), 'room_init must load the room playlist');
assert.ok(/'playlist' => \$playlist/.test(php), 'room_init must expose the playlist');
const roomInit = world.slice(world.indexOf('onRoomInit(data) {'), world.indexOf('_clearMatApplyTimers() {'));
assert.ok(roomInit.includes('renderPlaylist(data.playlist'),
    'onRoomInit must hydrate the Bank Musik from the snapshot');
assert.ok(/ws\.on\('playlist_updated'/.test(world),
    'world.js must react to live playlist_updated broadcasts');

// 6) No timeline without a track.
assert.ok(/if \(!this\.currentTrack\) return 0;/.test(player),
    'getCurrentTime/getDuration must return 0 when no track is loaded');
const getCur = player.slice(player.indexOf('    getCurrentTime() {'), player.indexOf('    setVolume('));
assert.ok(/getCurrentTime\(\) \{\n[^}]*?if \(!this\.currentTrack\) return 0;/.test(getCur),
    'getCurrentTime must short-circuit before reading the YT bridge position');
assert.ok(getCur.indexOf('if (!this.currentTrack) return 0;') < getCur.indexOf('this.ytPlayer.getCurrentTime'),
    'the no-track guard must run before the YT bridge is queried');

// 7) Queue/playlist writes must target a real shared room, not a mat we left.
//    hasSharedTarget() decides WHICH queue a track belongs to and must NOT
//    depend on socket state: gating it on isConnected dropped legacy room
//    actions into the private solo queue during a reconnect.
assert.ok(/hasSharedTarget\(\) \{/.test(search),
    'search.js must expose a hasSharedTarget() routing helper');
const targetHelper = search.slice(search.indexOf('hasSharedTarget() {'), search.indexOf('addTracksToBankMusik(tracks) {'));
assert.ok(/app\.world\.activeBox/.test(targetHelper),
    'hasSharedTarget must require an active mat in world mode');
assert.ok(!/isConnected/.test(targetHelper),
    'hasSharedTarget must not depend on socket state (legacy reconnect regression)');

// 8) Emptied room must remember where it stopped.
//    The pause path used to flip the state to 'paused' BEFORE reading the
//    position, but getCurrentPosition() only adds the elapsed delta while state
//    is still 'playing'. The position therefore froze at the last explicit anchor
//    and an emptied room restarted at 0:00 instead of resuming where it stopped.
//    Both the mat detach and the legacy onClose go through pauseRoom(), so the
//    ordering is asserted once, on the shared helper.
const pause = php.slice(php.indexOf('private function pauseRoom'), php.indexOf('public function onMessage'));
assert.ok(pause.indexOf('getCurrentPosition($roomId)') < pause.indexOf("'playback_state'] = $state"),
    'pauseRoom must read the live position BEFORE pausing the room');
assert.ok(/\$this->rooms\[\$roomId\]\['position'\] = \$position/.test(pause),
    'pauseRoom must persist the computed position on the in-memory room');
assert.ok(/\$this->rooms\[\$roomId\]\['last_sync_timestamp'\] = microtime\(true\)/.test(pause),
    'pauseRoom must reset the sync anchor alongside the position');
const detach = php.slice(php.indexOf('private function detachFromRoom'), php.indexOf('private function pauseRoom'));
assert.ok(detach.includes('$this->pauseRoom($roomId)'),
    'detachFromRoom must delegate the pause bookkeeping to pauseRoom');
assert.ok(!detach.includes("'playback_state'] = 'paused'"),
    'detachFromRoom must not pause the room itself (pauseRoom owns the ordering)');

console.log('world_mat_exit_reset_check: OK');
