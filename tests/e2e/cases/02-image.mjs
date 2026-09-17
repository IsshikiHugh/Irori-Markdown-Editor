/* Image lines — the one exception to source decoration.
   Invariant: the line holding the caret is always source; every other image line is always an image. */
import { caretToLine, docText, sleep } from '../harness.mjs';

// 4x3 PNG (red), enough for naturalWidth/Height to be meaningful
export const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';

const DOC = ['# 图片', '', '![一张图](a/pic.png)', '', '> ![](a/pic.png)', '', '![](a/missing.png)', '', '结尾'].join('\n');

const seed = {
  files: { '/n/a.md': DOC },
  images: { '/n/a/pic.png': PNG },
  startup: '/n/a.md',
};

export const cases = [
  {
    id: 'B-10',
    name: 'Image lines render as images (at natural size, no fixed frame)',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(150);
      const info = await page.evaluate(() => {
        const img = document.querySelector('.cm-content .imgwrap img');
        const s = img && getComputedStyle(img);
        return img ? { ok: true, maxW: s.maxWidth, display: s.display, complete: img.complete, w: img.naturalWidth } : { ok: false };
      });
      t.ok('image element exists', info.ok, JSON.stringify(info));
      t.eq('max-width:100%', info.maxW, '100%');
      t.ok('image has loaded', info.complete && info.w === 4, JSON.stringify(info));
    },
  },
  {
    id: 'B-11',
    name: 'Caret enters an image line → that line turns back into editable source; caret leaves → back to an image',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(100);
      await caretToLine(page, 3);
      await sleep(60);
      const onLine = await page.evaluate(() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')];
        const row = lines.find((l) => l.textContent === '![一张图](a/pic.png)');
        return { found: !!row, imgs: document.querySelectorAll('.cm-content .imgwrap img').length };
      });
      t.ok('turned back into editable source', onLine.found, '');
      t.eq('this line\'s image widget is gone (the other is still there)', onLine.imgs, 1);
      await caretToLine(page, 1);
      await sleep(60);
      const offLine = await page.evaluate(() => ({
        source: [...document.querySelectorAll('.cm-content .cm-line')].some((l) => l.textContent === '![一张图](a/pic.png)'),
        imgs: document.querySelectorAll('.cm-content .imgwrap img').length,
      }));
      t.ok('source no longer shown after leaving', !offLine.source, '');
      t.eq('both images are back', offLine.imgs, 2);
    },
  },
  {
    id: 'B-12',
    name: 'Arrow keys step into an image line instead of skipping it',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(100);
      await caretToLine(page, 2); // blank line, the one above the image line
      await page.keyboard.press('ArrowDown');
      const line = await page.evaluate(() => {
        const v = window.__irori.view;
        return v.state.doc.lineAt(v.state.selection.main.head).number;
      });
      t.eq('caret lands on the image line', line, 3);
      const isSource = await page.evaluate(() =>
        [...document.querySelectorAll('.cm-content .cm-line')].some((l) => l.textContent === '![一张图](a/pic.png)'),
      );
      t.ok('and it is shown as source', isSource, '');
      // Press the arrow key again to leave; the image should come back
      await page.keyboard.press('ArrowDown');
      await sleep(80);
      const backToImage = await page.evaluate(
        () => !![...document.querySelectorAll('.cm-content .ln.imgrow')].length,
      );
      t.ok('turns back into an image after leaving', backToImage, '');
    },
  },
  {
    id: 'B-13',
    name: 'A missing image shows a warning in place, leaving no hole',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(250);
      const miss = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.cm-content .imgmiss')].filter((e) => e.offsetParent !== null);
        return el.map((e) => e.textContent);
      });
      t.ok('there is an "image not found" notice', miss.some((x) => x.includes('missing.png')), JSON.stringify(miss));
    },
  },
  {
    id: 'B-14',
    name: 'An image inside a quote keeps the quote rail',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(100);
      const rows = await page.evaluate(() => [...document.querySelectorAll('.cm-content .ln.imgrow')].map((e) => e.className));
      t.eq('both images render as image lines', rows.length, 3);
      t.ok('the one inside the quote is still on the rail', rows.some((c) => c.includes('quote')), JSON.stringify(rows));
      const border = await page.evaluate(
        () => getComputedStyle(document.querySelector('.cm-content .ln.imgrow.quote')).borderLeftWidth,
      );
      t.eq('left rail is still there', border, '3px');
    },
  },
  {
    id: 'B-15',
    name: 'Image lines do not change the text: the document is always Markdown source',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(100);
      t.eq('document not rewritten', await docText(page), DOC);
    },
  },
  {
    id: 'B-16',
    name: 'An image shows its Markdown source only on hover',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(150);
      const before = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content .imgsrc')).opacity);
      t.eq('hidden normally', before, '0');
      const box = await page.evaluate(() => {
        const r = document.querySelector('.cm-content .imgwrap').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.move(box.x, box.y);
      await sleep(250);
      const after = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content .imgsrc')).opacity);
      t.ok('shown on hover', Number(after) > 0.9, after);
      const src = await page.evaluate(() => document.querySelector('.cm-content .imgsrc').textContent);
      t.eq('what is shown is the source', src, '![一张图](a/pic.png)');
    },
  },
];
