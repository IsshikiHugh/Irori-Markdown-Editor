/* Export to PDF: the text as the editor shows it — paper, ink, font, heading sizes, quote
   rails, list grid, the visible markdown markers — laid out on A4 pages, without the
   window chrome (TOC, minimap, title bar, drawer).

   The editor itself cannot simply be printed: CodeMirror only keeps the lines on screen in
   the DOM. So the whole document is rebuilt from its text with the same row renderer the
   minimap uses (tokens.ts), and paginated here rather than by the engine:

   - the text column keeps the editor's width (652px), so every paragraph wraps exactly where
     it wraps on screen;
   - each page is a window onto one continuous strip of rows, clipped at a gap BETWEEN two
     visual lines — a paragraph may continue on the next page, but a line is never cut;
   - the paper colour covers the whole sheet, margins included (engine page margins would
     be white), which is why the pages carry their own margins and the host prints with none.

   `#print` is invisible on screen; only the print media shows it (style.css). */

import type { Platform } from '../platform/types';
import { basename } from '../platform/paths';
import { codeLineDeco, decorateLine, fenceScan, imageLine, lineHTML, listScan, quoteScan, tableHTML, tableRanges, withListRow } from '../editor/tokens';

/** A4 height at 96 CSS px per inch (the width, 210mm, lives in style.css). */
export const PAGE_H = 1122.5;
/** top and bottom margin of every page */
export const PAGE_PAD = 72;
/** usable height of a page — a hair under the arithmetic, so rounding can never add a page */
export const PAGE_BODY = Math.floor(PAGE_H - 2 * PAGE_PAD) - 2;

/** The editor's head ornament (style.css: .cm-content::before/::after) — two hairlines tapering
    toward a hollow diamond — as a picture on the paper colour, in the same place. Not the CSS
    itself: WebKit's PDF output breaks that 1px gradient (its transparent stretches come out black
    and the taper is lost); a flat bitmap has nothing left to break. */
function ornament(): string {
  const k = 4; // drawn at 4× so it stays crisp in print
  const canvas = document.createElement('canvas');
  canvas.width = 260 * k;
  canvas.height = 13 * k;
  const g = canvas.getContext('2d');
  if (!g) return '';
  g.scale(k, k);
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#f7f3ec';
  g.fillRect(0, 0, 260, 13);
  const line = g.createLinearGradient(0, 0, 260, 0);
  const stops: [number, number][] = [[0, 0], [0.42, 0.9], [0.465, 0], [0.535, 0], [0.58, 0.9], [1, 0]];
  for (const [at, a] of stops) line.addColorStop(at, `rgba(195,183,164,${a})`);
  g.fillStyle = line;
  g.fillRect(0, 6, 260, 1);
  g.translate(131, 7);
  g.rotate(Math.PI / 4);
  g.strokeStyle = 'rgba(162,123,92,.65)';
  g.lineWidth = 1;
  g.strokeRect(-3.5, -3.5, 7, 7);
  return `<img src="${canvas.toDataURL()}" alt="">`;
}

/** `line`: the document line the row starts at (0 for the ornament) */
type Row = { html: string; cls: string; style: string; heading: boolean; blank: boolean; text: boolean; line: number };

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Every line of the document as a row, decorated exactly like the editor decorates it. */
export function buildRows(text: string, resolveAsset: (src: string) => string | null): Row[] {
  const lines = text.split('\n');
  const rails = quoteScan(lines);
  const lists = listScan(lines);
  // the head ornament opens the text, as on screen (its picture is drawn by preparePrint)
  const rows: Row[] = [{ html: '', cls: 'porn', style: '', heading: false, blank: false, text: false, line: 0 }];
  // a table is one row, rendered; a page may still end between two of its rows (lineGaps)
  const tables = tableRanges((n) => lines[n - 1], lines.length);
  const code = fenceScan(lines);
  let t = 0;
  lines.forEach((line, i) => {
    const table = tables[t];
    if (table && i + 1 >= table.from) {
      if (i + 1 === table.from) {
        const html = tableHTML(lines.slice(table.from - 1, table.to));
        rows.push({ html, cls: 'ln tblrow', style: '', heading: false, blank: false, text: true, line: i + 1 });
      }
      if (i + 1 === table.to) t++;
      return;
    }
    const part = code[i];
    if (part) {
      const deco = codeLineDeco(line, part);
      const html = lineHTML(line, deco);
      rows.push({ html, cls: 'ln ' + deco.lineClass, style: '', heading: false, blank: false, text: true, line: i + 1 });
      return;
    }
    const { deco, style } = withListRow(line, decorateLine(line), lists[i]);
    const cls = ['ln'];
    if (deco.lineClass) cls.push(deco.lineClass);
    if (rails[i].member) cls.push('quote');
    if (rails[i].lazy) cls.push('qlazy');
    const img = imageLine(line);
    let html: string;
    if (img) {
      cls.push('imgrow');
      const url = img.src ? resolveAsset(img.src) : null;
      const miss = `<span class="imgmiss"${url ? ' style="display:none"' : ''}>⚠ ${img.src ? '图片未找到 · ' + escapeAttr(img.src) : '空图片链接'}</span>`;
      html = `<span class="imgwrap">${url ? `<img src="${escapeAttr(url)}" alt="${escapeAttr(img.alt)}">` : ''}${miss}</span>`;
    } else {
      html = lineHTML(line, deco);
    }
    rows.push({
      html,
      cls: cls.join(' '),
      style,
      heading: /\bh[1-6]\b/.test(deco.lineClass),
      blank: line.trim() === '',
      text: !img,
      line: i + 1,
    });
  });
  return rows;
}

/** `data-line`: the row's line number in the document (the ornament has none) */
const rowHTML = (r: Row) =>
  `<div class="${r.cls}"${r.line ? ` data-line="${r.line}"` : ''}${r.style ? ` style="${r.style}"` : ''}>${r.html}</div>`;

/** Wait for every picture to settle (loaded or failed), so the rows can be measured. */
async function settleImages(root: HTMLElement, timeout = 8000) {
  const imgs = [...root.querySelectorAll('img')];
  await Promise.race([
    Promise.all(
      imgs.map(
        (img) =>
          new Promise<void>((done) => {
            const fail = () => {
              img.style.display = 'none';
              (img.nextElementSibling as HTMLElement | null)?.style.removeProperty('display');
              done();
            };
            if (img.complete) return img.naturalWidth ? done() : fail();
            img.addEventListener('load', () => done(), { once: true });
            img.addEventListener('error', fail, { once: true });
          }),
      ),
    ),
    new Promise((r) => setTimeout(r, timeout)),
  ]);
}

/** Where a page may end inside a text row: midway in the gap between two visual lines (px from
    the row's top). Measured from the laid-out glyph boxes, so mixed fonts and inline code can't
    throw the arithmetic off. */
function lineGaps(el: HTMLElement): number[] {
  const top = el.getBoundingClientRect().top;
  const range = document.createRange();
  range.selectNodeContents(el);
  const boxes = [...range.getClientRects()]
    .filter((r) => r.height > 0)
    .map((r) => ({ top: r.top - top, bottom: r.bottom - top }))
    .sort((a, b) => a.top - b.top);
  const lines: { top: number; bottom: number }[] = [];
  for (const b of boxes) {
    const last = lines[lines.length - 1];
    // same visual line: the boxes overlap vertically
    if (last && b.top < last.bottom - 1) last.bottom = Math.max(last.bottom, b.bottom);
    else lines.push({ ...b });
  }
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) gaps.push((lines[i - 1].bottom + lines[i].top) / 2);
  return gaps;
}

export type Page = { from: number; to: number; first: number; last: number };

type Measured = { top: number; bottom: number; gaps: () => number[] };

/** Split the strip [0, total) into pages no taller than `body`. Pure, so it is unit-testable. */
export function paginate(rows: (Measured & { heading: boolean; blank: boolean })[], body: number): Page[] {
  const pages: Page[] = [];
  const total = rows.length ? rows[rows.length - 1].bottom : 0;
  let from = 0;
  let first = 0;
  while (first < rows.length) {
    const end = from + body;
    if (end >= total) {
      pages.push({ from, to: total, first, last: rows.length - 1 });
      break;
    }
    // the row the page's lower edge falls in
    let last = first;
    while (rows[last].bottom <= end) last++;
    const r = rows[last];
    let cut = r.top;
    const fits = r.gaps().filter((g) => r.top + g <= end && r.top + g > from);
    if (fits.length) cut = r.top + fits[fits.length - 1];
    // a heading never ends a page: it moves over with the text it introduces
    for (let k = cut === r.top ? last - 1 : last; k >= first; k--) {
      if (rows[k].blank) continue;
      if (!rows[k].heading || rows[k].bottom > cut || rows[k].top <= from) break;
      cut = rows[k].top;
    }
    // a single block taller than the page (cannot happen for text; pictures are capped) is cut hard
    if (cut <= from) cut = end;
    let lastOnPage = last;
    while (lastOnPage > first && rows[lastOnPage].top >= cut) lastOnPage--;
    pages.push({ from, to: cut, first, last: lastOnPage });
    // the next page starts where this one stopped — minus blank lines, which would only push
    // its text down
    from = cut;
    first = rows[lastOnPage].bottom <= cut ? lastOnPage + 1 : lastOnPage;
    while (first < rows.length && rows[first].blank && rows[first].top >= from) {
      from = rows[first].bottom;
      first++;
    }
  }
  return pages;
}

/** Build the print pages for `text` into #print (replacing any previous ones). Resolves once
    fonts and pictures have settled and the pages are laid out. Returns the page count. */
export async function preparePrint(text: string, resolveAsset: (src: string) => string | null): Promise<number> {
  document.getElementById('print')?.remove();
  const rows = buildRows(text, resolveAsset);
  rows[0].html = ornament();

  // measure off-screen, in the same column the editor uses
  const measure = document.createElement('div');
  measure.className = 'pmeasure';
  measure.innerHTML = rows.map(rowHTML).join('');
  document.body.appendChild(measure);
  await settleImages(measure);
  await document.fonts?.ready;

  const els = [...measure.children] as HTMLElement[];
  const base = measure.getBoundingClientRect().top;
  const measured = els.map((el, i) => {
    const r = el.getBoundingClientRect();
    return {
      top: r.top - base,
      bottom: r.bottom - base,
      heading: rows[i].heading,
      blank: rows[i].blank,
      gaps: () => (rows[i].text ? lineGaps(el) : []),
    };
  });
  const pages = paginate(measured, PAGE_BODY);
  // an image the load check hid has to stay hidden in the pages too
  const html = els.map((el) => el.outerHTML);
  measure.remove();

  const root = document.createElement('div');
  root.id = 'print';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = pages
    .map((p) => {
      const shift = measured[p.first].top - p.from;
      return (
        `<section class="pg"><div class="pclip" style="height:${(p.to - p.from).toFixed(2)}px">` +
        `<div class="pflow" style="margin-top:${shift.toFixed(2)}px">${html.slice(p.first, p.last + 1).join('')}</div>` +
        `</div></section>`
      );
    })
    .join('');
  document.body.appendChild(root);
  await settleImages(root);
  return pages.length;
}

export function clearPrint() {
  document.getElementById('print')?.remove();
}

let busy = false;

/** ⌘P: ask where to (when the host can write the file itself), lay the pages out, print them. */
export async function exportPdf(
  platform: Platform,
  stemName: string,
  text: string,
  resolveAsset: (src: string) => string | null,
  toast: (msg: string) => void,
): Promise<void> {
  if (busy) return;
  busy = true;
  let system = false;
  try {
    let path: string | null = null;
    if (platform.writesPdf) {
      path = await platform.saveDialog(stemName + '.pdf', 'pdf');
      if (!path) return;
      toast('正在导出 PDF…');
    }
    await preparePrint(text, resolveAsset);
    system = !path;
    await platform.printPdf(path);
    if (path) toast('已导出 ' + basename(path));
  } catch (err) {
    toast('导出失败：' + (err instanceof Error ? err.message : String(err)));
  } finally {
    // the system dialog may still be reading the pages when it returns; they are hidden on
    // screen anyway and replaced by the next export
    if (!system) clearPrint();
    busy = false;
  }
}
