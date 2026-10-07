// Guard: every listener world.js binds must be detachable. bindInput() runs on
// each world entry; any handler stored outside _bound (or never removed in
// unbindInput) leaks and stacks on window/joy across re-entries.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('../public/js/world.js', import.meta.url), 'utf8');
const bound = [...src.matchAll(/this\._bound\.(\w+)\s*=/g)].map((m) => m[1]);
assert.ok(bound.length >= 6, `expected several bound handlers, found ${bound.length}`);

const unbind = src.slice(src.lastIndexOf('unbindInput()'));
for (const name of bound) {
    assert.ok(unbind.includes(`this._bound.${name})`),
        `unbindInput() must removeEventListener this._bound.${name}`);
}

// The joystick's window-level listeners must live on _bound, not inline arrows.
const joy = src.slice(src.indexOf('const joy = document.getElementById'), src.lastIndexOf('unbindInput()'));
assert.ok(!/window\.addEventListener\('(mousemove|mouseup)', \(/.test(joy),
    'joystick window listeners must be named (_bound) so unbindInput can remove them');
assert.ok(joy.includes('joyTouchStart') && joy.includes('joyMouseMove'),
    'joystick touch/mouse handlers must be stored on _bound');

console.log('world_input_cleanup_check: OK');
