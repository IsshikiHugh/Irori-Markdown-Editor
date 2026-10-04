/* Export to PDF: the text as the editor shows it — paper, ink, font, heading sizes, quote
   rails, list grid, the visible markdown markers — laid out on A4 pages, without the
   window chrome (TOC, minimap, title bar, drawer) or the head ornament.

   The editor itself cannot simply be printed: CodeMirror only keeps the lines on screen in
   the DOM. So the whole document is rebuilt from its text with the same row renderer the
   minimap uses (tokens.ts), and paginated here rather than by the engine:

   - the text column keeps the editor's width (652px), so every paragraph wraps exactly where
     it wraps on screen;
   - each page is a window onto one continuous strip of rows, clipped at a gap BETWEEN two
     visual lines — a paragraph may continue on the next page, but a line is never cut;
   - the paper colour covers the whole sheet, margins included (engine page margins would
     be white), which is why the pages carry their own margins and the host prints with none.

   `#print` is invisible on screen; only the print media shows it (style.css).

   Two modes: colour (as on screen) and black & white, for printers — every mark pure black on
   pure white, no greys (style.css: `.pbw`); only pictures can't be split that way and go grey. */

import type { PdfMode, Platform } from '../platform/types';
import { highlightBlock, loadLanguages } from '../editor/highlight';
import { basename } from '../platform/paths';
import { codeLineDeco, decorateLine, fenceScan, imageLine, lineHTML, listScan, mathLineDeco, mathScan, quoteScan, tableHTML, tableRanges, withListRow } from '../editor/tokens';
import { loadMath, renderMath } from '../editor/math';

/** A4 height at 96 CSS px per inch (the width, 210mm, lives in style.css). */
export const PAGE_H = 1122.5;
/** top and bottom margin of every page */
export const PAGE_PAD = 72;
/** usable height of a page — a hair under the arithmetic, so rounding can never add a page */
export const PAGE_BODY = Math.floor(PAGE_H - 2 * PAGE_PAD) - 2;

/** `line`: the document line the row starts at */
type Row = { html: string; cls: string; style: string; heading: boolean; blank: boolean; text: boolean; line: number };

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Every line of the document as a row, decorated exactly like the editor decorates it. */
export function buildRows(text: string, resolveAsset: (src: string) => string | null): Row[] {
  const lines = text.split('\n');
  const rails = quoteScan(lines);
  const lists = listScan(lines);
  const rows: Row[] = [];
  // a table is one row, rendered; a page may still end between two of its rows (lineGaps)
  const tables = tableRanges((n) => lines[n - 1], lines.length);
  const code = fenceScan(lines);
  const maths = mathScan(lines);
  // inline math prints typeset, as the editor shows it away from the caret
  const inline = (tex: string) => renderMath(tex, false);
  let colours: { at: number; marks: ReturnType<typeof highlightBlock> } = { at: 0, marks: null };
  let t = 0;
  lines.forEach((line, i) => {
    const table = tables[t];
    if (table && i + 1 >= table.from) {
      if (i + 1 === table.from) {
        const html = tableHTML(lines.slice(table.from - 1, table.to), inline);
        rows.push({ html, cls: 'ln tblrow', style: '', heading: false, blank: false, text: true, line: i + 1 });
      }
      if (i + 1 === table.to) t++;
      return;
    }
    const math = maths[i];
    if (math) {
      // a math block is one row, typeset; it is never split across pages
      const html = renderMath(math.tex, true);
      if (html == null) {
        const deco = mathLineDeco(line, math, i + 1);
        rows.push({ html: lineHTML(line, deco), cls: 'ln ' + deco.lineClass, style: '', heading: false, blank: false, text: true, line: i + 1 });
      } else if (i + 1 === math.from) {
        rows.push({ html, cls: 'ln mathrow', style: '', heading: false, blank: false, text: false, line: i + 1 });
      }
      return;
    }
    const part = code[i];
    if (part) {
      const deco = codeLineDeco(line, part);
      if (part === 'body') {
        if (code[i - 1] === 'open') {
          // a new block: colour it whole, once
          let z = i;
          while (code[z + 1] === 'body') z++;
          colours = { at: i, marks: highlightBlock(lines[i - 1], lines.slice(i, z + 1)) };
        }
        deco.marks.push(...(colours.marks?.[i - colours.at] ?? []));
      }
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
      html = lineHTML(line, deco, inline);
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

/** `data-line`: the row's line number in the document */
const rowHTML = (r: Row) => `<div class="${r.cls}" data-line="${r.line}"${r.style ? ` style="${r.style}"` : ''}>${r.html}</div>`;

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
export async function preparePrint(text: string, resolveAsset: (src: string) => string | null, mode: PdfMode = 'color'): Promise<number> {
  document.getElementById('print')?.remove();
  // on the root, so the print media's page background follows too; set before measuring, since
  // the black & white code blocks trade padding for borders (same geometry, but measured anyway)
  document.documentElement.classList.toggle('pbw', mode === 'bw');
  // the code blocks' languages, so they print coloured
  const lines = text.split('\n');
  const parts = fenceScan(lines);
  await loadLanguages(lines.filter((_, i) => parts[i] === 'open'));
  if (text.includes('$')) await loadMath();
  const rows = buildRows(text, resolveAsset);

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
  document.documentElement.classList.remove('pbw');
}

/** Ask which PDF to make (the dialog #pdfmode): resolves with the choice, or null when it is
    dismissed (Esc, a click beside the box). `initial` — the last choice — has the focus, so
    Enter repeats it. */
export function choosePdfMode(initial: PdfMode): Promise<PdfMode | null> {
  const box = document.getElementById('pdfmode');
  if (!box) return Promise.resolve(initial);
  const buttons = [...box.querySelectorAll<HTMLButtonElement>('button[data-mode]')];
  return new Promise((resolve) => {
    const done = (mode: PdfMode | null) => {
      box.classList.remove('open');
      box.removeEventListener('keydown', onKey);
      box.removeEventListener('mousedown', onDown);
      for (const b of buttons) b.onclick = null;
      resolve(mode);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // handled here: the window's Esc (closing the drawer) must not fire as well
        e.preventDefault();
        e.stopPropagation();
        done(null);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(at + (e.key === 'ArrowLeft' ? buttons.length - 1 : 1)) % buttons.length].focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (e.target === box) done(null);
    };
    for (const b of buttons) {
      b.classList.toggle('primary', b.dataset.mode === initial);
      b.onclick = () => done(b.dataset.mode as PdfMode);
    }
    box.addEventListener('keydown', onKey);
    box.addEventListener('mousedown', onDown);
    box.classList.add('open');
    buttons.find((b) => b.dataset.mode === initial)?.focus();
  });
}

let busy = false;

/** ⌘P: ask which mode and where to (when the host can write the file itself), lay the pages
    out, print them. `remember` keeps the chosen mode for next time. */
export async function exportPdf(
  platform: Platform,
  stemName: string,
  text: string,
  resolveAsset: (src: string) => string | null,
  toast: (msg: string) => void,
  lastMode: PdfMode,
  remember: (mode: PdfMode) => void,
): Promise<void> {
  if (busy) return;
  busy = true;
  let system = false;
  try {
    const mode = await choosePdfMode(lastMode);
    if (!mode) return;
    remember(mode);
    let path: string | null = null;
    if (platform.writesPdf) {
      path = await platform.saveDialog(stemName + '.pdf', 'pdf');
      if (!path) return;
      toast('正在导出 PDF…');
    }
    await preparePrint(text, resolveAsset, mode);
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
