/* 性能目标（CONTEXT.md 约束）：单篇十万字仍然流畅；图片数量不设上限，
   滚出视口的图片必须被卸载，不常驻内存。 */
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
    name: '十万字文档：秒开，且 DOM 里只有一屏的行',
    async run(t, ctx) {
      const doc = bigDoc();
      const chars = doc.length;
      const started = Date.now();
      const page = await ctx.open({ files: { '/n/big.md': doc }, startup: '/n/big.md' });
      await sleep(300);
      const bootMs = Date.now() - started;
      t.ok('文档确实超过十万字', chars > 100000, String(chars));
      t.ok('打开耗时可接受（含浏览器启动页）', bootMs < 8000, bootMs + 'ms');
      const rendered = await page.evaluate(() => document.querySelectorAll('.cm-content .cm-line').length);
      t.ok('渲染的行数远小于总行数', rendered < 300, String(rendered));
      const total = await page.evaluate(() => window.__irori.view.state.doc.lines);
      t.ok('文档行数很大', total > 3000, String(total));
      const miniRows = await page.evaluate(() => document.getElementById('miniContent').children.length);
      t.ok('缩略图也是按需渲染', miniRows <= 1200, String(miniRows));
    },
  },
  {
    id: 'B-71',
    name: '十万字文档：输入延迟仍然很低',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/big.md': bigDoc() }, startup: '/n/big.md' });
      await sleep(300);
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 20000));
      await sleep(200);
      await page.click('.cm-content');
      const ms = await page.evaluate(async () => {
        const v = window.__irori.view;
        const pos = v.state.selection.main.head;
        const t0 = performance.now();
        for (let i = 0; i < 40; i++) v.dispatch({ changes: { from: pos + i, insert: '字' } });
        return performance.now() - t0;
      });
      t.ok('40 次插入的总耗时 < 1200ms', ms < 1200, ms.toFixed(0) + 'ms');
      const per = ms / 40;
      t.ok('单次 < 30ms', per < 30, per.toFixed(1) + 'ms');
    },
  },
  {
    id: 'B-72',
    name: '几百张图：只有视口内的图片存在于 DOM（滚出即卸载）',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/many.md': manyImages() }, startup: '/n/many.md' });
      await sleep(400);
      const top = await page.evaluate(() => document.querySelectorAll('.cm-content img').length);
      t.ok('一屏内的图片数量很少', top < 30, String(top));
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 12000));
      await sleep(400);
      const mid = await page.evaluate(() => document.querySelectorAll('.cm-content img').length);
      t.ok('滚动后依然只有一屏的量', mid < 30, String(mid));
      const total = await page.evaluate(() => (window.__irori.view.state.doc.toString().match(/!\[\]/g) || []).length);
      t.eq('文档里确实有 300 张图', total, 300);
    },
  },
  {
    id: 'B-73',
    name: '撤销历史不保存全文快照（长文反复编辑后内存不爆）',
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
        // 300 次编辑 × 十万字全文快照 ≈ 30MB+；增量历史应该远低于此
        t.ok('300 次编辑后堆增长 < 20MB', mb < 20, mb.toFixed(1) + 'MB');
      } else {
        t.ok('（此浏览器不暴露 performance.memory，跳过内存断言）', true, '');
      }
      t.ok('文档仍然完整', grown.docChars > 100000, String(grown.docChars));
    },
  },
];
