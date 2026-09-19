/* Markdown SOURCE decoration — the one rule of this editor: the text never changes,
   only its dressing. Every function here is pure and works on a single line of source,
   which is what makes the same rules usable by three different renderers (the
   CodeMirror plugin, the minimap clone, and the unit tests).

   The precedence order (code → link → ***bi*** → **b** → *i*) and the regexes are
   ported verbatim from the blog editor, because "the same text must decorate the same
   way" is the acceptance criterion. The old code stashed already-parsed spans behind
   placeholders so later regexes could not scan into injected HTML; here we mark the
   consumed ranges instead — same effect, no string surgery. */

export type Mark = { from: number; to: number; cls: string };

export type LineDeco = {
  /** extra classes for the line element, e.g. "h2" or "morecomment" ("" for a plain line) */
  lineClass: string;
  /** inline marks, offsets relative to the start of the line */
  marks: Mark[];
};

export const IMG = /^!\[([^\]]*)\]\(([^)]*)\)\s*$/; // bare image line
export const QUOTE_IMG = /^(>\s*)!\[([^\]]*)\]\(([^)]*)\)\s*$/; // image inside a blockquote

const RE_MORE = /^<!--\s*more\s*-->$/;
const RE_HEAD = /^(#{1,6})(\s+)(.*)$/;
const RE_QUOTE = /^(>\s?)(.*)$/;

/** Is this line a lone image (optionally inside a blockquote)? */
export function imageLine(text: string): { quote: string; alt: string; src: string } | null {
  let m = text.match(IMG);
  if (m) return { quote: '', alt: m[1], src: m[2] };
  m = text.match(QUOTE_IMG);
  if (m) return { quote: m[1], alt: m[2], src: m[3] };
  return null;
}

/* ---------- inline ---------- */

type Rule = { re: RegExp; marks: (m: RegExpExecArray, at: number) => Mark[] };

const RULES: Rule[] = [
  {
    // `code`
    re: /`([^`]+)`/g,
    marks: (m, at) => [
      { from: at, to: at + m[0].length, cls: 'code' },
      { from: at, to: at + 1, cls: 'tok' },
      { from: at + m[0].length - 1, to: at + m[0].length, cls: 'tok' },
    ],
  },
  {
    // [text](url) — the url may hold one level of parentheses, as Wikipedia's do: (Foo_(bar))
    re: /\[([^\]]*)\]\(((?:[^()]|\([^()]*\))+)\)/g,
    marks: (m, at) => {
      const openTo = at + 1;
      const midFrom = at + 1 + m[1].length;
      const midTo = midFrom + 2;
      const urlTo = midTo + m[2].length;
      return [
        { from: at, to: at + m[0].length, cls: 'lnk' },
        { from: at, to: openTo, cls: 'tok' },
        { from: midFrom, to: midTo, cls: 'tok' },
        { from: midTo, to: urlTo, cls: 'url' },
        { from: urlTo, to: urlTo + 1, cls: 'tok' },
      ];
    },
  },
  { re: /\*\*\*([^*]+)\*\*\*/g, marks: (m, at) => emphasis(m, at, 3, ['b', 'i']) },
  { re: /\*\*([^*]+)\*\*/g, marks: (m, at) => emphasis(m, at, 2, ['b']) },
  { re: /\*([^*\n]+)\*/g, marks: (m, at) => emphasis(m, at, 1, ['i']) },
];

function emphasis(m: RegExpExecArray, at: number, n: number, cls: string[]): Mark[] {
  const end = at + m[0].length;
  return [
    ...cls.map((c) => ({ from: at, to: end, cls: c })),
    { from: at, to: at + n, cls: 'tok' },
    { from: end - n, to: end, cls: 'tok' },
  ];
}

/** Inline marks for a fragment of a line. `base` is the fragment's offset in the line. */
export function inlineMarks(text: string, base = 0): Mark[] {
  const consumed = new Uint8Array(text.length);
  const out: Mark[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const at = m.index;
      const end = at + m[0].length;
      let clash = false;
      for (let i = at; i < end; i++) if (consumed[i]) { clash = true; break; }
      if (clash) {
        // resume one character in, not past the clashing match: the same rule may still
        // match later in the line (bold at the start must not hide a later italic)
        rule.re.lastIndex = at + 1;
        continue;
      }
      for (let i = at; i < end; i++) consumed[i] = 1;
      out.push(...rule.marks(m, at + base));
    }
  }
  // Stable, renderer-friendly order: outer (longer) spans first at the same offset.
  out.sort((a, b) => a.from - b.from || b.to - a.to);
  return out;
}

/* ---------- a whole line ---------- */

export function decorateLine(text: string): LineDeco {
  if (RE_MORE.test(text.trim())) {
    return { lineClass: 'morecomment', marks: [{ from: 0, to: text.length, cls: 'tok' }] };
  }
  let m = text.match(RE_HEAD);
  if (m) {
    const lead = m[1].length + m[2].length;
    return {
      lineClass: 'h' + m[1].length,
      marks: [{ from: 0, to: lead, cls: 'tok' }, ...inlineMarks(m[3], lead)],
    };
  }
  m = text.match(RE_QUOTE);
  if (m) {
    const lead = m[1].length;
    // NOTE: the `.quote` rail class is NOT set here — rail membership spans several
    // lines and is decided by quoteStep() below.
    return { lineClass: '', marks: [{ from: 0, to: lead, cls: 'tok' }, ...inlineMarks(m[2], lead)] };
  }
  const li = listItem(text);
  if (li) {
    const ind = li.indent.length;
    const lead = ind + li.marker.length + li.gap.length;
    const marks: Mark[] = ind ? [{ from: 0, to: ind, cls: 'lind' }] : [];
    marks.push({ from: ind, to: lead, cls: li.ordered ? 'lnum' : 'lmark' });
    // the rest is decorated on its own, so a "* " bullet can never pair up with a later "*"
    return { lineClass: 'li', marks: [...marks, ...inlineMarks(text.slice(lead), lead)] };
  }
  return { lineClass: '', marks: inlineMarks(text) };
}

/* ---------- lists ----------
   A list item's leading run (indent · marker · gap) is laid out on a column grid: each
   source column is one fixed-width cell (--lc in style.css), so the text after the marker
   starts at the same x on every row of the item, and a nested item — indented to its
   parent's text column in the source — starts exactly where the parent's text does.
   Ordered markers are right-aligned inside a box as wide as the LONGEST number of their
   list, so "9." and "10." line up on the dot. That width depends on the lines around,
   which is why it comes from listScan() rather than decorateLine(). */

export type ListItem = { indent: string; marker: string; gap: string; ordered: boolean };

const RE_LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

export function listItem(text: string): ListItem | null {
  const m = RE_LIST.exec(text);
  if (!m || RE_HR.test(text)) return null;
  return { indent: m[1], marker: m[2], gap: m[3], ordered: m[2].length > 1 };
}

/** Source columns of a run of blanks starting at column `at` (a tab advances to the next multiple of 4). */
function columns(ws: string, at = 0): number {
  let c = at;
  for (const ch of ws) c = ch === '\t' ? c + 4 - (c % 4) : c + 1;
  return c - at;
}

/** Grid cells of a list row: `ind` for the indent box, `mark` for the marker box (0 on a continuation line). */
export type ListRow = { ind: number; mark: number };

/** A line that closes every open list: text starting in column 0 that is not an item. */
export const isListReset = (src: string) => /^[^ \t]/.test(src) && !listItem(src);

/** Grid layout for a run of lines. Blank lines keep a list open; indented lines inside a
    list are continuations and get the indent box only. */
export function listScan(lines: string[]): (ListRow | null)[] {
  const out: (ListRow | null)[] = lines.map(() => null);
  // sibling groups currently open, outermost first; `digits` is the widest number seen
  type Group = { indent: number; key: string; digits: number };
  const stack: Group[] = [];
  const items: { i: number; li: ListItem; g: Group; ind: number }[] = [];
  lines.forEach((text, i) => {
    const li = listItem(text);
    if (li) {
      const ind = columns(li.indent);
      while (stack.length && stack[stack.length - 1].indent > ind) stack.pop();
      const key = li.ordered ? 'o' + li.marker.slice(-1) : 'b';
      let top = stack[stack.length - 1];
      if (!top || top.indent !== ind || top.key !== key) {
        if (top && top.indent === ind) stack.pop();
        top = { indent: ind, key, digits: 0 };
        stack.push(top);
      }
      if (li.ordered) top.digits = Math.max(top.digits, li.marker.length - 1);
      items.push({ i, li, g: top, ind });
    } else if (text.trim() === '') {
      // blank: a list survives it
    } else if (stack.length && /^[ \t]/.test(text)) {
      const ws = /^[ \t]*/.exec(text)![0];
      const ind = columns(ws);
      while (stack.length > 1 && stack[stack.length - 1].indent > ind) stack.pop();
      out[i] = { ind, mark: 0 };
    } else {
      stack.length = 0;
    }
  });
  for (const { i, li, g, ind } of items) {
    const head = li.ordered ? g.digits + 1 : 1;
    const gap = columns(li.gap, ind + li.marker.length);
    out[i] = { ind, mark: head + gap };
  }
  return out;
}

/** Grid layout for lines `from..to` (1-based) of a document, scanning out to the enclosing list's edges. */
export function listRows(line: (n: number) => string, lines: number, from: number, to: number): (ListRow | null)[] {
  let a = from;
  while (a > 1 && !isListReset(line(a - 1))) a--;
  let z = to;
  while (z < lines && !isListReset(line(z + 1))) z++;
  const texts: string[] = [];
  for (let n = a; n <= z; n++) texts.push(line(n));
  return listScan(texts).slice(from - a, to - a + 1);
}

/** Fold a list row into a line's decoration: the line class, the indent box of a
    continuation line, and the inline style carrying the grid widths. */
export function withListRow(text: string, deco: LineDeco, row: ListRow | null | undefined): { deco: LineDeco; style: string } {
  if (!row) return { deco, style: '' };
  const style = `--li-ind:${row.ind};--li-mark:${row.mark}`;
  if (row.mark > 0) return { deco, style };
  const ws = /^[ \t]*/.exec(text)![0].length;
  return {
    deco: { lineClass: deco.lineClass ? deco.lineClass + ' li' : 'li', marks: [{ from: 0, to: ws, cls: 'lind' }, ...deco.marks] },
    style,
  };
}

/* ---------- fenced code blocks ----------
   ``` or ~~~ (three or more) opens a block; the same character, at least as many times, alone
   on its line, closes it — or the end of the document does. Inside, nothing is markdown: no
   heading, list, table or link is recognised, and the lines are shown as code. The fences
   stay visible, dimmed, like any other markup. */

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Lines (1-based, inclusive) of every fenced code block, fences included; `closed` is false
    for one that runs to the end of the document. */
export function fenceRanges(line: (n: number) => string, lines: number): { from: number; to: number; closed: boolean }[] {
  const out: { from: number; to: number; closed: boolean }[] = [];
  for (let n = 1; n <= lines; n++) {
    const m = RE_FENCE.exec(line(n));
    // an info string after backticks may not contain a backtick (that is inline code)
    if (!m || (m[1][0] === '`' && m[2].includes('`'))) continue;
    const close = new RegExp(`^ {0,3}${m[1][0] === '`' ? '`' : '~'}{${m[1].length},}[ \t]*$`);
    let z = n + 1;
    while (z <= lines && !close.test(line(z))) z++;
    out.push({ from: n, to: Math.min(z, lines), closed: z <= lines });
    n = z;
  }
  return out;
}

/** Per line (0-based): which part of a code block it is, if any. */
export type FencePart = 'open' | 'body' | 'close' | null;
export function fenceScan(lines: string[]): FencePart[] {
  const out: FencePart[] = lines.map(() => null);
  for (const r of fenceRanges((n) => lines[n - 1], lines.length)) {
    for (let n = r.from; n <= r.to; n++) out[n - 1] = 'body';
    out[r.from - 1] = 'open';
    if (r.closed) out[r.to - 1] = 'close';
  }
  return out;
}

/** A line of a code block: monospace, no markdown; the fences (and the language after the
    opening one) are markup. */
export function codeLineDeco(text: string, part: Exclude<FencePart, null>): LineDeco {
  const cls = part === 'body' ? 'cb' : part === 'open' ? 'cb cbopen' : 'cb cbclose';
  if (part === 'body' || !text) return { lineClass: cls, marks: [] };
  const fence = /^ {0,3}(`+|~+)/.exec(text)![0].length;
  const marks: Mark[] = [{ from: 0, to: fence, cls: 'tok' }];
  if (text.length > fence) marks.push({ from: fence, to: text.length, cls: 'cblang' });
  return { lineClass: cls, marks };
}

/* ---------- links ----------
   Away from the caret a link shows only its text: the `[` in front and the `](url)` behind
   are hidden (the editor replaces them; the minimap and the PDF hide them with CSS). */

/** The hidden parts of every link in a line's marks: `head` is the `[`, `tail` the `](url)`.
    An image's source (`![…](…)`, decorated like a link) is not a link and keeps its markup. */
export function linkParts(text: string, marks: Mark[]): { from: number; to: number; head: Mark; tail: Mark }[] {
  const out: { from: number; to: number; head: Mark; tail: Mark }[] = [];
  for (const l of marks) {
    if (l.cls !== 'lnk' || text[l.from - 1] === '!') continue;
    const toks = marks.filter((m) => m.cls === 'tok' && m.from >= l.from && m.to <= l.to);
    // `[`, `](`, `)` in that order — see the link rule above
    if (toks.length < 3) continue;
    out.push({ from: l.from, to: l.to, head: toks[0], tail: { from: toks[1].from, to: l.to, cls: 'tok' } });
  }
  return out;
}

/** The URL of the link at `offset` in a line (its text or its markup), or null. A title after
    the URL (`[a](url "title")`) is left out. */
export function linkAt(text: string, offset: number): string | null {
  for (const l of linkParts(text, inlineMarks(text))) {
    if (offset < l.from || offset >= l.to) continue;
    const url = text.slice(l.tail.from + 2, l.to - 1).trim().split(/\s+/)[0];
    return url || null;
  }
  return null;
}

/* ---------- tables ----------
   A GFM table: a header row, a delimiter row with the same number of cells (`---`, `:--`,
   `--:`, `:-:`), then body rows up to a blank line or a line without a `|`. Away from the
   caret the editor shows it as a table; with the caret in it, every line is source. */

export type Align = 'left' | 'center' | 'right' | null;
/** a cell's text and where it starts in its line */
export type Cell = { text: string; at: number };
export type Table = { head: Cell[]; align: Align[]; rows: Cell[][] };

/** Split a row at its unescaped pipes (a pipe inside `code` does not count). Null without a pipe. */
export function tableCells(text: string): Cell[] | null {
  if (text.indexOf('|') < 0) return null;
  const bounds: number[] = [];
  let code = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === '`') code = !code;
    else if (ch === '|' && !code) bounds.push(i);
  }
  if (!bounds.length) return null;
  const lead = /^\s*/.exec(text)![0].length;
  const trail = text.length - /\s*$/.exec(text)![0].length;
  // a leading and a trailing pipe are borders, not cell separators
  const cuts = [bounds[0] === lead ? lead : -1, ...bounds.filter((b) => b !== lead && b !== trail - 1)];
  const end = bounds[bounds.length - 1] === trail - 1 && trail - 1 !== lead ? trail - 1 : text.length;
  const cells: Cell[] = [];
  for (let k = 0; k < cuts.length; k++) {
    const from = cuts[k] + 1;
    const to = k + 1 < cuts.length ? cuts[k + 1] : end;
    const raw = text.slice(from, to);
    const pad = /^\s*/.exec(raw)![0].length;
    cells.push({ text: raw.trim(), at: from + pad });
  }
  return cells;
}

function delimiter(text: string): Align[] | null {
  const cells = tableCells(text);
  if (!cells || !cells.every((c) => /^:?-+:?$/.test(c.text))) return null;
  return cells.map(({ text: t }) =>
    t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : t.startsWith(':') ? 'left' : null,
  );
}

/** Lines (1-based, inclusive) of every table in the document. */
export function tableRanges(line: (n: number) => string, lines: number): { from: number; to: number }[] {
  // a table inside a code block is just code
  const code = new Uint8Array(lines + 2);
  for (const r of fenceRanges(line, lines)) code.fill(1, r.from, r.to + 1);
  const src = line;
  line = (n) => (code[n] ? '' : src(n));
  const out: { from: number; to: number }[] = [];
  for (let n = 1; n < lines; n++) {
    const head = line(n);
    if (head.indexOf('|') < 0 || /^ {4}/.test(head)) continue;
    const align = delimiter(line(n + 1));
    if (!align || tableCells(head)!.length !== align.length) continue;
    let z = n + 1;
    while (z < lines && line(z + 1).trim() !== '' && tableCells(line(z + 1))) z++;
    out.push({ from: n, to: z });
    n = z;
  }
  return out;
}

/** The table made of these lines (a range from tableRanges); rows are cut or padded to the header's width. */
export function parseTable(lines: string[]): Table {
  const head = tableCells(lines[0])!;
  const width = head.length;
  const fit = (cells: Cell[]) =>
    Array.from({ length: width }, (_, k) => cells[k] ?? { text: '', at: -1 });
  return {
    head,
    align: delimiter(lines[1])!,
    rows: lines.slice(2).map((l) => fit(tableCells(l) ?? [{ text: l.trim(), at: /^\s*/.exec(l)![0].length }])),
  };
}

/** A table line shown as source: its pipes (and the whole delimiter row) are markup. */
export function tableSourceDeco(text: string, delimiterRow: boolean): LineDeco {
  if (delimiterRow) return { lineClass: 'tsrc', marks: [{ from: 0, to: text.length, cls: 'tok' }] };
  const marks: Mark[] = [];
  let code = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === '`') code = !code;
    else if (ch === '|' && !code) marks.push({ from: i, to: i + 1, cls: 'tok' });
  }
  const inline = inlineMarks(text).filter((m) => !marks.some((p) => p.from >= m.from && p.from < m.to));
  return { lineClass: 'tsrc', marks: [...marks, ...inline].sort((a, b) => a.from - b.from || b.to - a.to) };
}

/** A table as HTML, cells decorated like any text (with the markup hidden by CSS). Each cell
    carries `data-off`: where its text starts, counted from the table's first character. */
export function tableHTML(lines: string[]): string {
  const t = parseTable(lines);
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  const cell = (tag: string, c: Cell, k: number, lineIdx: number) => {
    const align = t.align[k] ? ` style="text-align:${t.align[k]}"` : '';
    const at = c.at >= 0 ? starts[lineIdx] + c.at : starts[lineIdx] + lines[lineIdx].length;
    return `<${tag} data-off="${at}"${align}>${c.text ? lineHTML(c.text) : ''}</${tag}>`;
  };
  const headRow = `<tr>${t.head.map((c, k) => cell('th', c, k, 0)).join('')}</tr>`;
  const body = t.rows.map((r, i) => `<tr>${r.map((c, k) => cell('td', c, k, i + 2)).join('')}</tr>`).join('');
  return `<table class="mdtbl"><thead>${headRow}</thead>${body ? `<tbody>${body}</tbody>` : ''}</table>`;
}

/* ---------- blockquote rail grouping ----------
   Consecutive quote rows share ONE continuous left rail, exactly like a single quote
   paragraph that wraps. Membership follows marked's blockquote grouping: a ">" line
   (bare ">" included) is in; a line with no ">" is a lazy continuation of the open
   paragraph (so it joins too); a plain blank line — or a line that starts a new block —
   ends the quote. Ported verbatim from the blog editor's paintQuotes(). */

export const QLEAD = /^[ ]{0,3}>/;
const isBareQuote = (s: string) => QLEAD.test(s) && s.replace(/^[ ]{0,3}(?:>[ ]?)+/, '').trim() === '';
const QINTERRUPT = /^[ ]{0,3}(#{1,6}\s|```|~~~|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,}|_{3,})\s*$|<!--)/;

export type QuoteState = { inQuote: boolean; openPara: boolean };
export const QUOTE_START: QuoteState = { inQuote: false, openPara: false };

export type QuoteHit = { state: QuoteState; member: boolean; lazy: boolean };

export function quoteStep(state: QuoteState, src: string): QuoteHit {
  let { inQuote, openPara } = state;
  let member: boolean;
  if (QLEAD.test(src)) {
    member = true;
    inQuote = true;
    openPara = !isBareQuote(src);
  } else if (src.trim() === '') {
    member = inQuote = openPara = false;
  } else if (inQuote && openPara && !QINTERRUPT.test(src)) {
    member = true;
  } else {
    member = inQuote = openPara = false;
  }
  return { state: { inQuote, openPara }, member, lazy: member && !QLEAD.test(src) };
}

/** Whole-document convenience (tests, minimap): rail flags for every line. */
export function quoteScan(lines: string[]): { member: boolean; lazy: boolean }[] {
  let st = QUOTE_START;
  return lines.map((src) => {
    const hit = quoteStep(st, src);
    st = hit.state;
    return { member: hit.member, lazy: hit.lazy };
  });
}

/** A line where the quote scan can be restarted from scratch (blank line resets both flags). */
export const isQuoteReset = (src: string) => src.trim() === '';

/* ---------- html rendering (minimap clone + tests) ---------- */

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Render one decorated line to HTML. Nested marks are emitted as nested spans. */
export function lineHTML(text: string, deco = decorateLine(text)): string {
  if (!text) return '<br>';
  const marks = [...deco.marks].sort((a, b) => a.from - b.from || b.to - a.to);
  let out = '';
  let pos = 0;
  const stack: { to: number }[] = [];
  const closeTo = (at: number) => {
    while (stack.length && stack[stack.length - 1].to <= at) {
      out += esc(text.slice(pos, stack[stack.length - 1].to));
      pos = stack[stack.length - 1].to;
      out += '</span>';
      stack.pop();
    }
  };
  for (const m of marks) {
    closeTo(m.from);
    out += esc(text.slice(pos, m.from));
    pos = m.from;
    out += `<span class="${m.cls}">`;
    stack.push({ to: m.to });
  }
  closeTo(text.length);
  out += esc(text.slice(pos));
  while (stack.length) { out += '</span>'; stack.pop(); }
  return out;
}
