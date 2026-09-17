/* macOS app icon: places the final Irori mark on a rounded paper plate.
 *   node design/icon/appicon.gen.mjs && node design/icon/render.mjs out/irori-app.svg
 *   npm run tauri -- icon design/icon/out/irori-app.png
 *
 * The mark itself (hearth.gen.mjs) is pure vector on a transparent background; this file only
 * handles two things, "plate + placement":
 *
 *   plate     — macOS icon grid: 1024 canvas, 824 body, 100 margin on every side. The corners use a
 *               superellipse (n = 5) rather than rx rounding, so curvature is continuous and matches
 *               the outline of the system's own icons.
 *               The paper color is the app's own background, slightly lighter at the top and darker at
 *               the bottom, plus a soft drop shadow — the only place in the image that uses gradients
 *               and translucency. That is platform convention (icons since Big Sur have a plate with
 *               depth); the mark itself is still seven solid colors. For a fully flat fill, turn on
 *               PLATE_FLAT.
 *
 *   placement — in its own 512 canvas the mark's bounding box is (78.3, 76.9, 355.3, 354.9), almost
 *               square. It is scaled uniformly to MARK and centered on the plate. The clipPaths use
 *               userSpaceOnUse and transform along with the outer transform, so wrapping the mark in a
 *               <g transform> is enough; its coordinates don't need to change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, ROUND } from './hearth.gen.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));

const PLATE = 824; //   plate side length (1024 canvas, 100 margin on every side)
const MARK = 600; //    target size of the mark's bounding box
const MARK_DY = 8; //   nudge down slightly: the mark's visual center (the slab) sits below its bbox center, since the smoke takes the upper half
const PLATE_FLAT = false; // true = flat plate fill, no gradient or drop shadow

const PAPER_TOP = '#FCF9F3';
const PAPER_BOT = '#EFE6D8';
const ACCENT = '#A27B5C';

/** Superellipse (continuous corners). Larger n is squarer; 5 is close to the macOS icon outline. */
function squircle(cx, cy, a, n = 5, steps = 256) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push(
      `${(cx + a * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(2)},` +
        `${(cy + a * Math.sign(s) * Math.abs(s) ** (2 / n)).toFixed(2)}`,
    );
  }
  return `M${pts.join('L')}Z`;
}

const mark = build(ROUND);
const defs = mark.slice(mark.indexOf('<defs>') + 6, mark.indexOf('</defs>')).trim();
const body = mark.slice(mark.indexOf('</defs>') + 7, mark.lastIndexOf('</svg>')).trim();

// The mark's bounding box (512 space), measured with getBBox; see the acceptance checklist in §12 of the design doc
const BB = { x: 78.34, y: 76.9, w: 355.32, h: 354.9 };
const k = MARK / Math.max(BB.w, BB.h);
const tx = (1024 - BB.w * k) / 2 - BB.x * k;
const ty = (1024 - BB.h * k) / 2 - BB.y * k + MARK_DY;

const BODY = squircle(512, 512, PLATE / 2);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="Irori">
  <defs>
${PLATE_FLAT ? '' : `    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${PAPER_TOP}"/>
      <stop offset="1" stop-color="${PAPER_BOT}"/>
    </linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#5A3D22" flood-opacity="0.22"/>
    </filter>
`}    <clipPath id="plateclip"><path d="${BODY}"/></clipPath>
    ${defs}
  </defs>

  <!-- Plate -->
  <path d="${BODY}" fill="${PLATE_FLAT ? PAPER_TOP : 'url(#plate)'}"${PLATE_FLAT ? '' : ' filter="url(#drop)"'}/>

  <!-- Mark. Clipped to the plate, so if it is ever enlarged and overflows, nothing bleeds past the edge -->
  <g clip-path="url(#plateclip)">
    <g transform="translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${k.toFixed(5)})">
      ${body}
    </g>
  </g>

  <!-- A very faint inner stroke to finish the plate's edge -->
  <path d="${BODY}" fill="none" stroke="${ACCENT}" stroke-opacity="0.16" stroke-width="3"/>
</svg>
`;

fs.mkdirSync(path.join(here, 'out'), { recursive: true });
fs.writeFileSync(path.join(here, 'out/irori-app.svg'), svg);
console.log('› out/irori-app.svg  (plate ' + PLATE + ', mark ' + MARK + ', scale ' + k.toFixed(3) + ')');
