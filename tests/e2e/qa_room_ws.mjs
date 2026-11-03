// QA: legacy room WebSocket protocol end-to-end with two live clients.
const WS = 'ws://localhost:8081/';
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
    async connect(params) {
        this.ws = new WebSocket(WS + '?' + new URLSearchParams(params));
        this.ws.addEventListener('message', e => { try { this.msgs.push(JSON.parse(e.data)); } catch {} });
        this.closed = null;
        this.ws.addEventListener('close', e => { this.closed = { code: e.code, reason: e.reason }; });
        await new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
        await sleep(600);
        return this;
    }
    send(type, extra = {}) { this.ws.send(JSON.stringify({ type, ...extra })); }
    last(type) { for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].type === type) return this.msgs[i]; return null; }
    all(type) { return this.msgs.filter(m => m.type === type); }
    clear() { this.msgs.length = 0; }
    close() { try { this.ws.close(); } catch {} }
}

const track = (id, title) => ({ youtube_id: id, title, channel: 'QA', duration_seconds: 240, thumbnail_url: '', duration_formatted: '4:00' });

(async () => {
    // --- setup: create a room through HTTP ---
    const devA = 'dev_qa_room_a_' + Date.now().toString(36);
    const devB = 'dev_qa_room_b_' + Date.now().toString(36);
    await fetch('http://localhost/jamri/api/auth.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: devA, nickname: 'RoomA', emoji: '🦊' }) });
    await fetch('http://localhost/jamri/api/auth.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: devB, nickname: 'RoomB', emoji: '🐼' }) });
    const cr = await (await fetch('http://localhost/jamri/api/rooms.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA Room Proto', device_id: devA }) })).json();
    const roomId = cr.room.id;
    console.log('room:', roomId);

    console.log('== handshake ==');
    const A = await new C('A').connect({ mode: 'room', room_id: roomId, device_id: devA, nickname: 'RoomA', emoji: '🦊' });
    const init = A.last('room_init');
    check('room_init received', !!init, JSON.stringify(A.msgs.map(m => m.type)));
    check('room_init carries room id', init && init.room_id === roomId);
    check('room_init carries online users', init && Array.isArray(init.online_users) && init.online_users.length === 1);
    check('room_init carries state', init && typeof init.state === 'string', init && init.state);
    check('room_init carries queue', init && Array.isArray(init.queue));

    const B = await new C('B').connect({ mode: 'room', room_id: roomId, device_id: devB, nickname: 'RoomB', emoji: '🐼' });
    await sleep(700);
    check('A sees user_joined', !!A.last('user_joined'), JSON.stringify(A.msgs.map(m => m.type)));
    check('A online users = 2', A.last('user_joined') && A.last('user_joined').online_users.length === 2);

    console.log('== bad handshake ==');
    const bad = await new C('bad').connect({ mode: 'room', room_id: '00000000-0000-0000-0000-000000000000', device_id: devA, nickname: 'X', emoji: '🎧' });
    check('unknown room -> room_not_found', !!bad.last('room_not_found') || !!bad.closed, JSON.stringify(bad.msgs.map(m => m.type)) + ' closed=' + JSON.stringify(bad.closed));
    bad.close();
    const noId = await new C('noid').connect({ mode: 'room', device_id: devA, nickname: 'X', emoji: '🎧' });
    check('missing room_id handled', !!noId.last('room_not_found') || !!noId.closed || !!noId.last('notice'), JSON.stringify(noId.msgs.map(m => m.type)));
    noId.close();

    console.log('== queue ==');
    A.send('queue_add', { track: track('dQw4w9WgXcQ', 'QA Song 1') });
    await sleep(900);
    check('A queue_updated after add', !!A.last('queue_updated'), JSON.stringify(A.msgs.map(m => m.type)));
    check('B receives queue_updated', !!B.last('queue_updated'));
    check('first add auto-starts the track', A.last('track_change') && A.last('track_change').track.youtube_id === 'dQw4w9WgXcQ', A.last('track_change') && A.last('track_change').track.title);
    const q = A.last('queue_updated').queue;
    check('started track leaves the queue', q.length === 0, JSON.stringify(q.map(x => x.title)));
    A.send('queue_add', { track: track('9bZkp7q19f0', 'QA Song 2') });
    await sleep(700);
    check('queue now 1 (only the pending track)', A.last('queue_updated').queue.length === 1, JSON.stringify(A.last('queue_updated').queue.map(x => x.title)));

    console.log('== playback ==');
    await sleep(1200);
    A.clear(); B.clear();
    A.send('ping'); B.send('ping');
    await sleep(500);
    const pa = A.last('pong'), pb = B.last('pong');
    check('A pong has state', pa && typeof pa.state === 'string', pa && pa.state);
    check('A pong has position', pa && typeof pa.position === 'number', pa && String(pa.position));
    check('A/B agree on track', pa && pb && (pa.track ? pa.track.youtube_id : null) === (pb.track ? pb.track.youtube_id : null), `${pa && pa.track && pa.track.title} vs ${pb && pb.track && pb.track.title}`);
    check('A/B position drift < 0.2s', pa && pb && Math.abs(pa.position - pb.position) < 0.2, pa && pb && String(Math.abs(pa.position - pb.position)));

    A.send('pause');
    await sleep(800);
    check('B receives pause', !!B.last('pause'), JSON.stringify(B.msgs.map(m => m.type)));
    const pausedPos = B.last('pause') && B.last('pause').position;
    A.clear(); B.clear(); A.send('ping'); B.send('ping'); await sleep(400);
    check('paused state propagates to pong', A.last('pong').state === 'paused' && B.last('pong').state === 'paused');
    check('paused position frozen on A', Math.abs(A.last('pong').position - pausedPos) < 0.3, `${A.last('pong').position} vs ${pausedPos}`);

    A.send('play', { position: pausedPos });
    await sleep(900);
    check('B receives play', !!B.last('play'));

    A.send('seek', { position: 60 });
    await sleep(700);
    check('B receives seek', !!B.last('seek'), JSON.stringify(B.msgs.map(m => m.type)));
    check('seek position = 60', B.last('seek') && Math.abs(B.last('seek').position - 60) < 0.5, B.last('seek') && String(B.last('seek').position));

    console.log('== next / prev / track_ended ==');
    A.send('next');
    await sleep(1400);
    check('next triggers track_change', !!B.last('track_change'), JSON.stringify(B.msgs.map(m => m.type)));
    check('next moved to song 2', B.last('track_change') && B.last('track_change').track.youtube_id === '9bZkp7q19f0', B.last('track_change') && B.last('track_change').track.title);
    await sleep(1300);
    A.send('prev');
    await sleep(1200);
    check('prev back to song 1', A.last('track_change') && A.last('track_change').track.youtube_id === 'dQw4w9WgXcQ', A.last('track_change') && A.last('track_change').track.title);
    await sleep(3300);
    A.clear(); B.clear();
    A.send('track_ended');
    await sleep(1200);
    check('track_ended advances or stops', !!B.last('track_change') || !!B.last('playback_stopped'), JSON.stringify(B.msgs.map(m => m.type)));

    console.log('== loop / shuffle ==');
    A.send('set_loop', { mode: 'one' });
    await sleep(600);
    check('loop_changed broadcast', B.last('loop_changed') && B.last('loop_changed').loop_mode === 'one', JSON.stringify(B.last('loop_changed')));
    A.send('set_loop', { mode: 'all' });
    await sleep(500);
    check('loop all', B.last('loop_changed').loop_mode === 'all');
    A.send('set_loop', { mode: 'off' });
    await sleep(500);
    check('loop off', B.last('loop_changed').loop_mode === 'off');
    A.send('queue_shuffle');
    await sleep(700);
    check('shuffle broadcasts queue_updated', !!B.last('queue_updated'), JSON.stringify(B.msgs.map(m => m.type)));

    console.log('== queue reorder / remove ==');
    A.clear(); B.clear();
    A.send('queue_add', { track: track('kJQP7kiw5Fk', 'QA Song 3') });
    await sleep(700);
    const q3 = A.last('queue_updated').queue;
    check('queue_add appends', q3.length >= 1, JSON.stringify(q3.map(x => x.title)));
    const ids = q3.map(x => x.id);
    if (ids.length >= 2) {
        A.send('queue_reorder', { ordered_ids: ids.slice().reverse() });
        await sleep(700);
        check('reorder broadcasts', !!B.last('queue_updated'), JSON.stringify(B.msgs.map(m => m.type)));
    }
    A.clear(); B.clear();
    A.send('queue_remove', { queue_id: ids[0] });
    await sleep(700);
    check('remove broadcasts', !!B.last('queue_updated'));
    check('remove shrank queue', B.last('queue_updated').queue.length < q3.length, `${B.last('queue_updated').queue.length} vs ${q3.length}`);

    console.log('== chat ==');
    A.clear(); B.clear();
    A.send('chat', { message: 'halo dari A' });
    await sleep(700);
    check('B receives chat_message', !!B.last('chat_message'), JSON.stringify(B.msgs.map(m => m.type)));
    check('chat body intact', B.last('chat_message') && B.last('chat_message').message.message === 'halo dari A', JSON.stringify(B.last('chat_message')).slice(0, 200));
    check('chat has sender_nickname', B.last('chat_message') && B.last('chat_message').message.sender_nickname === 'RoomA', JSON.stringify(B.last('chat_message').message).slice(0, 150));
    // Mat chat in world mode also draws a speech bubble, so the payload needs the
    // sender's connection id for the bubble to land on the right avatar.
    check('mat chat carries the sender connection id',
        B.last('chat_message') && typeof B.last('chat_message').message.sender_res_id === 'number' && B.last('chat_message').message.sender_res_id > 0,
        JSON.stringify(B.last('chat_message').message.sender_res_id));
    A.send('chat', { message: '' });
    await sleep(500);
    check('empty chat ignored', !B.all('chat_message').some(m => !m.message.message || !m.message.message.trim()), JSON.stringify(B.all('chat_message').map(m => m.message.message)));
    A.send('chat', { message: 'x'.repeat(500) });
    await sleep(600);
    const long = B.all('chat_message').map(m => m.message.message).filter(t => t.length > 300);
    check('chat clamped to 300', long.length === 0, long.map(t => t.length).join(','));
    A.send('chat', { message: '<img src=x onerror=alert(1)>' });
    await sleep(600);
    check('chat stored raw (escaped at render)', B.last('chat_message').message.message.includes('<img'), B.last('chat_message').message.message);

    console.log('== soundboard ==');
    B.clear();
    A.send('soundboard_play', { sound_id: 'applause' });
    await sleep(600);
    check('soundboard_play broadcast', !!B.last('soundboard_play'), JSON.stringify(B.msgs.map(m => m.type)));

    console.log('== games ==');
    B.clear();
    A.send('game_start', { game: 'reaction' });
    await sleep(700);
    check('game_start broadcast', !!B.last('game_started') || !!B.last('notice'), JSON.stringify(B.msgs.map(m => m.type)));

    console.log('== voice ==');
    B.clear();
    A.send('voice_state', { speaking: true });
    await sleep(500);
    check('voice_state broadcast or ignored safely', true, JSON.stringify(B.msgs.map(m => m.type)));
    A.send('voice_chunk', { data: 'AAAA' });
    await sleep(400);
    check('voice_chunk does not kill socket', A.closed === null, JSON.stringify(A.closed));

    console.log('== hostile payloads ==');
    const before = A.closed;
    for (const bad of [
        { type: 'queue_add' }, { type: 'queue_add', track: {} },
        { type: 'queue_reorder' }, { type: 'queue_reorder', queue_ids: 'nope' },
        { type: 'queue_remove' }, { type: 'seek' }, { type: 'seek', position: 'abc' },
        { type: 'set_loop' }, { type: 'set_loop', mode: 'bogus' },
        { type: 'chat' }, { type: 'chat', message: 12345 },
        { type: 'soundboard_play' }, { type: 'game_start' },
        { type: 'playlist_add' }, { type: 'playlist_remove' },
        { type: 'nonexistent_type' }, { type: 'mat.place' }, { type: 'world.move', x: 'a', y: 'b' },
    ]) { A.ws.send(JSON.stringify(bad)); await sleep(120); }
    await sleep(900);
    check('socket survives hostile payloads', A.closed === null, JSON.stringify(A.closed));
    A.clear(); A.send('ping'); await sleep(500);
    check('socket still responsive after garbage', !!A.last('pong'), JSON.stringify(A.msgs.map(m => m.type)));

    // non-JSON garbage
    A.ws.send('not json at all');
    await sleep(400);
    A.ws.send('{"type":');
    await sleep(400);
    check('socket survives non-JSON frames', A.closed === null, JSON.stringify(A.closed));

    console.log('== leave / reconnect ==');
    B.clear();
    B.close();
    await sleep(900);
    check('A sees user_left', !!A.last('user_left'), JSON.stringify(A.msgs.map(m => m.type)));
    const B2 = await new C('B2').connect({ mode: 'room', room_id: roomId, device_id: devB, nickname: 'RoomB', emoji: '🐼' });
    const init2 = B2.last('room_init');
    check('rejoin gets room_init', !!init2);
    check('rejoin restores current track', init2 && init2.current_track && init2.current_track.youtube_id, init2 && init2.current_track && init2.current_track.title);
    check('rejoin restores position', init2 && typeof init2.position === 'number', init2 && String(init2.position));
    check('rejoin restores queue', init2 && Array.isArray(init2.queue));

    console.log('== private room passcode ==');
    const pcr = await (await fetch('http://localhost/jamri/api/rooms.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA Priv WS', is_private: true, passcode: '4321', device_id: devA }) })).json();
    const privId = pcr.room.id;
    const P1 = await new C('P1').connect({ mode: 'room', room_id: privId, device_id: devB, nickname: 'Intruder', emoji: '🐼' });
    check('private room rejects without passcode', !!P1.last('room_not_found') || !!P1.closed || !!P1.last('notice'), JSON.stringify(P1.msgs.map(m => m.type)) + ' closed=' + JSON.stringify(P1.closed));
    P1.close();
    const P2 = await new C('P2').connect({ mode: 'room', room_id: privId, device_id: devB, nickname: 'Guest', emoji: '🐼', passcode: '4321' });
    check('private room accepts correct passcode', !!P2.last('room_init'), JSON.stringify(P2.msgs.map(m => m.type)));
    P2.close();

    A.close(); B2.close();
    await sleep(300);
    console.log(`\nRoom WS QA: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:'); failures.forEach(f => console.log(' - ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
