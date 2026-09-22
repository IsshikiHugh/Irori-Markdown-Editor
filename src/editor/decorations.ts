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
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension, Range } from '@codemirror/state';
import {
  codeLineDeco,
  decorateLine,
  blockRanges,
  imageLine,
  isQuoteReset,
  linkParts,
  listRows,
  mathLineDeco,
  quoteStep,
  QUOTE_START,
  tableHTML,
  tableSourceDeco,
  withListRow,
} from './tokens';
import type { MathRange, QuoteState } from './tokens';
import { isOpenClick, openLink } from './links';
import { highlightBlock, onLanguageLoaded } from './highlight';
import { onMathLoaded, renderMath } from './math';

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

const inlineMath = (tex: string) => renderMath(tex, false);

class TableWidget extends WidgetType {
  constructor(
    readonly lines: string[],
    /** KaTeX has arrived — the cells' inline math shows typeset */
    readonly ready: boolean,
  ) {
    super();
  }
  override eq(other: TableWidget) {
    return other.lines.join('\n') === this.lines.join('\n') && other.ready === this.ready;
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
      view.dispatch({ selection: { anchor: pos }, userEvent: 'select' });
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
  ) {
    super();
  }
  override eq(other: MathWidget) {
    return other.tex === this.tex && other.at === this.at && other.ready === this.ready;
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
      view.dispatch({ selection: { anchor: view.posAtDOM(row) + this.at }, userEvent: 'select' });
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
      view.dispatch({ selection: { anchor: view.posAtDOM(span) + this.open }, userEvent: 'select' });
      view.focus();
    });
    return span;
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

type Span = { from: number; to: number };
type Blocks = { deco: DecorationSet; tables: Span[]; fences: (Span & { closed: boolean })[]; maths: MathRange[] };

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
          Decoration.replace({ widget: new TableWidget(lines, ready), block: true }),
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
          const at = math.from === math.to ? first.text.indexOf('$$') + 2 : first.length + 1;
          const html = renderMath(math.tex, true);
          b.add(
            first.from,
            doc.line(math.to).to,
            Decoration.replace({ widget: new MathWidget(math.tex, at, html != null), block: true }),
          );
        }
      }
      if (n === math.to) k++;
      continue;
    }
    while (fences[f] && fences[f].to < n) f++;
    if (fences[f] && n >= fences[f].from) continue; // code: an image line in it is just code
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
  return { deco: b.finish(), tables, fences, maths };
}

/** KaTeX has arrived: typeset the math blocks that showed their TeX meanwhile */
const mathLoaded = StateEffect.define<null>();

const blockField = StateField.define<Blocks>({
  create: buildBlocks,
  update(blocks, tr) {
    if (tr.effects.some((e) => e.is(mathLoaded))) return buildBlocks(tr.state);
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

/** Is line `n` inside a fenced code block (fences included)? */
export function inCode(state: EditorState, n: number): boolean {
  return state.field(blockField).fences.some((r) => n >= r.from && n <= r.to);
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
  // the current-line highlight follows the caret itself (the head of the main range),
  // exactly like the blog editor's updateActiveLine()
  const anchorLine = doc.lineAt(state.selection.main.head).number;
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
        if (lineNo === anchorLine) cls.push('aline');
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
        if (lineNo === anchorLine) cls.push('aline');
        if (hovered === line.from) cls.push('mhover');
        out.push(Decoration.line({ class: cls.join(' ') }).range(line.from));
        for (const m of deco.marks) out.push(Decoration.mark({ class: m.cls }).range(line.from + m.from, line.from + m.to));
        continue;
      }
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

/** a code block's language has arrived: draw it again, coloured */
const languageLoaded = StateEffect.define<null>();

export const sourceDecoration: Extension = [
  hoverHighlight,
  blockField,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      offs: (() => void)[];
      constructor(view: EditorView) {
        this.decorations = build(view);
        this.offs = [
          onLanguageLoaded(() => view.dispatch({ effects: languageLoaded.of(null) })),
          onMathLoaded(() => view.dispatch({ effects: mathLoaded.of(null) })),
        ];
      }
      destroy() {
        for (const off of this.offs) off();
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.transactions.some((t) => t.effects.length))
          this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  ),
];
