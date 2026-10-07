// Guard: world.js must define send() exactly once, routed through the shared
// websocket client. A duplicate legacy send() shadowed the real one and made
// every world action (e.g. "Gelar Tikar" / mat.place) silently vanish.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('../public/js/world.js', import.meta.url), 'utf8');
const defs = src.match(/^\s{4}send\(type/gm) || [];
assert.strictEqual(defs.length, 1, `expected 1 send() definition, found ${defs.length}`);
assert.ok(src.includes('client.send(type, payload)'), 'send() must use the shared client');
assert.ok(!/this\.ws\.send\(/.test(src), 'no legacy this.ws.send() allowed');
console.log('world_send_check: OK');
