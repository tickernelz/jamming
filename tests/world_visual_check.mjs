// Guard: the world must stay BRIGHT. The first renderer used a navy void
// (#0b0f1a) with dark brown walls, which made the map look murky. These checks
// keep the daylight palette, the animation hooks, and the render-loop safety
// net from silently regressing.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const js = read('../public/js/world.js');
const css = read('../public/css/world.css');

// 1) No leftover "night" palette anywhere in the renderer or the stage.
for (const dark of ['#0b0f1a', '#20263a', '#1b2033', '#3b2c1e', '#5a4430']) {
    assert.ok(!js.includes(dark), `world.js must not paint the old dark palette (${dark})`);
    assert.ok(!css.includes(dark), `world.css must not use the old dark palette (${dark})`);
}

// 2) The stage background must be the daylight grass tone.
assert.ok(/#86c973/.test(css), 'world-stage must have a bright grass background');
assert.ok(/background:\s*#86c973/.test(css), 'stage background must be the grass colour');

// 3) Daylight lighting pass: warm sun + a *subtle* green vignette only.
assert.ok(/rgba\(255, 249, 214/.test(js), 'render must add a warm sunlight pass');
const vignette = js.match(/rgba\(18, 48, 30, ([\d.]+)\)/g) || [];
assert.ok(vignette.length >= 1, 'render must keep a soft vignette');
for (const v of vignette) {
    const alpha = parseFloat(v.slice(v.lastIndexOf(',') + 1, v.lastIndexOf(')')));
    assert.ok(alpha <= 0.2, `vignette alpha must stay subtle (got ${alpha})`);
}

// 4) WorkAdventure-style animation hooks must exist.
for (const hook of ['walkPhase', 'spawnDust', 'spawnNote', 'showBubble', 'zoomFor', 'camLook']) {
    assert.ok(js.includes(hook), `renderer must keep the ${hook} animation hook`);
}

// 4b) Mats must be a genuinely translucent disc, never a checkerboard of
//     "fake transparency" tiles (it read as grey squares over the grass).
const drawMats = js.slice(js.indexOf('    drawMats(ctx, camX, camY, now) {'), js.indexOf('    drawParticles(ctx, camX, camY) {'));
assert.ok(!/ctx\.clip\(\)/.test(drawMats), 'mats must not clip a tiled pattern');
assert.ok(!/cell = 16/.test(drawMats), 'mats must not draw tile cells');
// Extract the mat BODY fill only (between the rug comment and the border).
const bodyStart = drawMats.indexOf('Rug body');
const bodyEnd = drawMats.indexOf('Border:');
const body = drawMats.slice(bodyStart, bodyEnd);
const matFillAlphas = [...body.matchAll(/hsla\(\$\{hue\},[^)]*?,\s*0\.(\d+)\)`/g)].map(m => parseFloat('0.' + m[1]));
assert.ok(matFillAlphas.length >= 2,
    `mat body must be filled with translucent hsla colours (found ${matFillAlphas.length})`);
assert.ok(Math.max(...matFillAlphas) <= 0.35,
    `mat fill must stay translucent (max alpha ${Math.max(...matFillAlphas)})`);
assert.ok(/arc\(sx, sy, r, 0, Math\.PI \* 2\)/.test(body), 'mat body must be a circle');

// 5) Render-loop safety: a partial box payload (no x/y) must never throw.
const drawMatsSrc = js.slice(js.indexOf('drawMats(ctx, camX, camY, now)'));
assert.ok(/Number\.isFinite\(b\.x\)/.test(drawMatsSrc) && /Number\.isFinite\(b\.y\)/.test(drawMatsSrc),
    'drawMats must skip boxes without finite coordinates (NaN gradient would kill the loop)');

// 6) High-DPI: canvas must be sized by devicePixelRatio and the scene scaled.
assert.ok(/devicePixelRatio/.test(js), 'resize() must account for devicePixelRatio');
assert.ok(/const scale = zoom \* dpr/.test(js), 'render must scale the world pass by zoom * dpr');
assert.ok(/ResizeObserver/.test(js), 'stage resizes must be observed (stale buffer = stretched world)');

console.log('world_visual_check: OK');
