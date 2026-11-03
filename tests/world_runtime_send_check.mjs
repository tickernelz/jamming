// Independent QA (DEV-98): drive the REAL websocket.js + world.js in a sandbox
// and assert the Goal A world actions actually reach the socket. Unlike the
// static world_send_check, this exercises the code path end to end.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const sockets = [];
class FakeWebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(d) { this.sent.push(JSON.parse(d)); }
    close() { this.readyState = 3; }
}
const noopEl = () => new Proxy({}, { get: (t, k) => k === 'style' || k === 'classList' || k === 'dataset' ? noopEl() : (k === 'querySelector' || k === 'getElementById' ? () => noopEl() : () => noopEl()), set: () => true });
const sandbox = {
    WebSocket: FakeWebSocket,
    console: { log() {}, error() {} },
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    escapeHtml: (s) => String(s), safeEmoji: (s) => String(s),
    window: {
        location: { protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '8080' },
        addEventListener() {}, removeEventListener() {},
        JAMRI_APP: {},
    },
    document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null, createElement: () => noopEl(), querySelector: () => null, querySelectorAll: () => [], body: noopEl() },
};
sandbox.window.WebSocket = FakeWebSocket;
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);
vm.runInContext(read('../public/js/websocket.js'), sandbox);
vm.runInContext(read('../public/js/world.js'), sandbox);

const wsClient = new sandbox.window.JamriWebSocket();
const world = new sandbox.window.JamriWorld({ syncJammingState() {}, playTrack() {}, stop() {}, setLoopMode() {} });
sandbox.window.JAMRI_APP.wsClient = wsClient;

// Enter the world: this must open exactly ONE shared socket in mode=world.
world.worldId = 'world-1';
world.user = { device_id: 'dev-1', nickname: 'QA', emoji: '🎧' };
world.connect();
assert.strictEqual(sockets.length, 1, 'world entry must use the single shared socket');
assert.ok(/mode=world/.test(sockets[0].url), 'shared socket must connect with mode=world');
sockets[0].onopen(); // socket opened

// Simulate the server handing us our avatar so mat/chat actions have state.
const ws = sockets[0];
ws.onmessage({ data: JSON.stringify({ type: 'world_init', map: { w: 10, h: 10, tile: 32, colliders: [] }, you: { id: 7, x: 100, y: 100, is_owner: true }, avatars: [] }) });
world.activeBox = { id: 'box-9', room_id: 'room-9', x: 100, y: 100 };
world.me = { x: 100, y: 100, dir: 0 };

const goalA = [
    ['mat.place',  () => world.send('mat.place', { label: 'Tikar QA', control_mode: 'everyone' })],
    ['mat.pickup', () => world.send('mat.pickup', { box_id: 'box-9' })],
    ['world.move', () => world.send('world.move', { x: 100, y: 100, dir: 0 })],
    ['world.chat', () => world.send('world.chat', { message: 'halo' })],
    ['world.emote',() => world.sendEmote('👋')],  // void: only delivery is asserted
];
for (const [type, fire] of goalA) {
    ws.sent.length = 0;
    fire();
    assert.ok(ws.sent.some((m) => m.type === type), `${type} must reach the socket`);
}

// Re-entering the world must not stack handlers or open a second socket.
const before = sockets.length;
world.connect();
assert.strictEqual(sockets.length, before + 1, 're-entry opens one fresh socket');
assert.strictEqual(sockets[before - 1].onclose, null, 'replaced socket handlers must be detached');
assert.strictEqual(Object.keys(wsClient.listeners).filter((k) => k === 'world.chat').length, 1, 'no duplicate world.chat binding');
assert.strictEqual(wsClient.listeners['world.chat'].length, 1, 'exactly one world.chat listener after re-entry');

// While disconnected, actions must fail loudly (return false), never vanish silently.
wsClient.isConnected = false;
assert.strictEqual(world.send('mat.place', { label: 'x' }), false, 'send while disconnected must return false');

console.log('world_runtime_send_check: OK');
