// Guard (DEV-99): the lyrics engine must release PiP/modal resources when a
// session ends. Previously openPiP() attached pagehide/unload handlers that
// were never removed, the scroll debounce timer was never cleared, and
// embeddedContainers only ever grew as room/solo views were re-rendered.
// This drives the REAL lyrics.js in a sandbox and asserts teardown() releases
// everything and that app.js calls it when leaving a room/world.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

let live = { pagehide: 0, unload: 0 };
const fakePipWin = {
    closed: false,
    addEventListener(type) { if (type in live) live[type]++; },
    removeEventListener(type) { if (type in live) live[type]--; },
    close() { this.closed = true; },
    focus() {},
};
let timerId = 0;
const cleared = [];
const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    localStorage: { getItem: () => null, setItem() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => ++timerId,
    clearTimeout: (id) => cleared.push(id),
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    escapeHtml: (s) => String(s),
    safeEmoji: (s) => String(s),
    window: {
        screen: { width: 1200 },
        open: () => fakePipWin,
        addEventListener() {},
        removeEventListener() {},
    },
    document: {
        documentElement: { setAttribute() {}, getAttribute: () => 'dark' },
        body: { style: {} },
        addEventListener() {},
        removeEventListener() {},
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} } }),
    },
};
sandbox.window.document = sandbox.document;
vm.createContext(sandbox);
vm.runInContext(read('../public/js/lyrics.js') + '\n;globalThis.__LyricsManager = JamriLyricsManager;', sandbox);

const mgr = new sandbox.__LyricsManager();
assert.strictEqual(typeof mgr.teardown, 'function', 'lyrics manager must expose teardown()');

// Stub rendering so openPiP() exercises only the lifecycle wiring.
mgr.setupPiPStyles = () => {};
mgr.renderPiPContent = () => {};
mgr.updatePiPButtonState = () => {};

await mgr.openPiP('full');
assert.strictEqual(mgr.pipWindow, fakePipWin, 'openPiP must hold the PiP window');
assert.strictEqual(live.pagehide, 1, 'openPiP must attach one pagehide listener');
assert.strictEqual(live.unload, 1, 'openPiP must attach one unload listener');
assert.strictEqual(typeof mgr.pipCloseHandler, 'function', 'openPiP must remember its close handler');

mgr.registerUserScroll();
const scheduled = mgr.scrollDebounceTimer;
assert.ok(scheduled, 'registerUserScroll must schedule a debounce timer');
mgr.embeddedContainers.add('room-embedded-lyrics-container');
mgr.isOpen = true;
mgr.modalEl = { style: {} };

mgr.teardown();

assert.strictEqual(live.pagehide, 0, 'teardown must remove the pagehide listener');
assert.strictEqual(live.unload, 0, 'teardown must remove the unload listener');
assert.strictEqual(mgr.pipWindow, null, 'teardown must drop the PiP window reference');
assert.strictEqual(mgr.pipCloseHandler, null, 'teardown must drop the close handler');
assert.ok(cleared.includes(scheduled), 'teardown must clear the scroll debounce timer');
assert.strictEqual(mgr.scrollDebounceTimer, null, 'teardown must null the debounce timer');
assert.strictEqual(mgr.embeddedContainers.size, 0, 'teardown must clear embedded containers');
assert.strictEqual(mgr.isOpen, false, 'teardown must close the modal');
assert.strictEqual(fakePipWin.closed, true, 'teardown must close an open PiP window');

// renderAllViews() must also prune containers removed by a room/solo re-render.
mgr.embeddedContainers.add('stale-container');
mgr.renderAllViews();
assert.strictEqual(mgr.embeddedContainers.has('stale-container'), false,
    'renderAllViews must prune containers that no longer exist in the DOM');

// app.js must actually call teardown() when a room or world session ends.
const app = read('../public/js/app.js');
const body = (name, nextName) => {
    const start = app.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `${name} must exist`);
    const end = app.indexOf(`function ${nextName}(`, start);
    return app.slice(start, end === -1 ? undefined : end);
};
assert.ok(body('leaveRoom', 'joinRoom').includes('lyrics.teardown()'),
    'leaveRoom() must tear down the lyrics PiP/modal listeners');
assert.ok(body('leaveWorld', 'renderRoomShell').includes('lyrics.teardown()'),
    'leaveWorld() must tear down the lyrics PiP/modal listeners');

console.log('lyrics_lifecycle_check: OK');
