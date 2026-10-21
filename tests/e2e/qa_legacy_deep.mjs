// QA: legacy-room scenarios, each in its OWN freshly created room so state from
// one scenario can never leak into the next (the previous single-room version
// produced false failures: a duplicate youtube_id left behind in the queue, and
// the 3s track_ended debounce, both contaminated later assertions).
const WS = 'ws://localhost:8081/';
const API = 'http://localhost/jamri/api';
import { execFileSync } from 'node:child_process';
let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d = '') => {
    if (c) { pass++; return; }
    fail++; failures.push(`${n}${d ? ' :: ' + d : ''}`);
    console.log(`  FAIL ${n}${d ? ' :: ' + d : ''}`);
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

const T = (id, title, dur = 240) => ({ youtube_id: id, title, channel: 'QA', duration_seconds: dur, thumbnail_url: '' });
const post = (p, b) => fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

let devSeq = 0;
const newDev = async (nick) => {
    const d = 'dev_lgd_' + Date.now().toString(36) + '_' + (++devSeq);
    await post('/auth.php', { device_id: d, nickname: nick, emoji: '🦊' });
    return d;
};

/** Fresh room + host/guest sockets, torn down afterwards. */
async function scenario(name, fn, opts = {}) {
    console.log(`\n== ${name} ==`);
    const devHost = await newDev('Host');
    const devGuest = await newDev('Guest');
    const cr = await post('/rooms.php', { name: 'QA ' + name + ' ' + Date.now().toString(36), device_id: devHost });
    if (!cr.body || !cr.body.room) { check(`${name}: room created`, false, JSON.stringify(cr.body).slice(0, 120)); return; }
    const roomId = cr.body.room.id;
    // The daemon caches control_mode when the room session is created, so it has
    // to be set BEFORE the first socket attaches.
    if (opts.control) {
        execFileSync('php', ['tests/e2e/qa_set_room_control.php', roomId, opts.control], { stdio: 'pipe' });
    }
    const host = await new C('h').connect({ mode: 'room', room_id: roomId, device_id: devHost, nickname: 'Host', emoji: '🦊' });
    const guest = await new C('g').connect({ mode: 'room', room_id: roomId, device_id: devGuest, nickname: 'Guest', emoji: '🐼' });
    await sleep(700);
    try {
        await fn({ roomId, host, guest, devHost, devGuest });
    } catch (e) {
        check(`${name}: no exception`, false, e.message);
    } finally {
        host.close(); guest.close();
        await sleep(500);
    }
}

(async () => {
    await scenario('queue basics', async ({ host, guest }) => {
        const init = host.last('room_init');
        check('room_init exposes playlist', init && Array.isArray(init.playlist), JSON.stringify(init && Object.keys(init)));
        check('room_init exposes control_mode', init && typeof init.control_mode === 'string', init && init.control_mode);

        host.clear(); guest.clear();
        host.send('queue_add', { track: T('dQw4w9WgXcQ', 'Song A') });
        await sleep(1000);
        check('first add starts the track', guest.last('track_change') && guest.last('track_change').track.title === 'Song A',
            guest.last('track_change') && guest.last('track_change').track.title);
        check('first add leaves the queue empty', guest.last('queue_updated') && guest.last('queue_updated').queue.length === 0,
            JSON.stringify(guest.last('queue_updated') && guest.last('queue_updated').queue.map(q => q.title)));

        host.clear(); guest.clear();
        host.send('queue_add', { track: T('9bZkp7q19f0', 'Song B') });
        await sleep(800);
        check('second add appends to the queue', host.last('queue_updated') && host.last('queue_updated').queue.length === 1,
            JSON.stringify(host.last('queue_updated') && host.last('queue_updated').queue.map(q => q.title)));

        host.clear();
        host.send('queue_add', { track: T('9bZkp7q19f0', 'Song B') });
        await sleep(800);
        check('duplicate queued add is rejected', !!host.last('notice') && !host.last('queue_updated'),
            JSON.stringify(host.msgs.map(m => m.type)));
    });

    await scenario('requeue the playing track', async ({ host }) => {
        host.send('queue_add', { track: T('dQw4w9WgXcQ', 'Playing Song') });
        await sleep(1000);
        host.clear();
        host.send('queue_add', { track: T('dQw4w9WgXcQ', 'Playing Song') });
        await sleep(900);
        const reAdded = host.last('queue_updated') && host.last('queue_updated').queue.some(q => q.youtube_id === 'dQw4w9WgXcQ');
        // Re-queueing the track that is already playing means the same song plays
        // twice in a row, which is never what the user asked for.
        check('re-queueing the currently playing track is refused', !reAdded,
            JSON.stringify(host.last('queue_updated') && host.last('queue_updated').queue.map(q => q.title)));
    });

    await scenario('loop one', async ({ host, guest }) => {
        host.send('queue_add', { track: T('dQw4w9WgXcQ', 'Loop Song') });
        await sleep(1000);
        host.send('set_loop', { mode: 'one' });
        await sleep(600);
        // Wait past the 3s track_ended debounce that setRoomTrack just armed.
        await sleep(3200);
        host.clear(); guest.clear();
        host.send('track_ended');
        await sleep(1400);
        check('loop=one replays the same track', guest.last('track_change') && guest.last('track_change').track.title === 'Loop Song',
            JSON.stringify(guest.msgs.map(m => m.type)));
        check('loop=one keeps the queue untouched', !guest.last('queue_updated'),
            JSON.stringify(guest.msgs.map(m => m.type)));
    });

    await scenario('loop all', async ({ host, guest }) => {
        host.send('queue_add', { track: T('dQw4w9WgXcQ', 'All A') });
        await sleep(1000);
        host.send('queue_add', { track: T('9bZkp7q19f0', 'All B') });
        await sleep(800);
        host.send('set_loop', { mode: 'all' });
        await sleep(600);
        await sleep(3200);
        host.clear(); guest.clear();
        host.send('next');
        await sleep(1500);
        check('loop=all advances to B', guest.last('track_change') && guest.last('track_change').track.title === 'All B',
            guest.last('track_change') && guest.last('track_change').track.title);
        await sleep(3200);
        host.clear(); guest.clear();
        host.send('next');
        await sleep(1500);
        check('loop=all wraps back to A', guest.last('track_change') && guest.last('track_change').track.title === 'All A',
            guest.last('track_change') && guest.last('track_change').track.title);
        host.clear(); host.send('ping'); await sleep(400);
        check('loop=all keeps playing', host.last('pong').state === 'playing', host.last('pong').state);
    });

    await scenario('queue drain', async ({ host, guest }) => {
        host.send('queue_add', { track: T('dQw4w9WgXcQ', 'Last Song') });
        await sleep(1000);
        await sleep(3200);
        host.clear(); guest.clear();
        host.send('next');
        await sleep(1600);
        check('next with an empty queue stops playback', !!guest.last('playback_stopped'),
            JSON.stringify(guest.msgs.map(m => m.type)));
        host.clear(); host.send('ping'); await sleep(400);
        check('state is stopped', host.last('pong').state === 'stopped', host.last('pong').state);
        check('no current track', host.last('pong').track === null, JSON.stringify(host.last('pong').track));
    });

    await scenario('bank musik', async ({ host, guest }) => {
        host.clear(); guest.clear();
        host.send('playlist_add', { track: T('kJQP7kiw5Fk', 'Bank C') });
        await sleep(900);
        const pl = guest.last('playlist_updated');
        check('playlist_add broadcasts', !!pl, JSON.stringify(guest.msgs.map(m => m.type)));
        check('playlist contains the track', pl && pl.playlist.some(t => t.title === 'Bank C'),
            pl && JSON.stringify(pl.playlist.map(t => t.title)));
        const bankId = pl && pl.playlist.find(t => t.title === 'Bank C').id;

        host.clear(); guest.clear();
        host.send('set_track', { track: { ...T('kJQP7kiw5Fk', 'Bank C'), id: bankId } });
        await sleep(900);
        check('set_track plays the bank track', guest.last('track_change') && guest.last('track_change').track.title === 'Bank C',
            guest.last('track_change') && guest.last('track_change').track.title);
        check('set_track does not leave it in the queue',
            !(guest.last('queue_updated') && guest.last('queue_updated').queue.some(q => q.id === bankId)),
            JSON.stringify(guest.last('queue_updated') && guest.last('queue_updated').queue.map(q => q.title)));

        host.clear(); guest.clear();
        host.send('playlist_remove', { playlist_id: bankId });
        await sleep(800);
        check('playlist_remove broadcasts', !!guest.last('playlist_updated'), JSON.stringify(guest.msgs.map(m => m.type)));
        check('playlist is empty afterwards', guest.last('playlist_updated').playlist.length === 0,
            String(guest.last('playlist_updated').playlist.length));

        host.clear();
        host.send('playlist_add', { track: T('kJQP7kiw5Fk', 'Bank C') });
        await sleep(700);
        host.clear();
        host.send('playlist_add', { track: T('kJQP7kiw5Fk', 'Bank C') });
        await sleep(700);
        check('duplicate bank add is rejected', !!host.last('notice'), JSON.stringify(host.msgs.map(m => m.type)));
    });

    await scenario('bulk bank import', async ({ host, guest }) => {
        guest.clear();
        host.send('playlist_add', { tracks: [T('dQw4w9WgXcQ', 'Bulk 1'), T('9bZkp7q19f0', 'Bulk 2'), T('kJQP7kiw5Fk', 'Bulk 3')] });
        await sleep(1400);
        const pl = guest.last('playlist_updated');
        check('bulk import broadcasts', !!pl, JSON.stringify(guest.msgs.map(m => m.type)));
        check('bulk import added all three', pl && pl.playlist.length === 3, pl && String(pl.playlist.length));
        check('bulk import reports the count', pl && pl.added_count === 3, pl && String(pl.added_count));
    });

    await scenario('reconnect during playback', async ({ host, guest, roomId, devGuest }) => {
        host.send('queue_add', { track: T('dQw4w9WgXcQ', 'Live Song') });
        await sleep(1000);
        host.send('play', { position: 0 });
        await sleep(3600);
        host.clear(); guest.clear();
        host.send('ping'); guest.send('ping');
        await sleep(500);
        const before = guest.last('pong').position;

        guest.close();
        await sleep(900);
        const g2 = await new C('g2').connect({ mode: 'room', room_id: roomId, device_id: devGuest, nickname: 'Guest', emoji: '🐼' });
        const re = g2.last('room_init');
        check('reconnect keeps the track', re && re.current_track && re.current_track.title === 'Live Song',
            re && re.current_track && re.current_track.title);
        check('reconnect keeps playing state', re && re.state === 'playing', re && re.state);
        check('reconnect position is not behind', re && re.position >= before - 0.5, `${re && re.position} vs ${before}`);
        g2.close();
    });

    await scenario('emptied room remembers position', async ({ host, guest, roomId, devGuest }) => {
        host.send('queue_add', { track: T('dQw4w9WgXcQ', 'Memory Song') });
        await sleep(1000);
        host.send('play', { position: 0 });
        await sleep(3600);
        host.clear(); host.send('ping'); await sleep(400);
        const beforeExit = host.last('pong').position;

        host.close(); guest.close();
        await sleep(1600);

        const probe = await new C('probe').connect({ mode: 'room', room_id: roomId, device_id: devGuest, nickname: 'Guest', emoji: '🐼' });
        const re = probe.last('room_init');
        check('emptied room is paused on return', re && re.state === 'paused', re && re.state);
        check('emptied room kept the track', re && re.current_track && re.current_track.title === 'Memory Song',
            re && re.current_track && re.current_track.title);
        check('emptied room kept the position', re && re.position > 0 && Math.abs(re.position - beforeExit) < 3,
            `rejoined ${re && re.position} vs ${beforeExit}`);
        probe.close();
    });

    await scenario('punishment gate', async ({ guest }) => {
        guest.clear();
        guest.send('punishment_clear', { device_id: 'someone-else' });
        await sleep(800);
        check('non-host punishment_clear is refused', !!guest.last('notice') || !guest.last('punishments_updated'),
            JSON.stringify(guest.msgs.map(m => m.type)));
    });

    await scenario('play/pause with nothing queued', async ({ host }) => {
        host.clear();
        host.send('play');
        await sleep(900);
        check('play with an empty room is safe', host.closed === null, JSON.stringify(host.closed));
        check('play with nothing queued emits no track', !host.last('track_change'), JSON.stringify(host.msgs.map(m => m.type)));
        host.clear();
        host.send('pause');
        await sleep(700);
        check('pause with nothing queued is safe', host.closed === null, JSON.stringify(host.closed));
        host.clear(); host.send('ping'); await sleep(400);
        check('room stays stopped', host.last('pong').state === 'stopped', host.last('pong').state);
    });

    await scenario('seek and prev edge cases', async ({ host, guest }) => {
        host.send('queue_add', { track: T('dQw4w9WgXcQ', 'Seek Song') });
        await sleep(1000);
        guest.clear();
        host.send('seek', { position: 120 });
        await sleep(800);
        check('seek broadcasts', !!guest.last('seek'), JSON.stringify(guest.msgs.map(m => m.type)));
        check('seek position applied', Math.abs(guest.last('seek').position - 120) < 1, String(guest.last('seek').position));

        host.clear(); guest.clear();
        host.send('prev');   // no history -> restart the current track
        await sleep(900);
        check('prev with no history restarts the track', !!guest.last('seek') && guest.last('seek').position === 0,
            JSON.stringify(guest.msgs.map(m => m.type)));
    });

    await scenario('queue reorder/remove isolation', async ({ host, guest }) => {
        host.send('queue_add', { track: T('dQw4w9WgXcQ', 'R1') });
        await sleep(900);
        host.send('queue_add', { track: T('9bZkp7q19f0', 'R2') });
        await sleep(700);
        host.send('queue_add', { track: T('kJQP7kiw5Fk', 'R3') });
        await sleep(800);
        const q = host.last('queue_updated').queue;
        // R1 started playing immediately (a legacy room auto-starts the first
        // add), so only R2 and R3 remain queued.
        check('two queued after the first track started', q.length === 2, JSON.stringify(q.map(x => x.title)));

        const reversed = q.map(x => x.id).reverse();
        guest.clear();
        host.send('queue_reorder', { ordered_ids: reversed });
        await sleep(800);
        check('reorder broadcasts', !!guest.last('queue_updated'), JSON.stringify(guest.msgs.map(m => m.type)));
        check('reorder applied the order', guest.last('queue_updated').queue.map(x => x.id).join(',') === reversed.join(','),
            guest.last('queue_updated').queue.map(x => x.title).join(','));

        guest.clear();
        host.send('queue_reorder', { ordered_ids: [999999, 888888] });
        await sleep(700);
        check('foreign queue ids are ignored', !guest.last('queue_updated') || guest.last('queue_updated').queue.length === 2,
            JSON.stringify(guest.last('queue_updated') && guest.last('queue_updated').queue.map(x => x.title)));
    });

    await scenario('owner-only control on a legacy room', async ({ host, guest }) => {
        // control_mode lives on the rooms row, so a legacy room flagged 'owner'
        // must be enforced by the server too — not just world mats.
        host.clear(); guest.clear();
        guest.send('queue_add', { track: T('dQw4w9WgXcQ', 'Guest Song') });
        await sleep(900);
        check('guest cannot queue when control is owner', !guest.last('queue_updated') && !!guest.last('notice'),
            JSON.stringify(guest.msgs.map(m => m.type)));
        check('guest is told why', !!guest.last('notice') && /pemilik/i.test(guest.last('notice').message || ''),
            guest.last('notice') && guest.last('notice').message);

        host.clear(); guest.clear();
        host.send('queue_add', { track: T('dQw4w9WgXcQ', 'Host Song') });
        await sleep(1000);
        check('owner can still queue', guest.last('track_change') && guest.last('track_change').track.title === 'Host Song',
            JSON.stringify(guest.msgs.map(m => m.type)));

        guest.clear();
        guest.send('pause');
        await sleep(700);
        check('guest cannot pause when control is owner', !guest.last('pause') && !!guest.last('notice'),
            JSON.stringify(guest.msgs.map(m => m.type)));
    }, { control: 'owner' });

    await scenario('chat hardening', async ({ host, guest }) => {
        guest.clear();
        host.send('chat', { message: 'hello' });
        await sleep(700);
        check('chat broadcasts', !!guest.last('chat_message'), JSON.stringify(guest.msgs.map(m => m.type)));
        check('chat keeps the sender', guest.last('chat_message').message.sender_nickname === 'Host',
            JSON.stringify(guest.last('chat_message').message).slice(0, 120));

        guest.clear();
        for (let i = 0; i < 8; i++) { host.send('chat', { message: 'flood ' + i }); await sleep(120); }
        await sleep(900);
        check('chat flood is rate limited', !!host.last('notice') || guest.all('chat_message').length <= 5,
            `delivered=${guest.all('chat_message').length}`);
    });

    console.log(`\nLegacy isolated QA: ${pass} passed, ${fail} failed`);
    if (fail) { console.log('FAILURES:'); failures.forEach(f => console.log(' - ' + f)); }
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
