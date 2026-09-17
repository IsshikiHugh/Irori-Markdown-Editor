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
    // [text](url)
    re: /\[([^\]]*)\]\(([^)]+)\)/g,
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
