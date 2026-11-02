/* Image lines — the one exception to source decoration.
   Invariant: the line holding the caret is always source; every other image line is always an image. */
import zlib from 'node:zlib';
import { caretToLine, docText, sleep } from '../harness.mjs';

/** A plain grey PNG of any size, as base64 (for pictures much taller than a line). */
function pngOf(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8; // 8-bit greyscale
  const rows = Buffer.alloc((w + 1) * h, 0xc0);
  for (let y = 0; y < h; y++) rows[y * (w + 1)] = 0; // filter byte
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

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
  {
    id: 'B-108',
    name: 'An image in a list (an item, or an item\'s indented line) renders, with the marker in front and the picture at the text column',
    async run(t, ctx) {
      const doc = ['- 文字', '- ![](a/pic.png)', '1. ![](a/pic.png)', '   ![](a/pic.png)', '', '结尾'].join('\n');
      const page = await ctx.open({ files: { '/n/a.md': doc }, images: { '/n/a/pic.png': PNG }, startup: '/n/a.md' });
      await caretToLine(page, 6);
      await page.waitForFunction(() => document.querySelectorAll('.cm-content .imgwrap img').length === 3);
      const info = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.cm-content .imgrow.li')];
        // the item's text column: where the hanging indent puts the text after the marker
        const column = (r) => r.getBoundingClientRect().left + parseFloat(getComputedStyle(r).paddingLeft);
        const plain = document.querySelector('.cm-content .cm-line.li');
        return {
          rows: rows.length,
          markers: rows.map((r) => r.querySelector('.lmark,.lnum')?.textContent ?? ''),
          imgX: rows.map((r) => Math.round(r.querySelector('img').getBoundingClientRect().left - column(r))),
          // "- " items line up with each other, picture or text
          bullet: Math.round(column(rows[0]) - column(plain)),
        };
      });
      t.eq('three list rows show a picture', info.rows, 3);
      t.eq('the markers stay (none on the continuation line)', info.markers, ['- ', '1. ', '']);
      t.ok('each picture starts at its item\'s text column', info.imgX.every((d) => Math.abs(d) <= 1), JSON.stringify(info.imgX));
      t.eq('a picture item and a text item share the text column', info.bullet, 0);
      await caretToLine(page, 2);
      await page.waitForFunction(() => document.querySelectorAll('.cm-content .imgwrap img').length === 2);
      t.ok('the caret line is source', await page.evaluate(() =>
        [...document.querySelectorAll('.cm-content .cm-line')].some((l) => l.textContent === '- ![](a/pic.png)')), '');
      t.eq('document not rewritten', await docText(page), doc);
    },
  },
  {
    id: 'B-109',
    name: 'Leaving an image line keeps the caret where it is on screen: the picture grows away from it',
    async run(t, ctx) {
      const lines = [];
      for (let i = 1; i <= 30; i++) lines.push(`第 ${i} 段`);
      lines.push('![](a/big.png)'); // line 31
      for (let i = 32; i <= 70; i++) lines.push(`第 ${i} 段`);
      const doc = lines.join('\n');
      const page = await ctx.open({ files: { '/n/a.md': doc }, images: { '/n/a/big.png': pngOf(400, 300) }, startup: '/n/a.md' });
      // the caret on the image line (source), which sits in the middle of the screen
      const onImage = async () => {
        await caretToLine(page, 31);
        await page.evaluate(() => {
          const v = window.__irori.view;
          v.scrollDOM.scrollTop = v.lineBlockAt(v.state.doc.line(31).from).top - 350;
        });
        await sleep(150);
      };
      const top = (n) =>
        page.evaluate((n) => {
          const v = window.__irori.view;
          return v.coordsAtPos(v.state.doc.line(n).from).top;
        }, n);
      const after = () =>
        page.evaluate(() => {
          const v = window.__irori.view;
          const img = document.querySelector('.cm-content .imgwrap img');
          return {
            line: v.state.doc.lineAt(v.state.selection.main.head).number,
            top: v.coordsAtPos(v.state.selection.main.head).top,
            img: img ? img.getBoundingClientRect().height : 0,
          };
        });

      for (const [key, to] of [['ArrowDown', 32], ['ArrowUp', 30]]) {
        await onImage();
        const before = await top(to);
        await page.keyboard.press(key);
        await sleep(200);
        const a = await after();
        t.eq(`${key}: caret on line ${to}`, a.line, to);
        t.ok(`${key}: the picture is back, taller than a line`, a.img > 200, String(a.img));
        t.ok(`${key}: the caret did not move on screen`, Math.abs(a.top - before) <= 1, `${before} → ${a.top}`);
      }

      // a click further down: the clicked line stays under the mouse
      await onImage();
      const at = await page.evaluate(() => {
        const v = window.__irori.view;
        const c = v.coordsAtPos(v.state.doc.line(36).from + 2);
        return { x: c.left, y: (c.top + c.bottom) / 2, top: c.top };
      });
      await page.mouse.click(at.x, at.y);
      await sleep(200);
      const c = await after();
      t.eq('click: caret on the clicked line', c.line, 36);
      t.ok('click: the clicked line stayed under the mouse', Math.abs(c.top - at.top) <= 1, `${at.top} → ${c.top}`);

      // Enter at the end of the image line: the new line stays right under where the source row was
      await onImage();
      await page.keyboard.press('End');
      const row = await page.evaluate(() => {
        const v = window.__irori.view;
        const b = v.lineBlockAt(v.state.doc.line(31).from);
        return v.documentTop + b.bottom;
      });
      await page.keyboard.press('Enter');
      await sleep(200);
      const a = await after();
      const now = await page.evaluate(() => {
        const v = window.__irori.view;
        return v.documentTop + v.lineBlockAt(v.state.selection.main.head).top;
      });
      t.eq('Enter: caret on the new line', a.line, 32);
      t.ok('Enter: the new line starts where the source row ended', Math.abs(now - row) <= 1, `${row} → ${now}`);
    },
  },
];
