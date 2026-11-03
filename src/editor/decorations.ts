/* The CodeMirror side of source decoration.

   Two things happen here:

   1. every line CodeMirror actually renders (its viewport) gets its classes
      (h1…h6 / quote rail / morecomment) and its inline marks — which is what makes a
      100k-word document cost the same as a short one;
   2. an image line the caret is NOT on is replaced by a block widget showing the
      picture, and so is a table the caret is not in (all its lines, by a rendered
      table), and so is a math block (by the typeset formula). Where the caret is, the
      text always shows source — that invariant is the whole contract of this editor.
      Links and inline math follow the same rule inline: away from the caret a link
      shows only its text and a formula shows typeset.

   The two live in different places on purpose: decorations that change the block
   layout (lines replaced by a picture or a table) may only come from a state field,
   never from a view plugin — CodeMirror rejects them otherwise. The field is rebuilt
   only when the document changes or the caret moves to another line. */

import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import type { Extension, Range } from '@codemirror/state';
import {
  codeLineDeco,
  decorateLine,
  blockRanges,
  imageLine,
  isQuoteReset,
  leadHTML,
  linkParts,
  listRows,
  listScan,
  maybeListImage,
  mathLineDeco,
  quoteStep,
  QUOTE_START,
  tableHTML,
  tableSourceDeco,
  withListRow,
} from './tokens';
import type { ListRow, MathRange, QuoteState } from './tokens';
import { isOpenClick, openLink } from './links';
import { highlightBlock, onLanguageLoaded } from './highlight';
import { onMathLoaded, renderMath } from './math';

/** How an image's relative `src` becomes something the webview can load. */
export type AssetResolver = (src: string) => string | null;

let resolveAsset: AssetResolver = () => null;
export function setAssetResolver(fn: AssetResolver) {
  resolveAsset = fn;
}

/* ---------- a block takes its full room, drawn or not ---------- */

/* CodeMirror draws only the lines near the screen. For a block it has not drawn it takes the
   widget's estimatedHeight — and without one a picture, a table or a formula counted as one line
   of text, so the document grew by its height each time one scrolled into view: the scrollbar and
   the minimap jumped, and dragging the minimap fought a document that kept changing length.
   So every picture's size is learned as soon as the document is read, and every block's height is
   worked out from the same CSS the editor draws it with, in a hidden probe in the editor's column. */

type Size = { w: number; h: number };
/** natural size of each picture, by url */
const NAT = new Map<string, Size>();
const warming = new Set<string>();
/** urls that did not load: not asked for again on every rebuild */
const failed = new Set<string>();
const queue: string[] = [];
let loading = 0;
/** pictures read at once — a document may hold hundreds */
const MAX_LOADS = 4;

/** Tell the views that sizes (or the column they are laid out in) changed — batched, since a
    document's pictures arrive one after another. */
const sizedFns = new Set<() => void>();
let sizedTimer: ReturnType<typeof setTimeout> | null = null;
function sized() {
  sizedTimer ??= setTimeout(() => {
    sizedTimer = null;
    for (const fn of sizedFns) fn();
  }, 30);
}
/** Pictures got their sizes, or the column changed: the blocks were laid out again. */
export function onBlocksResized(fn: () => void): () => void {
  sizedFns.add(fn);
  return () => sizedFns.delete(fn);
}

function learn(url: string, w: number, h: number) {
  if (!w || !h || NAT.has(url)) return;
  NAT.set(url, { w, h });
  sized();
}

function sizeOf(src: string): Size | null {
  const url = src ? resolveAsset(src) : null;
  return (url && NAT.get(url)) || null;
}

/** Read a picture's size, without showing it. */
function warmSize(src: string) {
  const url = src ? resolveAsset(src) : null;
  if (!url || NAT.has(url) || warming.has(url) || failed.has(url)) return;
  warming.add(url);
  queue.push(url);
  pump();
}
function pump() {
  while (loading < MAX_LOADS && queue.length) {
    const url = queue.shift()!;
    loading++;
    const img = new Image();
    const done = () => {
      loading--;
      warming.delete(url);
      pump();
    };
    img.onload = () => {
      learn(url, img.naturalWidth, img.naturalHeight);
      done();
    };
    img.onerror = () => {
      failed.add(url);
      done();
    };
    img.src = url;
  }
}

/** the text column's width, as the editor lays it out (0 until the view has measured it) */
let column = 0;
/** the font the rows are set in — a change alters the line box around a picture */
let columnFont = '';
/** bumped when the column or its font changes: every block's height must be worked out again */
let layoutEpoch = 0;
/** a hidden box in the editor's column, to measure rows with the editor's classes in */
let probe: HTMLElement | null = null;
/** per kind of row (plain / in a quote / in a list): height with an empty picture, what a row adds
    to the picture's height, and the width a picture may take */
const rowKinds = new Map<string, { min: number; extra: number; avail: number }>();

function rowKind(railed: boolean, lead: string, style: string) {
  const key = `${railed ? 1 : 0}|${style}|${lead}`;
  const hit = rowKinds.get(key);
  if (hit || !probe || !column) return hit ?? null;
  probe.style.width = column + 'px';
  const row = document.createElement('div');
  row.className = 'ln imgrow' + (railed ? ' quote' : '') + (lead ? ' li' : '');
  if (style) row.setAttribute('style', style);
  if (lead) row.innerHTML = lead;
  const wrap = document.createElement('span');
  wrap.className = 'imgwrap';
  const pic = document.createElement('span');
  pic.style.cssText = 'display:block;width:1px;height:0';
  wrap.appendChild(pic);
  row.appendChild(wrap);
  probe.appendChild(row);
  const min = row.getBoundingClientRect().height;
  pic.style.height = '1000px';
  const extra = row.getBoundingClientRect().height - 1000;
  const cs = getComputedStyle(row);
  const avail = row.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  row.remove();
  const kind = { min, extra, avail };
  rowKinds.set(key, kind);
  return kind;
}

/** heights of tables and formulas as drawn, by their class and content */
const blockHeights = new Map<string, number>();
const BLOCK_HEIGHTS_MAX = 2000;

/** The height of a row with class `cls` holding `html`, laid out in the editor's column (-1 before
    the view has measured the column). */
function blockHeight(cls: string, html: string): number {
  if (!probe || !column) return -1;
  const key = cls + '\n' + html;
  const hit = blockHeights.get(key);
  if (hit != null) return hit;
  probe.style.width = column + 'px';
  const row = document.createElement('div');
  row.className = cls;
  row.innerHTML = html;
  probe.appendChild(row);
  const h = row.getBoundingClientRect().height;
  row.remove();
  if (blockHeights.size >= BLOCK_HEIGHTS_MAX) blockHeights.clear();
  blockHeights.set(key, h);
  return h;
}

/** Keeps `column` and the probe up to date for one view. */
const blockGeometry = ViewPlugin.fromClass(
  class {
    host: HTMLElement;
    constructor(readonly view: EditorView) {
      // clipped to nothing, so it never adds to what the scroller can scroll
      this.host = document.createElement('div');
      this.host.setAttribute('aria-hidden', 'true');
      this.host.style.cssText = 'position:absolute;left:0;top:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
      view.scrollDOM.appendChild(this.host);
      probe = this.host;
      this.measure();
    }
    measure() {
      this.view.requestMeasure({
        read: (view) => {
          const cs = getComputedStyle(view.contentDOM);
          const width = view.contentDOM.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
          return { width, font: cs.fontFamily };
        },
        write: ({ width, font }) => {
          if (width <= 0 || (Math.abs(width - column) < 0.5 && font === columnFont)) return;
          column = width;
          columnFont = font;
          // the editor sets the body font on its content, not on the scroller the probe sits in
          this.host.style.fontFamily = font;
          rowKinds.clear();
          blockHeights.clear();
          layoutEpoch++;
          sized();
        },
      });
    }
    update(u: ViewUpdate) {
      if (u.geometryChanged) this.measure();
    }
    destroy() {
      this.host.remove();
      if (probe === this.host) probe = null;
    }
  },
);

/** pictures got sizes, or the column changed: lay the blocks out again */
const blocksResized = StateEffect.define<null>();

/* ---------- the caret holds still when a block comes back ---------- */

/* Leaving an image line, a table or a math block turns its source rows back into the picture,
   the table or the formula, whose height differs. CodeMirror keeps the line at the top of the
   screen in place, so a caret below the block would be pushed by the difference. Instead the
   caret's line keeps its place on the screen: with the caret above, the block grows (or
   shrinks) downward; below it, upward. */

/** when the caret last left a block (a picture whose size was unknown re-pins on load) */
let leftAt = -Infinity;

/** the view a state is shown in — the pin reads the layout as it is before the update */
const viewOf = new WeakMap<EditorState, EditorView>();

/** CodeMirror's own scroll snapshot, aimed at the line at `pos` instead of the top one: after the
    update, that line's top sits `offset` px below where the scroller's top is. */
function pinLine(view: EditorView, pos: number, offset: number): StateEffect<unknown> | null {
  const snap = view.scrollSnapshot();
  const target = snap.value as unknown as { range?: unknown; yMargin?: unknown };
  if (!target || !('range' in target) || typeof target.yMargin !== 'number') return null;
  Object.assign(target, { range: EditorSelection.cursor(pos), yMargin: offset });
  return snap;
}

/** Is this stretch of the document (heights from the document top) wholly on screen? */
function onScreen(view: EditorView, top: number, bottom: number): boolean {
  const box = view.scrollDOM.getBoundingClientRect();
  const at = view.documentTop;
  return at + top >= box.top - 1 && at + bottom <= box.bottom + 1;
}

/** Keep the main caret's line where it is on the screen through the next layout change. */
function holdCaret(view: EditorView) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const block = view.lineBlockAt(line.from);
  if (!onScreen(view, block.top, block.bottom)) return;
  const pin = pinLine(view, line.from, block.top - view.scrollDOM.scrollTop);
  if (pin) view.dispatch({ effects: pin });
}

/** The rendered blocks (an image line, a table, a math block; lines 1-based, inclusive) a caret or
    selection is in, and that therefore show source. */
function liveBlocks(state: EditorState): Span[] {
  const { images, tables, maths } = state.field(blockField);
  const out: Span[] = [];
  if (!images.size && !tables.length && !maths.length) return out;
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const z = state.doc.lineAt(r.to).number;
    if (z - a < images.size) {
      for (let n = a; n <= z; n++) if (images.has(n)) out.push({ from: n, to: n });
    } else for (const n of images) if (n >= a && n <= z) out.push({ from: n, to: n });
    for (const b of tables) if (b.from <= z && b.to >= a) out.push(b);
    for (const b of maths) if (b.from <= z && b.to >= a) out.push(b);
  }
  return out;
}

const pinOnLeave: Extension = [
  ViewPlugin.define((view) => {
    viewOf.set(view.state, view);
    return { update: (u) => void viewOf.set(u.state, u.view) };
  }),
  EditorState.transactionExtender.of((tr) => {
    const view = viewOf.get(tr.startState);
    if (!view || view.state !== tr.startState || (!tr.selection && !tr.docChanged)) return null;
    const start = tr.startState;
    const live = liveBlocks(start);
    if (!live.length) return null;
    const doc = tr.newDoc;
    const sel = tr.newSelection;
    // a block the carets just left, unchanged (its lines in both numberings)
    let was: Span | null = null;
    let now: Span | null = null;
    for (const b of live) {
      const from = start.doc.line(b.from).from;
      const to = start.doc.line(b.to).to;
      const a = tr.changes.mapPos(from, 1);
      const z = tr.changes.mapPos(to, -1);
      if (z < a || doc.sliceString(a, z) !== start.doc.sliceString(from, to)) continue;
      if (sel.ranges.some((r) => r.from <= z && r.to >= a)) continue;
      was = b;
      now = { from: doc.lineAt(a).number, to: doc.lineAt(z).number };
      break;
    }
    if (!was || !now) return null;
    leftAt = performance.now();
    // where the caret's new line was on the screen before: its own top — or, when it is a line
    // just made under the block (Enter at its end), the bottom of the block's last source row
    const line = doc.lineAt(sel.main.head);
    const back = tr.changes.invertedDesc.mapPos(line.from, -1);
    const old = view.lineBlockAt(back);
    if (!onScreen(view, old.top, old.bottom)) return null; // off screen: ordinary scrolling
    const backNo = start.doc.lineAt(back).number;
    const under = backNo >= was.from && backNo <= was.to && line.number > now.to;
    const pin = pinLine(view, line.from, (under ? old.bottom : old.top) - view.scrollDOM.scrollTop);
    return pin ? { effects: pin } : null;
  }),
];

/* ---------- mouse-hover line (only while the mouse actually moves) ---------- */

const setHover = StateEffect.define<number | null>();
const hoverLine = StateField.define<number | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setHover)) return e.value;
    return v;
  },
});

export const hoverHighlight: Extension = [
  hoverLine,
  EditorView.domEventHandlers({
    mousemove(e, view) {
      // highlight only when actually hovering a line's text box — the scroller is wider than the
      // text column, and passing over the margins on either side should not light up a line
      const row = (e.target as HTMLElement | null)?.closest?.('.cm-line') ?? null;
      const pos = row ? view.posAtCoords({ x: e.clientX, y: e.clientY }) : null;
      const line = pos == null ? null : view.state.doc.lineAt(pos).from;
      if (view.state.field(hoverLine) !== line) view.dispatch({ effects: setHover.of(line) });
    },
    mouseleave(_e, view) {
      if (view.state.field(hoverLine) !== null) view.dispatch({ effects: setHover.of(null) });
    },
    keydown(_e, view) {
      if (view.state.field(hoverLine) !== null) view.dispatch({ effects: setHover.of(null) });
    },
  }),
];

/** A click on a rendered block puts the caret at `pos` — or, ⌥-clicked, adds a caret there. */
function placeCaret(view: EditorView, pos: number, e: MouseEvent) {
  const selection =
    e.altKey && !e.shiftKey ? view.state.selection.addRange(EditorSelection.cursor(pos)) : EditorSelection.single(pos);
  view.dispatch({ selection, userEvent: 'select' });
}

/* ---------- image widget ---------- */

class ImageWidget extends WidgetType {
  constructor(
    readonly raw: string,
    readonly quote: string,
    readonly alt: string,
    readonly src: string,
    /** the line is part of a blockquote rail — the picture keeps the left border */
    readonly railed: boolean,
    /** in a list: the list markup in front of the picture, and the row's grid widths */
    readonly lead = '',
    readonly style = '',
    /** the picture's natural size, once known */
    readonly size: Size | null = null,
    /** the layout (column and font) the row was worked out for */
    readonly epoch = 0,
  ) {
    super();
  }
  override eq(other: ImageWidget) {
    return (
      other.raw === this.raw &&
      other.railed === this.railed &&
      other.style === this.style &&
      other.size?.w === this.size?.w &&
      other.size?.h === this.size?.h &&
      other.epoch === this.epoch
    );
  }
  /** the row's height before it is drawn, so the document keeps its length while it is off screen */
  override get estimatedHeight() {
    const kind = this.size ? rowKind(this.railed, this.lead, this.style) : null;
    if (!kind || !this.size) return -1;
    const h = (Math.min(this.size.w, kind.avail) * this.size.h) / this.size.w;
    return Math.max(kind.min, h + kind.extra);
  }
  /** only the size became known (or the column changed): the picture already drawn stays */
  override updateDOM(dom: HTMLElement) {
    const was = drawnBy.get(dom);
    if (!was || was.raw !== this.raw || was.railed !== this.railed || was.style !== this.style) return false;
    const img = dom.querySelector('img');
    if (img && this.size && !img.getAttribute('width')) {
      img.width = this.size.w;
      img.height = this.size.h;
    }
    drawnBy.set(dom, this);
    return true;
  }
  /** A block widget REPLACES the line element, so it carries the line's own classes. */
  override toDOM(view: EditorView) {
    const row = document.createElement('div');
    row.className = 'ln imgrow' + (this.railed ? ' quote' : '') + (this.lead ? ' li' : '');
    if (this.style) row.setAttribute('style', this.style);
    if (this.lead) row.innerHTML = this.lead;
    const wrap = document.createElement('span');
    wrap.className = 'imgwrap';
    const cap = document.createElement('span');
    cap.className = 'imgsrc';
    cap.textContent = `${this.quote}![${this.alt}](${this.src})`;
    const url = this.src ? resolveAsset(this.src) : null;
    if (this.src && url) {
      const img = document.createElement('img');
      img.alt = this.alt;
      const d = this.size ?? NAT.get(url);
      if (d) {
        img.width = d.w;
        img.height = d.h;
      }
      const miss = document.createElement('span');
      miss.className = 'imgmiss';
      miss.textContent = `⚠ 图片未找到 · ${this.src}`;
      miss.style.display = 'none';
      // the caret has just left this line and the picture's size was not known yet: it grows only
      // now, so hold the caret's line where it is once more
      const late = !d && performance.now() - leftAt < 100;
      img.onload = () => {
        learn(url, img.naturalWidth, img.naturalHeight);
        if (late && row.isConnected) holdCaret(view);
      };
      img.onerror = () => {
        img.style.display = 'none';
        miss.style.display = '';
      };
      img.src = url;
      wrap.append(img, miss, cap);
    } else {
      const miss = document.createElement('span');
      miss.className = 'imgmiss';
      miss.textContent = this.src ? `⚠ 图片未找到 · ${this.src}` : '⚠ 空图片链接';
      wrap.append(miss, cap);
    }
    row.appendChild(wrap);
    drawnBy.set(row, this);
    return row;
  }
  override ignoreEvent() {
    return false;
  }
}

/** which widget drew a picture row */
const drawnBy = new WeakMap<HTMLElement, ImageWidget>();

/* ---------- table widget ---------- */

const inlineMath = (tex: string) => renderMath(tex, false);

class TableWidget extends WidgetType {
  constructor(
    readonly lines: string[],
    /** KaTeX has arrived — the cells' inline math shows typeset */
    readonly ready: boolean,
    /** the layout (column and font) the height was worked out for */
    readonly epoch = 0,
  ) {
    super();
  }
  override eq(other: TableWidget) {
    return other.lines.join('\n') === this.lines.join('\n') && other.ready === this.ready && other.epoch === this.epoch;
  }
  /** the table's height before it is drawn, so the document keeps its length while it is off screen */
  override get estimatedHeight() {
    return blockHeight('ln tblrow', tableHTML(this.lines, inlineMath));
  }
  override toDOM(view: EditorView) {
    const row = document.createElement('div');
    row.className = 'ln tblrow';
    row.innerHTML = tableHTML(this.lines, inlineMath);
    // a click goes into the source at the cell that was clicked, not just to the table's start
    row.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // ⌘/Ctrl-click on a link in a cell opens it (links.ts) instead of editing the table
      const link = (e.target as HTMLElement).closest('.lnk');
      if (link && isOpenClick(e)) {
        const url = link.querySelector('.url')?.textContent?.trim().split(/\s+/)[0];
        if (url) openLink(url);
        return;
      }
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-off]');
      const pos = view.posAtDOM(row) + Number(cell?.dataset.off ?? 0);
      placeCaret(view, pos, e);
      view.focus();
    });
    return row;
  }
  override ignoreEvent(e: Event) {
    return e.type === 'mousedown'; // handled above
  }
}

/* ---------- math block widget ---------- */

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    /** where a click puts the caret: the start of the TeX, counted from the block's first character */
    readonly at: number,
    /** KaTeX has arrived — until then the block shows its TeX, dimmed */
    readonly ready: boolean,
    /** the layout (column and font) the height was worked out for */
    readonly epoch = 0,
  ) {
    super();
  }
  override eq(other: MathWidget) {
    return other.tex === this.tex && other.at === this.at && other.ready === this.ready && other.epoch === this.epoch;
  }
  /** the formula's height before it is drawn, so the document keeps its length while it is off screen */
  override get estimatedHeight() {
    const html = renderMath(this.tex, true);
    if (html != null) return blockHeight('ln mathrow', html);
    const wait = document.createElement('span');
    wait.className = 'mathwait';
    wait.textContent = this.tex;
    return blockHeight('ln mathrow', wait.outerHTML);
  }
  override toDOM(view: EditorView) {
    const row = document.createElement('div');
    row.className = 'ln mathrow';
    const html = renderMath(this.tex, true);
    if (html != null) row.innerHTML = html;
    else {
      const wait = document.createElement('span');
      wait.className = 'mathwait';
      wait.textContent = this.tex;
      row.appendChild(wait);
    }
    // a click goes into the source, at the TeX
    row.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      placeCaret(view, view.posAtDOM(row) + this.at, e);
      view.focus();
    });
    return row;
  }
  override ignoreEvent(e: Event) {
    return e.type === 'mousedown'; // handled above
  }
}

/* ---------- inline math widget ---------- */

class InlineMathWidget extends WidgetType {
  constructor(
    readonly html: string,
    /** length of the opening delimiter: a click puts the caret just after it */
    readonly open: number,
  ) {
    super();
  }
  override eq(other: InlineMathWidget) {
    return other.html === this.html && other.open === this.open;
  }
  override toDOM(view: EditorView) {
    const span = document.createElement('span');
    span.className = 'mathr';
    span.innerHTML = this.html;
    span.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      placeCaret(view, view.posAtDOM(span) + this.open, e);
      view.focus();
    });
    return span;
  }
  override ignoreEvent(e: Event) {
    return e.type === 'mousedown'; // handled above
  }
}

/** The lines every caret and selection end is on, as one comparable key. */
function rangeLines(state: EditorState): string {
  const doc = state.doc;
  return state.selection.ranges.map((r) => doc.lineAt(r.anchor).number + ':' + doc.lineAt(r.head).number).join(',');
}

/** Lines the caret (or a selection) touches: those always show source. */
function caretLines(state: EditorState): Set<number> {
  const out = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const z = state.doc.lineAt(r.to).number;
    for (let n = a; n <= z; n++) out.add(n);
  }
  return out;
}

type Span = { from: number; to: number };
type Blocks = {
  deco: DecorationSet;
  tables: Span[];
  fences: (Span & { closed: boolean })[];
  maths: MathRange[];
  /** lines that are a lone image, shown as the picture or (with a caret on them) as source */
  images: Set<number>;
};

function buildBlocks(state: EditorState): Blocks {
  const b = new RangeSetBuilder<Decoration>();
  const live = caretLines(state);
  const doc = state.doc;
  // one array of the text, one scan for all three kinds of block
  const texts: string[] = [];
  for (const l of doc.iterLines()) texts.push(l);
  const { fences, maths, tables } = blockRanges((n) => texts[n - 1], texts.length);
  let f = 0;
  let t = 0;
  let k = 0;
  let n = 0;
  let st = QUOTE_START;
  const images = new Set<number>();
  // list rows, worked out only once a line might be an image in a list
  let lists: (ListRow | null)[] | null = null;
  for (const line of texts) {
    n++;
    const hit = quoteStep(st, line);
    st = hit.state;
    const table = tables[t];
    if (table && n === table.from) {
      let caretIn = false;
      for (let k = table.from; k <= table.to; k++) caretIn ||= live.has(k);
      if (!caretIn) {
        const lines: string[] = [];
        for (let k = table.from; k <= table.to; k++) lines.push(doc.line(k).text);
        // a cell's formula asks for KaTeX; the table is redrawn once it is here
        const ready = lines.some((l) => l.includes('$')) && renderMath('', false) != null;
        b.add(
          doc.line(table.from).from,
          doc.line(table.to).to,
          Decoration.replace({ widget: new TableWidget(lines, ready, layoutEpoch), block: true }),
        );
      }
    }
    if (table && n === table.to) t++;
    if (table && n >= table.from && n <= table.to) continue;
    const math = maths[k];
    if (math && n >= math.from) {
      if (n === math.from) {
        let caretIn = false;
        for (let j = math.from; j <= math.to; j++) caretIn ||= live.has(j);
        if (!caretIn) {
          const first = doc.line(math.from);
          // a click lands on the first TeX: after the `$$`, or on the next line when it stands alone
          const at = math.from === math.to || first.text.trim() !== '$$' ? first.text.indexOf('$$') + 2 : first.length + 1;
          const html = renderMath(math.tex, true);
          b.add(
            first.from,
            doc.line(math.to).to,
            Decoration.replace({ widget: new MathWidget(math.tex, at, html != null, layoutEpoch), block: true }),
          );
        }
      }
      if (n === math.to) k++;
      continue;
    }
    while (fences[f] && fences[f].to < n) f++;
    if (fences[f] && n >= fences[f].from) continue; // code: an image line in it is just code
    if (line.length < 5 || line.indexOf('![') < 0) continue; // cheap reject for the common case
    let row: ListRow | null = null;
    if (maybeListImage(line)) row = (lists ??= listScan(texts))[n - 1];
    const img = imageLine(line, row);
    if (!img) continue;
    images.add(n);
    warmSize(img.src);
    if (live.has(n)) continue;
    const l = doc.line(n);
    let lead = '';
    let style = '';
    if (img.lead) {
      const listed = withListRow(line, decorateLine(line), row);
      lead = leadHTML(line, img.lead, listed.deco);
      style = listed.style;
    }
    b.add(
      l.from,
      l.to,
      Decoration.replace({
        widget: new ImageWidget(line, img.quote, img.alt, img.src, hit.member, lead, style, sizeOf(img.src), layoutEpoch),
        block: true,
      }),
    );
  }
  return { deco: b.finish(), tables, fences, maths, images };
}

/** KaTeX has arrived: typeset the math blocks that showed their TeX meanwhile */
const mathLoaded = StateEffect.define<null>();

const blockField = StateField.define<Blocks>({
  create: buildBlocks,
  update(blocks, tr) {
    if (tr.effects.some((e) => e.is(mathLoaded) || e.is(blocksResized))) return buildBlocks(tr.state);
    if (!tr.docChanged && !tr.selection) return blocks;
    if (tr.selection && !tr.docChanged) {
      // only matters when a caret (any of them) moved to a different line
      if (rangeLines(tr.startState) === rangeLines(tr.state)) return blocks;
    }
    return buildBlocks(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f, (blocks) => blocks.deco),
});

/** Is line `n` a lone image (shown as the picture while no caret is on it)? */
export function isImage(state: EditorState, n: number): boolean {
  return state.field(blockField).images.has(n);
}

/** Is line `n` inside a fenced code block (fences included)? */
export function inCode(state: EditorState, n: number): boolean {
  return state.field(blockField).fences.some((r) => n >= r.from && n <= r.to);
}

/** Every fenced code block (lines 1-based, fences included), in document order. */
export function codeBlocks(state: EditorState): readonly (Span & { closed: boolean })[] {
  return state.field(blockField).fences;
}

/** The start of the line the mouse is over, if any. */
export function hoveredLine(state: EditorState): number | null {
  return state.field(hoverLine, false) ?? null;
}

/** The math block line `n` belongs to, if any. */
export function inMath(state: EditorState, n: number): MathRange | null {
  return state.field(blockField).maths.find((r) => n >= r.from && n <= r.to) ?? null;
}

/** Is line `n` part of a table? (Lines 1-based; also used by the arrow-key navigation.) */
export function inTable(state: EditorState, n: number): { from: number; to: number } | null {
  for (const t of state.field(blockField).tables) if (n >= t.from && n <= t.to) return t;
  return null;
}

/* ---------- per-line decoration (viewport only) ---------- */

/** Replay the blockquote scan from the nearest line that resets it (a blank line). */
function quoteStateAt(state: EditorState, lineNo: number): QuoteState {
  const doc = state.doc;
  let start = lineNo;
  while (start > 1 && !isQuoteReset(doc.line(start - 1).text)) start--;
  let st = QUOTE_START;
  for (let n = start; n < lineNo; n++) st = quoteStep(st, doc.line(n).text).state;
  return st;
}

function build(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const state = view.state;
  const doc = state.doc;
  const live = caretLines(state);
  const hovered = state.field(hoverLine, false);
  // the current-line highlight follows the caret itself (the head of each range), exactly like the
  // blog editor's updateActiveLine() — with several carets, every line one is on
  const caretRows = new Set(state.selection.ranges.map((r) => doc.lineAt(r.head).number));
  const { tables, fences, maths } = state.field(blockField);
  const touches = (from: number, to: number) => state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  // syntax colours, one parse per code block on screen
  const colours = new Map<Span, ReturnType<typeof highlightBlock>>();
  const coloursOf = (f: Span & { closed: boolean }) => {
    if (!colours.has(f)) {
      const body: string[] = [];
      for (let k = f.from + 1; k <= (f.closed ? f.to - 1 : f.to); k++) body.push(doc.line(k).text);
      colours.set(f, highlightBlock(doc.line(f.from).text, body));
    }
    return colours.get(f);
  };

  // An empty document's visibleRanges is an empty array (the viewport is 0..0), so the first line
  // would get no decoration at all: the font falls back to 16px/1.4, the caret is short and sits
  // high, and only "snaps" to the right line height when the first character is typed.
  const ranges = view.visibleRanges.length
    ? view.visibleRanges
    : [{ from: view.viewport.from, to: view.viewport.to }];
  for (const { from, to } of ranges) {
    let lineNo = doc.lineAt(from).number;
    const lastNo = doc.lineAt(to).number;
    let st = quoteStateAt(state, lineNo);
    const firstNo = lineNo;
    const lists = listRows((n) => doc.line(n).text, doc.lines, firstNo, lastNo);
    for (; lineNo <= lastNo; lineNo++) {
      const line = doc.line(lineNo);
      const text = line.text;
      const hit = quoteStep(st, text);
      st = hit.state;

      const fence = fences.find((r) => lineNo >= r.from && lineNo <= r.to);
      if (fence) {
        const part = lineNo === fence.from ? 'open' : fence.closed && lineNo === fence.to ? 'close' : 'body';
        const deco = codeLineDeco(text, part);
        const cls = ['ln', deco.lineClass];
        if (caretRows.has(lineNo)) cls.push('aline');
        if (hovered === line.from) cls.push('mhover');
        out.push(Decoration.line({ class: cls.join(' ') }).range(line.from));
        for (const m of deco.marks) out.push(Decoration.mark({ class: m.cls }).range(line.from + m.from, line.from + m.to));
        if (part === 'body')
          for (const m of coloursOf(fence)?.[lineNo - fence.from - 1] ?? [])
            out.push(Decoration.mark({ class: m.cls }).range(line.from + m.from, line.from + m.to));
        continue;
      }
      const math = maths.find((r) => lineNo >= r.from && lineNo <= r.to);
      if (math) {
        if (![...live].some((k) => k >= math.from && k <= math.to)) continue; // rendered by blockField
        const deco = mathLineDeco(text, math, lineNo);
        const cls = ['ln', deco.lineClass];
        if (caretRows.has(lineNo)) cls.push('aline');
        if (hovered === line.from) cls.push('mhover');
        out.push(Decoration.line({ class: cls.join(' ') }).range(line.from));
        for (const m of deco.marks) out.push(Decoration.mark({ class: m.cls }).range(line.from + m.from, line.from + m.to));
        continue;
      }
      const table = tables.find((t) => lineNo >= t.from && lineNo <= t.to);
      if (table && ![...live].some((k) => k >= table.from && k <= table.to)) continue; // rendered by blockField
      const img = table ? null : imageLine(text, lists[lineNo - firstNo]);
      const asImage = !!img && !live.has(lineNo);
      const { deco, style } = table
        ? { deco: tableSourceDeco(text, lineNo === table.from + 1), style: '' }
        : withListRow(text, decorateLine(text), lists[lineNo - firstNo]);
      const cls = ['ln'];
      if (deco.lineClass) cls.push(deco.lineClass);
      if (hit.member) cls.push('quote');
      if (hit.lazy) cls.push('qlazy');
      if (asImage) cls.push('imgrow');
      if (caretRows.has(lineNo)) cls.push('aline');
      if (hovered === line.from) cls.push('mhover');
      out.push(Decoration.line({ class: cls.join(' '), attributes: style ? { style } : undefined }).range(line.from));

      if (asImage) continue; // the picture (a block decoration) comes from blockField
      // a formula the caret is not on shows typeset (as source until KaTeX has arrived)
      const typeset: Span[] = [];
      for (const m of deco.marks) {
        if (m.cls !== 'math' || touches(line.from + m.from, line.from + m.to)) continue;
        const open = text.startsWith('$$', m.from) ? 2 : 1;
        const html = renderMath(text.slice(m.from + open, m.to - open), false);
        if (html == null) continue;
        typeset.push(m);
        out.push(Decoration.replace({ widget: new InlineMathWidget(html, open) }).range(line.from + m.from, line.from + m.to));
      }
      for (const m of deco.marks) {
        if (m.to <= m.from) continue;
        if (typeset.some((r) => m.from >= r.from && m.to <= r.to)) continue;
        out.push(Decoration.mark({ class: m.cls }).range(line.from + m.from, line.from + m.to));
      }
      // a link the caret is not on shows only its text
      for (const l of linkParts(text, deco.marks)) {
        if (touches(line.from + l.from, line.from + l.to)) continue;
        out.push(hideMarkup.range(line.from + l.head.from, line.from + l.head.to));
        out.push(hideMarkup.range(line.from + l.tail.from, line.from + l.tail.to));
      }
    }
  }
  return Decoration.set(out, true);
}

const hideMarkup = Decoration.replace({});

/** A code block scrolled sideways to `x` (codescroll.ts), or just its scrollbar faded: nothing
    here needs drawing again. The transaction carries the unchanged selection, so it must not be
    taken for a caret move either (onlyScrolled). */
export const codeScrolled = StateEffect.define<{ at: number; x: number } | null>();

/** an update that only scrolled a code block sideways */
export const onlyScrolled = (u: ViewUpdate) =>
  !u.docChanged && u.transactions.length > 0 && u.transactions.every((t) => t.effects.some((e) => e.is(codeScrolled)));

/** a code block's language has arrived: draw it again, coloured */
const languageLoaded = StateEffect.define<null>();

export const sourceDecoration: Extension = [
  hoverHighlight,
  blockField,
  pinOnLeave,
  blockGeometry,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      offs: (() => void)[];
      constructor(view: EditorView) {
        this.decorations = build(view);
        this.offs = [
          onLanguageLoaded(() => view.dispatch({ effects: languageLoaded.of(null) })),
          onMathLoaded(() => view.dispatch({ effects: mathLoaded.of(null) })),
          onBlocksResized(() => view.dispatch({ effects: blocksResized.of(null) })),
        ];
      }
      destroy() {
        for (const off of this.offs) off();
      }
      update(u: ViewUpdate) {
        if (onlyScrolled(u)) return;
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.transactions.some((t) => t.effects.some((e) => !e.is(codeScrolled)))
        )
          this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  ),
];
