import { describe, expect, it } from 'vitest';
import {
  decorateLine,
  imageLine,
  inlineMarks,
  lineHTML,
  linkParts,
  listItem,
  listRows,
  listScan,
  parseTable,
  quoteScan,
  tableCells,
  tableHTML,
  tableRanges,
  tableSourceDeco,
  withListRow,
} from '../../src/editor/tokens';

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

describe('lists', () => {
  it('recognises bullets and numbers followed by a blank', () => {
    expect(listItem('- a')).toMatchObject({ indent: '', marker: '-', gap: ' ', ordered: false });
    expect(listItem('* a')?.marker).toBe('*');
    expect(listItem('+ a')?.marker).toBe('+');
    expect(listItem('  12. a')).toMatchObject({ indent: '  ', marker: '12.', ordered: true });
    expect(listItem('3) a')?.ordered).toBe(true);
    expect(listItem('- ')).not.toBeNull(); // an item just being typed
  });

  it('does not mistake other lines for items', () => {
    for (const s of ['-a', '1.5 kg', '**粗体** 开头', '*斜体*', '---', '* * *', '- - -', '1234567890. a', '　　正文']) {
      expect(listItem(s), s).toBeNull();
    }
  });

  it('marks the indent and marker, and decorates the rest on its own', () => {
    const d = decorateLine('  - 有 *斜体*');
    expect(d.lineClass).toBe('li');
    expect(d.marks.slice(0, 2)).toEqual([
      { from: 0, to: 2, cls: 'lind' },
      { from: 2, to: 4, cls: 'lmark' },
    ]);
    expect(d.marks.some((m) => m.cls === 'i' && m.from === 6)).toBe(true);
    // the bullet star never pairs with a later star
    expect(decorateLine('* a *b').marks.some((m) => m.cls === 'i')).toBe(false);
    expect(decorateLine('10. a').marks[0]).toEqual({ from: 0, to: 4, cls: 'lnum' });
  });

  it('sizes every number box of a list by its longest number, so the dots line up', () => {
    const rows = listScan(['9. a', '10. b', '11. c']);
    expect(rows).toEqual([
      { ind: 0, mark: 4 },
      { ind: 0, mark: 4 },
      { ind: 0, mark: 4 },
    ]);
    expect(listScan(['1. a', '2. b'])[0]).toEqual({ ind: 0, mark: 3 });
  });

  it('keeps nested lists and separate lists apart', () => {
    const rows = listScan(['1. a', '   1. x', '   2. y', '10. b', '', '9. p', '', '段落', '1. q']);
    expect(rows[1]).toEqual({ ind: 3, mark: 3 }); // the nested list has its own width
    expect(rows[3]).toEqual({ ind: 0, mark: 4 });
    expect(rows[5]).toEqual({ ind: 0, mark: 4 }); // a blank line does not end the list
    expect(rows[8]).toEqual({ ind: 0, mark: 3 }); // a paragraph does
    expect(rows[7]).toBeNull();
  });

  it('gives indented lines inside a list the indent box only', () => {
    const rows = listScan(['- a', '  续行', '', '    还在', '段落', '  不在列表里']);
    expect(rows.map((r) => r && r.ind)).toEqual([0, 2, null, 4, null, null]);
    expect(rows[1]!.mark).toBe(0);
    const { deco, style } = withListRow('  续行', decorateLine('  续行'), rows[1]);
    expect(deco.lineClass).toBe('li');
    expect(deco.marks[0]).toEqual({ from: 0, to: 2, cls: 'lind' });
    expect(style).toBe('--li-ind:2;--li-mark:0');
  });

  it('counts a tab as reaching the next multiple of four columns', () => {
    expect(listScan(['- a', '\t- b'])[1]).toEqual({ ind: 4, mark: 2 });
  });

  it('looks past the requested lines for the enclosing list', () => {
    const doc = ['段落', '8. a', '9. b', '10. c', '段落'];
    const rows = listRows((n) => doc[n - 1], doc.length, 3, 3);
    expect(rows).toEqual([{ ind: 0, mark: 4 }]);
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

describe('links', () => {
  it('finds the hidden parts: the [ in front and the ](url) behind', () => {
    const text = '看 [文档](https://x.y) 吧';
    const [l] = linkParts(text, inlineMarks(text));
    expect(text.slice(l.from, l.to)).toBe('[文档](https://x.y)');
    expect(text.slice(l.head.from, l.head.to)).toBe('[');
    expect(text.slice(l.tail.from, l.tail.to)).toBe('](https://x.y)');
  });
  it('leaves an image source and code alone', () => {
    expect(linkParts('![a](b.png)', inlineMarks('![a](b.png)'))).toEqual([]);
    expect(linkParts('`[a](b)`', inlineMarks('`[a](b)`'))).toEqual([]);
  });
});

describe('tables', () => {
  const doc = ['前文', '| 名称 | 数量 |', '| :-- | --: |', '| 苹果 | 3 |', '| 梨 | 12 |', '', '后文'];
  const at = (n: number) => doc[n - 1];

  it('splits cells at unescaped pipes outside code', () => {
    expect(tableCells('| a | `x|y` | b\\|c |')!.map((c) => c.text)).toEqual(['a', '`x|y`', 'b\\|c']);
    expect(tableCells('a | b')!.map((c) => c.text)).toEqual(['a', 'b']);
    expect(tableCells('没有竖线')).toBeNull();
  });
  it('records where each cell text starts', () => {
    const cells = tableCells('|  名称 | x |')!;
    expect(cells[0].at).toBe(3);
    expect(cells[1].at).toBe(8);
  });
  it('finds a table: header, delimiter, body up to a blank line', () => {
    expect(tableRanges(at, doc.length)).toEqual([{ from: 2, to: 5 }]);
  });
  it('needs a delimiter row with as many cells as the header', () => {
    expect(tableRanges((n) => ['a | b', '---'][n - 1], 2)).toEqual([]);
    expect(tableRanges((n) => ['a | b', 'c | d'][n - 1], 2)).toEqual([]);
    expect(tableRanges((n) => ['| a |', '| --- |'][n - 1], 2)).toEqual([{ from: 1, to: 2 }]);
  });
  it('stops at a line without a pipe', () => {
    const d = ['a | b', '--|--', '1 | 2', '正文'];
    expect(tableRanges((n) => d[n - 1], d.length)).toEqual([{ from: 1, to: 3 }]);
  });
  it('reads the alignment and pads short rows', () => {
    const t = parseTable(['a | b | c', ':-: | --: | :--', '1']);
    expect(t.align).toEqual(['center', 'right', 'left']);
    expect(t.rows[0].map((c) => c.text)).toEqual(['1', '', '']);
  });
  it('renders cells with data-off pointing at their text in the source', () => {
    const lines = doc.slice(1, 5);
    const src = lines.join('\n');
    const html = tableHTML(lines);
    const offs = [...html.matchAll(/data-off="(\d+)"/g)].map((m) => +m[1]);
    expect(offs.map((o) => src.slice(o, o + 2))).toEqual(['名称', '数量', '苹果', '3 ', '梨 ', '12']);
    expect(html).toContain('style="text-align:right"');
  });
  it('marks the pipes and the delimiter row as markup in source', () => {
    const d = tableSourceDeco('| **a** | b |', false);
    expect(d.marks.filter((m) => m.cls === 'tok' && m.to - m.from === 1).length).toBeGreaterThanOrEqual(3);
    expect(d.marks.some((m) => m.cls === 'b')).toBe(true);
    expect(tableSourceDeco('| --- |', true).marks).toEqual([{ from: 0, to: 7, cls: 'tok' }]);
  });
});
