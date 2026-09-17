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
  return { lineClass: '', marks: inlineMarks(text) };
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
