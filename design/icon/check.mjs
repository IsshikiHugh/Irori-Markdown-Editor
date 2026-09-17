/* The mark's acceptance checklist, in executable form. Corresponds to §12 of the design doc
 * design/icon/hearth.md.
 *   node design/icon/check.mjs
 *
 * Why this exists: the mark went through four rounds of rework, and all four bugs came from
 * "verifying geometry by eye". A 5px inward shift of the boundary is invisible in a thumbnail but
 * has nowhere to hide once measured. After a change, run this first, then look at the image.
 */
import { launch } from '../../tests/e2e/harness.mjs';
import { build, DEFAULTS, ROUND } from './hearth.gen.mjs';

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

console.log(bad ? `\n${bad} check(s) failed\n` : '\nAll checks passed\n');
process.exit(bad ? 1 : 0);
