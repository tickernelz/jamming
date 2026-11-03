// QA: input hardening & XSS across every sink that renders user data.
import { readFileSync } from 'node:fs';
const API = 'http://localhost/jamri/api';
let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { pass++; return; } fail++; failures.push(`${n}${d ? ' :: ' + d : ''}`); console.log(`  FAIL ${n}${d ? ' :: ' + d : ''}`); };
const post = (p, o) => fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const get = (p) => fetch(API + p).then(async r => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));

(async () => {
    const dev = 'dev_qa_sec_' + Date.now().toString(36);
    console.log('== stored payloads are stored raw, rendered escaped ==');
    const payloads = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '"><svg onload=alert(1)>',
        "'; DROP TABLE rooms; --",
        '{{7*7}}',
        'javascript:alert(1)',
        '\u0000null\u0000byte',
        '𝕳𝖊𝖑𝖑𝖔 🎧 中文 עברית',
    ];
    for (const [i, p] of payloads.entries()) {
        // A fresh device per payload: auth_write is limited to 10/60s per device.
        const d = `${dev}_p${i}`;
        const r = await post('/auth.php', { device_id: d, nickname: p, emoji: '🎧' });
        check(`nickname payload accepted without 500: ${JSON.stringify(p).slice(0, 30)}`, r.status === 200 && r.body.success, String(r.status));
        check(`nickname clamped to 25 chars: ${JSON.stringify(p).slice(0, 20)}`, r.body.user.nickname.length <= 25, String(r.body.user.nickname.length));
        check(`nickname has no NUL/control chars: ${JSON.stringify(p).slice(0, 20)}`, !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(r.body.user.nickname));
    }
    // DB intact after the DROP TABLE attempt
    const rooms = await get('/rooms.php');
    check('rooms table survived injection payload', rooms.status === 200 && Array.isArray(rooms.body.rooms), String(rooms.status));

    console.log('== emoji is whitelisted ==');
    for (const [i, e] of ['<img src=x>', '"><svg>', 'javascript:', '🎧', '🦊', ''].entries()) {
        const r = await post('/auth.php', { device_id: `${dev}_e${i}`, nickname: 'QA', emoji: e });
        const out = r.body.user.emoji;
        const safe = !/[<>"'`&\\\/{}()\[\]=;:]/.test(out);
        check(`emoji ${JSON.stringify(e)} yields safe value ${JSON.stringify(out)}`, safe, out);
    }

    console.log('== room name / passcode hardening ==');
    const rn = await post('/rooms.php', { name: '<script>alert(1)</script>', device_id: dev });
    check('room name stored (escaped at render)', rn.status === 200 && rn.body.room, String(rn.status));
    const pv = await post('/rooms.php', { name: 'QA Sec', is_private: true, passcode: '<script>x</script>', device_id: dev });
    check('passcode never echoed in create response', pv.status === 200 && !JSON.stringify(pv.body).includes('passcode'), JSON.stringify(pv.body).slice(0, 120));
    const privId = pv.body.room && pv.body.room.id;
    if (privId) {
        const det = await get(`/room_detail.php?room_id=${privId}&passcode=${encodeURIComponent('<script>x</script>')}`);
        check('passcode never returned by room_detail', !JSON.stringify(det.body).includes('"passcode"'), JSON.stringify(det.body).slice(0, 120));
    }

    console.log('== track metadata hardening ==');
    const room = await post('/rooms.php', { name: 'QA Sec Tracks', device_id: dev });
    const roomId = room.body.room.id;
    const evil = {
        youtube_id: 'dQw4w9WgXcQ',
        title: '<img src=x onerror=alert(1)>',
        channel: '<script>alert(1)</script>',
        duration_seconds: -5,
        thumbnail_url: 'https://evil.example.com/x.png',
    };
    const add = await post('/rooms.php', { action: 'add_playlist', room_id: roomId, device_id: dev, track: evil });
    const t = add.body.data;
    check('thumbnail_url from a non-YouTube host is dropped', t && t.thumbnail_url === '', t && JSON.stringify(t.thumbnail_url));
    check('negative duration clamped to 0', t && Number(t.duration_seconds) === 0, t && String(t.duration_seconds));
    check('title preserved (escaped at render)', t && typeof t.title === 'string');

    const jsThumb = await post('/rooms.php', { action: 'add_playlist', room_id: roomId, device_id: dev, track: { ...evil, youtube_id: '9bZkp7q19f0', thumbnail_url: 'javascript:alert(1)' } });
    check('javascript: thumbnail dropped', jsThumb.body.data && jsThumb.body.data.thumbnail_url === '', jsThumb.body.data && jsThumb.body.data.thumbnail_url);

    const httpThumb = await post('/rooms.php', { action: 'add_playlist', room_id: roomId, device_id: dev, track: { ...evil, youtube_id: 'kJQP7kiw5Fk', thumbnail_url: 'http://i.ytimg.com/vi/x/hq.jpg' } });
    check('http (non-https) thumbnail dropped', httpThumb.body.data && httpThumb.body.data.thumbnail_url === '', httpThumb.body.data && httpThumb.body.data.thumbnail_url);

    const badId = await post('/rooms.php', { action: 'add_playlist', room_id: roomId, device_id: dev, track: { ...evil, youtube_id: '<script>alert(1)</script>' } });
    check('invalid youtube_id rejected', badId.status === 400, String(badId.status));

    console.log('== device_id / room_id sanitisation ==');
    const badDev = await get('/auth.php?device_id=' + encodeURIComponent("' OR '1'='1"));
    check('sql-ish device_id returns no user', badDev.status === 200 && badDev.body.exists === false, JSON.stringify(badDev.body).slice(0, 80));
    const longDev = await get('/auth.php?device_id=' + 'a'.repeat(500));
    check('oversized device_id handled', longDev.status === 200, String(longDev.status));

    console.log('== rate limiting ==');
    const dev2 = 'dev_qa_rl_' + Date.now().toString(36);
    await post('/auth.php', { device_id: dev2, nickname: 'RL', emoji: '🎧' });
    let limited = false;
    for (let i = 0; i < 10; i++) {
        const r = await post('/rooms.php', { name: 'RL ' + i, device_id: dev2 });
        if (r.status === 429) { limited = true; break; }
    }
    check('room creation is rate limited', limited, 'never got 429 in 10 attempts');

    console.log('== path traversal / protected dirs ==');
    for (const p of ['/../data/jamri.sqlite', '/../config/database.php', '/../src/Validator.php', '/../vendor/autoload.php', '/../.git/config']) {
        const res = await fetch('http://localhost/jamri/api' + p).catch(() => ({ status: 0 }));
        check(`blocked: api${p}`, res.status !== 200, String(res.status));
    }

    console.log('== static analysis: escaping helpers in use ==');
    const app = readFileSync(new URL('../../public/js/app.js', import.meta.url), 'utf8');
    const chat = readFileSync(new URL('../../public/js/chat.js', import.meta.url), 'utf8');
    const world = readFileSync(new URL('../../public/js/world.js', import.meta.url), 'utf8');
    check('app.js defines escapeHtml', /function escapeHtml/.test(app));
    check('chat.js escapes message bodies', /escapeHtml|textContent/.test(chat));
    check('world.js escapes chat', /escapeHtml|escape\(/.test(world));
    const inlineHandlers = [];
    for (const f of ['app.js', 'chat.js', 'world.js', 'lyrics.js', 'search.js', 'player.js', 'soundboard.js', 'games.js', 'voice-ptt.js']) {
        const src = readFileSync(new URL(`../../public/js/${f}`, import.meta.url), 'utf8');
        // Only count inline handlers inside template literals (real DOM injection)
        const hits = src.match(/on(?:error|click|load|input|change|submit)\s*=\s*["'][^"']*["']/g) || [];
        if (hits.length) inlineHandlers.push(`${f}: ${hits.length}`);
    }
    check('no inline event handlers (CSP script-src has no unsafe-inline)', inlineHandlers.length === 0, inlineHandlers.join(', '));

    console.log('== CSP / headers on the app shell ==');
    const shell = await fetch('http://localhost/jamri/');
    const csp = shell.headers.get('content-security-policy') || '';
    check('CSP present on shell', csp.length > 0);
    check('CSP forbids unsafe-inline scripts', !/script-src[^;]*unsafe-inline/.test(csp), csp.slice(0, 120));
    check('CSP sets object-src none', /object-src 'none'/.test(csp));
    check('CSP sets base-uri self', /base-uri 'self'/.test(csp));
    check('X-Frame-Options DENY', (shell.headers.get('x-frame-options') || '').includes('DENY'));
    check('nosniff present', (shell.headers.get('x-content-type-options') || '').includes('nosniff'));

    console.log(`\nSecurity QA: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:'); failures.forEach(f => console.log(' - ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
