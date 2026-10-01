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

import { EditorView, RectangleMarker, ViewPlugin, keymap, layer } from '@codemirror/view';
import type { LayerMarker, PluginValue, ViewUpdate } from '@codemirror/view';
import { EditorSelection, Prec } from '@codemirror/state';
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
    // Before CodeMirror redraws, its DOM still shows the previous document: mapping an element to
    // a line then is only right if the document did not change. When it did, the redraw follows and
    // docViewUpdate writes the offsets.
    if (!u.docChanged) this.apply();
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
        const b = blockAt(state, state.doc.lineAt(Math.min(view.posAtDOM(el), state.doc.length)).number);
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

/* ---------- Home / End ----------
   CodeMirror's Home and End stop at the edge of what shows first (they look for wrap points by
   probing the editor's edges) — in a pane scrolled sideways that is the middle of the line. A code
   line never wraps, so here they go to its true ends: End to the end, Home to the end of the
   indentation and then to the start. Outside code (any range not in a code block) CodeMirror's own run. */

function lineEnds(forward: boolean, extend: boolean) {
  return (view: EditorView): boolean => {
    const state = view.state;
    const doc = state.doc;
    if (!state.selection.ranges.every((r) => blockAt(state, doc.lineAt(r.head).number))) return false;
    const sel = EditorSelection.create(
      state.selection.ranges.map((r) => {
        const line = doc.lineAt(r.head);
        let to = line.to;
        if (!forward) {
          const space = /^\s*/.exec(line.text)![0].length;
          to = space && r.head !== line.from + space ? line.from + space : line.from;
        }
        return extend ? EditorSelection.range(r.anchor, to) : EditorSelection.cursor(to);
      }),
      state.selection.mainIndex,
    );
    view.dispatch({ selection: sel, scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}

const keys = Prec.high(
  keymap.of([
    { key: 'Home', run: lineEnds(false, false), shift: lineEnds(false, true), preventDefault: true },
    { key: 'End', run: lineEnds(true, false), shift: lineEnds(true, true), preventDefault: true },
    { mac: 'Mod-ArrowLeft', run: lineEnds(false, false), shift: lineEnds(false, true) },
    { mac: 'Mod-ArrowRight', run: lineEnds(true, false), shift: lineEnds(true, true) },
  ]),
);

/* ---------- dragging a selection in a pane ----------
   CodeMirror reads the position under the mouse. Past a pane's edge that is the margin, where it
   finds a character in the hidden part of the line (or none), so the selection leapt out of sight.
   Here, over a pane, the pointer is held to the pane's edges — what you select is what you see —
   and held past an edge, the pane scrolls on its own, faster the further out, carrying the
   selection with it (CodeMirror asks again after every scroll: update() returns true). */

const mouse = EditorView.mouseSelectionStyle.of((view, start) => {
  if (start.button !== 0 || start.detail > 1 || start.altKey || start.metaKey || start.ctrlKey) return null;
  const cs = view.plugin(codeScrollPlugin);
  const row = (start.target as HTMLElement | null)?.closest?.('.cm-line.cb') as HTMLElement | null;
  if (!cs || !row) return null;
  const startBlock = blockAt(view.state, view.state.doc.lineAt(view.posAtDOM(row)).number);
  if (!startBlock || !maxOffset(view.state, startBlock, cs.width)) return null;

  /** the pane the pointer is over, vertically, and its edges on screen */
  const paneAt = (y: number) => {
    const state = view.state;
    const blk = view.lineBlockAtHeight(y - view.documentTop);
    const b = blockAt(state, state.doc.lineAt(blk.from).number);
    if (!b || !maxOffset(state, b, cs.width)) return null;
    const box = view.contentDOM.getBoundingClientRect();
    return { b, left: box.left, right: box.left + cs.width };
  };
  const posAt = (e: MouseEvent) => {
    const p = paneAt(e.clientY);
    // inside the padding, so the head is never where following the caret would move the pane
    const x = p ? Math.max(p.left + PAD, Math.min(p.right - PAD, e.clientX)) : e.clientX;
    return view.posAtCoords({ x, y: e.clientY }, false);
  };

  let anchor = start.shiftKey ? view.state.selection.main.anchor : posAt(start);
  let last = start;
  let frame = 0;
  // CodeMirror may still ask for the selection once after the button is up: never scroll after that
  let done = false;
  const stop = () => {
    done = true;
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const step = () => {
    frame = 0;
    if (done) return;
    const p = paneAt(last.clientY);
    if (!p) return;
    const lo = p.left + PAD;
    const hi = p.right - PAD;
    const over = last.clientX < lo ? last.clientX - lo : last.clientX > hi ? last.clientX - hi : 0;
    if (!over) return;
    const speed = Math.sign(over) * Math.min(48, 2 + Math.abs(over) * 0.35);
    cs.scrollTo(p.b, cs.offsetOf(view.state, p.b) + speed);
    frame = requestAnimationFrame(step);
  };
  window.addEventListener('mouseup', stop, { once: true });

  return {
    get(cur) {
      last = cur;
      if (!frame && !done) frame = requestAnimationFrame(step);
      return EditorSelection.single(anchor, posAt(cur));
    },
    update(u) {
      if (u.docChanged) anchor = u.changes.mapPos(anchor);
      // the pane scrolled under a mouse that held still: ask again
      return u.transactions.some((t) => t.effects.some((e) => e.is(codeScrolled) && e.value));
    },
  };
});

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

/** Not drawn: clips CodeMirror's selection layer out of every pane that scrolls (selectionLayer below
    draws the selection there instead), and its caret layer at the panes' edges, so nothing hidden
    shows in the margin. */
class ClipMarker implements LayerMarker {
  constructor(
    readonly scroller: HTMLElement,
    readonly sel: string,
    readonly cur: string,
  ) {}
  eq(o: ClipMarker) {
    return o.sel === this.sel && o.cur === this.cur && o.scroller === this.scroller;
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
    const clip = (holes: string) =>
      holes ? `path(evenodd, "M-1000000 -1000000H1000000V100000000H-1000000Z${holes}")` : '';
    const sel = this.scroller.querySelector<HTMLElement>(':scope > .cm-selectionLayer');
    const cur = this.scroller.querySelector<HTMLElement>(':scope > .cm-cursorLayer');
    if (sel) sel.style.clipPath = clip(this.sel);
    if (cur) cur.style.clipPath = clip(this.cur);
  }
}

/** A pane on screen that scrolls, in layer coordinates (the scroller's content box, like
    CodeMirror's own layers). */
type Pane = { b: Block; at: number; max: number; off: number; top: number; height: number };
type Panes = { left: number; width: number; panes: Pane[]; toLayer: (clientX: number) => number; top0: number };

function panesOf(view: EditorView, cs: CodeScroll): Panes {
  const state = view.state;
  const doc = state.doc;
  const scroller = view.scrollDOM;
  const rect = scroller.getBoundingClientRect();
  const toLayer = (x: number) => x - rect.left + scroller.scrollLeft;
  const left = toLayer(view.contentDOM.getBoundingClientRect().left);
  const top0 = view.documentTop - rect.top + scroller.scrollTop;
  const width = cs.width;
  const first = doc.lineAt(view.viewport.from).number;
  const last = doc.lineAt(view.viewport.to).number;
  const panes: Pane[] = [];
  for (const b of codeBlocks(state)) {
    if (b.to < first) continue;
    if (b.from > last) break;
    const max = maxOffset(state, b, width);
    if (!max) continue;
    const at = keyOf(state, b);
    const top = top0 + view.lineBlockAt(at).top;
    const height = top0 + view.lineBlockAt(doc.line(b.to).from).bottom - top;
    panes.push({ b, at, max, off: Math.min(max, cs.offs.get(at) ?? 0), top, height });
  }
  return { left, width, panes, toLayer, top0 };
}

function markers(view: EditorView): LayerMarker[] {
  const cs = view.plugin(codeScrollPlugin);
  const scroller = view.scrollDOM;
  if (!cs) return [new ClipMarker(scroller, '', '')];
  const state = view.state;
  const doc = state.doc;
  const out: LayerMarker[] = [];
  let band = '';
  let sides = '';
  const { left, width, panes } = panesOf(view, cs);
  const hover = hoveredLine(state);
  const hoverNo = hover == null ? -1 : doc.lineAt(hover).number;
  for (const { b, at, max, off, top, height } of panes) {
    const l = off > 0;
    const r = off < max;
    const track = width - 2 * PAD;
    const thumbW = Math.max(24, Math.round((track * track) / (track + max)));
    const thumbX = Math.round(((track - thumbW) * off) / max);
    const hot = cs.isHot(at) || (hoverNo >= b.from && hoverNo <= b.to);
    out.push(new SlitMarker(at, left, top, width, height, l, r, hot, thumbX, thumbW));
    band += `M-1000000 ${top}H1000000V${top + height}H-1000000Z`;
    if (l) sides += `M-1000000 ${top}H${left}V${top + height}H-1000000Z`;
    if (r) sides += `M${left + width} ${top}H1000000V${top + height}H${left + width}Z`;
  }
  return [new ClipMarker(scroller, band, sides), ...out];
}

/* ---------- the selection inside a pane that scrolls ----------
   CodeMirror finds where a line starts and ends on screen by probing the editor's left and right
   edges — right for wrapped text, wrong for a line scrolled sideways: it takes the part that shows
   for the whole line, so a selection there is drawn only over what was visible. Here each line is
   simply a row: the part of every range on it, from its start (or the row's left edge, if it began
   on an earlier line) to its end (or the right edge, if it runs on), cut to the pane. */

function selectionMarkers(view: EditorView): LayerMarker[] {
  const cs = view.plugin(codeScrollPlugin);
  const sel = view.state.selection;
  if (!cs || sel.ranges.every((r) => r.empty)) return [];
  const doc = view.state.doc;
  const { left, width, panes, toLayer, top0 } = panesOf(view, cs);
  const right = left + width;
  const out: LayerMarker[] = [];
  const first = doc.lineAt(view.viewport.from).number;
  const last = doc.lineAt(view.viewport.to).number;
  for (const { b, off } of panes) {
    for (let n = Math.max(b.from, first); n <= Math.min(b.to, last); n++) {
      const line = doc.line(n);
      let row: { top: number; height: number } | null = null;
      for (const r of sel.ranges) {
        if (r.empty || r.to < line.from || r.from > line.to) continue;
        if (r.to === line.from && r.from < line.from) continue; // ends where this row begins
        const xAt = (pos: number) => {
          const c = view.coordsAtPos(pos, 1);
          return c ? toLayer(c.left) : left + PAD + textWidth(line.text.slice(0, pos - line.from)) - off;
        };
        const x0 = Math.max(left, r.from <= line.from ? left : xAt(r.from));
        const x1 = Math.min(right, r.to > line.to ? right : xAt(r.to));
        if (x1 - x0 < 0.5) continue;
        row ??= (() => {
          const blk = view.lineBlockAt(line.from);
          return { top: top0 + blk.top, height: blk.height };
        })();
        out.push(new RectangleMarker('cm-selectionBackground', x0, row.top, x1 - x0, row.height));
      }
    }
  }
  return out;
}

const selectionLayer = layer({
  above: false,
  class: 'cm-codeSelection',
  markers: selectionMarkers,
  update: (u) =>
    u.docChanged ||
    u.selectionSet ||
    u.viewportChanged ||
    u.geometryChanged ||
    u.transactions.some((t) => t.effects.some((e) => e.is(codeScrolled))),
});

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

export const codeScroll: Extension = [codeScrollPlugin, wheel, mouse, keys, slits, selectionLayer];

/** Scroll the code block line `n` (1-based) is in to `x` (clamped) — for the smoke probe. */
export function scrollCodeBlock(view: EditorView, n: number, x: number): boolean {
  const b = blockAt(view.state, n);
  const cs = view.plugin(codeScrollPlugin);
  return !!b && !!cs && cs.scrollTo(b, x);
}
