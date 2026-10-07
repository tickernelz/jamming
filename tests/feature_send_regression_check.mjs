// Independent QA (DEV-98, Goal B): drive the REAL websocket.js in a sandbox and
// assert every feature send helper emits the wire type the PHP handler switches
// on. Static `node --check` cannot catch a helper that silently sends nothing
// or the wrong type, so this exercises the code path end to end.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/js/websocket.js', import.meta.url), 'utf8');

class FakeWebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; }
    send(d) { this.sent.push(JSON.parse(d)); }
    close() { this.readyState = 3; }
}
const sandbox = {
    WebSocket: FakeWebSocket,
    console: { log() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    window: { location: { protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '8080' }, addEventListener() {} },
    document: { addEventListener() {}, visibilityState: 'visible' },
};
sandbox.window.WebSocket = FakeWebSocket;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const ws = new sandbox.window.JamriWebSocket();
ws.connect('room-1', { device_id: 'd1', nickname: 'QA', emoji: '🎧' }, 'room');
ws.ws.onopen(); // mark connected + start ping interval

// [helper, expected wire type, required payload keys]
const cases = [
    ['sendPlay',           'play',                 ['position'],        [12.5]],
    ['sendPause',          'pause',                [],                  []],
    ['sendSeek',           'seek',                 ['position'],        [3]],
    ['sendNext',           'next',                 [],                  []],
    ['sendPrev',           'prev',                 [],                  []],
    ['sendSetTrack',       'set_track',            ['track'],           [{ id: 1 }]],
    ['sendTrackEnded',     'track_ended',          [],                  []],
    ['sendSetLoop',        'set_loop',             ['mode'],            ['all']],
    ['sendQueueAdd',       'queue_add',            ['track'],           [{ id: 2 }]],
    ['sendQueueRemove',    'queue_remove',         ['queue_id'],        [5]],
    ['sendQueueShuffle',   'queue_shuffle',        [],                  []],
    ['sendQueueReorder',   'queue_reorder',        ['ordered_ids'],     [[1, 2, 3]]],
    ['sendPlaylistAdd',    'playlist_add',         ['track'],           [{ id: 3 }]],
    ['sendPlaylistAddBulk','playlist_add',         ['tracks'],          [[{ id: 4 }]]],
    ['sendPlaylistRemove', 'playlist_remove',      ['playlist_id'],     [9]],
    ['sendChatMessage',    'chat',                 ['message'],         ['halo']],
    ['sendSoundboardPlay', 'soundboard_play',      ['sound_id'],        [{ id: 's1', title: 'T', emoji: '🔊' }]],
    ['sendVoiceChunk',     'voice_chunk',          ['audio', 'channel'],['b64', 'pcm16', 16000, 1, 'general']],
    ['sendVoiceState',     'voice_state',          ['speaking', 'channel'], [true, 'general']],
    ['sendKaraokeMuteToggle', 'karaoke_mute_toggle', ['muted'],         [true]],
    ['sendGameStart',      'game_start',           ['game_type', 'penalty_minutes'], ['roulette', 2, {}]],
    ['sendPunishmentClear','punishment_clear',     ['device_id'],       ['dev-9']],
];

for (const [helper, type, keys, args] of cases) {
    assert.strictEqual(typeof ws[helper], 'function', `${helper} must exist`);
    ws.ws.sent.length = 0;
    ws[helper](...args);
    const msg = ws.ws.sent[0];
    assert.ok(msg, `${helper} must send a frame`);
    assert.strictEqual(msg.type, type, `${helper} must send type=${type}`);
    for (const k of keys) {
        assert.ok(Object.prototype.hasOwnProperty.call(msg, k), `${helper} (${type}) must include ${k}`);
    }
}

// Disconnected helpers must fail loudly (return false), not vanish silently.
ws.ws.readyState = 3;
assert.strictEqual(ws.send('play', { position: 0 }), false, 'send while closed must return false');

console.log('feature_send_regression_check: OK');
