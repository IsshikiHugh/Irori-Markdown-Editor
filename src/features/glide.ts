/* Every "jump" scroll goes through here: TOC clicks, minimap clicks, and focus mode pulling
   the caret back into the band.

   Three requirements shape the curve:

   1. **Duration grows with the number of lines crossed**, instead of the fixed, distance-blind
      pace of the browser's `behavior:'smooth'`.
      Within a page: 1 line 250ms · 2 lines 350ms · 4 lines 450ms · capped at 500ms for a page.

   2. **The ending always looks the same.** The last 250ms always covers 1.2 lines on the same
      deceleration curve — i.e. the speed "t ms before the end" is identical for a 2-line and
      a 40-line jump. However far the jump, the eye can read, in that final stretch, which way
      it is going and the rhythm at which it comes to rest.

   3. **The start must be visible too.** Long jumps get a start phase mirroring the ending
      (250ms / 1.2 lines / quadratic ease-in); otherwise, once the middle speeds up, the whole
      thing looks like "teleported, then slowly settled".

   Hence:
       short (within a page): two phases — a cubic Hermite accelerating from rest + the fixed ending;
       long: three phases — fixed start + middle (cubic Hermite, speed at both ends equal to the
       join speed) + fixed ending.
   Speed is continuous at every join, so there is never a sudden brake.

   The target is re-resolved every frame: CodeMirror estimates line heights for regions it has
   not rendered and corrects them with measured values on the way there — with a fixed target,
   that correction would shove the animation to its end midway and it would still land wrong. */

import type { EditorView } from '@codemirror/view';

export const GLIDE_MIN = 250;
/** cap for jumps within a page (~10 lines) */
export const GLIDE_MAX = 500;
/** never longer than this — squeezing a very long jump into 500ms smears the text past the eye,
    which is anything but smooth */
export const GLIDE_MAX_FAR = 1400;
/** start phase: a fixed stretch mirroring the ending (only used for long jumps) */
export const HEAD_MS = 250;
/** duration of the ending: fixed, which is what keeps "the ease-out is always the same" true */
export const TAIL_MS = 250;
/** distance covered by the ending, in lines */
export const TAIL_LINES = 1.2;

export function glideDuration(lines: number): number {
  const l = Math.max(1, lines);
  // within a page: 1 line 250ms, 2 lines 350ms, 4 lines 450ms, capped at 500ms by 10 lines
  // (the pace the user chose — keep it as is)
  if (l <= 10) return Math.min(GLIDE_MAX, GLIDE_MIN + 100 * Math.log2(l));
  // farther: allow enough time for a visible start and ending at both ends
  // (otherwise the middle is a "teleport")
  return Math.min(GLIDE_MAX_FAR, GLIDE_MAX * Math.sqrt(l / 10));
}

export type GlideProfile = {
  /** total duration, ms */
  total: number;
  /** duration of the head, ms (may be 0: a short jump is only the ending) */
  headMs: number;
  /** distance covered by the ending, px */
  tailDistance: number;
  /** speed at the join, px/ms */
  joinSpeed: number;
  /** distance covered after t ms, px */
  at: (t: number) => number;
};

/** Pure function, so it can be tested directly: given a distance and line height, compute the
    whole motion curve.

    A long jump (when there is time for the fixed phases at both ends) has three phases:
        start 250ms / 1.2 lines (quadratic ease-in) → middle (cubic Hermite, speed at both ends
        equal to the join speed) → ending 250ms / 1.2 lines (quadratic ease-out)
    Start and ending are symmetric and independent of the distance, so the direction reads
    clearly at both ends; only the middle is the "fast" part.
    A short jump (within a page) has no room for three phases and falls back to the two-phase
    "accelerate from rest + fixed ending", with exactly the same pace as before. */
export function glideProfile(distance: number, lineHeight: number): GlideProfile {
  const S = Math.abs(distance);
  const total = glideDuration(S / lineHeight);
  const ramp = Math.min(TAIL_LINES * lineHeight, S / 2);

  if (total >= HEAD_MS + TAIL_MS + 60 && S > 2 * ramp + 1) {
    const midMs = total - HEAD_MS - TAIL_MS;
    const mid = S - 2 * ramp;
    const joinSpeed = (2 * ramp) / TAIL_MS;
    const m = (joinSpeed * midMs) / mid;
    const c3 = 2 * (m - 1);
    const c2 = 3 * (1 - m);
    const at = (t: number): number => {
      if (t <= 0) return 0;
      if (t >= total) return S;
      if (t < HEAD_MS) {
        const x = t / HEAD_MS;
        return ramp * x * x;
      }
      if (t < HEAD_MS + midMs) {
        const x = (t - HEAD_MS) / midMs;
        return ramp + mid * (c3 * x * x * x + c2 * x * x + m * x);
      }
      const x = (t - HEAD_MS - midMs) / TAIL_MS;
      return ramp + mid + ramp * (1 - (1 - x) * (1 - x));
    };
    return { total, headMs: HEAD_MS + midMs, tailDistance: ramp, joinSpeed, at };
  }

  const headMs = Math.max(0, total - TAIL_MS);
  let D = Math.min(S, TAIL_LINES * lineHeight);
  // The head must be monotonic (no moving backwards before going forwards). The cubic Hermite's
  // end-speed slope is m = v_join·headMs/H, and m > 3 backtracks — if that happens, shrink the
  // ending's distance.
  if (headMs > 0 && S - D > 0) {
    const m = ((2 * D) / TAIL_MS) * (headMs / (S - D));
    if (m > 3) D = (3 * TAIL_MS * S) / (2 * headMs + 3 * TAIL_MS);
  }
  const H = S - D;
  const joinSpeed = (2 * D) / TAIL_MS;
  const m = H > 0 ? (joinSpeed * headMs) / H : 0;
  const a = m - 2;
  const b = 3 - m;

  const at = (t: number): number => {
    if (t <= 0) return 0;
    if (t >= total) return S;
    if (t < headMs) {
      const x = t / headMs;
      return H * (a * x * x * x + b * x * x);
    }
    const x = (t - headMs) / TAIL_MS;
    return H + D * (1 - (1 - x) * (1 - x));
  };

  return { total, headMs, tailDistance: D, joinSpeed, at };
}

/** Actual data from the last glide — lets "the ending is constant" be asserted directly instead
    of guessed from samples. */
export type GlideRun = {
  from: number;
  to: number;
  total: number;
  headMs: number;
  tailMs: number;
  /** start and end of the ending (their difference is the distance the ending covered) */
  tailFrom: number;
  tailTo: number;
};

export type Glide = {
  by: (delta: number) => void;
  to: (scrollTop: number | (() => number)) => void;
  cancel: () => void;
  running: () => boolean;
  duration: (lines: number) => number;
  profile: (distance: number, lineHeight?: number) => GlideProfile;
  lastRun: () => GlideRun | null;
};

export function createGlide(view: EditorView): Glide {
  let frame = 0;
  let last: GlideRun | null = null;

  function cancel() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function to(target: number | (() => number), depth = 0) {
    const el = view.scrollDOM;
    cancel();
    const resolve = () => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      return Math.max(0, Math.min(max, typeof target === 'function' ? target() : target));
    };
    const from = el.scrollTop;
    const dist = resolve() - from;
    if (Math.abs(dist) < 1) return;
    const dir = Math.sign(dist);
    const p = glideProfile(dist, view.defaultLineHeight || 39);
    const headDist0 = Math.abs(dist) - p.tailDistance;
    const start = performance.now();
    let tailFrom: number | null = null;
    let tailGoal = 0;
    let tailStart = 0;
    last = { from, to: resolve(), total: p.total, headMs: p.headMs, tailMs: TAIL_MS, tailFrom: NaN, tailTo: NaN };

    const step = (now: number) => {
      const t = now - start;

      if (tailFrom === null && t >= p.headMs) {
        // Entering the ending: freeze the target and snap the position to "exactly D from the end".
        // The snap is a few dozen pixels at most and happens at the end of the fast phase, so it is
        // invisible; in exchange **the final 250ms always covers the same distance on the same
        // deceleration curve**, however far this jump went.
        tailGoal = resolve();
        tailFrom = tailGoal - dir * p.tailDistance;
        tailStart = now;
        el.scrollTop = tailFrom;
        if (last) {
          last.tailFrom = tailFrom;
          last.tailTo = tailGoal;
          last.to = tailGoal;
        }
      }

      if (tailFrom === null) {
        // head: follow the target (CodeMirror corrects its height estimates for unrendered
        // regions along the way), scaled proportionally
        const goal = resolve();
        const headNow = Math.max(0, Math.abs(goal - from) - p.tailDistance);
        const scale = headDist0 > 0 ? headNow / headDist0 : 0;
        el.scrollTop = from + dir * p.at(t) * scale;
        frame = requestAnimationFrame(step);
        return;
      }

      const x = Math.min(1, (now - tailStart) / TAIL_MS);
      el.scrollTop = tailFrom + (tailGoal - tailFrom) * (1 - (1 - x) * (1 - x));
      if (x >= 1) {
        cancel();
        // Re-check the landing: while scrolling, CodeMirror is still measuring unrendered regions
        // and the document's total height grows, so the target computed now may be farther than at
        // the start (most visible when jumping to the end — it shows up as "didn't scroll to the
        // bottom"). If it is off by much, glide again (that leg has the same fixed ending), at most
        // three rounds, so it never chases back and forth.
        const err = resolve() - el.scrollTop;
        if (Math.abs(err) > 2 && depth < 3) to(target, depth + 1);
        return;
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
  }

  return {
    by: (delta: number) => to(view.scrollDOM.scrollTop + delta),
    to,
    cancel,
    running: () => frame !== 0,
    lastRun: () => last,
    duration: glideDuration,
    profile: (distance: number, lineHeight = view.defaultLineHeight || 39) => glideProfile(distance, lineHeight),
  };
}
