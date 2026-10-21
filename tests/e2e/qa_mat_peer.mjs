// QA helper: a second peer that mutates the mat's queue/playlist, so the browser
// can verify that leaving + re-entering a mat shows the CURRENT state.
const WS = 'ws://localhost:8081/';
const API = 'http://localhost/jamri/api';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const worldId = process.argv[2];
const action = process.argv[3] || 'seed';
if (!worldId) { console.error('usage: node qa_mat_peer.mjs <worldId> [seed|inspect]'); process.exit(2); }

const dev = 'dev_qa_peer_' + Date.now().toString(36);
await fetch(API + '/auth.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: dev, nickname: 'PeerX', emoji: '🐧' }) });

const msgs = [];
const ws = new WebSocket(WS + '?' + new URLSearchParams({ mode: 'world', room_id: worldId, device_id: dev, nickname: 'PeerX', emoji: '🐧' }));
ws.addEventListener('message', e => { try { msgs.push(JSON.parse(e.data)); } catch {} });
await new Promise(r => ws.addEventListener('open', r));
await sleep(900);
const send = (t, x = {}) => ws.send(JSON.stringify({ type: t, ...x }));
const last = (t) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].type === t) return msgs[i]; return null; };

const init = last('world_init');
const box = (init.boxes || [])[0];
if (!box) { console.error('no mat'); process.exit(2); }

if (action === 'seed') {
    send('world.move', { x: box.x, y: box.y, dir: 0 });
    await sleep(1600);
    const r = last('room_init');
    console.log('peer joined mat:', { queue: (r.queue || []).map(t => t.title), playlist: (r.playlist || []).map(t => t.title) });
    send('queue_add', { track: { youtube_id: 'kJQP7kiw5Fk', title: 'Peer Queued', channel: 'Peer', duration_seconds: 200, thumbnail_url: '' } });
    await sleep(800);
    send('playlist_add', { track: { youtube_id: '9bZkp7q19f0', title: 'Peer Bank', channel: 'Peer', duration_seconds: 200, thumbnail_url: '' } });
    await sleep(1200);
    console.log('peer added: queue=Peer Queued, playlist=Peer Bank');
} else {
    send('world.move', { x: box.x, y: box.y, dir: 0 });
    await sleep(1600);
    const r = last('room_init');
    console.log(JSON.stringify({
        state: r.state,
        position: r.position,
        current: r.current_track && r.current_track.title,
        queue: (r.queue || []).map(t => t.title),
        playlist: (r.playlist || []).map(t => t.title),
    }, null, 2));
}
ws.close();
await sleep(200);
process.exit(0);
