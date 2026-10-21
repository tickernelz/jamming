// QA: does the mat remember its playback position while the room is empty?
// Walking off a mat empties the room (server pauses it). Coming back should
// resume at the position where it stopped, not restart at 0:00.
const WS = 'ws://localhost:8081/';
const API = 'http://localhost/jamri/api';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const worldId = process.argv[2];
if (!worldId) { console.error('usage: node qa_mat_position.mjs <worldId>'); process.exit(2); }

const dev = 'dev_qa_pos_' + Date.now().toString(36);
await fetch(API + '/auth.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: dev, nickname: 'PosX', emoji: '🐧' }) });

const msgs = [];
const ws = new WebSocket(WS + '?' + new URLSearchParams({ mode: 'world', room_id: worldId, device_id: dev, nickname: 'PosX', emoji: '🐧' }));
ws.addEventListener('message', e => { try { msgs.push(JSON.parse(e.data)); } catch {} });
await new Promise(r => ws.addEventListener('open', r));
await sleep(900);
const send = (t, x = {}) => ws.send(JSON.stringify({ type: t, ...x }));
const last = (t) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].type === t) return msgs[i]; return null; };

let init = last('world_init');
let box = (init.boxes || [])[0];
if (!box) {
    // Isolated run: lay our own mat so no other peer can keep the room alive.
    send('mat.place', { label: 'PosTest', control_mode: 'everyone' });
    await sleep(1500);
    const placed = last('mat.placed');
    if (!placed) { console.error('could not place a mat'); process.exit(2); }
    box = placed.box;
    await sleep(800);
}

send('world.move', { x: box.x, y: box.y, dir: 0 });
await sleep(1800);
let r = last('room_init');
console.log('joined:', { state: r.state, position: r.position, track: r.current_track && r.current_track.title });

if (!r.current_track) {
    send('queue_add', { track: { youtube_id: 'dQw4w9WgXcQ', title: 'Pos Song', channel: 'QA', duration_seconds: 240, thumbnail_url: '' } });
    await sleep(2000);
    r = last('room_init');
    console.log('seeded track:', { state: r.state, track: r.current_track && r.current_track.title });
}

send('play', { position: 0 });
await sleep(6000);
msgs.length = 0;
send('ping');
await sleep(500);
let p = last('pong');
const beforeExit = p.position;
console.log('playing, position before exit:', beforeExit.toFixed(2));

// Leave the mat (room becomes empty -> server pauses)
send('world.move', { x: box.x + 900, y: box.y + 700, dir: 0 });
await sleep(1500);
msgs.length = 0;
send('ping');
await sleep(500);
p = last('pong');
console.log('off mat:', { state: p.state, pos: p.position, box: p.box_id });

// Confirm the mat room really has no listeners left before asserting.
msgs.length = 0;
send('world.move', { x: box.x, y: box.y, dir: 0 });
await sleep(1800);
r = last('room_init');
console.log('rejoined:', { state: r.state, position: r.position && r.position.toFixed(2), online: (r.online_users || []).length });
msgs.length = 0;
send('ping');
await sleep(500);
p = last('pong');
console.log('rejoined pong:', { state: p.state, pos: p.position && p.position.toFixed(2) });

const preserved = Math.abs(r.position - beforeExit) < 2.0;
console.log(preserved
    ? `POSITION OK (kept ${r.position.toFixed(2)} vs ${beforeExit.toFixed(2)})`
    : `POSITION LOST (rejoined at ${r.position.toFixed(2)}, expected ~${beforeExit.toFixed(2)})`);
ws.close();
await sleep(200);
process.exit(preserved ? 0 : 1);
