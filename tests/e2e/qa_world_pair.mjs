// QA: world mat sync with ONE browser (A) and one raw protocol peer (B).
// The browser page is authoritative for nothing; the server is. This isolates
// server-side playback anchoring from browser tab-throttling artefacts.
const WS = 'ws://localhost:8081/';
const API = 'http://localhost/jamri/api';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const worldId = process.argv[2];
    if (!worldId) { console.error('usage: node qa_world_pair.mjs <worldId>'); process.exit(2); }
    const devB = 'dev_qa_pair_' + Date.now().toString(36);
    await fetch(API + '/auth.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: devB, nickname: 'PairB', emoji: '🐧' }) });

    const msgs = [];
    const ws = new WebSocket(WS + '?' + new URLSearchParams({ mode: 'world', room_id: worldId, device_id: devB, nickname: 'PairB', emoji: '🐧' }));
    ws.addEventListener('message', e => { try { msgs.push(JSON.parse(e.data)); } catch {} });
    await new Promise(r => ws.addEventListener('open', r));
    await sleep(900);
    const send = (t, x = {}) => ws.send(JSON.stringify({ type: t, ...x }));
    const last = (t) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].type === t) return msgs[i]; return null; };
    const clear = () => { msgs.length = 0; };

    const init = last('world_init');
    const boxes = init.boxes || [];
    if (!boxes.length) { console.error('no mat in this world'); process.exit(2); }
    const box = boxes[0];
    console.log('mat:', box.label, '@', Math.round(box.x), Math.round(box.y));

    const ping = async () => { clear(); send('ping'); await sleep(500); return last('pong'); };

    send('world.move', { x: box.x, y: box.y, dir: 0 });
    await sleep(1500);
    let p = await ping();
    console.log('B joined mat:', { state: p.state, pos: p.position && p.position.toFixed(2), track: p.track && p.track.title });

    // B pauses
    send('pause');
    await sleep(1000);
    const pausedPos = (await ping()).position;
    console.log('B paused at', pausedPos.toFixed(2));

    // B leaves and re-enters 6 times while paused
    for (let i = 0; i < 6; i++) {
        send('world.move', { x: box.x + 900, y: box.y + 700, dir: 0 });
        await sleep(450);
        send('world.move', { x: box.x, y: box.y, dir: 0 });
        await sleep(900);
    }
    p = await ping();
    console.log('after 6 exit/enter (paused):', { state: p.state, pos: p.position.toFixed(2), onMat: !!p.box_id });
    const stillPaused = p.state === 'paused' && Math.abs(p.position - pausedPos) < 0.5;

    // B resumes at a known position
    send('play', { position: 60 });
    await sleep(1500);
    p = await ping();
    console.log('after resume@60:', { state: p.state, pos: p.position.toFixed(2) });
    const resumed = p.state === 'playing' && p.position >= 60 && p.position < 66;

    // A brand new peer must land on the same position
    const devC = 'dev_qa_pair_c_' + Date.now().toString(36);
    await fetch(API + '/auth.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: devC, nickname: 'PairC', emoji: '🐼' }) });
    const msgsC = [];
    const wsC = new WebSocket(WS + '?' + new URLSearchParams({ mode: 'world', room_id: worldId, device_id: devC, nickname: 'PairC', emoji: '🐼' }));
    wsC.addEventListener('message', e => { try { msgsC.push(JSON.parse(e.data)); } catch {} });
    await new Promise(r => wsC.addEventListener('open', r));
    await sleep(900);
    wsC.send(JSON.stringify({ type: 'world.move', x: box.x, y: box.y, dir: 0 }));
    await sleep(1600);
    const cInit = [...msgsC].reverse().find(m => m.type === 'room_init');
    const pB = await ping();
    // cInit is a snapshot taken at join time; compare against B's position at that
    // same instant, not against "now".
    const cAge = (Date.now() - (cInit && cInit.server_time ? cInit.server_time : Date.now())) / 1000;
    const cProjected = cInit ? cInit.position + (cInit.state === 'playing' ? Math.max(0, cAge) : 0) : 0;
    console.log('late joiner C snapshot:', { state: cInit && cInit.state, pos: cInit && cInit.position && cInit.position.toFixed(2), age: cAge.toFixed(2) });
    console.log('C projected now:', cProjected.toFixed(2), '| B now:', pB.position.toFixed(2));
    const lateJoinOk = cInit && Math.abs(cProjected - pB.position) < 1.5;

    ws.close(); wsC.close();
    const ok = stillPaused && resumed && lateJoinOk;
    console.log('\nstill paused after churn:', stillPaused);
    console.log('resumed correctly:', resumed);
    console.log('late joiner in sync:', lateJoinOk);
    console.log(ok ? 'PAIR OK' : 'PAIR FAIL');
    process.exit(ok ? 0 : 1);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
