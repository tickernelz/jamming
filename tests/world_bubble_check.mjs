// QA: speech-bubble hardening. Bubble text comes from other clients, so it must
// survive control chars, bidi overrides, zero-width joiners, emoji, 10k-char
// payloads and space-less monsters without throwing or overflowing the layout.
//
// The functions under test are pure, so they are lifted out of world.js and
// evaluated in Node with a fake canvas context (measureText = 6px per glyph).
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('../public/js/world.js', import.meta.url), 'utf8');

// ---- extract the three constants + two helpers -----------------------------
const consts = src.slice(src.indexOf('const BUBBLE_MAX_CHARS'), src.indexOf('/**\n * Normalise untrusted chat text'));
const sanitize = src.slice(src.indexOf('function sanitizeBubbleText'), src.indexOf('/**\n * Split sanitised text'));
const wrap = src.slice(src.indexOf('function wrapBubbleLines'), src.indexOf('class JamriWorld'));

assert.ok(consts.includes('BUBBLE_MAX_CHARS'), 'bubble limits must be module constants');
assert.ok(sanitize.length > 100, 'sanitizeBubbleText must be extractable');
assert.ok(wrap.length > 100, 'wrapBubbleLines must be extractable');

const mod = await import('data:text/javascript;base64,' + Buffer.from(
    consts + '\n' + sanitize + '\n' + wrap +
    '\nexport { sanitizeBubbleText, wrapBubbleLines, BUBBLE_MAX_CHARS, BUBBLE_MAX_LINES, BUBBLE_MAX_WIDTH };'
).toString('base64'));

const { sanitizeBubbleText, wrapBubbleLines, BUBBLE_MAX_CHARS, BUBBLE_MAX_LINES, BUBBLE_MAX_WIDTH } = mod;

// ---- fake canvas context --------------------------------------------------
const ctx = {
    font: '12px system-ui, sans-serif',
    // Deterministic width: 6px per code point, 0 for nothing.
    measureText(t) { return { width: Array.from(String(t)).length * 6 }; },
};

let pass = 0;
const check = (name, cond, detail = '') => {
    if (cond) { pass++; return; }
    console.error(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
    process.exitCode = 1;
};

// ---- sanitizer ------------------------------------------------------------
check('plain text passes through', sanitizeBubbleText('halo semua') === 'halo semua');
check('non-string null -> empty', sanitizeBubbleText(null) === '');
check('non-string undefined -> empty', sanitizeBubbleText(undefined) === '');
check('number is coerced', sanitizeBubbleText(42) === '42');
check('object does not throw', (() => { try { sanitizeBubbleText({ a: 1 }); return true; } catch (e) { return false; } })());
check('array does not throw', (() => { try { sanitizeBubbleText([1, 2]); return true; } catch (e) { return false; } })());

const control = sanitizeBubbleText('a\u0000b\u0007c\u001fd');
check('control chars removed', control === 'a b c d', JSON.stringify(control));

const newlines = sanitizeBubbleText('baris1\nbaris2\r\nbaris3\tbaris4');
check('newlines/tabs collapsed to single spaces', newlines === 'baris1 baris2 baris3 baris4', JSON.stringify(newlines));

const bidi = sanitizeBubbleText('ab\u202Ecd\u202Aef\u2066gh\u2069ij');
check('bidi overrides stripped', bidi === 'abcdefghij', JSON.stringify(bidi));

const zero = sanitizeBubbleText('a\u200Bb\u200Dc\uFEFFd\u00ADe');
check('zero-width/invisible chars stripped', zero === 'abcde', JSON.stringify(zero));

const seps = sanitizeBubbleText('x\u2028y\u2029z');
check('line/paragraph separators become spaces', seps === 'x y z', JSON.stringify(seps));

const html = sanitizeBubbleText('<script>alert(1)</script>');
check('html is kept as literal text (canvas draws, never parses)', html === '<script>alert(1)</script>', html);

const long = sanitizeBubbleText('x'.repeat(10000));
check('10k payload capped', Array.from(long).length <= BUBBLE_MAX_CHARS + 1, String(Array.from(long).length));
check('capped text ends with ellipsis', long.endsWith('…'), long.slice(-3));

const emojiLong = sanitizeBubbleText('😀'.repeat(500));
check('emoji payload capped without splitting a surrogate pair',
    Array.from(emojiLong).every(ch => ch === '😀' || ch === '…'),
    JSON.stringify(emojiLong.slice(-2)));

const onlyControls = sanitizeBubbleText('\u0000\u0001\u0002\u200B\u202E');
check('all-invisible message becomes empty (no bubble)', onlyControls === '', JSON.stringify(onlyControls));

const whitespaceOnly = sanitizeBubbleText('   \n\t   ');
check('whitespace-only message becomes empty', whitespaceOnly === '');

// ---- wrapper --------------------------------------------------------------
const wrapOf = (t) => wrapBubbleLines(ctx, t, BUBBLE_MAX_WIDTH - 18);

const w1 = wrapOf('halo semua');
check('short text is one line', w1.length === 1, JSON.stringify(w1));

const w2 = wrapOf('kata '.repeat(60));
check('long text never exceeds the line cap', w2.length <= BUBBLE_MAX_LINES, String(w2.length));
check('long text is summarised with an ellipsis', w2[w2.length - 1].endsWith('…'), JSON.stringify(w2));

const monster = 'x'.repeat(400);
const w3 = wrapOf(monster);
check('a 400-char single word is broken up', w3.length > 1 || w3[0].length < 400, JSON.stringify(w3));
check('broken word stays inside the line cap', w3.length <= BUBBLE_MAX_LINES, String(w3.length));
check('every broken line fits the bubble width',
    w3.every(l => ctx.measureText(l).width <= BUBBLE_MAX_WIDTH - 18),
    JSON.stringify(w3.map(l => ctx.measureText(l).width)));

const w4 = wrapOf('');
check('empty text yields no lines', w4.length === 0, JSON.stringify(w4));

const w5 = wrapOf('a');
check('single char yields one line', w5.length === 1 && w5[0] === 'a', JSON.stringify(w5));

// A word list mixing normal words and a monster token must not throw or loop.
const mixed = wrapOf('pendek ' + 'y'.repeat(300) + ' akhir');
check('mixed monster token handled', Array.isArray(mixed) && mixed.length <= BUBBLE_MAX_LINES, JSON.stringify(mixed));

// Pathological width: nothing fits at all. Must terminate with something.
const tinyCtx = { measureText(t) { return { width: Array.from(String(t)).length * 1000 }; } };
const w6 = wrapBubbleLines(tinyCtx, 'abc def', BUBBLE_MAX_WIDTH);
check('impossible width still returns bounded output', w6.length <= BUBBLE_MAX_LINES, JSON.stringify(w6));

// ---- server payload contract ---------------------------------------------
const php = readFileSync(new URL('../src/WebSocketHandler.php', import.meta.url), 'utf8');
const worldChat = php.slice(php.indexOf("case 'world.chat':"), php.indexOf("case 'world.emote':"));
check('world.chat carries sender_res_id', /'sender_res_id' => \$resId/.test(worldChat),
    'bubbles must anchor by connection id, not nickname');
const roomChat = php.slice(php.indexOf("case 'chat':"), php.indexOf("case 'soundboard_play':"));
check('mat chat carries sender_res_id', /\$saved\['sender_res_id'\] = \$resId/.test(roomChat),
    'mat chat bubbles need the same anchor');

// Both bubble entry points must funnel through the sanitizer.
const showBubble = src.slice(src.indexOf('    showBubble(msg) {'), src.indexOf('    resolveAvatarId(msg) {'));
check('showBubble sanitises before storing', showBubble.includes('sanitizeBubbleText(msg.message)'));
check('showBubble resolves the avatar id explicitly', showBubble.includes('this.resolveAvatarId(msg)'));
check('showBubble caps the bubble map', /this\.bubbles\.size > 64/.test(showBubble));

// Departed avatars must not leak bubbles.
const reap = src.slice(src.indexOf('    reapAvatars(list) {'), src.indexOf('    updateHud(name'));
check('reapAvatars drops bubbles for gone avatars', reap.includes('this.bubbles.delete(id)'));
const leaveCase = src.slice(src.indexOf("case 'world.leave':"), src.indexOf("case 'world.boxes':"));
check('world.leave drops the bubble', leaveCase.includes('this.bubbles.delete(data.id)'));

// Layout must be cached per message, not re-measured every frame.
check('bubble layout is cached', /bub\.layout = \{ lines, bw, bh \}/.test(src));
check('bubble uses the shared wrapper', src.includes('wrapBubbleLines(ctx, bub.text'));

console.log(`world_bubble_check: ${pass} OK`);
