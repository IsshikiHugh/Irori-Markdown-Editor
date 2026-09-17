import { describe, expect, it } from 'vitest';
import { decorateLine, imageLine, inlineMarks, lineHTML, quoteScan } from '../../src/editor/tokens';

const classesAt = (text: string, i: number) =>
  inlineMarks(text)
    .filter((m) => m.from <= i && i < m.to)
    .map((m) => m.cls)
    .sort();

describe('inline decoration', () => {
  it('keeps every marker inside the text (source is never rewritten)', () => {
    const text = '这是 **粗体** 与 *斜体*';
    expect(lineHTML(text).replace(/<[^>]+>/g, '')).toBe(text);
  });

  it('marks bold and its tokens', () => {
    const text = 'a **b** c';
    expect(classesAt(text, 2)).toEqual(['b', 'tok']); // the first '*'
    expect(classesAt(text, 4)).toEqual(['b']); // the letter
  });

  it('does not let italic eat into bold (the old placeholder bug)', () => {
    const text = '**粗** 和 *斜*';
    const marks = inlineMarks(text);
    const bolds = marks.filter((m) => m.cls === 'b');
    const italics = marks.filter((m) => m.cls === 'i');
    expect(bolds).toHaveLength(1);
    expect(italics).toHaveLength(1);
    expect(italics[0].from).toBeGreaterThan(bolds[0].to);
  });

  it('parses ***bold italic*** as both', () => {
    const cls = inlineMarks('***x***')
      .filter((m) => m.cls === 'b' || m.cls === 'i')
      .map((m) => m.cls)
      .sort();
    expect(cls).toEqual(['b', 'i']);
  });

  it('inline code wins over emphasis inside it', () => {
    const marks = inlineMarks('`a*b*c`');
    expect(marks.some((m) => m.cls === 'i')).toBe(false);
    expect(marks.some((m) => m.cls === 'code')).toBe(true);
  });

  it('links mark text, url and brackets separately', () => {
    const marks = inlineMarks('[标题](https://x.y/z)');
    expect(marks.filter((m) => m.cls === 'lnk')).toHaveLength(1);
    expect(marks.filter((m) => m.cls === 'url')).toHaveLength(1);
    expect(marks.filter((m) => m.cls === 'tok')).toHaveLength(3);
  });

  it('escapes html in the rendered clone', () => {
    expect(lineHTML('<script>')).toContain('&lt;script&gt;');
  });
});

describe('line decoration', () => {
  it('classifies headings h1..h6 and dims the marker', () => {
    for (let n = 1; n <= 6; n++) {
      const d = decorateLine('#'.repeat(n) + ' 标题');
      expect(d.lineClass).toBe('h' + n);
      expect(d.marks[0]).toEqual({ from: 0, to: n + 1, cls: 'tok' });
    }
  });

  it('treats <!--more--> as its own line kind', () => {
    expect(decorateLine('<!--more-->').lineClass).toBe('morecomment');
    expect(decorateLine('<!-- more -->').lineClass).toBe('morecomment');
  });

  it('marks the quote marker but leaves rail membership to the scan', () => {
    const d = decorateLine('> 引用');
    expect(d.lineClass).toBe('');
    expect(d.marks[0]).toEqual({ from: 0, to: 2, cls: 'tok' });
  });

  it('decorates inline content inside a heading', () => {
    const d = decorateLine('## 有 **粗体** 的标题');
    expect(d.marks.some((m) => m.cls === 'b')).toBe(true);
  });
});

describe('blockquote rail grouping', () => {
  it('joins consecutive quote lines and lazy continuations', () => {
    const rails = quoteScan(['> 一', '二', '> 三', '', '四']);
    expect(rails.map((r) => r.member)).toEqual([true, true, true, false, false]);
    expect(rails[1].lazy).toBe(true);
  });

  it('a bare ">" closes the paragraph so the next plain line is out', () => {
    const rails = quoteScan(['> 一', '>', '二']);
    expect(rails.map((r) => r.member)).toEqual([true, true, false]);
  });

  it('a new block interrupts the rail', () => {
    const rails = quoteScan(['> 一', '# 标题']);
    expect(rails.map((r) => r.member)).toEqual([true, false]);
  });
});

describe('image lines', () => {
  it('recognises a bare image line', () => {
    expect(imageLine('![alt](a/b.png)')).toEqual({ quote: '', alt: 'alt', src: 'a/b.png' });
  });
  it('recognises an image inside a quote', () => {
    expect(imageLine('> ![](x.png)')?.quote).toBe('> ');
  });
  it('ignores an image with text around it', () => {
    expect(imageLine('看 ![](x.png)')).toBeNull();
  });
});
