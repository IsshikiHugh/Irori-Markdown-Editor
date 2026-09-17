/* Performance targets (CONTEXT.md constraints): a single 100k-character document stays smooth; there is no cap
   on the number of images, and images scrolled out of the viewport must be unloaded, not kept in memory. */
import { sleep } from '../harness.mjs';

const bigDoc = () => {
  const para = '这是一段用来撑大文档的中文正文，每一行大约四十来个字，读起来没有意义。';
  const lines = [];
  for (let i = 0; i < 3000; i++) {
    if (i % 25 === 0) lines.push(`## 第 ${i / 25 + 1} 节`);
    lines.push(para + i);
    if (i % 7 === 0) lines.push('');
  }
  return lines.join('\n');
};

const manyImages = () => {
  const lines = [];
  for (let i = 0; i < 300; i++) {
    lines.push(`第 ${i} 段文字`, '', `![](imgs/p${i}.png)`, '');
  }
  return lines.join('\n');
};

export const cases = [
  {
    id: 'B-70',
    name: '100k-character document: opens instantly, and the DOM holds only one screen of lines',
    async run(t, ctx) {
      const doc = bigDoc();
      const chars = doc.length;
      const started = Date.now();
      const page = await ctx.open({ files: { '/n/big.md': doc }, startup: '/n/big.md' });
      await sleep(300);
      const bootMs = Date.now() - started;
      t.ok('document really exceeds 100k characters', chars > 100000, String(chars));
      t.ok('open time is acceptable (including browser page startup)', bootMs < 8000, bootMs + 'ms');
      const rendered = await page.evaluate(() => document.querySelectorAll('.cm-content .cm-line').length);
      t.ok('rendered lines are far fewer than total lines', rendered < 300, String(rendered));
      const total = await page.evaluate(() => window.__irori.view.state.doc.lines);
      t.ok('document has many lines', total > 3000, String(total));
      const miniRows = await page.evaluate(() => document.getElementById('miniContent').children.length);
      t.ok('minimap is also rendered on demand', miniRows <= 1200, String(miniRows));
    },
  },
  {
    id: 'B-71',
    name: '100k-character document: input latency stays low',
    async run(t, ctx) {
      // Median time of 40 synchronous inserts, measured the same way on a short and a 100k-character
      // document. The long document is compared against the short one in the same browser rather
      // than against a fixed number: absolute timings depend on the machine (about 1ms per insert on
      // an M-series Mac, ~30ms on a shared CI runner), but the ratio does not — and "a long document
      // costs about the same as a short one" is exactly the property this case guards.
      const medianInsert = async (text) => {
        const page = await ctx.open({ files: { '/n/doc.md': text }, startup: '/n/doc.md' });
        await sleep(300);
        await page.evaluate(() => {
          const s = window.__irori.view.scrollDOM;
          s.scrollTop = Math.min(20000, s.scrollHeight / 2);
        });
        await sleep(200);
        await page.click('.cm-content');
        return page.evaluate(() => {
          const v = window.__irori.view;
          const pos = v.state.selection.main.head;
          const each = [];
          for (let i = 0; i < 40; i++) {
            const t0 = performance.now();
            v.dispatch({ changes: { from: pos + i, insert: '字' } });
            each.push(performance.now() - t0);
          }
          return each.sort((a, b) => a - b)[20];
        });
      };
      const big = bigDoc();
      const small = await medianInsert(big.split('\n').slice(0, 30).join('\n'));
      const large = await medianInsert(big);
      const detail = `100k: ${large.toFixed(1)}ms / short: ${small.toFixed(1)}ms`;
      t.ok('median insert on the 100k doc is within 6× (+5ms) of a short doc', large < small * 6 + 5, detail);
      t.ok('median insert < 60ms even on a slow machine', large < 60, detail);
    },
  },
  {
    id: 'B-72',
    name: 'Hundreds of images: only images in the viewport exist in the DOM (unloaded once scrolled out)',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/many.md': manyImages() }, startup: '/n/many.md' });
      await sleep(400);
      const top = await page.evaluate(() => document.querySelectorAll('.cm-content img').length);
      t.ok('few images within one screen', top < 30, String(top));
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 12000));
      await sleep(400);
      const mid = await page.evaluate(() => document.querySelectorAll('.cm-content img').length);
      t.ok('still only one screen worth after scrolling', mid < 30, String(mid));
      const total = await page.evaluate(() => (window.__irori.view.state.doc.toString().match(/!\[\]/g) || []).length);
      t.eq('document really has 300 images', total, 300);
    },
  },
  {
    id: 'B-73',
    name: 'Undo history does not store full-text snapshots (memory does not blow up after repeated edits to a long doc)',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/big.md': bigDoc() }, startup: '/n/big.md' });
      await sleep(300);
      const grown = await page.evaluate(async () => {
        const v = window.__irori.view;
        const before = performance.memory ? performance.memory.usedJSHeapSize : 0;
        for (let i = 0; i < 300; i++) {
          v.dispatch({ changes: { from: 10 + i, insert: '字' } });
          await new Promise((r) => setTimeout(r, 0));
        }
        const after = performance.memory ? performance.memory.usedJSHeapSize : 0;
        return { before, after, docChars: v.state.doc.length };
      });
      if (grown.before) {
        const mb = (grown.after - grown.before) / 1048576;
        // 300 edits × a 100k-character full snapshot ≈ 30MB+; incremental history should be far below that
        t.ok('heap growth < 20MB after 300 edits', mb < 20, mb.toFixed(1) + 'MB');
      } else {
        t.ok('(this browser does not expose performance.memory; skipping the memory assertion)', true, '');
      }
      t.ok('document is still intact', grown.docChars > 100000, String(grown.docChars));
    },
  },
];
