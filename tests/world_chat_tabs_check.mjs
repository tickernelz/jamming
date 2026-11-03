// Guard: the world side panel must have ONE chat input with two tabs
// (Chat Tikar / Chat World), not two separate stacked chat blocks.
//
// Previously the panel rendered two independent lists + two forms, which made
// the panel tall and confusing. Now: one form, two panels, one visible at a time.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const world = readFileSync(new URL('../public/js/world.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/world.css', import.meta.url), 'utf8');

const dom = world.slice(world.indexOf('buildDom() {'), world.indexOf('    setChatTab(tab) {'));

// 1) Two tabs + two panels, exactly one form.
assert.ok((dom.match(/class="world-chat-tab[ "]/g) || []).length === 2,
    'panel must render exactly two chat tabs');
assert.ok((dom.match(/class="world-chat-panel[ "]/g) || []).length === 2,
    'panel must render exactly two chat panels');
assert.strictEqual((dom.match(/<form/g) || []).length, 1,
    'panel must render exactly one chat form (shared by both tabs)');

// The old duplicate blocks must be gone.
assert.ok(!dom.includes('id="mat-chat-form"'), 'the separate mat chat form must be removed');
assert.ok(!dom.includes('id="mat-chat-input"'), 'the separate mat chat input must be removed');

// 2) Tab switching must be wired and state-aware.
assert.ok(/querySelectorAll\('\.world-chat-tab'\)\.forEach/.test(dom), 'tabs must be wired to clicks');
const setter = world.slice(world.indexOf('    setChatTab(tab) {'), world.indexOf('    openPlaceMatDialog() {'));
assert.ok(setter.includes('world-chat-panel-'), 'setChatTab must toggle panel visibility');
assert.ok(setter.includes('activeBox'), 'setChatTab must reflect the on-mat state');
assert.ok(/this\.send\('world\.chat'/.test(world), 'world tab must send world.chat');
assert.ok(/sendChatMessage\(text\)/.test(world), 'mat tab must send the room chat');

// 3) CSS: hidden panels must actually be hidden.
assert.ok(/\.world-chat-panel\s*\{[^}]*display:\s*none/.test(css),
    'inactive chat panels must be display:none');
assert.ok(/\.world-chat-panel\.active\s*\{[^}]*display:\s*flex/.test(css),
    'the active chat panel must be displayed');

console.log('world_chat_tabs_check: OK');
