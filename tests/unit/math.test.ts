import { describe, expect, it } from 'vitest';
import { inlineMarks, lineHTML, mathLineDeco, mathRanges, mathScan, tableRanges } from '../../src/editor/tokens';
import { loadMath, renderMath } from '../../src/editor/math';

const spans = (text: string, cls: string) =>
  inlineMarks(text)
    .filter((m) => m.cls === cls)
    .map((m) => text.slice(m.from, m.to));

describe('inline math', () => {
  it('marks $…$ and $$…$$, dollars dimmed, commands picked out', () => {
    const t = '能量 $E=mc^2$ 与 $$\\sum_i x_i$$ 守恒';
    expect(spans(t, 'math')).toEqual(['$E=mc^2$', '$$\\sum_i x_i$$']);
    expect(spans(t, 'mcmd')).toEqual(['\\sum']);
    expect(spans(t, 'tok')).toEqual(['$', '$', '$$', '$$']);
  });

  it('leaves prices, escaped dollars and blank-padded dollars alone', () => {
    expect(spans('花了 $5 和 $10', 'math')).toEqual([]);
    expect(spans('\\$x$ 不是公式', 'math')).toEqual([]);
    expect(spans('$ x $', 'math')).toEqual([]);
    expect(spans('$20$ 元', 'math')).toEqual(['$20$']);
  });

  it('wins over emphasis inside it and loses to code', () => {
    expect(spans('$a*b*c$', 'i')).toEqual([]);
    expect(spans('`$x$`', 'math')).toEqual([]);
  });
});

describe('math blocks', () => {
  const doc = (lines: string[]) => mathRanges((n) => lines[n - 1], lines.length);

  it('finds $$ … $$ blocks and one-line $$tex$$', () => {
    const lines = ['前', '$$', 'a^2', '+b^2', '$$', '$$ x = 1 $$', '后'];
    expect(doc(lines)).toEqual([
      { from: 2, to: 5, tex: 'a^2\n+b^2' },
      { from: 6, to: 6, tex: 'x = 1' },
    ]);
    expect(mathScan(lines).map((r) => (r ? r.from : 0))).toEqual([0, 2, 2, 2, 2, 6, 0]);
  });

  it('an unclosed $$ is text; $$ inside a code block is code', () => {
    expect(doc(['$$', 'x'])).toEqual([]);
    expect(doc(['```', '$$', 'x', '$$', '```'])).toEqual([]);
  });

  it('a table inside a math block is not a table', () => {
    const lines = ['$$', 'a | b', '--- | ---', '$$'];
    expect(tableRanges((n) => lines[n - 1], lines.length)).toEqual([]);
  });

  it('decorates its source lines', () => {
    const r = { from: 1, to: 3, tex: '\\frac{a}{b}' };
    expect(mathLineDeco('$$', r, 1)).toEqual({ lineClass: 'mb mbopen', marks: [{ from: 0, to: 2, cls: 'tok' }] });
    const body = mathLineDeco('\\frac{a}{b}', r, 2);
    expect(body.lineClass).toBe('mb');
    expect(body.marks.filter((m) => m.cls === 'mcmd')).toEqual([{ from: 0, to: 5, cls: 'mcmd' }]);
    const one = mathLineDeco('$$x$$', { from: 1, to: 1, tex: 'x' }, 1);
    expect(one.lineClass).toBe('mb mbopen mbclose');
    expect(one.marks.filter((m) => m.cls === 'tok')).toEqual([
      { from: 0, to: 2, cls: 'tok' },
      { from: 3, to: 5, cls: 'tok' },
    ]);
  });
});

describe('typesetting', () => {
  it('is null until KaTeX has loaded, then HTML; a bad formula does not throw', async () => {
    await loadMath();
    expect(renderMath('\\frac{1}{2}', true)).toContain('katex-display');
    expect(renderMath('\\frac{1}{', false)).toContain('katex-error');
  });

  it('prints inline math typeset when asked, source otherwise', async () => {
    await loadMath();
    const t = '设 $x^2$ 为 **正**';
    expect(lineHTML(t)).toContain('<span class="math">');
    const printed = lineHTML(t, undefined, (tex) => renderMath(tex, false));
    expect(printed).toContain('<span class="mathr"><span class="katex">');
    expect(printed).not.toContain('x^2');
    expect(printed).toContain('<span class="b">');
  });
});
