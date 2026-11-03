// Guard: leaving the world via the nav tabs / logo must actually end the world
// session. Navigation previously only checked activeRoomId, so the world socket
// and its render loop kept running hidden (and stacked on re-entry).
import assert from 'node:assert';
import { appSource } from './lib/app-source.mjs';

const src = appSource();

const nav = src.slice(src.indexOf('function bindNavigation'), src.indexOf('LOBBY ROOMS'));
assert.ok(nav.includes('leaveActiveSession()'),
    'nav tabs + logo must leave the active session (world or room), not just rooms');
assert.ok(!/if \(window\.JAMRI_APP\.activeRoomId\) \{\s*leaveRoom\(\);/.test(nav),
    'navigation must not special-case activeRoomId only');

const helper = src.slice(src.indexOf('function leaveActiveSession'), src.indexOf('function leaveRoom'));
assert.ok(helper.includes('window.JAMRI_APP.activeWorldId'), 'leaveActiveSession must handle worlds');
assert.ok(helper.includes('leaveWorld()'), 'leaveActiveSession must call leaveWorld() for worlds');
assert.ok(helper.includes('window.JAMRI_APP.activeRoomId'), 'leaveActiveSession must handle rooms');
assert.ok(helper.includes('leaveRoom()'), 'leaveActiveSession must call leaveRoom() for rooms');

console.log('nav_session_leave_check: OK');
