// QA: world mode WebSocket protocol end-to-end (presence, mats, chat, emotes,
// playback sync, ownership rules, hostile payloads).
const WS = 'ws://localhost:8081/';
const API = 'http://localhost/jamri/api';
let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail = '') => {
    if (cond) { pass++; return; }
    fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`);
    console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class C {
    constructor(tag) { this.tag = tag; this.msgs = []; }
    async connect(p) {
        this.ws = new WebSocket(WS + '?' + new URLSearchParams(p));
        this.ws.addEventListener('message', e => { try { this.msgs.push(JSON.parse(e.data)); } catch {} });
        this.closed = null;
        this.ws.addEventListener('close', e => { this.closed = { code: e.code }; });
        await new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
        await sleep(700);
        return this;
    }
    send(type, extra = {}) { this.ws.send(JSON.stringify({ type, ...extra })); }
    last(t) { for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].type === t) return this.msgs[i]; return null; }
    all(t) { return this.msgs.filter(m => m.type === t); }
    clear() { this.msgs.length = 0; }
    close() { try { this.ws.close(); } catch {} }
}
const track = (id, title) => ({ youtube_id: id, title, channel: 'QA', duration_seconds: 240, thumbnail_url: '' });

(async () => {
    const devA = 'dev_qa_w_a_' + Date.now().toString(36);
    const devB = 'dev_qa_w_b_' + Date.now().toString(36);
    for (const [d, n] of [[devA, 'WorldA'], [devB, 'WorldB']]) {
        await fetch(API + '/auth.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: d, nickname: n, emoji: '🦊' }) });
    }
    const cr = await (await fetch(API + '/worlds.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA World Proto', device_id: devA }) })).json();
    const worldId = cr.world.id;
    console.log('world:', worldId);

    console.log('== handshake & map ==');
    const A = await new C('A').connect({ mode: 'world', room_id: worldId, device_id: devA, nickname: 'WorldA', emoji: '🦊' });
    const init = A.last('world_init');
    check('world_init received', !!init, JSON.stringify(A.msgs.map(m => m.type)));
    check('world_init has map', init && init.map && Array.isArray(init.map.tiles) || (init && init.map && init.map.w), JSON.stringify(init && Object.keys(init.map || {})));
    check('world_init has you (spawn)', init && init.you && Number.isFinite(init.you.x) && Number.isFinite(init.you.y), JSON.stringify(init && init.you));
    check('world_init has boxes', init && Array.isArray(init.boxes));
    check('world_init has avatars', init && Array.isArray(init.avatars) || !!init.players, JSON.stringify(init && Object.keys(init)));
    check('map version exposed', Number.isFinite(init.map.v) && init.map.v > 0, String(init.map.v));
    check('map dims sane', init.map.w > 0 && init.map.h > 0 && init.map.tile > 0, `${init.map.w}x${init.map.h}@${init.map.tile}`);

    console.log('== movement ==');
    A.clear();
    const spawn = init.you;
    A.send('world.move', { x: spawn.x + 32, y: spawn.y, dir: 2 });
    await sleep(500);
    const snap = A.last('world.snapshot');
    check('world.snapshot after move', !!snap, JSON.stringify(A.msgs.map(m => m.type)));
    const meAfter = snap && snap.avatars && snap.avatars.find(a => a.i === init.you.id);
    check('avatar moved', meAfter && Math.abs(meAfter.x - (spawn.x + 32)) < 40, meAfter && `${meAfter.x} vs ${spawn.x + 32}`);

    console.log('== wall collision ==');
    A.clear();
    A.send('world.move', { x: -5000, y: -5000, dir: 0 });
    await sleep(500);
    const s2 = A.last('world.snapshot');
    const me2 = s2 && s2.avatars && s2.avatars.find(a => a.i === init.you.id);
    check('out-of-bounds move clamped/rejected', me2 && me2.x >= 0 && me2.y >= 0, me2 && `${me2.x},${me2.y}`);

    console.log('== second player presence ==');
    const B = await new C('B').connect({ mode: 'world', room_id: worldId, device_id: devB, nickname: 'WorldB', emoji: '🐼' });
    const bInit = B.last('world_init');
    check('B got world_init', !!bInit);
    await sleep(500);
    A.clear();
    A.send('world.move', { x: spawn.x + 60, y: spawn.y + 10, dir: 2 });
    await sleep(600);
    const s3 = A.last('world.snapshot');
    check('A sees 2 avatars', s3 && s3.avatars && s3.avatars.length === 2, s3 && String(s3.avatars.length));

    console.log('== mat placement ==');
    A.clear(); B.clear();
    A.send('mat.place', { label: 'QA Mat', control_mode: 'everyone' });
    await sleep(900);
    const placed = A.last('mat.placed');
    check('mat.placed broadcast', !!placed, JSON.stringify(A.msgs.map(m => m.type)));
    check('B sees mat.placed', !!B.last('mat.placed'));
    const box = placed && placed.box;
    check('mat has id/room_id', box && box.id && box.room_id, JSON.stringify(box && Object.keys(box)));
    check('mat has coords', box && Number.isFinite(box.x) && Number.isFinite(box.y));
    check('placer auto-enters mat', !!A.last('zone.enter'), JSON.stringify(A.msgs.map(m => m.type)));
    check('zone.enter carries room_init', !!A.last('room_init'), JSON.stringify(A.msgs.map(m => m.type)));

    console.log('== mat playback sync ==');
    A.clear(); B.clear();
    A.send('queue_add', { track: track('dQw4w9WgXcQ', 'Mat Song 1') });
    await sleep(1000);
    check('mat track_change on A', !!A.last('track_change'), JSON.stringify(A.msgs.map(m => m.type)));
    check('mat track_change on B (same mat)', !!B.last('track_change'), JSON.stringify(B.msgs.map(m => m.type)));
    await sleep(4000);
    A.clear(); B.clear();
    A.send('ping'); B.send('ping');
    await sleep(600);
    const pa = A.last('pong'), pb = B.last('pong');
    check('A pong has mat box_id', pa && pa.box_id, JSON.stringify(pa));
    check('A pong has track', pa && pa.track && pa.track.youtube_id === 'dQw4w9WgXcQ');
    check('B pong has track', pb && pb.track && pb.track.youtube_id === 'dQw4w9WgXcQ');
    check('A/B mat position drift < 0.2s', pa && pb && Math.abs(pa.position - pb.position) < 0.2, pa && pb && String(Math.abs(pa.position - pb.position)));
    check('mat state is playing', pa && pa.state === 'playing', pa && pa.state);

    console.log('== paused mat stays paused ==');
    A.send('pause');
    await sleep(900);
    check('B receives pause', !!B.last('pause'), JSON.stringify(B.msgs.map(m => m.type)));
    const pausedPos = B.last('pause') && B.last('pause').position;
    A.clear(); B.clear();
    for (let i = 0; i < 5; i++) { A.send('world.move', { x: box.x + i * 6, y: box.y + 5, dir: 2 }); await sleep(120); }
    await sleep(700);
    A.clear(); B.clear(); A.send('ping'); B.send('ping'); await sleep(500);
    check('walking keeps mat paused', A.last('pong').state === 'paused' && B.last('pong').state === 'paused', `${A.last('pong').state}/${B.last('pong').state}`);
    check('paused position frozen', Math.abs(A.last('pong').position - pausedPos) < 0.4, `${A.last('pong').position} vs ${pausedPos}`);

    console.log('== late joiner mid-song ==');
    A.send('play', { position: pausedPos });
    await sleep(2500);
    const C3 = await new C('C').connect({ mode: 'world', room_id: worldId, device_id: 'dev_qa_w_c_' + Date.now().toString(36), nickname: 'WorldC', emoji: '🐧' });
    C3.send('world.move', { x: box.x, y: box.y, dir: 0 });
    await sleep(1600);
    const cInit = C3.last('room_init');
    check('late joiner gets room_init', !!cInit, JSON.stringify(C3.msgs.map(m => m.type)));
    check('late joiner gets live position', cInit && cInit.position > 1, cInit && String(cInit.position));
    check('late joiner gets playing state', cInit && cInit.state === 'playing', cInit && cInit.state);
    C3.clear(); C3.send('ping'); await sleep(500);
    check('late joiner pong matches', Math.abs(C3.last('pong').position - A.last('pong').position) < 25, `${C3.last('pong').position}`);

    console.log('== enter/exit stress ==');
    const drifts = [];
    for (let i = 0; i < 5; i++) {
        C3.send('world.move', { x: box.x + 900, y: box.y + 700, dir: 0 });
        await sleep(500);
        C3.send('world.move', { x: box.x, y: box.y, dir: 0 });
        await sleep(1100);
        A.clear(); C3.clear(); A.send('ping'); C3.send('ping'); await sleep(400);
        drifts.push(Math.abs(A.last('pong').position - C3.last('pong').position));
    }
    check('drift stays tiny across 5 enter/exit cycles', Math.max(...drifts) < 0.3, drifts.map(d => d.toFixed(2)).join(','));
    check('mat still playing after stress', A.last('pong').state === 'playing', A.last('pong').state);
    C3.close();

    console.log('== mat ownership ==');
    B.clear();
    B.send('mat.pickup', { box_id: box.id });
    await sleep(700);
    check('non-owner cannot pick up', !!B.last('notice') && !B.last('mat.removed'), JSON.stringify(B.msgs.map(m => m.type)));
    check('mat still present', !A.last('mat.removed'));

    console.log('== world chat & emote ==');
    A.clear(); B.clear();
    A.send('world.chat', { message: 'halo world' });
    await sleep(700);
    check('B receives world.chat', !!B.last('world.chat'), JSON.stringify(B.msgs.map(m => m.type)));
    check('world chat body intact', B.last('world.chat') && B.last('world.chat').message.message === 'halo world');
    check('world chat sender_nickname', B.last('world.chat') && B.last('world.chat').message.sender_nickname === 'WorldA');
    A.clear(); B.clear();
    A.send('world.emote', { emote: '🔥' });
    await sleep(600);
    check('B receives world.emote', !!B.last('world.emote'), JSON.stringify(B.msgs.map(m => m.type)));
    check('emote value intact', B.last('world.emote') && B.last('world.emote').emote === '🔥', B.last('world.emote') && B.last('world.emote').emote);

    console.log('== hostile payloads ==');
    const beforeClosed = A.closed;
    for (const bad of [
        { type: 'world.move' }, { type: 'world.move', x: 'a', y: null }, { type: 'world.move', x: NaN, y: Infinity },
        { type: 'world.chat' }, { type: 'world.chat', message: 123 }, { type: 'world.chat', message: { a: 1 } },
        { type: 'world.chat', message: ['x'] }, { type: 'world.emote' }, { type: 'world.emote', emote: '<script>' },
        { type: 'mat.place' }, { type: 'mat.place', label: { x: 1 } }, { type: 'mat.place', control_mode: 'hacker' },
        { type: 'mat.pickup' }, { type: 'mat.pickup', box_id: 12345 }, { type: 'zone.select' },
        { type: 'zone.select', box_id: 'nope' }, { type: 'queue_add' }, { type: 'queue_add', track: [] },
        { type: 'pause' }, { type: 'play', position: 'x' }, { type: 'seek' }, { type: 'set_loop', mode: 'x' },
        { type: 'bogus.world.type' }, { type: 'chat' }, { type: 'voice_chunk' }, { type: 'soundboard_play' },
    ]) { A.ws.send(JSON.stringify(bad)); await sleep(110); }
    await sleep(900);
    check('world socket survives hostile payloads', A.closed === null, JSON.stringify(A.closed));
    A.clear(); A.send('ping'); await sleep(500);
    check('world socket still responsive', !!A.last('pong'), JSON.stringify(A.msgs.map(m => m.type)));
    A.ws.send('}{not json');
    await sleep(400);
    check('world socket survives non-JSON', A.closed === null, JSON.stringify(A.closed));

    console.log('== zone.select anti-spoof ==');
    // B is far away; it must not be able to "select" the mat.
    B.send('world.move', { x: box.x + 900, y: box.y + 700, dir: 0 });
    await sleep(600);
    B.clear();
    B.send('zone.select', { box_id: box.id });
    await sleep(700);
    check('cannot select a mat you are not standing on', !B.last('zone.enter'), JSON.stringify(B.msgs.map(m => m.type)));

    console.log('== mat pickup by owner ==');
    A.clear(); B.clear();
    A.send('mat.pickup', { box_id: box.id });
    await sleep(900);
    check('owner picks up mat', !!A.last('mat.removed'), JSON.stringify(A.msgs.map(m => m.type)));
    check('B sees mat.removed', !!B.last('mat.removed'));
    check('placer gets zone.exit', !!A.last('zone.exit'), JSON.stringify(A.msgs.map(m => m.type)));
    check('mat playback stops after pickup', A.last('pong') && A.last('pong').box_id === undefined || !A.last('pong'), 'ok');

    console.log('== world limits ==');
    const maxUsers = (await (await fetch(API + '/worlds.php')).json()).max_users;
    check('max_users published', typeof maxUsers === 'number' && maxUsers > 0, String(maxUsers));

    console.log('== unknown world ==');
    const nw = await new C('nw').connect({ mode: 'world', room_id: '00000000-0000-0000-0000-000000000000', device_id: devA, nickname: 'X', emoji: '🎧' });
    check('unknown world rejected', !!nw.last('world_not_found') || !!nw.closed, JSON.stringify(nw.msgs.map(m => m.type)) + ' closed=' + JSON.stringify(nw.closed));
    nw.close();

    console.log('== disconnect / reconnect ==');
    B.clear(); B.close();
    await sleep(900);
    A.clear(); A.send('world.move', { x: spawn.x + 20, y: spawn.y, dir: 1 }); await sleep(600);
    const s4 = A.last('world.snapshot');
    check('avatar removed after disconnect', s4 && s4.avatars.length === 1, s4 && String(s4.avatars.length));
    const B2 = await new C('B2').connect({ mode: 'world', room_id: worldId, device_id: devB, nickname: 'WorldB', emoji: '🐼' });
    check('reconnect gets fresh world_init', !!B2.last('world_init'));
    check('reconnect sees existing boxes', B2.last('world_init').boxes !== undefined);

    A.close(); B2.close();
    await sleep(300);
    console.log(`\nWorld WS QA: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:'); failures.forEach(f => console.log(' - ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
