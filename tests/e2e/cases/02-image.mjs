/* 图片行 —— 源码装饰的唯一例外。
   不变量：光标所在的那一行永远是源码，其他图片行永远是图片。 */
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
    name: '图片行渲染成图片（按原始大小，不套固定选框）',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(150);
      const info = await page.evaluate(() => {
        const img = document.querySelector('.cm-content .imgwrap img');
        const s = img && getComputedStyle(img);
        return img ? { ok: true, maxW: s.maxWidth, display: s.display, complete: img.complete, w: img.naturalWidth } : { ok: false };
      });
      t.ok('图片元素存在', info.ok, JSON.stringify(info));
      t.eq('max-width:100%', info.maxW, '100%');
      t.ok('图片已加载', info.complete && info.w === 4, JSON.stringify(info));
    },
  },
  {
    id: 'B-11',
    name: '光标进入图片行 → 该行变回可编辑源码；离开 → 变回图片',
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
      t.ok('变回可编辑源码', onLine.found, '');
      t.eq('这一行的图片 widget 消失了（另一张还在）', onLine.imgs, 1);
      await caretToLine(page, 1);
      await sleep(60);
      const offLine = await page.evaluate(() => ({
        source: [...document.querySelectorAll('.cm-content .cm-line')].some((l) => l.textContent === '![一张图](a/pic.png)'),
        imgs: document.querySelectorAll('.cm-content .imgwrap img').length,
      }));
      t.ok('离开后不再显示源码', !offLine.source, '');
      t.eq('两张图都回来了', offLine.imgs, 2);
    },
  },
  {
    id: 'B-12',
    name: '方向键走进图片行，而不是跳过它',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(100);
      await caretToLine(page, 2); // 空行，图片行的上一行
      await page.keyboard.press('ArrowDown');
      const line = await page.evaluate(() => {
        const v = window.__irori.view;
        return v.state.doc.lineAt(v.state.selection.main.head).number;
      });
      t.eq('光标落在图片行上', line, 3);
      const isSource = await page.evaluate(() =>
        [...document.querySelectorAll('.cm-content .cm-line')].some((l) => l.textContent === '![一张图](a/pic.png)'),
      );
      t.ok('且显示为源码', isSource, '');
      // 再按一次方向键离开，图片应该回来
      await page.keyboard.press('ArrowDown');
      await sleep(80);
      const backToImage = await page.evaluate(
        () => !![...document.querySelectorAll('.cm-content .ln.imgrow')].length,
      );
      t.ok('离开后变回图片', backToImage, '');
    },
  },
  {
    id: 'B-13',
    name: '图片缺失时原地显示警告，不留空洞',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(250);
      const miss = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.cm-content .imgmiss')].filter((e) => e.offsetParent !== null);
        return el.map((e) => e.textContent);
      });
      t.ok('有一条「图片未找到」', miss.some((x) => x.includes('missing.png')), JSON.stringify(miss));
    },
  },
  {
    id: 'B-14',
    name: '引用内图片保留引用左边线',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(100);
      const rows = await page.evaluate(() => [...document.querySelectorAll('.cm-content .ln.imgrow')].map((e) => e.className));
      t.eq('两张图都渲染成了图片行', rows.length, 3);
      t.ok('引用内的那张仍在 rail 上', rows.some((c) => c.includes('quote')), JSON.stringify(rows));
      const border = await page.evaluate(
        () => getComputedStyle(document.querySelector('.cm-content .ln.imgrow.quote')).borderLeftWidth,
      );
      t.eq('左边线仍在', border, '3px');
    },
  },
  {
    id: 'B-15',
    name: '图片行不改变文本：文档内容始终是 markdown 源码',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(100);
      t.eq('文档未被改写', await docText(page), DOC);
    },
  },
  {
    id: 'B-16',
    name: '悬停图片才显示它的 markdown 源',
    async run(t, ctx) {
      const page = await ctx.open(seed);
      await sleep(150);
      const before = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content .imgsrc')).opacity);
      t.eq('平时隐藏', before, '0');
      const box = await page.evaluate(() => {
        const r = document.querySelector('.cm-content .imgwrap').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.move(box.x, box.y);
      await sleep(250);
      const after = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content .imgsrc')).opacity);
      t.ok('悬停后显示', Number(after) > 0.9, after);
      const src = await page.evaluate(() => document.querySelector('.cm-content .imgsrc').textContent);
      t.eq('显示的是源码', src, '![一张图](a/pic.png)');
    },
  },
];
