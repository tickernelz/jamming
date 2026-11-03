// Guard (DEV-99): room and world share ONE websocket whose ?mode= is fixed at
// connect time, so entering one while the other is active must first leave the
// other. Previously joinRoom() never cleared activeWorldId and enterWorld()
// never cleared activeRoomId, so both ids stayed set and one session's socket
// kept running hidden / got overwritten on the next entry.
import assert from 'node:assert';
import { appSource } from './lib/app-source.mjs';

const src = appSource();

const body = (name, nextName) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `${name} must exist`);
    const end = src.indexOf(`function ${nextName}(`, start);
    return src.slice(start, end === -1 ? undefined : end);
};

const joinRoom = body('joinRoom', 'enterWorld');
assert.ok(/if \(window\.JAMRI_APP\.activeWorldId\)\s*\{\s*leaveWorld\(\);/.test(joinRoom),
    'joinRoom() must leave an active world before entering a room');
assert.ok(joinRoom.indexOf('leaveWorld()') < joinRoom.indexOf("window.JAMRI_APP.activeRoomId = roomId"),
    'joinRoom() must clear the world before it claims the room');

const enterWorld = body('enterWorld', 'leaveWorld');
assert.ok(/if \(window\.JAMRI_APP\.activeRoomId\)\s*\{\s*leaveRoom\(\);/.test(enterWorld),
    'enterWorld() must leave an active room before entering a world');
assert.ok(enterWorld.indexOf('leaveRoom()') < enterWorld.indexOf('window.JAMRI_APP.activeWorldId = worldId'),
    'enterWorld() must clear the room before it claims the world');

// leaveActiveSession() must not early-return: a leftover id on either side
// would let the next entry overlap the previous session.
const leaveActive = body('leaveActiveSession', 'leaveRoom');
assert.ok(!/leaveWorld\(\);\s*return true;/.test(leaveActive),
    'leaveActiveSession() must not early-return after leaving a world');
assert.ok(/leaveWorld\(\);[\s\S]*?leaveRoom\(\);/.test(leaveActive),
    'leaveActiveSession() must be able to clear both world and room ids');

console.log('world_room_mode_overlap_check: OK');
