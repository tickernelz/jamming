// Guards for the bugs found during the full end-to-end QA pass.
//
// Each assertion below maps to a defect that shipped and was reproduced live:
//   2. queue_add auto-start left the started track in the unplayed queue, so the
//      very next `next` replayed the same song instead of advancing.
//   3. Validator methods were typed ?string, so a JSON number/array in any field
//      threw a TypeError inside the daemon (logged as an onMessage error).
//   5. .git/config was served with HTTP 200 (root .htaccess only blocked named
//      folders).
//   6. lyrics.js used inline onerror handlers, which the app's own CSP
//      (script-src without 'unsafe-inline') blocks, and its close button was
//      labelled "Tutup (Esc)" while Escape did nothing.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { appSource } from './lib/app-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const ws = read('../src/WebSocketHandler.php');
const roomManager = read('../src/RoomManager.php');
const validator = read('../src/Validator.php');
const htaccess = read('../.htaccess');
const lyrics = read('../public/js/lyrics.js');
const websocketJs = read('../public/js/websocket.js');
const appJs = appSource();

// 2) A track that auto-starts on queue_add must leave the queue.
const queueAdd = ws.slice(ws.indexOf("case 'queue_add':"), ws.indexOf("case 'queue_reorder':"));
assert.ok(/markTrackPlayed\(\$roomId, \(int\)\$added\['id'\]\)/.test(queueAdd),
    'auto-starting a queued track must mark it played, otherwise next() replays it');
assert.ok(queueAdd.indexOf('markTrackPlayed') < queueAdd.indexOf('setRoomTrack'),
    'the queue must be updated before the track is announced');

// 3) Validators must accept untrusted JSON shapes without a TypeError.
assert.ok(!/public static function \w+\(\?string \$value/.test(validator),
    'no Validator method may be typed ?string: JSON numbers/arrays would throw');
assert.ok(/private static function str\(mixed \$value\)/.test(validator),
    'Validator must coerce non-string JSON values safely');
assert.ok(/Validator::chatMessage\(is_scalar\(\$data\['message'\] \?\? null\)/.test(ws),
    'room chat must coerce its payload before validation');
assert.ok(/Validator::chatMessage\(is_scalar\(\$data\['message'\] \?\? null\)/.test(ws),
    'world chat must coerce its payload before validation');

assert.ok(/new RateLimiter\(\)/.test(ws),
    'WebSocketHandler must run its limiter in memory only');

// 5) VCS metadata must not be web-reachable.
assert.ok(/\\\.\(git\|github\|svn/.test(htaccess),
    '.htaccess must block .git and friends (a named-folder rule does not cover them)');

// 6) No inline handlers (CSP) and Escape must close the lyrics overlay.
for (const [name, src] of [['lyrics.js', lyrics], ['app.js', appJs]]) {
    const inline = src.match(/on(?:error|click|load|input|change|submit)\s*=\s*["'][^"']*["']/g) || [];
    assert.strictEqual(inline.length, 0,
        `${name} must not use inline event handlers (blocked by the app CSP): ${inline.join(', ')}`);
}
assert.ok(/data-fallback="1"/.test(lyrics),
    'cover images must opt in to the delegated error fallback');
assert.ok(/addEventListener\('error'/.test(lyrics),
    'lyrics.js must delegate image errors instead of inline onerror');
assert.ok(/e\.key === 'Escape' && this\.isOpen/.test(lyrics),
    'Escape must close the lyrics overlay (the button is labelled "Tutup (Esc)")');
assert.ok(/openFallbackPiPWindow\(/.test(lyrics),
    'Document PiP must fall back to a popup instead of hard-failing');

// 7) A deleted room must end the session politely, not with an FK error log.
assert.ok(/FOREIGN KEY constraint failed/.test(ws),
    'onMessage must translate FK violations on a deleted room');
assert.ok(/private function handleRoomGone\(/.test(ws),
    'a deleted room must notify the client and detach');

// 8) enterWorld must not run before the profile exists.
assert.ok(/if \(!window\.JAMRI_USER\)/.test(appJs),
    'enterWorld must bail out until the profile exists');

console.log('qa_regressions_check: OK');
