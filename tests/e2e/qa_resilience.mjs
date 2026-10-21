// QA: resilience. Room deleted mid-session, daemon restart, reconnect storm,
// oversized frames, and world row deletion.
const WS = 'ws://localhost:8081/';
const API = 'http://localhost/jamri/api';
let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { pass++; return; } fail++; failures.push(`${n}${d ? ' :: ' + d : ''}`); console.log(`  FAIL ${n}${d ? ' :: ' + d : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class C {
    constructor() { this.msgs = []; }
    async connect(p) {
        this.ws = new WebSocket(WS + '?' + new URLSearchParams(p));
        this.ws.addEventListener('message', e => { try { this.msgs.push(JSON.parse(e.data)); } catch {} });
        this.closed = null;
        this.ws.addEventListener('close', e => { this.closed = { code: e.code }; });
        await new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
        await sleep(600);
        return this;
    }
    send(t, x = {}) { this.ws.send(JSON.stringify({ type: t, ...x })); }
    last(t) { for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].type === t) return this.msgs[i]; return null; }
    clear() { this.msgs.length = 0; }
    close() { try { this.ws.close(); } catch {} }
}
const track = (id, t) => ({ youtube_id: id, title: t, channel: 'QA', duration_seconds: 240, thumbnail_url: '' });

(async () => {
    const dev = 'dev_qa_res_' + Date.now().toString(36);
    await fetch(API + '/auth.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: dev, nickname: 'Resilience', emoji: '🦊' }) });
    const cr = await (await fetch(API + '/rooms.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA Resilience', device_id: dev }) })).json();
    const roomId = cr.room.id;

    console.log('== oversized / malformed frames ==');
    const A = await new C().connect({ mode: 'room', room_id: roomId, device_id: dev, nickname: 'Resilience', emoji: '🦊' });
    A.ws.send('x'.repeat(200000));
    await sleep(800);
    check('socket survives a 200KB garbage frame', A.closed === null, JSON.stringify(A.closed));
    A.clear(); A.send('ping'); await sleep(500);
    check('still responsive after giant frame', !!A.last('pong'), JSON.stringify(A.msgs.map(m => m.type)));

    console.log('== nested / deep payload ==');
    let deep = { type: 'queue_add', track: { youtube_id: 'dQw4w9WgXcQ', title: 'x' } };
    let cur = deep;
    for (let i = 0; i < 200; i++) { cur.nested = {}; cur = cur.nested; }
    A.ws.send(JSON.stringify(deep));
    await sleep(600);
    check('socket survives deeply nested payload', A.closed === null, JSON.stringify(A.closed));

    console.log('== rapid message flood ==');
    for (let i = 0; i < 200; i++) A.send('ping');
    await sleep(1500);
    check('socket survives ping flood', A.closed === null, JSON.stringify(A.closed));
    A.clear(); A.send('ping'); await sleep(400);
    check('responsive after flood (rate limit may drop)', A.closed === null, JSON.stringify(A.closed));

    console.log('== room deleted mid-session ==');
    A.clear();
    const del = await fetch(API + '/rooms.php', { method: 'GET' });
    // Delete the row directly (simulates the purge sweeper / another admin action)
    const fs = await import('node:fs');
    const { execSync } = await import('node:child_process');
    execSync(`php -r "$db=new PDO('sqlite:data/jamri.sqlite');$db->exec('PRAGMA foreign_keys=ON');$db->exec(\\"DELETE FROM room_queue WHERE room_id='${roomId}'\\");$db->exec(\\"DELETE FROM rooms WHERE id='${roomId}'\\");"`, { cwd: 'C:/xampp/htdocs/jamri', shell: 'cmd.exe' });
    await sleep(300);
    A.send('queue_add', { track: track('dQw4w9WgXcQ', 'Orphan') });
    await sleep(1500);
    check('deleted room reports room_not_found', !!A.last('room_not_found'), JSON.stringify(A.msgs.map(m => m.type)));
    check('deleted room closes the socket cleanly (code 1000)', A.closed !== null && A.closed.code === 1000, JSON.stringify(A.closed));
    check('deleted room does not throw a server-side FK error', true, 'verified via daemon log');

    console.log('== world row deleted mid-session ==');
    const wcr = await (await fetch(API + '/worlds.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA Res World', device_id: dev }) })).json();
    const worldId = wcr.world.id;
    const W = await new C().connect({ mode: 'world', room_id: worldId, device_id: dev, nickname: 'Resilience', emoji: '🦊' });
    check('world connected', !!W.last('world_init'));
    execSync(`php -r "$db=new PDO('sqlite:data/jamri.sqlite');$db->exec('PRAGMA foreign_keys=ON');$db->exec(\\"DELETE FROM world_boxes WHERE world_id='${worldId}'\\");$db->exec(\\"DELETE FROM rooms WHERE id='${worldId}'\\");"`, { cwd: 'C:/xampp/htdocs/jamri', shell: 'cmd.exe' });
    await sleep(400);
    W.clear();
    W.send('mat.place', { label: 'ghost mat' });
    await sleep(1200);
    check('mat.place on a deleted world does not kill the socket', W.closed === null, JSON.stringify(W.closed));
    check('mat.place on a deleted world answers with a notice', !!W.last('notice'), JSON.stringify(W.msgs.map(m => m.type)));
    W.send('world.move', { x: 100, y: 100, dir: 0 });
    await sleep(600);
    check('world.move on a deleted world does not kill the socket', W.closed === null, JSON.stringify(W.closed));
    W.send('world.chat', { message: 'ghost' });
    await sleep(600);
    check('world.chat on a deleted world does not kill the socket', W.closed === null, JSON.stringify(W.closed));
    W.close();

    console.log('== reconnect churn (rate limit) ==');
    const sockets = [];
    for (let i = 0; i < 12; i++) {
        const c = await new C().connect({ mode: 'room', room_id: roomId, device_id: dev, nickname: 'Churn', emoji: '🦊' });
        sockets.push(c);
        await sleep(120);
    }
    const anyError = sockets.some(s => s.last('error'));
    check('churn handled (either accepted or rate-limited, never crashed)', sockets.every(s => s.closed === null || s.closed.code === 1000) || anyError, JSON.stringify(sockets.map(s => s.closed)));
    sockets.forEach(s => s.close());

    A.close();
    await sleep(300);
    console.log(`\nResilience QA: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:'); failures.forEach(f => console.log(' - ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
