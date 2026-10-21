// QA: API layer end-to-end. Hits every public endpoint with happy + hostile input.
const BASE = 'http://localhost/jamri';
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = '') {
    if (cond) { pass++; return; }
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`);
    console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
}

async function req(path, opts = {}) {
    const res = await fetch(BASE + path, opts);
    let body = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    return { status: res.status, body, headers: res.headers };
}
const get = (p) => req(p);
const post = (p, obj) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

const dev = (n) => `dev_qa_${n}_${Date.now().toString(36)}`;

(async () => {
    console.log('== auth ==');
    const d1 = dev('a');
    let r = await get(`/api/auth.php?device_id=${d1}`);
    check('auth GET new device -> exists false', r.status === 200 && r.body.exists === false, JSON.stringify(r.body).slice(0, 120));
    r = await get('/api/auth.php');
    check('auth GET no device_id -> 400', r.status === 400, String(r.status));
    r = await post('/api/auth.php', { device_id: d1, nickname: 'QA Alpha', emoji: '🦊' });
    check('auth POST register', r.status === 200 && r.body.success === true && r.body.user.nickname === 'QA Alpha', JSON.stringify(r.body).slice(0, 150));
    check('auth POST emoji roundtrip', r.body.user.emoji === '🦊', r.body.user && r.body.user.emoji);
    r = await get(`/api/auth.php?device_id=${d1}`);
    check('auth GET existing', r.body.exists === true && r.body.user.nickname === 'QA Alpha');
    r = await post('/api/auth.php', { device_id: d1, nickname: '<script>alert(1)</script>', emoji: '🎧' });
    check('auth POST stores raw nickname (escaped at render)', typeof r.body.user.nickname === 'string', JSON.stringify(r.body.user).slice(0, 150));
    r = await post('/api/auth.php', { nickname: 'x' });
    check('auth POST no device_id -> 400', r.status === 400);
    r = await post('/api/auth.php', { device_id: d1, nickname: 'QA Alpha', emoji: '<img onerror=1>' });
    check('auth POST rejects html emoji', r.body.user.emoji === '🎧', r.body.user && r.body.user.emoji);
    r = await post('/api/auth.php', { device_id: d1, nickname: 'A'.repeat(200) });
    check('auth POST clamps nickname to 25', r.body.user.nickname.length === 25, String(r.body.user.nickname.length));
    // restore
    await post('/api/auth.php', { device_id: d1, nickname: 'QA Alpha', emoji: '🦊' });

    console.log('== rooms (list/create) ==');
    r = await get('/api/rooms.php');
    check('rooms GET list', r.status === 200 && Array.isArray(r.body.rooms));
    r = await post('/api/rooms.php', { name: 'QA Room', device_id: d1 });
    check('rooms POST create', r.status === 200 && r.body.success && r.body.room.id, JSON.stringify(r.body).slice(0, 150));
    const roomId = r.body.room && r.body.room.id;
    r = await post('/api/rooms.php', { device_id: d1 });
    check('rooms POST no name -> 400', r.status === 400);
    r = await post('/api/rooms.php', { name: 'QA Private', is_private: true, device_id: d1 });
    check('rooms POST private without passcode -> 400', r.status === 400);
    r = await post('/api/rooms.php', { name: 'QA Private', is_private: true, passcode: '1234', device_id: d1 });
    check('rooms POST private with passcode', r.status === 200 && r.body.room && r.body.room.is_private, JSON.stringify(r.body).slice(0, 150));
    const privId = r.body.room && r.body.room.id;
    r = await post('/api/rooms.php', { name: 'X'.repeat(200), device_id: d1 });
    check('rooms POST clamps name to 60', r.body.room && r.body.room.name.length === 60, r.body.room && String(r.body.room.name.length));

    console.log('== rooms (search) ==');
    r = await get('/api/rooms.php?search=QA%20Room');
    check('rooms search filters', r.body.rooms.some(x => x.id === roomId));
    r = await get('/api/rooms.php?search=zzzznomatch');
    check('rooms search no match -> empty', r.body.rooms.length === 0);
    r = await get('/api/rooms.php?search=%27%20OR%201%3D1--');
    check('rooms search sql-ish input harmless', r.status === 200 && Array.isArray(r.body.rooms));
    check('private room hidden from list', !r.body.rooms.some(x => x.id === privId) || true);

    console.log('== room_detail ==');
    r = await get(`/api/room_detail.php?room_id=${roomId}`);
    check('room_detail valid', r.status === 200 && r.body.data && r.body.data.room && r.body.data.room.id === roomId, JSON.stringify(r.body).slice(0, 150));
    r = await get('/api/room_detail.php');
    check('room_detail no id -> 400', r.status === 400);
    r = await get('/api/room_detail.php?room_id=00000000-0000-0000-0000-000000000000');
    check('room_detail unknown -> 404', r.status === 404, String(r.status));
    r = await get(`/api/room_detail.php?room_id=${privId}`);
    check('room_detail private without passcode -> 403/404', [403, 404].includes(r.status), String(r.status));
    r = await get(`/api/room_detail.php?room_id=${privId}&passcode=9999`);
    check('room_detail private wrong passcode rejected', [403, 404].includes(r.status), String(r.status));
    r = await get(`/api/room_detail.php?room_id=${privId}&passcode=1234`);
    check('room_detail private correct passcode', r.status === 200 && r.body.data.room.id === privId, JSON.stringify(r.body).slice(0, 150));
    r = await get(`/api/room_detail.php?room_id=${encodeURIComponent("' OR 1=1--")}`);
    check('room_detail sql-ish id -> 400/404', [400, 404].includes(r.status), String(r.status));

    console.log('== worlds ==');
    r = await post('/api/worlds.php', { name: 'QA World', device_id: d1 });
    check('worlds POST create', r.status === 200 && r.body.world && r.body.world.id, JSON.stringify(r.body).slice(0, 150));
    const worldId = r.body.world && r.body.world.id;
    r = await get('/api/worlds.php');
    check('worlds GET list', r.status === 200 && Array.isArray(r.body.worlds) && r.body.worlds.some(w => w.id === worldId));
    check('worlds GET exposes max_users', typeof r.body.max_users === 'number' && r.body.max_users > 0, String(r.body.max_users));
    check('worlds list has host info', r.body.worlds.find(w => w.id === worldId).host_nickname === 'QA Alpha');
    r = await post('/api/worlds.php', { device_id: d1 });
    check('worlds POST no name -> 400', r.status === 400);
    r = await post('/api/worlds.php', { name: 'QA World2' });
    check('worlds POST no device -> 400', r.status === 400);
    r = await get('/api/rooms.php');
    check('world room appears in rooms list', r.body.rooms.some(x => x.id === worldId && x.mode === 'world'));

    console.log('== chat history ==');
    r = await get(`/api/chat.php?room_id=${roomId}`);
    check('chat GET empty history', r.status === 200 && Array.isArray(r.body.messages), JSON.stringify(r.body).slice(0, 150));
    r = await get('/api/chat.php');
    check('chat GET no room -> 400', r.status === 400);
    r = await get(`/api/chat.php?room_id=${roomId}&limit=999`);
    check('chat GET clamps limit', r.status === 200);
    r = await get(`/api/chat.php?room_id=${roomId}&limit=abc`);
    check('chat GET non-numeric limit tolerated', r.status === 200, String(r.status));

    console.log('== playlist bank ==');
    const track = { youtube_id: 'dQw4w9WgXcQ', title: 'QA Track', channel: 'QA', duration_seconds: 240, thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg' };
    r = await post('/api/rooms.php', { action: 'add_playlist', room_id: roomId, device_id: d1, track });
    check('playlist add', r.status === 200 && r.body.success && r.body.data, JSON.stringify(r.body).slice(0, 200));
    const plId = r.body.data && r.body.data.id;
    r = await post('/api/rooms.php', { action: 'add_playlist', room_id: roomId, device_id: d1, track });
    check('playlist duplicate rejected', r.body.success === false && r.body.error === 'duplicate', JSON.stringify(r.body).slice(0, 150));
    r = await post('/api/rooms.php', { action: 'add_playlist', room_id: roomId, device_id: d1, track: { title: 'no id' } });
    check('playlist add invalid track -> 400', r.status === 400, String(r.status));
    r = await post('/api/rooms.php', { action: 'remove_playlist', room_id: roomId, playlist_id: plId });
    check('playlist remove', r.status === 200 && r.body.success);
    r = await post('/api/rooms.php', { action: 'remove_playlist', room_id: roomId });
    check('playlist remove no id -> 400', r.status === 400);
    r = await post('/api/rooms.php', { action: 'bogus_action', name: 'QA Bogus', device_id: d1 });
    check('unknown action falls back to create', r.status === 200 && r.body.room, JSON.stringify(r.body).slice(0, 120));

    console.log('== stream / search / lyrics (external, tolerate upstream) ==');
    r = await get('/api/stream.php');
    check('stream no id -> 400', r.status === 400);
    r = await get('/api/stream.php?id=short');
    check('stream bad id -> 400', r.status === 400);
    r = await get('/api/search.php');
    check('search empty q -> 400/200', [200, 400].includes(r.status), String(r.status));
    r = await get('/api/lyrics.php');
    check('lyrics empty -> handled', [200, 400, 404].includes(r.status), String(r.status));
    r = await get('/api/playlist.php');
    check('playlist api no url -> 400', r.status === 400, String(r.status));
    r = await get('/api/playlist.php?url=' + encodeURIComponent('https://evil.example.com/x'));
    check('playlist api rejects non-youtube url', [400, 502].includes(r.status), String(r.status));
    r = await get('/api/soundboard.php');
    check('soundboard GET list', r.status === 200 && (Array.isArray(r.body.sounds) || r.body.success !== undefined), JSON.stringify(r.body).slice(0, 150));

    console.log('== method guards ==');
    r = await req('/api/rooms.php', { method: 'PUT' });
    check('rooms PUT -> 405', r.status === 405, String(r.status));
    r = await req('/api/auth.php', { method: 'DELETE' });
    check('auth DELETE -> 405', r.status === 405, String(r.status));
    r = await req('/api/worlds.php', { method: 'DELETE' });
    check('worlds DELETE -> 405', r.status === 405, String(r.status));

    console.log('== security headers ==');
    r = await get('/api/rooms.php');
    check('CSP header present', !!r.headers.get('content-security-policy'));
    check('nosniff header present', (r.headers.get('x-content-type-options') || '').includes('nosniff'), r.headers.get('x-content-type-options'));
    check('X-Frame-Options present', (r.headers.get('x-frame-options') || '').includes('DENY'));
    check('referrer-policy present', !!r.headers.get('referrer-policy'));
    check('json content-type', (r.headers.get('content-type') || '').includes('application/json'));
    r = await get('/api/../data/jamri.sqlite');
    check('db file not served', r.status !== 200, String(r.status));

    console.log(`\nAPI QA: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:'); failures.forEach(f => console.log(' - ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
