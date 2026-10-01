/* Code blocks do not wrap. A long line runs on, and the whole block scrolls sideways as one
   pane — every line of it, fences included, shares one offset.

   How:
   - each code line is its own `overflow:hidden` box (style.css) and is scrolled with
     `scrollLeft`, so tab stops stay where the browser puts them. A wide invisible ::after
     keeps every line scrollable to any offset, however short it is.
   - the offsets live here, keyed by where the block starts, and are written to the line
     elements after every redraw (CodeMirror creates and replaces them freely).
   - the text disappears under the block's edge; on each side that hides something the edge
     shows as a slit (a hairline a shade darker, with a soft shadow on the text side). Those
     and a thin scrollbar are drawn on a layer above the text. The selection and caret
     layers are clipped at the edges too, so nothing hidden is drawn in the margin.
   - wheel / trackpad / ⇧-wheel over a block scrolls it; the main caret is kept in view.

   Widths are measured on a canvas in the code font (not from the DOM), so following the
   caret costs no layout. Syntax colours change colour only, never weight or slant
   (highlight.ts), so that is exact. */

import { EditorView, ViewPlugin, layer } from '@codemirror/view';
import type { LayerMarker, PluginValue, ViewUpdate } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { codeBlocks, codeScrolled, hoveredLine } from './decorations';

/** a code line's padding on either side: style.css */
const PAD = 14;
/** the code font, as in style.css (.ln.cb) */
const FONT = '15px ui-monospace, Menlo, monospace';
/** how long the scrollbar stays after a scroll */
const HOT_MS = 900;

type Block = { from: number; to: number; closed: boolean };

/* ---------- text width ---------- */

let ctx: CanvasRenderingContext2D | null = null;
const widths = new Map<string, number>();

function textWidth(s: string): number {
  if (!s) return 0;
  const hit = widths.get(s);
  if (hit != null) return hit;
  if (!ctx) {
    ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return 0;
    ctx.font = FONT;
  }
  const tab = ctx.measureText(' ').width * 4; // tab-size:4
  let w = 0;
  s.split('\t').forEach((part, i) => {
    if (i) w = (Math.floor(w / tab + 1e-6) + 1) * tab;
    w += ctx!.measureText(part).width;
  });
  if (widths.size > 20000) widths.clear();
  widths.set(s, w);
  return w;
}

/* ---------- blocks ---------- */

/** The code block line `n` (1-based) is in, if any. */
function blockAt(state: EditorState, n: number): Block | null {
  const all = codeBlocks(state);
  let lo = 0;
  let hi = all.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = all[mid];
    if (n < b.from) hi = mid - 1;
    else if (n > b.to) lo = mid + 1;
    else return b;
  }
  return null;
}

const keyOf = (state: EditorState, b: Block) => state.doc.line(b.from).from;

/** How far a block can scroll: its widest line minus what shows. */
function maxOffset(state: EditorState, b: Block, width: number): number {
  let w = 0;
  for (let n = b.from; n <= b.to; n++) w = Math.max(w, textWidth(state.doc.line(n).text));
  return Math.max(0, Math.ceil(w - (width - 2 * PAD)));
}

/* ---------- the plugin: offsets, and writing them to the lines ---------- */

class CodeScroll implements PluginValue {
  /** block start → offset (px); a block at 0 has no entry */
  offs = new Map<number, number>();
  /** block start → until when its scrollbar shows */
  hot = new Map<number, number>();
  /** the block whose scrollbar thumb is being dragged */
  dragging: number | null = null;
  /** the content box width — the width of every code line */
  width: number;
  /** what each line element was last scrolled to */
  private applied = new WeakMap<HTMLElement, number>();
  private touched = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private onScroll = (e: Event) => {
    // the browser may scroll a line on its own (revealing the native selection): put it back
    const el = e.target as HTMLElement;
    if (!el.classList?.contains('cb')) return;
    const want = this.applied.get(el) ?? 0;
    if (Math.abs(el.scrollLeft - want) > 0.5) el.scrollLeft = want;
  };

  constructor(readonly view: EditorView) {
    this.width = view.contentDOM.clientWidth || 652;
    view.contentDOM.addEventListener('scroll', this.onScroll, true);
  }

  destroy() {
    this.view.contentDOM.removeEventListener('scroll', this.onScroll, true);
    clearTimeout(this.timer);
  }

  offsetOf(state: EditorState, b: Block): number {
    return this.offs.get(keyOf(state, b)) ?? 0;
  }

  update(u: ViewUpdate) {
    const state = u.state;
    if (u.docChanged && this.offs.size) {
      const next = new Map<number, number>();
      const starts = new Set(codeBlocks(state).map((b) => keyOf(state, b)));
      for (const [k, x] of this.offs) {
        const at = u.changes.mapPos(k, -1);
        if (starts.has(at)) next.set(at, x);
      }
      this.offs = next;
      this.clampAll(state);
    }
    let follow = u.docChanged || u.selectionSet;
    for (const tr of u.transactions)
      for (const e of tr.effects) {
        if (!e.is(codeScrolled) || !e.value) continue;
        follow = u.docChanged; // a scroll alone moves the pane, not the caret
        const { at, x } = e.value;
        if (x > 0) this.offs.set(at, x);
        else this.offs.delete(at);
        this.hot.set(at, Date.now() + HOT_MS);
        this.coolLater();
      }
    if (follow) this.follow(state);
    if (u.geometryChanged)
      u.view.requestMeasure({
        key: this,
        read: (v) => v.contentDOM.clientWidth,
        write: (w) => {
          if (!w || w === this.width) return;
          this.width = w;
          this.clampAll(this.view.state);
          this.apply();
        },
      });
    this.apply();
  }

  docViewUpdate() {
    this.apply();
  }

  /** keep the main caret inside the pane it is in */
  private follow(state: EditorState) {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const b = blockAt(state, line.number);
    if (!b) return;
    const key = keyOf(state, b);
    const x = textWidth(line.text.slice(0, head - line.from));
    const shown = this.width - 2 * PAD;
    let off = this.offs.get(key) ?? 0;
    if (x < off) off = x;
    else if (x > off + shown) off = Math.min(Math.ceil(x - shown), maxOffset(state, b, this.width));
    off = Math.max(0, Math.round(off));
    if (off) this.offs.set(key, off);
    else this.offs.delete(key);
  }

  private clampAll(state: EditorState) {
    for (const [k, x] of this.offs) {
      const b = blockAt(state, state.doc.lineAt(k).number);
      const max = b ? maxOffset(state, b, this.width) : 0;
      if (x > max) {
        if (max) this.offs.set(k, max);
        else this.offs.delete(k);
      }
    }
  }

  /** write the offsets to the code lines on screen */
  apply() {
    if (!this.offs.size && !this.touched) return;
    const { view } = this;
    const state = view.state;
    for (const el of view.contentDOM.querySelectorAll<HTMLElement>(':scope > .cm-line.cb')) {
      let want = 0;
      if (this.offs.size) {
        const b = blockAt(state, state.doc.lineAt(view.posAtDOM(el)).number);
        if (b) want = this.offs.get(keyOf(state, b)) ?? 0;
      }
      // (a new line element starts at 0; one the browser scrolled itself is put back by onScroll)
      if ((this.applied.get(el) ?? 0) === want) continue;
      el.scrollLeft = want;
      this.applied.set(el, want);
    }
    this.touched = this.offs.size > 0;
  }

  /** scroll a block to `x` (clamped); a transaction carries it, so the caret and selection redraw */
  scrollTo(b: Block, x: number) {
    const state = this.view.state;
    const at = keyOf(state, b);
    const max = maxOffset(state, b, this.width);
    const to = Math.max(0, Math.min(max, Math.round(x)));
    if (to === (this.offs.get(at) ?? 0)) return false;
    this.view.dispatch({ selection: state.selection, effects: codeScrolled.of({ at, x: to }) });
    return true;
  }

  isHot(at: number) {
    return this.dragging === at || (this.hot.get(at) ?? 0) > Date.now();
  }

  /** take the scrollbar away once it has been still for a while */
  private coolLater() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const now = Date.now();
      for (const [k, t] of this.hot) if (t <= now) this.hot.delete(k);
      this.view.dispatch({ effects: codeScrolled.of(null) });
      if (this.hot.size) this.coolLater();
    }, HOT_MS + 20);
  }
}

const codeScrollPlugin = ViewPlugin.fromClass(CodeScroll);

/* ---------- input: wheel, trackpad, ⇧-wheel ---------- */

const wheel = Prec.high(
  EditorView.domEventHandlers({
    wheel(e, view) {
      const ax = Math.abs(e.deltaX);
      const ay = Math.abs(e.deltaY);
      // macOS already turns ⇧-wheel into a horizontal delta; elsewhere it stays vertical
      let d = ax > ay ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!d) return false;
      const row = (e.target as HTMLElement | null)?.closest?.('.cm-line.cb') as HTMLElement | null;
      const cs = view.plugin(codeScrollPlugin);
      if (!row || !cs) return false;
      const state = view.state;
      const b = blockAt(state, state.doc.lineAt(view.posAtDOM(row)).number);
      if (!b || !maxOffset(state, b, cs.width)) return false;
      if (e.deltaMode === 1) d *= 16;
      else if (e.deltaMode === 2) d *= cs.width;
      e.preventDefault();
      cs.scrollTo(b, cs.offsetOf(state, b) + d);
      return true;
    },
  }),
);

/* ---------- the slit layer: slits, their shadows, the scrollbar; clipping the other layers ---------- */

class SlitMarker implements LayerMarker {
  constructor(
    readonly at: number,
    readonly left: number,
    readonly top: number,
    readonly width: number,
    readonly height: number,
    /** something is hidden on that side */
    readonly l: boolean,
    readonly r: boolean,
    readonly hot: boolean,
    /** the thumb, within the track */
    readonly thumbX: number,
    readonly thumbW: number,
  ) {}

  eq(o: SlitMarker) {
    return (
      o.at === this.at &&
      o.left === this.left &&
      o.top === this.top &&
      o.width === this.width &&
      o.height === this.height &&
      o.l === this.l &&
      o.r === this.r &&
      o.hot === this.hot &&
      o.thumbX === this.thumbX &&
      o.thumbW === this.thumbW
    );
  }

  draw() {
    const dom = document.createElement('div');
    dom.className = 'cbpane';
    this.shape(dom);
    this.state(dom);
    return dom;
  }

  update(dom: HTMLElement, old: LayerMarker) {
    if (!(old instanceof SlitMarker) || !dom.classList.contains('cbpane')) return false;
    this.state(dom);
    return true;
  }

  /** the slits (CSS draws them: style.css .cbslit) and the scrollbar */
  private shape(dom: HTMLElement) {
    const parts = ['cbslit cbslit-l', 'cbslit cbslit-r', 'cbbar'].map((c) => {
      const el = document.createElement('div');
      el.className = c;
      return el;
    });
    const thumb = document.createElement('div');
    thumb.className = 'cbthumb';
    parts[2].append(thumb);
    dom.replaceChildren(...parts);
  }

  /** what moves: position, which slits show, the thumb */
  private state(dom: HTMLElement) {
    dom.style.left = this.left + 'px';
    dom.style.top = this.top + 'px';
    dom.style.width = this.width + 'px';
    dom.style.height = this.height + 'px';
    dom.dataset.at = String(this.at);
    dom.classList.toggle('l', this.l);
    dom.classList.toggle('r', this.r);
    dom.classList.toggle('hot', this.hot);
    const thumb = dom.querySelector<HTMLElement>('.cbthumb')!;
    thumb.style.left = this.thumbX + 'px';
    thumb.style.width = this.thumbW + 'px';
  }
}

/** Not drawn: clips the selection and caret layers at the block's edges, so nothing hidden shows in the margin. */
class ClipMarker implements LayerMarker {
  constructor(
    readonly scroller: HTMLElement,
    readonly path: string,
  ) {}
  eq(o: ClipMarker) {
    return o.path === this.path && o.scroller === this.scroller;
  }
  draw() {
    const dom = document.createElement('div');
    dom.className = 'cbclip';
    this.apply();
    return dom;
  }
  update(dom: HTMLElement, old: LayerMarker) {
    if (!(old instanceof ClipMarker)) return false;
    this.apply();
    return dom.classList.contains('cbclip');
  }
  private apply() {
    const clip = this.path ? `path(evenodd, "M-1000000 -1000000H1000000V100000000H-1000000Z${this.path}")` : '';
    for (const el of this.scroller.querySelectorAll<HTMLElement>(':scope > .cm-selectionLayer, :scope > .cm-cursorLayer'))
      el.style.clipPath = clip;
  }
}

function markers(view: EditorView): LayerMarker[] {
  const cs = view.plugin(codeScrollPlugin);
  const scroller = view.scrollDOM;
  if (!cs) return [new ClipMarker(scroller, '')];
  const state = view.state;
  const doc = state.doc;
  const out: LayerMarker[] = [];
  let holes = '';
  const rect = scroller.getBoundingClientRect();
  const left = view.contentDOM.getBoundingClientRect().left - rect.left + scroller.scrollLeft;
  const top0 = view.documentTop - rect.top + scroller.scrollTop;
  const width = cs.width;
  const first = doc.lineAt(view.viewport.from).number;
  const last = doc.lineAt(view.viewport.to).number;
  const hover = hoveredLine(state);
  const hoverNo = hover == null ? -1 : doc.lineAt(hover).number;
  for (const b of codeBlocks(state)) {
    if (b.to < first) continue;
    if (b.from > last) break;
    const max = maxOffset(state, b, width);
    if (!max) continue;
    const at = keyOf(state, b);
    const off = Math.min(max, cs.offs.get(at) ?? 0);
    const top = top0 + view.lineBlockAt(at).top;
    const height = top0 + view.lineBlockAt(doc.line(b.to).from).bottom - top;
    const l = off > 0;
    const r = off < max;
    const track = width - 2 * PAD;
    const thumbW = Math.max(24, Math.round((track * track) / (track + max)));
    const thumbX = Math.round(((track - thumbW) * off) / max);
    const hot = cs.isHot(at) || (hoverNo >= b.from && hoverNo <= b.to);
    out.push(new SlitMarker(at, left, top, width, height, l, r, hot, thumbX, thumbW));
    if (l) holes += `M-1000000 ${top}H${left}V${top + height}H-1000000Z`;
    if (r) holes += `M${left + width} ${top}H1000000V${top + height}H${left + width}Z`;
  }
  return [new ClipMarker(scroller, holes), ...out];
}

const slits = layer({
  above: true,
  class: 'cm-codeSlits',
  markers,
  update: (u) =>
    u.docChanged ||
    u.selectionSet ||
    u.viewportChanged ||
    u.geometryChanged ||
    hoveredLine(u.startState) !== hoveredLine(u.state) ||
    u.transactions.some((t) => t.effects.some((e) => e.is(codeScrolled))),
  mount(dom, view) {
    // drag the thumb
    dom.addEventListener('mousedown', (e) => {
      const thumb = (e.target as HTMLElement).closest('.cbthumb');
      const pane = thumb?.closest<HTMLElement>('.cbpane');
      const cs = view.plugin(codeScrollPlugin);
      if (!thumb || !pane || !cs || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const at = Number(pane.dataset.at);
      const state = view.state;
      const b = blockAt(state, state.doc.lineAt(at).number);
      if (!b) return;
      const max = maxOffset(state, b, cs.width);
      const track = cs.width - 2 * PAD;
      const ratio = max / Math.max(1, track - (thumb as HTMLElement).offsetWidth);
      const x0 = e.clientX;
      const off0 = cs.offsetOf(state, b);
      cs.dragging = at;
      const move = (m: MouseEvent) => {
        const now = blockAt(view.state, view.state.doc.lineAt(Math.min(at, view.state.doc.length)).number);
        if (now) cs.scrollTo(now, off0 + (m.clientX - x0) * ratio);
      };
      const up = () => {
        cs.dragging = null;
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        view.dispatch({ effects: codeScrolled.of(null) });
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  },
});

export const codeScroll: Extension = [codeScrollPlugin, wheel, slits];

/** Scroll the code block line `n` (1-based) is in to `x` (clamped) — for the smoke probe. */
export function scrollCodeBlock(view: EditorView, n: number, x: number): boolean {
  const b = blockAt(view.state, n);
  const cs = view.plugin(codeScrollPlugin);
  return !!b && !!cs && cs.scrollTo(b, x);
}
