/* The CodeMirror side of source decoration.

   Two things happen here:

   1. every line CodeMirror actually renders (its viewport) gets its classes
      (h1…h6 / quote rail / morecomment) and its inline marks — which is what makes a
      100k-word document cost the same as a short one;
   2. an image line the caret is NOT on is replaced by a block widget showing the
      picture, and so is a table the caret is not in (all its lines, by a rendered
      table). Where the caret is, the text always shows source — that invariant is the
      whole contract of this editor. Links follow the same rule inline: away from the
      caret only their text shows.

   The two live in different places on purpose: decorations that change the block
   layout (lines replaced by a picture or a table) may only come from a state field,
   never from a view plugin — CodeMirror rejects them otherwise. The field is rebuilt
   only when the document changes or the caret moves to another line. */

import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension, Range } from '@codemirror/state';
import {
  decorateLine,
  imageLine,
  isQuoteReset,
  linkParts,
  listRows,
  quoteStep,
  QUOTE_START,
  tableHTML,
  tableRanges,
  tableSourceDeco,
  withListRow,
} from './tokens';
import type { QuoteState } from './tokens';

/** How an image's relative `src` becomes something the webview can load. */
export type AssetResolver = (src: string) => string | null;

let resolveAsset: AssetResolver = () => null;
export function setAssetResolver(fn: AssetResolver) {
  resolveAsset = fn;
}

/** natural size cache: re-rendered images reserve space before load, so layout never jumps */
const NAT = new Map<string, { w: number; h: number }>();

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

/* ---------- image widget ---------- */

class ImageWidget extends WidgetType {
  constructor(
    readonly raw: string,
    readonly quote: string,
    readonly alt: string,
    readonly src: string,
    /** the line is part of a blockquote rail — the picture keeps the left border */
    readonly railed: boolean,
  ) {
    super();
  }
  override eq(other: ImageWidget) {
    return other.raw === this.raw && other.railed === this.railed;
  }
  /** A block widget REPLACES the line element, so it carries the line's own classes. */
  override toDOM() {
    const row = document.createElement('div');
    row.className = 'ln imgrow' + (this.railed ? ' quote' : '');
    const wrap = document.createElement('span');
    wrap.className = 'imgwrap';
    const cap = document.createElement('span');
    cap.className = 'imgsrc';
    cap.textContent = `${this.quote}![${this.alt}](${this.src})`;
    const url = this.src ? resolveAsset(this.src) : null;
    if (this.src && url) {
      const img = document.createElement('img');
      img.alt = this.alt;
      const d = NAT.get(this.src);
      if (d) {
        img.width = d.w;
        img.height = d.h;
      }
      const miss = document.createElement('span');
      miss.className = 'imgmiss';
      miss.textContent = `⚠ 图片未找到 · ${this.src}`;
      miss.style.display = 'none';
      img.onload = () => NAT.set(this.src, { w: img.naturalWidth, h: img.naturalHeight });
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
    return row;
  }
  override ignoreEvent() {
    return false;
  }
}

/* ---------- table widget ---------- */

class TableWidget extends WidgetType {
  constructor(readonly lines: string[]) {
    super();
  }
  override eq(other: TableWidget) {
    return other.lines.join('\n') === this.lines.join('\n');
  }
  override toDOM(view: EditorView) {
    const row = document.createElement('div');
    row.className = 'ln tblrow';
    row.innerHTML = tableHTML(this.lines);
    // a click goes into the source at the cell that was clicked, not just to the table's start
    row.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-off]');
      const pos = view.posAtDOM(row) + Number(cell?.dataset.off ?? 0);
      view.dispatch({ selection: { anchor: pos }, userEvent: 'select' });
      view.focus();
    });
    return row;
  }
  override ignoreEvent(e: Event) {
    return e.type === 'mousedown'; // handled above
  }
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

type Blocks = { deco: DecorationSet; tables: { from: number; to: number }[] };

function buildBlocks(state: EditorState): Blocks {
  const b = new RangeSetBuilder<Decoration>();
  const live = caretLines(state);
  const doc = state.doc;
  const tables = tableRanges((n) => doc.line(n).text, doc.lines);
  let t = 0;
  let n = 0;
  let st = QUOTE_START;
  for (const line of doc.iterLines()) {
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
        b.add(
          doc.line(table.from).from,
          doc.line(table.to).to,
          Decoration.replace({ widget: new TableWidget(lines), block: true }),
        );
      }
    }
    if (table && n === table.to) t++;
    if (table && n >= table.from && n <= table.to) continue;
    if (line.length < 5 || line.indexOf('![') < 0) continue; // cheap reject for the common case
    const img = imageLine(line);
    if (!img || live.has(n)) continue;
    const l = doc.line(n);
    b.add(
      l.from,
      l.to,
      Decoration.replace({ widget: new ImageWidget(line, img.quote, img.alt, img.src, hit.member), block: true }),
    );
  }
  return { deco: b.finish(), tables };
}

const blockField = StateField.define<Blocks>({
  create: buildBlocks,
  update(blocks, tr) {
    if (!tr.docChanged && !tr.selection) return blocks;
    if (tr.selection && !tr.docChanged) {
      // only matters when the caret moved to a different line
      const before = tr.startState.doc.lineAt(tr.startState.selection.main.head).number;
      const after = tr.state.doc.lineAt(tr.state.selection.main.head).number;
      const beforeAnchor = tr.startState.doc.lineAt(tr.startState.selection.main.anchor).number;
      const afterAnchor = tr.state.doc.lineAt(tr.state.selection.main.anchor).number;
      if (before === after && beforeAnchor === afterAnchor) return blocks;
    }
    return buildBlocks(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f, (blocks) => blocks.deco),
});

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
  // the current-line highlight follows the caret itself (the head of the main range),
  // exactly like the blog editor's updateActiveLine()
  const anchorLine = doc.lineAt(state.selection.main.head).number;
  const { tables } = state.field(blockField);
  const touches = (from: number, to: number) => state.selection.ranges.some((r) => r.from <= to && r.to >= from);

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

      const table = tables.find((t) => lineNo >= t.from && lineNo <= t.to);
      if (table && ![...live].some((k) => k >= table.from && k <= table.to)) continue; // rendered by blockField
      const img = table ? null : imageLine(text);
      const asImage = !!img && !live.has(lineNo);
      const { deco, style } = table
        ? { deco: tableSourceDeco(text, lineNo === table.from + 1), style: '' }
        : withListRow(text, decorateLine(text), lists[lineNo - firstNo]);
      const cls = ['ln'];
      if (deco.lineClass) cls.push(deco.lineClass);
      if (hit.member) cls.push('quote');
      if (hit.lazy) cls.push('qlazy');
      if (asImage) cls.push('imgrow');
      if (lineNo === anchorLine) cls.push('aline');
      if (hovered === line.from) cls.push('mhover');
      out.push(Decoration.line({ class: cls.join(' '), attributes: style ? { style } : undefined }).range(line.from));

      if (asImage) continue; // the picture (a block decoration) comes from blockField
      for (const m of deco.marks) {
        if (m.to <= m.from) continue;
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

export const sourceDecoration: Extension = [
  hoverHighlight,
  blockField,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.transactions.some((t) => t.effects.length))
          this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  ),
];
