// Guard: reconnecting must replace the socket cleanly. A stale socket's late
// onclose/onmessage used to re-enter attemptReconnect() and flap the connection.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/js/websocket.js', import.meta.url), 'utf8');

const sockets = [];
class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.sent = [];
        sockets.push(this);
    }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; }
}

const timers = [];
const sandbox = {
    WebSocket: FakeWebSocket,
    console: { log() {}, error() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    window: { location: { protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '8080' }, addEventListener() {} },
    document: { addEventListener() {}, visibilityState: 'visible' },
};
sandbox.window.WebSocket = FakeWebSocket;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const ws = new sandbox.window.JamriWebSocket();
const user = { device_id: 'd1', nickname: 'n', emoji: '🎧' };

ws.connect('room-1', user);
const first = sockets[0];
assert.ok(first, 'first socket created');

// Reconnect replaces the socket and detaches the old one's handlers.
ws.connect('room-1', user);
const second = sockets[1];
assert.ok(second && second !== first, 'second socket created');
assert.strictEqual(first.onclose, null, 'old socket onclose must be detached');
assert.strictEqual(first.onmessage, null, 'old socket onmessage must be detached');

// A late event from the replaced socket must not flip state or schedule reconnect.
const before = timers.length;
ws.isConnected = true;
first.onclose && first.onclose();
assert.strictEqual(ws.isConnected, true, 'stale onclose must not mark disconnected');
assert.strictEqual(timers.length, before, 'stale onclose must not schedule a reconnect');

console.log('websocket_lifecycle_check: OK');
