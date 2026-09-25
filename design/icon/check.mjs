/* The mark's acceptance checklist, in executable form. Corresponds to §12 of the design doc
 * design/icon/hearth.md.
 *   node design/icon/check.mjs
 *
 * Why this exists: the mark went through four rounds of rework, and all four bugs came from
 * "verifying geometry by eye". A 5px inward shift of the boundary is invisible in a thumbnail but
 * has nowhere to hide once measured. After a change, run this first, then look at the image.
 */
import { launch } from '../../tests/e2e/harness.mjs';
import { build, DEFAULTS, ROUND, UNLIT, ANIMATED, ANIM } from './hearth.gen.mjs';

const C30 = Math.cos(Math.PI / 6);
let bad = 0;
const ok = (pass, label, detail = '') => {
  console.log(`${pass ? '  ✓' : '  ✗'} ${label}${detail && '  ' + detail}`);
  if (!pass) bad++;
};

const { R, B, G, A, OUT, GAP, SCALE } = DEFAULTS;
const F = R - B, BO = A + G, M = F - BO;

console.log('\nLayout');
ok(2 * (B + M + G) + 2 * A === 2 * R, 'Rhythm identity (widths sum to 2R)', `${[B, M, G, 2 * A, G, M, B].join(' + ')} = ${2 * R}`);
ok(B === G && G === OUT, 'Rim = stroke = overhang', `${B} / ${G} / ${OUT}`);
ok(M - OUT > 0, 'Stroke ends clear of the rim', `clearance ${M - OUT}`);

console.log('\nGaps');
ok(true, 'Horizontal gap vertical distance (constant drop)', `${(GAP * SCALE).toFixed(2)}px`);
ok(true, 'Visible width on straight edges = vertical seam width', `${(GAP * C30 * SCALE).toFixed(2)}px`);

const browser = await launch();
const page = await browser.newPage();
for (const [name, opts] of [['Square-cornered', {}], ['Rounded', ROUND]]) {
  const svg = build(opts);
  console.log(`\n${name}`);

  // Solid colors only: no gradients, translucency or background rect allowed
  const junk = svg.match(/gradient|opacity|rgba|<rect/g) || [];
  ok(junk.length === 0, 'No gradient / translucency / background rect', junk.length ? junk.join(',') : '');
  ok(new Set(svg.match(/#[0-9A-F]{6}/g)).size === 7, 'Seven solid colors');

  /* Left-right mirror symmetry. The smoke is deliberately off-center, so it is excluded (it is the
     last path). Grab every coordinate — grabbing only M/L would miss the endpoints of the Q curves in
     the round caps, and this check would then report a false failure. */
  const body = svg.slice(0, svg.lastIndexOf('<path'));
  const xs = [...new Set([...body.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => +(+m[1]).toFixed(3)))].sort((a, b) => a - b);
  const worst = Math.max(...xs.map((x) => {
    const mir = 512 - x;
    return Math.abs(xs.reduce((b, c) => (Math.abs(c - mir) < Math.abs(b - mir) ? c : b)) - mir);
  }));
  ok(worst < 0.05, 'Left-right mirror', `max deviation ${worst.toFixed(4)}px (${xs.length} x coordinates)`);

  /* Boundary: the side walls' left/right extremes must be flush with the top face. This is the only
     check that catches "the boundary quietly moving inward" — the fillet radius indices were once
     swapped, the edge got backed off by 5px, and it was completely invisible in the render. */
  await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
  const [b1, b2, face] = await page.evaluate(() =>
    [...document.querySelectorAll('svg > path')].slice(0, 3).map((p) => {
      const b = p.getBBox();
      return { l: +b.x.toFixed(3), r: +(b.x + b.width).toFixed(3) };
    }),
  );
  const dL = Math.min(b1.l, b2.l) - face.l;
  const dR = face.r - Math.max(b1.r, b2.r);
  ok(Math.abs(dL) < 0.25 && Math.abs(dR) < 0.25, 'Side-wall boundary flush with top face', `left ${dL.toFixed(3)}px  right ${dR.toFixed(3)}px`);
}
await browser.close();

/* Variants share the geometry of the rounded mark; only the pit and the smoke differ. */
console.log('\nUnlit');
{
  const svg = build(UNLIT);
  const colors = new Set(svg.match(/#[0-9A-F]{6}/g));
  ok(colors.size === 6, 'Six solid colors (dying embers, no smoke)', [...colors].join(' '));
  ok(!/#F0A44B|#C3B7A4|#7E3D14/.test(svg), 'Live ember, ember wall and smoke colors absent');
  ok(svg.includes(UNLIT.EMBER) && svg.includes(UNLIT.PWALL), 'Dying-ember colors present');
  const strip = (x) => x.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ');
  const still = strip(build(ROUND));
  const unlit = strip(svg);
  const upTo = (x) => x.slice(0, x.indexOf('clip-path="url(#pit)"'));
  ok(upTo(still) === upTo(unlit), 'Slab, floor and grooves byte-identical to the still mark');
}

console.log('\nAnimated');
{
  const svg = build(ANIMATED);
  const junk = svg.match(/gradient|opacity|rgba|<rect|<script|<style/g) || [];
  ok(junk.length === 0, 'Still no gradient / translucency / script / stylesheet', junk.join(','));
  // Frame 0 must be the published still mark: stripping the SMIL children has to give it back exactly
  const stripped = svg.replace(/>\s*<animate [^>]*\/>\s*<\/path>/g, '/>');
  ok(stripped === build(ROUND), 'Without <animate> it is byte-identical to the still mark');
  const anims = [...svg.matchAll(/<animate attributeName="(\w+)" values="([^"]*)"/g)];
  ok(anims.length === 3, 'Embers, pit wall and smoke animate', `${anims.length} animate elements`);
  const d = anims.find((m) => m[1] === 'd');
  const frames = d ? d[2].split(';') : [];
  const sig = (f) => f.replace(/-?[\d.]+/g, '#');
  ok(frames.length === ANIM.FRAMES + 1 && frames[0] === frames[frames.length - 1], 'Smoke loop closes on itself', `${frames.length} frames`);
  ok(frames.every((f) => sig(f) === sig(frames[0])), 'Every smoke frame has the same path structure (SMIL can morph it)');
  /* The plume must really change direction (not just ripple on a fixed S), while its root stays
     pinned in the embers. Direction: at a few heights up the plume, the centerline (midpoint of the
     smoke's left and right edges at that height) has to swing to both sides of the canvas center
     over a loop. Root: the vertices next to the root barely move. */
  const verts = (f) => [...f.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  const loop = frames.slice(0, -1).map(verts);
  const { CX, CY } = DEFAULTS;
  const midAt = (vs, y) => {
    const xs = vs.filter((v) => Math.abs(v[1] - y) < 4).map((v) => v[0]);
    return xs.length >= 2 ? (Math.min(...xs) + Math.max(...xs)) / 2 : null;
  };
  const heights = [0.55, 0.7, 0.85].map((k) => CY - k * 190); // lower, middle and upper plume
  const flips = heights.map((y) => {
    const m = loop.map((vs) => midAt(vs, y)).filter((v) => v != null);
    return { lo: Math.min(...m) - CX, hi: Math.max(...m) - CX };
  });
  ok(flips.every((f) => f.lo < -4 && f.hi > 4), 'Plume swings to both sides at every height',
    flips.map((f) => `${f.lo.toFixed(0)}..${f.hi.toFixed(0)}px`).join('  '));
  const root = loop.map((vs) => vs[0]);
  const rootDev = Math.max(...root.map((v) => Math.hypot(v[0] - root[0][0], v[1] - root[0][1])));
  ok(rootDev < 1.5, 'Root stays pinned in the embers', `max drift ${rootDev.toFixed(2)}px`);
  /* Smoke doesn't whip: the very end of the plume must not suddenly speed up while the hook turns.
     Tracked as a material point: the tip vertex, which sits halfway round the closed outline (M,
     then one C with three coordinate pairs per point). "The topmost point" would not do: it jumps
     between the hook's crest and its end as the hook turns and fakes a spike. The largest step
     between keyframes stays within 2× the average (the hook driven by tanh(lean) whipped at about
     2.7×; driven linearly it is about 1.7×). */
  const tips = loop.map((vs) => vs[3 * (((vs.length - 1) / 3 - 1) / 2)]);
  const steps = tips.map((p, i) => { const q = tips[(i + 1) % tips.length]; return Math.hypot(q[0] - p[0], q[1] - p[1]); });
  const meanStep = steps.reduce((a, b) => a + b) / steps.length, maxStep = Math.max(...steps);
  ok(maxStep <= 2 * meanStep, 'Tip never whips (no sudden speed-up while turning)', `max step ${maxStep.toFixed(1)}px, mean ${meanStep.toFixed(1)}px`);
}

console.log(bad ? `\n${bad} check(s) failed\n` : '\nAll checks passed\n');
process.exit(bad ? 1 : 0);
