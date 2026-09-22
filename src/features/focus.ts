/* Focus mode: everything outside the band fades away along a curve you can drag.

   Ported from the blog editor, including the quartic Bézier with three draggable
   interior control points, the caret clamping, and the padding trick that lets the very
   first and very last line reach the band. The only change is what it measures: the
   CodeMirror scroller instead of the window. */

import type { EditorView } from '@codemirror/view';
import type { Glide } from './glide';
import { glideDuration } from './glide';

export type FocusPrefs = { on: boolean; top: number; bottom: number; curve: { x: number; y: number }[] };

export type FocusEls = {
  seg: HTMLElement;
  range: HTMLElement;
  adjust: HTMLElement;
  topR: HTMLInputElement;
  botR: HTMLInputElement;
  fill: HTMLElement;
  fade: HTMLElement;
  svg: SVGSVGElement;
  path: SVGPathElement;
  poly: SVGPolylineElement;
  handles: SVGCircleElement[];
  reset: HTMLElement;
};

export const CURVE_DEFAULT = [
  { x: 0.08, y: 0.62 },
  { x: 0.26, y: 0.9 },
  { x: 0.55, y: 0.99 },
];
const GAP = 8;
/** the top padding of a page with no mode on — the value style.css gives `--pad-top` */
export const BASE_PAD_TOP = 44;

export function createFocus(
  view: EditorView,
  els: FocusEls,
  prefs: FocusPrefs,
  persist: (p: FocusPrefs) => void,
  glide: Glide,
  /** the focus band / padding changed: the caller must re-lay out the minimap, or it keeps
      drawing with the old padding */
  onBandChange: () => void = () => {},
  /** space typewriter mode needs above and below the text; padding has one writer, and this
      is it (see features/typewriter.ts) */
  padFloor: (height: number) => { top: number; bottom: number } = () => ({ top: 0, bottom: 0 }),
) {
  let curve = prefs.curve?.length === 3 ? prefs.curve.map((p) => ({ ...p })) : CURVE_DEFAULT.map((p) => ({ ...p }));
  els.topR.value = String(prefs.top);
  els.botR.value = String(prefs.bottom);

  const isOn = () => document.body.classList.contains('focusmode');
  const save = () =>
    persist({ on: isOn(), top: +els.topR.value, bottom: +els.botR.value, curve: curve.map((p) => ({ ...p })) });

  /* ---- bezier ---- */
  const ctrlPts = () => [{ x: 0, y: 0 }, ...curve, { x: 1, y: 1 }];
  function bezXY(pts: { x: number; y: number }[], t: number) {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    for (let k = pts.length - 1; k > 0; k--)
      for (let i = 0; i < k; i++) {
        xs[i] += (xs[i + 1] - xs[i]) * t;
        ys[i] += (ys[i + 1] - ys[i]) * t;
      }
    return { x: xs[0], y: ys[0] };
  }
  function fadeY(x: number) {
    const pts = ctrlPts();
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      if (bezXY(pts, m).x < x) lo = m;
      else hi = m;
    }
    return Math.min(1, Math.max(0, bezXY(pts, (lo + hi) / 2).y));
  }
  function buildGrad() {
    const ft = +els.topR.value;
    const fb = +els.botR.value;
    const N = 12;
    const s: string[] = [];
    for (let i = 0; i <= N; i++) s.push(`rgba(247,243,236,${fadeY(1 - i / N).toFixed(3)}) ${((ft * i) / N).toFixed(2)}%`);
    s.push(`rgba(247,243,236,0) ${ft.toFixed(2)}%`, `rgba(247,243,236,0) ${fb.toFixed(2)}%`);
    for (let i = 0; i <= N; i++)
      s.push(`rgba(247,243,236,${fadeY(i / N).toFixed(3)}) ${(fb + ((100 - fb) * i) / N).toFixed(2)}%`);
    els.fade.style.backgroundImage = 'linear-gradient(to bottom,' + s.join(',') + ')';
  }

  /* ---- band ---- */
  /* Top and bottom padding. The old editor always reserved 85vh at the bottom so the last line
     could scroll to the top — but that rule is wrong for short documents: an empty document could
     scroll 9px, three lines 93px, ten lines that fit on one screen 359px, and the minimap's box
     became draggable along with it. So now the scroll-past-the-end space is only added when the
     text does not fit on one screen; likewise in focus mode, text that fits entirely in the band
     needs no scrolling. Heights are only accurate once CodeMirror has measured, so this reads and
     writes inside its measure cycle. */
  let lastPads = '';
  function applyPads() {
    view.requestMeasure({
      key: 'irori-pads',
      read: () => ({
        h: view.scrollDOM.clientHeight,
        textH: Math.max(0, view.contentHeight - view.documentPadding.top - view.documentPadding.bottom),
      }),
      write: ({ h, textH }) => {
        const content = view.contentDOM;
        const floor = padFloor(h);
        let top = '';
        let bottom = '';
        if (isOn()) {
          const ftop = parseFloat(els.topR.value);
          const fbot = parseFloat(els.botR.value);
          const padTop = (ftop * h) / 100;
          const band = ((fbot - ftop) * h) / 100;
          top = Math.max(padTop, floor.top) + 'px';
          bottom = Math.max(floor.bottom, textH <= band ? Math.max(0, h - padTop - textH) : ((100 - ftop) * h) / 100) + 'px';
        } else if (floor.top || floor.bottom) {
          // typewriter mode alone: the anchor decides both margins
          top = floor.top + 'px';
          bottom = floor.bottom + 'px';
        } else {
          const padTop = parseFloat(getComputedStyle(content).getPropertyValue('--pad-top')) || BASE_PAD_TOP;
          // fits on one screen → no scroll-past-the-end space (the content box itself is
          // min-height:100%, so clicking the empty area still places the caret)
          bottom = padTop + textH <= h ? '0px' : '';
        }
        const key = top + '|' + bottom;
        if (key === lastPads) return;
        lastPads = key;
        content.style.paddingTop = top;
        content.style.paddingBottom = bottom;
        if (top) content.style.setProperty('--pad-top', top);
        else content.style.removeProperty('--pad-top');
        onBandChange();
      },
    });
  }
  /** What the top padding would be for a given floor — typewriter mode asks before it swaps its
      own padding away, so it can move the text there itself instead of letting the swap jump it. */
  function padTopFor(floorTop: number, h = view.scrollDOM.clientHeight) {
    if (isOn()) return Math.max((parseFloat(els.topR.value) * h) / 100, floorTop);
    return floorTop || BASE_PAD_TOP;
  }
  function bandPx() {
    const rect = view.scrollDOM.getBoundingClientRect();
    return {
      top: rect.top + (rect.height * parseFloat(els.topR.value)) / 100,
      bottom: rect.top + (rect.height * parseFloat(els.botR.value)) / 100,
    };
  }
  let pendingBand = 0;
  function keepCaretInBand() {
    if (!isOn()) return;
    // typewriter mode holds the caret at one height, and its anchor is already clamped into this
    // band — two followers would tug the same caret to two different places
    if (document.body.classList.contains('typewriter')) return;
    // If a glide is running, wait until it lands — but **never drop this request**:
    // when typing right after Enter, dropping the requests that arrive midway leaves the caret
    // outside the band for good.
    if (glide.running()) {
      if (!pendingBand) {
        const again = () => {
          if (glide.running()) {
            pendingBand = requestAnimationFrame(again);
            return;
          }
          pendingBand = 0;
          keepCaretInBand();
        };
        pendingBand = requestAnimationFrame(again);
      }
      return;
    }
    // The caret position is fixed at departure: if the caret moves again midway, pendingBand above
    // starts a new leg after landing, instead of this leg switching to chase the new caret halfway
    // (that would keep the edge chosen at departure and align to the wrong edge)
    const head = view.state.selection.main.head;
    const caret = () => {
      // must not go out of range if the text gets shorter midway (this is read every frame; one
      // exception and the glide gets stuck)
      const pos = Math.min(head, view.state.doc.length);
      // coordsAtPos returns null when the caret's line is not rendered (e.g. the caret was just
      // moved far away), so fall back to CodeMirror's height map — otherwise it would never be
      // brought back into the band in that case
      const block = view.lineBlockAt(pos);
      const fallback = { top: view.documentTop + block.top, bottom: view.documentTop + block.top + block.height };
      return view.coordsAtPos(pos) ?? fallback;
    };
    const c = caret();
    const band = bandPx();
    if (c.top >= band.top && c.bottom <= band.bottom) return;
    // The glide re-resolves the target every frame instead of fixing it from the coordinates at
    // departure: the heights of distant lines are only estimates right now and get measured on the
    // way — with a fixed target, the caret lands outside the band by however much the estimate was
    // off (tens of pixels on platforms with different fonts).
    // Which edge to align to is decided at departure and never changes midway, so the target does
    // not flip the moment the caret enters the band and tug back and forth.
    const below = c.bottom > band.bottom;
    const edge = () => {
      const now = caret();
      const b = bandPx();
      return below ? now.bottom - b.bottom : now.top - b.top;
    };
    // for the glide's speed curve and duration see features/glide.ts (ease in/out, scaled by
    // lines crossed)
    glide.to(() => view.scrollDOM.scrollTop + edge());
  }
  function apply() {
    const a = +els.topR.value;
    const b = +els.botR.value;
    document.body.style.setProperty('--ftop', a + '%');
    document.body.style.setProperty('--fbot', b + '%');
    els.fill.style.left = a + '%';
    els.fill.style.width = b - a + '%';
    applyPads();
    onBandChange();
    keepCaretInBand();
  }
  function setOn(on: boolean) {
    // anchor the caret's row so turning focus on does not move the text under the eye
    const head = view.state.selection.main.head;
    const before = view.coordsAtPos(head)?.top ?? null;
    document.body.classList.toggle('focusmode', on);
    if (on) els.range.classList.remove('open');
    [...els.seg.children].forEach((x) => x.classList.toggle('on', ((x as HTMLElement).dataset.on === '1') === on));
    applyPads();
    const after = view.coordsAtPos(head)?.top ?? null;
    if (before != null && after != null) {
      const dy = after - before;
      if (Math.abs(dy) > 0.5) view.scrollDOM.scrollTop += dy;
    }
    onBandChange();
    keepCaretInBand();
    save();
  }

  /* ---- curve editor ---- */
  const W = 240;
  const H = 96;
  const toX = (x: number) => x * W;
  const toY = (y: number) => H - y * H;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  function draw() {
    const pts = ctrlPts();
    let d = 'M0,' + H;
    for (let i = 1; i <= 48; i++) {
      const q = bezXY(pts, i / 48);
      d += ' L' + toX(q.x).toFixed(1) + ',' + toY(q.y).toFixed(1);
    }
    els.path.setAttribute('d', d);
    els.poly.setAttribute(
      'points',
      [[0, H], ...curve.map((c) => [toX(c.x), toY(c.y)]), [W, 0]].map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '),
    );
    els.handles.forEach((h, i) => {
      h.setAttribute('cx', String(toX(curve[i].x)));
      h.setAttribute('cy', String(toY(curve[i].y)));
    });
  }
  let drag = -1;
  const at = (e: MouseEvent) => {
    const r = els.svg.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp(1 - (e.clientY - r.top) / r.height) };
  };
  els.handles.forEach((h, i) =>
    h.addEventListener('mousedown', (e) => {
      e.preventDefault();
      drag = i;
    }),
  );
  document.addEventListener('mousemove', (e) => {
    if (drag < 0) return;
    curve[drag] = at(e);
    draw();
    buildGrad();
  });
  document.addEventListener('mouseup', () => {
    if (drag >= 0) {
      drag = -1;
      save();
    }
  });
  els.reset.onclick = () => {
    curve = CURVE_DEFAULT.map((p) => ({ ...p }));
    draw();
    buildGrad();
    save();
  };
  els.adjust.onclick = () => els.range.classList.toggle('open');
  els.seg.onclick = () => setOn(!isOn());
  els.topR.oninput = () => {
    if (+els.topR.value > +els.botR.value - GAP) els.topR.value = String(+els.botR.value - GAP);
    apply();
    buildGrad();
    save();
  };
  els.botR.oninput = () => {
    if (+els.botR.value < +els.topR.value + GAP) els.botR.value = String(+els.topR.value + GAP);
    apply();
    buildGrad();
    save();
  };

  draw();
  apply();
  buildGrad();
  if (prefs.on) setOn(true);

  return { apply, setOn, keepCaretInBand, isOn, bandPx, padTopFor, buildGrad, glideDuration, syncPads: applyPads };
}
