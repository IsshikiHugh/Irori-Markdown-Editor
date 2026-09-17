/* The Irori (囲炉裏) 3D mark: a square sunken hearth in isometric projection.
 *   node design/icon/hearth.gen.mjs && node design/icon/render.mjs out/hearth-round.svg
 *
 * Emits two versions that share the same geometry and differ only in two corner radii:
 *   out/hearth.svg        square-cornered (RS = RG = 0)
 *   out/hearth-round.svg  rounded ← final
 * out/ is entirely git-ignored: anything one command can regenerate doesn't belong in version
 * control. The published copies live in assets/logo/.
 *
 * ── Why generated, not drawn ────────────────────────────────
 * Nothing here that "should be equal width" or "should be symmetric" relies on eyeballing: the
 * black hearth rim, the igeta strokes and the clearance between strokes and rim are all derived
 * from the world-coordinate constants below, then passed through one isometric projection. The
 * inner walls exposed by the recesses aren't hand-drawn either: for each edge of the opening
 * polygon we compute which faces point toward the camera, and draw only those.
 * So the "perspective" is a computed result, not a painted effect: change any number and the
 * occlusion rearranges itself.
 *
 * ── What the shape means ─────────────────────────────────────
 * The black outer ring = the hearth rim (炉縁), i.e. the enclosing 口 of the 囲 character;
 * the four inner grooves = the igeta (井桁) frame, i.e. the 井 inside 囲, which is also Markdown's #;
 * the center cell of the 井 sinks one level further = the hearth itself: the glow is the embers,
 * the rising shape is the smoke.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

/* ── Dimensions ─────────────────────────────────────────────
 * World coordinates = plan dimensions seen from above. Along a line through the center, from the
 * outside in:
 *
 *     rim 12 │ margin 18 │ stroke 12 │ hearth 24 │ stroke 12 │ margin 18 │ rim 12  = 108 = 2R
 *
 * All multiples of 6. With u = 6, outside-in reads 2u │ 3u │ 2u │ 4u │ 2u │ 3u │ 2u = 18u.
 * The three things that must share a width are all 2u: the rim (the outer 口 of 囲), the igeta
 * strokes (the inner 井), and each stroke's overhang past its crossing. The overhang equals the
 * stroke width so that the 井 reads as four strokes, not as a square ring with lumps on it.
 * The 4u hearth is the only enlarged cell, because it is the protagonist; stroke ends keep 1u
 * from the rim. The margin M is split between overhang and end clearance: M = OUT + clearance,
 * so when OUT changes, the clearance rebalances itself. */
export const DEFAULTS = {
  R: 54, //   half-width of the slab's outer edge (= 9u)
  B: 12, //   black hearth rim (2u)
  G: 12, //   igeta stroke width (2u)
  A: 12, //   half-width of the central hearth (2u; the full hearth cell is 4u)
  OUT: 12, // stroke overhang past the crossing (2u; leaves M - OUT = 1u between stroke end and rim)
  H: 24, //   slab thickness (extruded downward, 4u)
  D1: 5, //   igeta groove depth
  D2: 6, //   extra depth of the hearth below the groove
  RS: 0, //   corner radius of the slab outline / top face (world units, 0 = square)
  RF: null, // corner radius of the hearth floor; null = RS - B (concentric offset), so the rim
  //          keeps its width at the corners too
  RG: 0, //   corner radius of the igeta opening and the hearth
  TIP: 1.5, // radius of the arcs on the left and right sharp tips (screen px). The tangent point
  //          lands about 1.5×TIP from the tip, so keep this small: 7 grinds the tip into a round
  //          nub and the upward-pointing stance is gone
  FIL: 5, //  radius of the rounded caps on right-angle corners such as both ends of the vertical
  //          seam (screen px)
  GAP: 5, //  width of the gaps between slab faces (world units). The side walls drop this far below
  //          the top face, and the nearest vertical edge is cut back GAP/2 on each side, so the two
  //          gaps come out exactly equal in on-screen width measured perpendicular to the gap
  WMAX: 11.5, // smoke width at its thickest
  SPINE: null, // smoke centerline; default below
  SCALE: 2.08,
  CX: 256,
  CY: 280,
  SMOKE: null, // smoke color; null = the editor's --tok (source-marker color)
  FLOOR: null, // hearth floor color; null = the default ash color
  FIRE: true, // whether the center cell is burning; false = just a deeper pit
  BG: false, // whether to paint the paper background; off by default, left to the consumer
};

/* Isometric projection: +x goes down-right, +y down-left, +z up. The camera looks from the
   (+1,+1,+1) direction, so a face is visible only if its outward normal has a positive dot
   product with (1,1,1) — that is exactly what wallRuns() tests. */
const C30 = Math.cos(Math.PI / 6);
const S30 = 0.5;

/* ── Palette ────────────────────────────────────────────────
 * Solid colors only: no gradients, no translucency, and no background — that is left to the consumer.
 * The slab's three visible faces (top and two sides) share one black: depth no longer comes from
 * shading but from the gaps between faces (see GAP).
 * Only the inside of the recesses keeps two shades. That isn't a seam; it is the only cue that
 * "this part is sunken". A gap there would expose the paper-colored floor and read as a crack,
 * not a recess. */
const INK = '#221C18'; //   slab: top face and both side faces
const FLOOR = '#F7F3EC'; // hearth floor (ash) = the editor's --paper
const GROOVE = '#231A15'; //groove bottom
const GWALL = '#33271F'; // groove inner walls
const PWALL = '#7E3D14'; // hearth inner walls, lit from below by the embers
const EMBER = '#F0A44B'; // embers (the midpoint of the old highlight gradient, taken as one flat color)
/* Smoke uses the editor's --tok (#C3B7A4): the color of the "faded" source markers in body text,
   so the rising smoke is the same gray as the # you are typing.
   --paper (#F7F3EC) was the first choice, but with the mark placed on the editor's own background,
   the part of the smoke that rises past the rim would vanish entirely (same color). --tok is two
   steps darker than paper and stays visible on paper, on white and on the rim. */
const SMOKE = '#C3B7A4';

/* Smoke: starts at the center of the embers, makes one long bend to the right, one turn back to
   the left, and ends with a small hook. The centerline is a chain of cubic Beziers with a vertical
   tangent at every joint, so the S curve has continuous curvature; the width is given separately by
   width() and goes to zero at both ends so they taper to a point.
   The left/right switch is deliberately placed at y≈-65, just past the rim's farthest corner
   (y = -R = -54); otherwise the smoke would sit right on that corner and look skewered by it. */
const SPINE = [
  [0, 7],
  [0, -17], [13, -19], [13, -45],
  [13, -64], [-10, -66], [-10, -85],
  [-10, -93], [-4, -99], [3, -96],
];

/* ── Corner rounding: in the world plane, not on screen ─────────────
   At first I took the shortcut of filleting the projected polygons directly, and the slab's top
   face and side faces got rounded independently: a chunk of black side wall stuck out at the left
   and right corners, because the top-face corner there is 60° while the outline corner is 150°,
   and arcs of the same radius on those simply don't line up. Rounding must happen before
   projection: replace the square corners in plan with arcs, sample them into polylines, then send
   the whole thing through the projection. That way top face, side walls and occlusion boundaries
   all stay consistent automatically.

   Sampling density follows the radius: the sagitta error stays within 0.1 world units, so the
   polyline is indistinguishable from a curve by eye. */
function roundPlan(pts, r) {
  if (!(r > 0)) return pts;
  const m = pts.length;
  const out = [];
  for (let i = 0; i < m; i++) {
    const [x0, y0] = pts[(i - 1 + m) % m];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % m];
    const l1 = Math.hypot(x1 - x0, y1 - y0);
    const l2 = Math.hypot(x2 - x1, y2 - y1);
    const u1 = [(x0 - x1) / l1, (y0 - y1) / l1]; // from the vertex toward the previous point
    const u2 = [(x2 - x1) / l2, (y2 - y1) / l2]; // from the vertex toward the next point
    const half = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))) / 2;
    // Back off along each edge by t = r/tan(half-angle): in isometric view there are both 60° and
    // 120° corners, and a fixed back-off would make one fat and the other thin.
    // It also may not exceed half of either adjacent edge, so corners on short edges shrink on
    // their own instead of eating into each other.
    const t = Math.min(r / Math.tan(half), l1 / 2, l2 / 2);
    const rr = t * Math.tan(half);
    if (!(rr > 1e-6)) { out.push([x1, y1]); continue; }
    // The center lies on the bisector of the two edges (works for convex and concave corners
    // alike: the bisector always points to the side being rounded)
    const bx = u1[0] + u2[0], by = u1[1] + u2[1];
    const bl = Math.hypot(bx, by) || 1;
    const cx = x1 + (bx / bl) * (rr / Math.sin(half));
    const cy = y1 + (by / bl) * (rr / Math.sin(half));
    const a0 = Math.atan2(y1 + u1[1] * t - cy, x1 + u1[0] * t - cx);
    let d = Math.atan2(y1 + u2[1] * t - cy, x1 + u2[0] * t - cx) - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const steps = Math.max(4, Math.min(18, Math.ceil(rr * 1.5)));
    for (let k = 0; k <= steps; k++) {
      const a = a0 + (d * k) / steps;
      out.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
  }
  return out;
}

/* For each short segment of side wall, decide whether it faces the camera. A vertical wall's
   normal has no z component, so "facing the camera" means n·(1,1) > 0. `solid` says which side of
   the polygon is solid: the slab is solid inside (normals point out), a groove is solid outside
   (normals point in). The winding comes from the signed area, so vertex order doesn't matter.
   Returns contiguous runs, separated by whether the normal leans toward +x or +y — the two sides
   are shaded differently. */
function wallRuns(pts, solid, split = false) {
  const m = pts.length;
  let area = 0;
  for (let i = 0; i < m; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % m];
    area += x1 * y2 - x2 * y1;
  }
  const sgn = (area > 0 ? 1 : -1) * (solid ? 1 : -1);
  const seg = pts.map((a, i) => {
    const b = pts[(i + 1) % m];
    const nx = sgn * (b[1] - a[1]);
    const ny = -sgn * (b[0] - a[0]);
    return { vis: nx + ny > 1e-9, x: nx > ny };
  });
  // With split, cut once more by whether the normal leans +x or +y — the cut lands exactly on the
  // nearest edge. Unsplit, a continuous stretch of side wall stays one path, so same-colored
  // neighbors leave no anti-aliasing seam.
  const key = (k) => (seg[k].vis ? (split ? (seg[k].x ? 'x' : 'y') : 'v') : '-');
  let s0 = 0;
  while (s0 < m && key(s0) === key((s0 - 1 + m) % m)) s0++; // start at a boundary so a run wrapping around the ring isn't split in two
  if (s0 >= m) s0 = 0;
  const runs = [];
  for (let k = 0; k < m; ) {
    const i = (s0 + k) % m;
    let len = 1;
    while (k + len < m && key((s0 + k + len) % m) === key(i)) len++;
    if (seg[i].vis) {
      runs.push({
        start: i,
        len,
        head: seg[(i - 1 + m) % m].vis, // upstream is visible too → this end is a cut and must back off to leave a gap
        tail: seg[(i + len) % m].vis,
      });
    }
    k += len;
  }
  return runs;
}

/** Trim a polyline back by arc length at its head and tail. */
function trimArc(list, head, tail) {
  const cut = (pts, want) => {
    if (!(want > 0)) return pts;
    let rest = want;
    const out = pts.slice();
    // Note that length === 2 must be trimmable too — an end face is a two-point straight segment.
    // This once said length > 2, so end faces were never trimmed and those right-angle round caps
    // never took effect
    while (out.length >= 2) {
      const d = Math.hypot(out[1][0] - out[0][0], out[1][1] - out[0][1]);
      if (d > rest) {
        const t = rest / d;
        out[0] = [out[0][0] + (out[1][0] - out[0][0]) * t, out[0][1] + (out[1][1] - out[0][1]) * t];
        return out;
      }
      if (out.length === 2) return out; // trimming further would leave no segment
      rest -= d;
      out.shift();
    }
    return out;
  };
  // reverse() works in place: cut(list, 0) returns the original array untouched, and .reverse()
  // on it would flip the caller's array. The trimmed result looks fine, but when the caller later
  // takes list[last] it gets the other end — that is where the spike on the side wall came from
  // (with FIL=0 the two flips cancel out, so it only showed up with filleting enabled).
  const rev = (a) => a.slice().reverse();
  return rev(cut(rev(cut(list, head)), tail));
}

/* Back off from one end of the polyline until the **horizontal screen** displacement reaches want.
   This used to back off by arc length, which is fine on straight edges but wrong once rounded:
   the vertical seam at the near corner is set by the screen x of its two endpoints, and screen x
   depends only on (x - y). Backing off c along a straight edge changes (x-y) by exactly c; backing
   off the same c along an arc of radius rr changes (x-y) by √2·c — so the seam got 41% wider,
   which is exactly the spot that was circled in review. Hence the back-off must be measured in
   (x - y), regardless of straight edges or rounded corners. */
function trimDelta(list, head, tail) {
  const key = ([x, y]) => x - y;
  const cut = (pts, want) => {
    if (!(want > 0)) return pts;
    const k0 = key(pts[0]);
    const out = pts.slice();
    while (out.length > 2) {
      const d0 = Math.abs(key(out[0]) - k0);
      const d1 = Math.abs(key(out[1]) - k0);
      if (d1 >= want) {
        const t = d1 > d0 ? (want - d0) / (d1 - d0) : 0;
        out[0] = [out[0][0] + (out[1][0] - out[0][0]) * t, out[0][1] + (out[1][1] - out[0][1]) * t];
        return out;
      }
      out.shift();
    }
    return out;
  };
  const rev = (a) => a.slice().reverse(); // same as above: never reverse the caller's array in place
  return rev(cut(rev(cut(list, head)), tail));
}

export function build(o = {}) {
  const { R, B, G, A, OUT, H, D1, D2, RS, RF, RG, GAP, TIP, FIL, WMAX, SCALE, CX, CY, BG } = { ...DEFAULTS, ...o };
  const spine = o.SPINE || SPINE;
  const smokeFill = o.SMOKE || SMOKE;
  const floorFill = o.FLOOR || FLOOR;
  const pitFill = o.FIRE === false ? GROOVE : (o.EMBER || EMBER);
  const pitWall = o.FIRE === false ? GWALL : PWALL;
  const F = R - B; //   half-width of the hearth floor
  // Concentric shrink: the outer arc of radius RS moves in by B, so the inner radius is RS - B.
  // Otherwise the black rim would be noticeably narrower at the four corners than along the
  // straight edges, breaking the equal width.
  const rf = RF == null ? Math.max(0, RS - B) : RF;
  const BO = A + G; //  outer edge of the strokes
  const M = F - BO; //  margin on each side
  const E = BO + OUT; //half-length of a stroke including its overhang
  if (OUT >= M) throw new Error(`Strokes run into the hearth rim: OUT(${OUT}) must be less than the margin M(${M})`);

  const px = (x, y) => CX + SCALE * (x - y) * C30;
  const py = (x, y, z = 0) => CY + SCALE * ((x + y) * S30 - z);
  const n = (v) => String(Math.round(v * 100) / 100);
  const pt = ([x, y], z) => `${n(px(x, y))},${n(py(x, y, z))}`;
  /** Project a closed planar polyline to a given height and emit it as a closed path. */
  const face = (pts, z = 0) => 'M' + pts.map((p) => pt(p, z)).join('L') + 'Z';
  /** Extract the polyline of a run; when gap is truthy, back off GAP/2 at ends that touch another run. */
  const runPts = (ring, run, gap) => {
    const list = [];
    for (let k = 0; k <= run.len; k++) list.push(ring[(run.start + k) % ring.length]);
    // Trim only the cut ends (back off GAP/2 in x-y, which pins the vertical seam width). Free ends
    // stay put — the boundary has to remain where it is.
    return gap ? trimDelta(list, run.head ? GAP / 2 : 0, run.tail ? GAP / 2 : 0) : list;
  };
  /** One strip of side wall: out along the top edge, back along the bottom edge. Curved or straight alike. */
  const band = (list, z, d) =>
    'M' + list.map((p) => pt(p, z)).concat(list.slice().reverse().map((p) => pt(p, z - d))).join('L') + 'Z';

  /* On-screen width of a gap (measured perpendicular to the gap). The vertical seam is pinned to
     this value directly by the x-y back-off; the horizontal one results from the whole side wall
     dropping by GAP — and on straight edges it comes out exactly this value too. */
  const GW = C30 * SCALE * GAP;

  /* End faces of the side walls. At the left and right sharp tips they used to be needle-like: the
     end face is vertical, and the top edge's tangent there is exactly vertical as well — in
     isometric projection the outline's silhouette point is defined as the moment the tangent turns
     vertical — so the two edges meet almost parallel, at an angle close to zero.

     Such a corner can't be filleted (a fillet of radius r backs off r/tan(half-angle) along each
     edge, which diverges as the half-angle goes to zero); instead we **add an arc tangent to both
     edges**. The center sits at distance r from the end face (x = x0 + r); find the tangent point Q
     along the top edge, and run the arc from the tangent point A on the end face to Q. Because the
     center's x is exactly x0 + r, A is the leftmost point of the circle — the leftmost point of the
     cap still lies on the line x0, **so the boundary doesn't move inward at all**; only the tiny
     sliver at the needle tip is removed. */
  const seglen = (sg) => sg.reduce((a, _, i) => (i ? a + Math.hypot(sg[i][0] - sg[i - 1][0], sg[i][1] - sg[i - 1][1]) : 0), 0);
  /** Unit normal at point i of the curve (screen coords, y down). Its direction flips with the
      traversal order, so the caller has to pick the sign — see the one-time orientation in roundTip. */
  const normalAt = (c, i) => {
    const a = c[Math.max(i - 1, 0)];
    const b = c[Math.min(i + 1, c.length - 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  };
  /** Add a round cap tangent to the end face at the start of the top edge; returns the new top edge (arc samples included). */
  const roundTip = (c, r) => {
    const x0 = c[0][0];
    const k = Math.min(10, c.length - 1);
    // Settle two things once, instead of guessing from the tangent's limit at the tip (the tangent
    // is vertical there, so the sign of its x component is meaningless):
    //   sgn  — which way the side wall extends (left tip +1, right tip -1); just see where the curve heads
    //   flip — whether the normal must be negated to point into the wall (the interior is always
    //          below the top edge, so take the one with y > 0)
    const sgn = Math.sign(c[k][0] - x0) || 1;
    const flip = normalAt(c, k)[1] < 0;
    const inw = (i) => {
      const n = normalAt(c, i);
      return flip ? [-n[0], -n[1]] : n;
    };
    const f = (i) => sgn * (c[i][0] + r * inw(i)[0] - x0 - sgn * r); // has the center's x reached x0 + sgn·r yet
    let i = 1;
    while (i < c.length - 2 && f(i) < 0) i++;
    if (f(i) < 0) return c; // this stretch is too short; skip the cap
    const w = f(i) - f(i - 1) ? -f(i - 1) / (f(i) - f(i - 1)) : 0; // interpolate the tangent point between i-1 and i
    const Q = [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * w, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * w];
    const nq = inw(i);
    const C = [Q[0] + r * nq[0], Q[1] + r * nq[1]];
    const a0 = sgn > 0 ? Math.PI : 0; // A: the circle's extreme point on the end-face side; its x is still exactly x0
    let d = Math.atan2(Q[1] - C[1], Q[0] - C[0]) - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const arc = [];
    for (let j = 0; j <= 8; j++) {
      const a = a0 + (d * j) / 8;
      arc.push([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)]);
    }
    return [...arc, ...c.slice(i)];
  };
  /** Join end-to-end segments into a closed path; rs[i] is the cap radius of the joint at the end of segment i, 0 = none. */
  const joinSegs = (segs, rs) => {
    const P = (q) => `${n(q[0])},${n(q[1])}`;
    const lens = segs.map(seglen);
    const r = rs.map((v, i) => Math.min(v, lens[i] / 2.2, lens[(i + 1) % segs.length] / 2.2));
    const cut = segs.map((sg, i) => trimArc(sg, r[(i - 1 + segs.length) % segs.length], r[i]));
    let d = `M${P(cut[0][0])}`;
    for (let i = 0; i < segs.length; i++) {
      d += 'L' + cut[i].slice(1).map(P).join('L');
      if (r[i] > 0.01) d += `Q${P(segs[i][segs[i].length - 1])} ${P(cut[(i + 1) % segs.length][0])}`;
      else d += `L${P(cut[(i + 1) % segs.length][0])}`;
    }
    return d + 'Z';
  };
  const slabBand = (list, freeHead, freeTail) => {
    const top = list.map((p) => [px(p[0], p[1]), py(p[0], p[1], -GAP)]);
    const bot = list.map((p) => [px(p[0], p[1]), py(p[0], p[1], -H)]);
    let upper = freeHead ? roundTip(top, TIP) : top;
    upper = freeTail ? roundTip(upper.slice().reverse(), TIP).reverse() : upper;
    const segs = [
      upper, //                                        top edge (both ends already capped)
      [upper[upper.length - 1], bot[bot.length - 1]], // tail end face
      bot.slice().reverse(), //                        bottom edge, tail → head
      [bot[0], upper[0]], //                           head end face
    ];
    /* Cap radii of the four joints, in the same order as segs:
         [0] top edge → tail end face    = tail tip           a free end is already closed by the
                                                              tangent arc; filleting again would bite into the edge
         [1] tail end face → bottom edge = tail lower corner  a genuine right angle, filleted as usual
         [2] bottom edge → head end face = head lower corner  same as [1]
         [3] head end face → top edge    = head tip           same as [0]
       [2] and [3] were once swapped, so the tip got backed off by FIL = 5px — that is exactly where
       "the boundary still moves inward" came from. */
    return joinSegs(segs, [freeTail ? 0 : FIL, FIL, FIL, freeHead ? 0 : FIL]);
  };

  const sq = (h) => [[-h, -h], [h, -h], [h, h], [-h, h]];

  /* Opening of the igeta grooves: the four strokes (two vertical, two horizontal) and the center cell
     merge into one connected polygon with twenty-eight corners. Only a quarter is written out; the
     rest is generated by rotating 90° about the origin — so four-fold symmetry is guaranteed rather
     than left to eyeballed alignment. */
  const rot90 = ([x, y]) => [-y, x];
  const U = [];
  {
    let q = [[E, BO], [BO, BO], [BO, E], [A, E], [A, BO], [-A, BO], [-A, E]];
    for (let k = 0; k < 4; k++, q = q.map(rot90)) U.push(...q);
  }
  const PIT = sq(A);

  /* Smoke: offset the centerline by half the width to each side, then join into a closed Catmull-Rom curve. */
  const bez = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return [0, 1].map((i) => u ** 3 * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t ** 3 * p3[i]);
  };
  const spineAt = (t) => {
    const segs = (spine.length - 1) / 3;
    const s = Math.min(Math.floor(t * segs), segs - 1);
    return bez(spine[s * 3], spine[s * 3 + 1], spine[s * 3 + 2], spine[s * 3 + 3], t * segs - s);
  };
  // Zero at both ends, peaking at about 40% (it swells faster at the start than it tapers at the
  // end, which is what makes it read as rising)
  const width = (t) => WMAX * Math.sin(Math.PI * t ** 0.75) ** 1.1;
  const smoothClosed = (pts) => {
    const m = pts.length;
    const at = (i) => pts[(i + m) % m];
    let d = `M${n(at(0)[0])},${n(at(0)[1])}`;
    for (let i = 0; i < m; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${n(c1[0])},${n(c1[1])} ${n(c2[0])},${n(c2[1])} ${n(p2[0])},${n(p2[1])}`;
    }
    return d + 'Z';
  };
  const smoke = (N = 46) => {
    const L = [], Rt = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = spineAt(t);
      const [qx, qy] = spineAt(Math.min(t + 1e-3, 1));
      const [rx, ry] = spineAt(Math.max(t - 1e-3, 0));
      const len = Math.hypot(qx - rx, qy - ry) || 1;
      const nx = -(qy - ry) / len, ny = (qx - rx) / len;
      const w = width(t) / 2;
      Rt.push([CX + SCALE * (p[0] + nx * w), CY + SCALE * (p[1] + ny * w)]);
      L.push([CX + SCALE * (p[0] - nx * w), CY + SCALE * (p[1] - ny * w)]);
    }
    // Both ends have zero width, so the two sides coincide there; dropping the duplicate points is
    // what yields a true point
    return smoothClosed([...Rt.slice(1, -1), ...L.reverse().slice(0, -1)]);
  };

  // Round the four outlines in the plane first; all projections, side walls and occlusion below derive from these polylines
  const slabRing = roundPlan(sq(R), RS);
  const floorRing = roundPlan(sq(F), rf);
  const openRing = roundPlan(U, RG);
  const pitRing = roundPlan(PIT, RG);
  const openD = face(openRing); //        igeta opening (z = 0)
  const pitD = face(pitRing, -D1); //     hearth pit mouth (z = -D1)


  // Same canvas as irori.svg: 1024 square with coordinates still in 512 (scaled by viewBox), so render.mjs captures it full-frame
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512" role="img" aria-label="囲炉裏">
  <defs>
    <clipPath id="open"><path d="${openD}"/></clipPath>
    <clipPath id="pit"><path d="${pitD}"/></clipPath>
  </defs>
${BG ? `\n  <rect id="bg" width="512" height="512" fill="#F4F0E6"/>\n` : ''}
  <!-- Slab: top face and side walls share one black; depth comes entirely from the gaps. The side
       walls drop by GAP as a whole, opening a gap between top face and sides; they are also cut at
       the nearest edge and backed off GAP/2 on each side (measured in x-y, not arc length; see
       trimDelta), adding a vertical seam at the near corner. On straight edges both gaps are equally
       wide: GAP·cos30.

       The drop is deliberately constant, i.e. the gap's **vertical distance** is the same everywhere.
       Two alternatives were tried. Compensating along the tangent to keep the width perpendicular to
       the gap constant makes the compensation diverge around the left and right tips. Tapering it
       to zero at the tips instead makes the side wall's top edge merge with the top-face outline:
       the gap gets welded shut at the tips, which looks worse than an uneven width.
       The only cost of a constant drop is that a short stretch of gap at the near corner is 15%
       wider (the edge turns horizontal there); in exchange the gap wraps around both tips at a
       constant height and ends cleanly. -->
  ${wallRuns(slabRing, true, true).map((r) => `<path d="${slabBand(runPts(slabRing, r, true), !r.head, !r.tail)}" fill="${INK}"/>`).join('\n  ')}
  <path d="${face(slabRing)}" fill="${INK}"/>
  <path d="${face(floorRing)}" fill="${floorFill}"/>

  <!-- Igeta grooves: inside the opening, first fill the groove floor in one piece (the opening sunk
       by D1), then paint the camera-facing inner walls over it up to the top edge. The band the
       floor leaves uncovered is exactly the inner wall, so nothing extra has to be computed. The
       hearth is another pit in the groove floor, done the same way again. Both depth levels can only
       be seen through the opening, so no per-face sorting is needed: the clipping itself is the
       occlusion, and it follows along when the corner radii change. -->
  <g clip-path="url(#open)">
    <path d="${face(openRing, -D1)}" fill="${GROOVE}"/>
    ${wallRuns(openRing, false).map((r) => `<path d="${band(runPts(openRing, r), 0, D1)}" fill="${GWALL}"/>`).join('\n    ')}
    <g clip-path="url(#pit)">
      <path d="${face(pitRing, -D1 - D2)}" fill="${pitFill}"/>
      ${wallRuns(pitRing, false).map((r) => `<path d="${band(runPts(pitRing, r), -D1, D2)}" fill="${pitWall}"/>`).join('\n      ')}
    </g>
  </g>

  <!-- Smoke is drawn last: it rises from the hearth's center and is closer to the camera than the
       rim's farthest corner, so it rightly covers that corner -->
  <path d="${smoke()}" fill="${smokeFill}"/>
</svg>
`;
}

/* Rounded version: slab outline 16 (the inner radius automatically becomes 16 - B = 4, so the rim
   keeps its width at the corners), igeta and hearth 3. Any larger and the igeta stroke ends start
   to bulge and the four-stroke structure blurs. */
export const ROUND = { RS: 16, RG: 3 };

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.join(here, 'out');
  fs.mkdirSync(out, { recursive: true });
  for (const [file, opts] of [['hearth.svg', {}], ['hearth-round.svg', ROUND]]) {
    fs.writeFileSync(path.join(out, file), build(opts));
    console.log('› out/' + file);
  }
}
