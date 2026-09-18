import { describe, expect, it } from 'vitest';
import { buildRows, paginate } from '../../src/features/export';

/** A strip of rows: each entry is [lines, kind], every visual line 40px tall. */
type Kind = 'text' | 'heading' | 'blank' | 'block';
function strip(spec: [number, Kind][]) {
  let y = 0;
  return spec.map(([lines, kind]) => {
    const top = y;
    const h = kind === 'block' ? lines : lines * 40;
    y += h;
    return {
      top,
      bottom: top + h,
      heading: kind === 'heading',
      blank: kind === 'blank',
      // gaps between visual lines, in the middle of the 40px line boxes' shared edge
      gaps: () => (kind === 'text' ? Array.from({ length: lines - 1 }, (_, i) => (i + 1) * 40) : []),
    };
  });
}

describe('pagination', () => {
  it('keeps a short document on one page', () => {
    const pages = paginate(strip([[3, 'text']]), 1000);
    expect(pages).toEqual([{ from: 0, to: 120, first: 0, last: 0 }]);
  });

  it('splits a long paragraph only between two lines', () => {
    // 30 lines of 40px on 100px pages: 2 lines fit, never 2.5
    const pages = paginate(strip([[30, 'text']]), 100);
    for (const p of pages) {
      expect(p.from % 40).toBe(0);
      expect(p.to % 40).toBe(0);
      expect(p.to - p.from).toBeLessThanOrEqual(100);
    }
    expect(pages.length).toBe(15);
    expect(pages[pages.length - 1].to).toBe(1200);
  });

  it('covers the whole strip, each stretch exactly once', () => {
    const rows = strip([[1, 'heading'], [4, 'text'], [1, 'blank'], [7, 'text'], [1, 'blank'], [2, 'text']]);
    const pages = paginate(rows, 130);
    let at = 0;
    for (const p of pages) {
      // a gap between pages can only be blank lines that were dropped at a page top
      for (const r of rows) if (r.top >= at && r.bottom <= p.from) expect(r.blank).toBe(true);
      at = p.to;
    }
    expect(at).toBe(rows[rows.length - 1].bottom);
  });

  it('moves a heading that would end a page over to the next one', () => {
    // page is 200px: text (120) + blank (40) + heading (40) would fill it exactly
    const rows = strip([[3, 'text'], [1, 'blank'], [1, 'heading'], [5, 'text']]);
    const pages = paginate(rows, 200);
    expect(pages[0].to).toBe(160); // ends before the heading…
    expect(pages[1].from).toBe(160); // …which opens the next page
    expect(pages[1].first).toBe(2);
  });

  it('does not start a page with blank lines', () => {
    const rows = strip([[2, 'text'], [2, 'blank'], [2, 'text']]);
    const pages = paginate(rows, 80);
    expect(pages[1].first).toBe(2);
    expect(pages[1].from).toBe(160);
  });

  it('cuts a block taller than a page rather than looping forever', () => {
    const pages = paginate(strip([[1, 'text'], [250, 'block'], [1, 'text']]), 100);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[pages.length - 1].to).toBe(330);
  });
});

describe('export rows', () => {
  it('decorates each line like the editor and opens with the ornament', () => {
    const rows = buildRows('# 标题\n\n> 引用\n- 项\n![](a.png)', () => 'blob:x');
    expect(rows[0].cls).toBe('porn');
    expect(rows.slice(1).map((r) => r.cls)).toEqual(['ln h1', 'ln', 'ln quote', 'ln li', 'ln imgrow']);
    expect(rows[1].heading).toBe(true);
    expect(rows[2].blank).toBe(true);
    expect(rows[4].style).toContain('--li-mark');
    expect(rows[5].html).toContain('<img src="blob:x"');
    // the markdown markers stay in the text, as on screen
    expect(rows[1].html.replace(/<[^>]+>/g, '')).toBe('# 标题');
  });

  it('shows a picture it cannot resolve as the editor does', () => {
    const rows = buildRows('![](gone.png)', () => null);
    expect(rows[1].html).toContain('图片未找到 · gone.png');
    expect(rows[1].html).not.toContain('<img');
  });
});
