// Guard: a PAUSED mat must never start playing on its own.
//
// Two bugs caused it:
//   1. playTrack() unconditionally called playVideo(), so loading a track for a
//      paused mat (late join / room_init) started playback.
//   2. The autoplay-unlock helper armed window 'keydown'/'click' listeners, so
//      walking with WASD "clicked" and resumed the paused song.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const player = readFileSync(new URL('../public/js/player.js', import.meta.url), 'utf8');

// 1) playTrack must consult the server state instead of always playing.
const playTrack = player.slice(player.indexOf('    playTrack(track'), player.indexOf('    async handleRestrictedTrack'));
assert.ok(playTrack.includes('_shouldAutoPlay()'),
    'playTrack must gate playVideo() on _shouldAutoPlay()');
assert.ok(/if \(this\._shouldAutoPlay\(\)\)[\s\S]*?playVideo\(\)/.test(playTrack),
    'playVideo() may only run inside the _shouldAutoPlay() branch');
assert.ok(/pauseVideo\(\)/.test(playTrack),
    'a paused mat must explicitly pauseVideo() after loading');
// No unconditional playVideo() call left in the load path (ignore comments).
const loadIdx = playTrack.indexOf('loadVideoById');
const guardIdx = playTrack.indexOf('if (this._shouldAutoPlay())');
const callIdx = playTrack.indexOf('this.ytPlayer.playVideo()');
assert.ok(guardIdx !== -1 && callIdx !== -1 && guardIdx < callIdx,
    'the autoplay guard must come before the playVideo() call');

// 2) Autoplay unlock must be gated, armed once, and disarmed on pause.
assert.ok(player.includes('_shouldAutoPlay() {'), '_shouldAutoPlay helper must exist');
assert.ok(/_shouldAutoPlay\(\)[\s\S]{0,80}serverPlaybackState === 'playing'/.test(player),
    '_shouldAutoPlay must compare against serverPlaybackState');
assert.ok(player.includes('_armAutoUnlock()'), 'autoplay unlock must go through _armAutoUnlock');
assert.ok(player.includes('_disarmAutoUnlock()'), 'autoplay unlock must be disarmable');
const pauseFn = player.slice(player.indexOf('    pause() {'), player.indexOf('    stop() {'));
assert.ok(pauseFn.includes('_disarmAutoUnlock()'),
    'pause() must disarm the autoplay unlock so WASD cannot resume a paused mat');
const unlock = player.slice(player.indexOf('_armAutoUnlock() {'), player.indexOf('_disarmAutoUnlock() {'));
assert.ok(unlock.includes("_shouldAutoPlay()"),
    'the unlock handler must re-check the server state before playing');

// 3) A track queued before the YT bridge is ready must remember the state.
assert.ok(/pendingTrack = \{[^}]*state:/.test(player),
    'pendingTrack must carry the server playback state');
assert.ok(/pt\.state === 'paused' \|\| !this\._shouldAutoPlay\(\)/.test(player),
    'onReady must re-apply the paused state after the bridge initialises');

console.log('world_paused_state_check: OK');
