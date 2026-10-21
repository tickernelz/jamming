// Guard: world playback must be SERVER-DRIVEN, like a legacy jamming room.
//
// Root cause of "play masing-masing" + "paused auto-plays": enterWorld() called
// player.setMode('solo', null). Every sync branch in player.js was gated on
// `mode === 'jamming'`, so inside a world:
//   - getCurrentTime() returned the local YT clock instead of the server clock
//   - the player never sent its own ping (no periodic resync)
//   - play/pause/seek/next were applied locally only (never broadcast)
//   - room_init's paused state was ignored
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const player = readFileSync(new URL('../public/js/player.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const search = readFileSync(new URL('../public/js/search.js', import.meta.url), 'utf8');
const lyrics = readFileSync(new URL('../public/js/lyrics.js', import.meta.url), 'utf8');

// 1) A single shared-session helper must exist and understand world mode.
const helper = player.slice(player.indexOf('    isSynced() {'), player.indexOf('    setMode('));
assert.ok(helper.includes("mode === 'jamming'"), 'isSynced must keep legacy jamming support');
assert.ok(helper.includes("mode === 'world'"), 'isSynced must treat world mode as synced');
assert.ok(helper.includes('this.ws'), 'isSynced must require a live socket');

// 2) No sync branch may still test the raw jamming mode (it would be dead in a world).
const rawGuards = player.match(/this\.mode === 'jamming'/g) || [];
assert.strictEqual(rawGuards.length, 1,
    `only isSynced() may compare the raw mode (found ${rawGuards.length} occurrences)`);
const syncedUses = player.match(/this\.isSynced\(\)/g) || [];
assert.ok(syncedUses.length >= 12,
    `all sync branches must use isSynced() (found ${syncedUses.length})`);

// 3) enterWorld must set the world mode WITH the socket, and leaveWorld must reset.
const enter = app.slice(app.indexOf('function enterWorld'), app.indexOf('    window.JAMRI_APP.world.enter(worldId'));
const enterCode = enter.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
assert.ok(/setMode\('world',\s*ws\)/.test(enterCode),
    "enterWorld must call player.setMode('world', ws) — 'solo' killed every sync path");
assert.ok(!/setMode\('solo'/.test(enterCode), 'enterWorld must not downgrade the player to solo');

const leave = app.slice(app.indexOf('function leaveWorld'), app.indexOf('function renderRoomShell'));
assert.ok(/setMode\('solo',\s*null\)/.test(leave),
    'leaveWorld must return the player to local solo mode');

// 4) Other consumers must use the shared helper too.
assert.ok(!/player\.mode === 'jamming'/.test(app), 'app.js must use player.isSynced()');
assert.ok(!/player\.mode === 'jamming'/.test(lyrics), 'lyrics.js must use player.isSynced()');
assert.ok(!/player\.mode === 'jamming'/.test(search), 'search.js must use isSharedSession()');
assert.ok(/this\.player\.isSynced && this\.player\.isSynced\(\)/.test(search),
    'search.isSharedSession must consult player.isSynced()');

// 5) Periodic pong correction must be tighter inside a world. A mat is a shared
//    listening spot, so a 4.5s tolerance (fine for a legacy room's rare stalls)
//    is audible as "everyone playing their own copy".
const sync = player.slice(player.indexOf('syncJammingState(serverTrack'),
    player.indexOf('async downloadCurrentAsJamri'));
assert.ok(/driftLimit/.test(sync), 'periodic pong must use a named drift threshold');
assert.ok(/mode === 'world'\s*\?\s*1\.5\s*:\s*4\.5/.test(sync),
    'world mode must correct at 1.5s, legacy rooms keep 4.5s');

// 6) A world cannot be entered without a profile: the socket handshake needs
//    nickname/emoji/device_id, so half-entering used to flip the player into
//    'world' mode with a dead socket (and throw on user.device_id).
assert.ok(/if \(!window\.JAMRI_USER\)/.test(enterCode),
    'enterWorld must bail out until the user profile exists');
assert.ok(/JamriAuth\.showProfileModal/.test(enterCode),
    'enterWorld must prompt for a profile instead of entering half-way');
assert.ok(enterCode.indexOf('if (!window.JAMRI_USER)') < enterCode.indexOf('setMode('),
    'the profile guard must run before the player mode is switched');

console.log('world_player_mode_check: OK');
