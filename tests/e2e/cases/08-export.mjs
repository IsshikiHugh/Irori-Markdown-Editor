/* PDF export: the text as the editor shows it, on A4 pages, without the window chrome. */
import { MOD, sleep } from '../harness.mjs';
import { PNG } from './02-image.mjs';

const PARA =
  '这是一段足够长的正文，用来看分页时段落是在两行之间断开，而不是把一行字从中间劈成两半。含 **粗体**、*斜体*、`代码` 与 [链接](https://example.com)。';
const lines = ['# 导出', '', '> 一段引用', '', '- 列表', '  - 嵌套', '9. 九', '10. 十', '', '![图](a/pic.png)', ''];
for (let i = 0; i < 24; i++) lines.push(`## 第 ${i} 节`, '', PARA.repeat(1 + (i % 4)), '');
const DOC = lines.join('\n');
const seed = { files: { '/n/长文.md': DOC }, images: { '/n/a/pic.png': PNG }, startup: '/n/长文.md' };

const mod = async (page, key) => {
  await page.keyboard.down(MOD);
  await page.keyboard.press(key);
  await page.keyboard.up(MOD);
};

/** ⌘P asks colour or black & white first; wait for that dialog */
const modeDialog = (page) => page.waitForFunction(() => document.getElementById('pdfmode').classList.contains('open'), { timeout: 5000 });

/** Every visible mark on the pages that is neither pure black nor pure white (or transparent):
    text colours, fills, borders. */
const notBlackWhite = (page) =>
  page.evaluate(() => {
    const ok = (c) => !c || c === 'rgb(0, 0, 0)' || c === 'rgb(255, 255, 255)' || c === 'rgba(0, 0, 0, 0)' || /rgba\(.*, 0\)$/.test(c);
    const bad = [];
    for (const el of document.querySelectorAll('#print, #print *')) {
      if (el.tagName === 'IMG') continue;
      const cs = getComputedStyle(el);
      const marks = [['color', cs.color], ['background', cs.backgroundColor]];
      for (const side of ['Top', 'Right', 'Bottom', 'Left'])
        if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none') marks.push([`border${side}`, cs[`border${side}Color`]]);
      if (cs.backgroundImage !== 'none') marks.push(['backgroundImage', cs.backgroundImage]);
      for (const [what, c] of marks) if (!ok(c)) bad.push(`${el.className || el.tagName} ${what} ${c}`);
    }
    return bad;
  });

/** Every visual line of every page: which document line it belongs to, and whether the page's
    clip cuts through it. */
const pageLines = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#print .pclip')].map((clip) => {
      const c = clip.getBoundingClientRect();
      const out = [];
      for (const row of clip.querySelectorAll('[data-line]')) {
        const range = document.createRange();
        range.selectNodeContents(row);
        const rt = row.getBoundingClientRect().top;
        const seen = new Set();
        for (const r of range.getClientRects()) {
          if (!r.height) continue;
          const key = Math.round(r.top - rt);
          if (seen.has(key)) continue;
          seen.add(key);
          const inside = r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5;
          const outside = r.bottom <= c.top + 0.5 || r.top >= c.bottom - 0.5;
          out.push({ line: +row.dataset.line, at: key, inside, cut: !inside && !outside, heading: /\bh[1-6]\b/.test(row.className) });
        }
      }
      return out;
    }),
  );

export const cases = [
  {
    id: 'B-80',
    name: '⌘P asks where to save the PDF, lays the pages out, and cleans up after itself',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await page.evaluate(() => window.__irori.platform.dialogQueue.push('/n/out/长文.pdf'));
      await page.click('.cm-content');
      await mod(page, 'p');
      await modeDialog(page);
      await page.keyboard.press('Enter'); // colour: the default
      await page.waitForFunction(() => window.__irori.platform.pdfs.length > 0, { timeout: 10000 });
      const r = await page.evaluate(() => ({
        pdfs: window.__irori.platform.pdfs,
        file: window.__irori.platform.files.has('/n/out/长文.pdf'),
      }));
      t.eq('exported once, to the chosen path', r.pdfs.map((p) => p.path), ['/n/out/长文.pdf']);
      t.eq('in colour', r.pdfs[0].bw, false);
      t.ok('the long document spans several pages', r.pdfs[0].pages >= 3, r.pdfs[0].pages);
      t.ok('the file was written', r.file, '');
      await sleep(50);
      t.ok('the print pages are gone afterwards', !(await page.evaluate(() => !!document.getElementById('print'))), '');
      await sleep(100);
      t.ok('toast names the file', (await page.evaluate(() => document.getElementById('toast').textContent)).includes('长文.pdf'), '');
      t.eq('the document itself is untouched', await page.evaluate(() => window.__irori.view.state.doc.toString()), DOC);
    },
  },
  {
    id: 'B-81',
    name: 'Cancelling the save dialog exports nothing; the drawer button exports too',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await page.click('.cm-content');
      await mod(page, 'p');
      await modeDialog(page);
      await page.keyboard.press('Enter');
      // dialogQueue is empty → the save dialog answers "cancel"
      await sleep(300);
      t.eq('nothing exported', await page.evaluate(() => window.__irori.platform.pdfs.length), 0);
      t.ok('no print pages left behind', !(await page.evaluate(() => !!document.getElementById('print'))), '');
      await page.evaluate(() => {
        window.__irori.platform.dialogQueue.push('/n/b.pdf');
        document.body.classList.add('menuopen');
      });
      await sleep(300);
      await page.click('#pdfbtn');
      await modeDialog(page);
      await page.click('#pdfcolor');
      await page.waitForFunction(() => window.__irori.platform.pdfs.length > 0, { timeout: 10000 });
      t.eq('the button exported', await page.evaluate(() => window.__irori.platform.pdfs[0].path), '/n/b.pdf');
      t.ok('and closed the drawer', !(await page.evaluate(() => document.body.classList.contains('menuopen'))), '');
    },
  },
  {
    id: 'B-82',
    name: 'Pages break between lines: no line is cut, lost or repeated, and no page ends on a heading',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await page.evaluate(() => window.__irori.preparePrint());
      await page.emulateMediaType('print'); // the pages only exist on paper
      const pages = await pageLines(page);
      const all = pages.flat();
      t.ok('several pages', pages.length >= 3, pages.length);
      t.eq('no line is cut by a page edge', all.filter((l) => l.cut).length, 0);
      // …which only means something if a paragraph does run on across a page break
      const onPage = pages.map((p) => new Set(p.filter((l) => l.inside).map((l) => l.line)));
      t.ok('some paragraph continues on the next page', onPage.some((set, i) => i && [...set].some((n) => onPage[i - 1].has(n))), '');
      const shown = all.filter((l) => l.inside).map((l) => `${l.line}:${l.at}`);
      t.eq('no line shows twice', shown.length, new Set(shown).size);
      const lost = lines
        .map((text, i) => ({ text, n: i + 1 }))
        .filter(({ text, n }) => text.trim() && !all.some((l) => l.inside && l.line === n));
      t.eq('every non-blank line of the document is on some page', lost.map((l) => l.n), []);
      const endsOnHeading = pages.slice(0, -1).filter((p) => {
        const vis = p.filter((l) => l.inside);
        return vis.length && vis[vis.length - 1].heading;
      });
      t.eq('no page but the last ends on a heading', endsOnHeading.length, 0);
    },
  },
  {
    id: 'B-83',
    name: 'The pages look like the editor: same rows, font, colours and line wrapping',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await page.evaluate(() => window.__irori.preparePrint());
      // the same heading and the same paragraph, once in the editor (on screen), once on a page
      // (on paper)
      const probe = () => {
        const pick = (el) => {
          const cs = getComputedStyle(el);
          return { font: cs.fontFamily, size: cs.fontSize, color: cs.color, weight: cs.fontWeight, lh: cs.lineHeight, w: Math.round(el.getBoundingClientRect().width) };
        };
        const root = document.getElementById('print').offsetParent ? '#print' : '.cm-content';
        const q = (sel) => document.querySelector(`${root} ${sel}`);
        const para = [...document.querySelectorAll(`${root} .ln`)].find((el) => el.textContent.startsWith('这是一段足够长'));
        return {
          h1: pick(q('.ln.h1')),
          quote: getComputedStyle(q('.ln.quote')).borderLeft,
          tok: getComputedStyle(q('.tok')).color,
          para: pick(para),
          // a paragraph that fits on one page wraps into the same number of lines: same height
          height: para.getBoundingClientRect().height,
        };
      };
      const ed = await page.evaluate(probe);
      await page.emulateMediaType('print');
      const pr = await page.evaluate(probe);
      const s = await page.evaluate(() => ({
        paper: getComputedStyle(document.querySelector('#print .pg')).backgroundColor,
        img: !!document.querySelector('#print .imgwrap img'),
      }));
      t.eq('heading styled the same', pr.h1, ed.h1);
      t.eq('quote rail the same', pr.quote, ed.quote);
      t.eq('markdown markers keep their colour', pr.tok, ed.tok);
      t.eq('paragraph: same font, colour and column width', pr.para, ed.para);
      t.near('paragraph wraps the same', pr.height, ed.height, 0.5);
      t.eq('pages are the paper colour', s.paper, 'rgb(247, 243, 236)');
      t.ok('pictures are shown, not their source', s.img, '');
    },
  },
  {
    id: 'B-84',
    name: 'Printed, only the pages show — no TOC, minimap, title bar or drawer — one A4 sheet per page',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      const n = await page.evaluate(() => window.__irori.preparePrint());
      await page.emulateMediaType('print');
      const shown = await page.evaluate(() =>
        Object.fromEntries(
          ['#ptoc', '#mini', '.stage', '.drawer', '#hair', '#print'].map((sel) => [sel, getComputedStyle(document.querySelector(sel)).display !== 'none']),
        ),
      );
      t.eq('only #print is visible', shown, { '#ptoc': false, '#mini': false, '.stage': false, '.drawer': false, '#hair': false, '#print': true });
      const pdf = Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
      const raw = pdf.toString('latin1');
      const sheets = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
      t.eq('one PDF page per laid-out page', sheets, n);
      const box = raw.match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/);
      t.ok('A4 sheets', box && Math.abs(+box[1] - 595.3) < 1 && Math.abs(+box[2] - 841.9) < 1, box && box[0]);
    },
  },
  {
    id: 'B-105',
    name: 'The mode dialog: Enter repeats the last choice, Esc exports nothing, the choice is remembered',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await page.click('.cm-content');
      await mod(page, 'p');
      await modeDialog(page);
      t.eq('colour is the first default', await page.evaluate(() => document.activeElement.id), 'pdfcolor');
      await page.keyboard.press('Escape');
      await sleep(200);
      const r = await page.evaluate(() => ({
        open: document.getElementById('pdfmode').classList.contains('open'),
        pdfs: window.__irori.platform.pdfs.length,
      }));
      t.eq('Esc closes it and exports nothing', r, { open: false, pdfs: 0 });

      await page.evaluate(() => window.__irori.platform.dialogQueue.push('/n/bw.pdf'));
      await mod(page, 'p');
      await modeDialog(page);
      await page.keyboard.press('ArrowLeft');
      t.eq('arrows move between the choices', await page.evaluate(() => document.activeElement.id), 'pdfbw');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__irori.platform.pdfs.length > 0, { timeout: 10000 });
      t.eq('exported in black & white', await page.evaluate(() => (({ path, bw }) => ({ path, bw }))(window.__irori.platform.pdfs[0])), { path: '/n/bw.pdf', bw: true });
      t.eq('the choice is kept in the settings', await page.evaluate(() => window.__irori.settings.value.pdfMode), 'bw');
      t.ok('nothing of black & white lingers afterwards', !(await page.evaluate(() => document.documentElement.classList.contains('pbw'))), '');

      await mod(page, 'p');
      await modeDialog(page);
      const next = await page.evaluate(() => ({ focus: document.activeElement.id, primary: document.querySelector('#pdfmode .primary').id }));
      t.eq('next time black & white is the default', next, { focus: 'pdfbw', primary: 'pdfbw' });
      await page.mouse.click(5, 5); // beside the box
      await sleep(200);
      t.ok('a click beside the box dismisses it', !(await page.evaluate(() => document.getElementById('pdfmode').classList.contains('open'))), '');
      t.eq('still one export', await page.evaluate(() => window.__irori.platform.pdfs.length), 1);
    },
  },
  {
    id: 'B-106',
    name: 'Black & white pages: pure black on pure white, no greys — same pages, same line wrapping',
    async run(t, ctx) {
      const code = ['', '```js', 'const answer = 42; // a comment', '```', '', '| a | b |', '| - | - |', '| 1 | 2 |', '', '行内 $x^2$ 与 `code`', ''];
      const page = await ctx.open({ ...seed, files: { '/n/长文.md': DOC + code.join('\n') } });
      const layout = () =>
        page.evaluate(() => [...document.querySelectorAll('#print .pg')].map((pg) => [...pg.querySelectorAll('[data-line]')].map((r) => `${r.dataset.line}:${Math.round(r.getBoundingClientRect().height)}`).join(' ')));
      const colour = await page.evaluate(() => window.__irori.preparePrint('color'));
      await page.emulateMediaType('print');
      const colourLayout = await layout();
      t.ok('the colour pages do have colour', (await notBlackWhite(page)).length > 0, '');
      await page.emulateMediaType('screen');
      const bw = await page.evaluate(() => window.__irori.preparePrint('bw'));
      await page.emulateMediaType('print');
      t.eq('same number of pages', bw, colour);
      t.eq('every row on the same page, at the same height', await layout(), colourLayout);
      t.eq('no mark is anything but black or white', await notBlackWhite(page), []);
      const s = await page.evaluate(() => ({
        paper: getComputedStyle(document.querySelector('#print .pg')).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        frame: getComputedStyle(document.querySelector('#print .ln.cb.cbopen')).borderTopColor,
        rail: getComputedStyle(document.querySelector('#print .ln.quote')).borderLeftColor,
        img: getComputedStyle(document.querySelector('#print .imgwrap img')).filter,
      }));
      t.eq('white paper, black frames and rails, grey pictures', s, { paper: 'rgb(255, 255, 255)', body: 'rgb(255, 255, 255)', frame: 'rgb(0, 0, 0)', rail: 'rgb(0, 0, 0)', img: 'grayscale(1)' });
      t.ok('no head ornament on the pages', !(await page.evaluate(() => document.querySelector('#print img:not(.imgwrap img)'))), '');
    },
  },
];
