/* 抽屉、快捷键层、字体设置、以及「v1 没有菜单栏」这件事。 */
import fs from 'node:fs';
import path from 'node:path';
import { MOD, ROOT, sleep } from '../harness.mjs';

export const cases = [
  {
    id: 'B-60',
    name: '右缘发丝拉出抽屉；⌘\\ 开关；Esc 与遮罩关闭',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      const hair = await page.evaluate(() => {
        const r = document.getElementById('hair').getBoundingClientRect();
        return { w: r.width, h: r.height, right: Math.round(window.innerWidth - r.right) };
      });
      t.eq('发丝宽 3px', Math.round(hair.w), 3);
      t.eq('发丝高 96px', Math.round(hair.h), 96);
      t.eq('贴在右缘', hair.right, 0);
      await page.click('#hair');
      await sleep(350);
      t.ok('抽屉打开', await page.evaluate(() => document.body.classList.contains('menuopen')), '');
      const x = await page.evaluate(() => document.querySelector('.drawer').getBoundingClientRect().right - window.innerWidth);
      t.near('抽屉完全滑入', x, 0, 1);
      await page.click('#scrim');
      await sleep(350);
      t.ok('遮罩点击关闭', !(await page.evaluate(() => document.body.classList.contains('menuopen'))), '');
      await page.click('.cm-content');
      await page.keyboard.down(MOD);
      await page.keyboard.press('\\');
      await page.keyboard.up(MOD);
      await sleep(300);
      t.ok('⌘\\ 打开', await page.evaluate(() => document.body.classList.contains('menuopen')), '');
      await page.keyboard.press('Escape');
      await sleep(300);
      t.ok('Esc 关闭', !(await page.evaluate(() => document.body.classList.contains('menuopen'))), '');
    },
  },
  {
    id: 'B-61',
    name: '抽屉里只剩视图、字数、设置 —— 博客那些字段一个都不在',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      const gone = await page.evaluate(() => ({
        slug: !!document.getElementById('slugin'),
        tags: !!document.getElementById('tagrow'),
        publish: !!document.getElementById('pubbtn'),
        list: !!document.getElementById('listwrap'),
        date: !!document.getElementById('datev'),
      }));
      t.eq('slug 没了', gone.slug, false);
      t.eq('tags 没了', gone.tags, false);
      t.eq('发布按钮没了', gone.publish, false);
      t.eq('文章列表没了', gone.list, false);
      t.eq('date 字段没了', gone.date, false);
      const kept = await page.evaluate(() => ({
        focus: !!document.getElementById('fseg'),
        wc: !!document.getElementById('wcv'),
        settings: !!document.getElementById('aseg'),
      }));
      t.eq('专注模式还在', kept.focus, true);
      t.eq('字数还在', kept.wc, true);
      t.eq('设置在', kept.settings, true);
    },
  },
  {
    id: 'B-62',
    name: '字体来自本机、可在设置里改',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      const noWebfont = await page.evaluate(() =>
        [...document.querySelectorAll('link[rel=stylesheet]')].every((l) => !/fonts|jsdelivr|googleapis/.test(l.href)),
      );
      t.ok('没有任何网络字体依赖', noWebfont, '');
      await page.click('#hair');
      await sleep(320);
      await page.evaluate(() => {
        const el = document.getElementById('fontin');
        el.value = 'Courier New, monospace';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await sleep(200);
      const applied = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).fontFamily);
      t.ok('立即生效', applied.includes('Courier'), applied);
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('irori.settings') || '{}').fontFamily);
      t.ok('已持久化', String(saved).includes('Courier'), String(saved));
    },
  },
  {
    id: 'B-63',
    name: '专注模式的偏好跨会话保留',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      await page.click('#hair');
      await sleep(320);
      await page.click('#fseg');
      await page.evaluate(() => {
        const el = document.getElementById('ftopR');
        el.value = '35';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await sleep(400);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('irori.settings') || '{}').focus);
      t.eq('开关记住', stored.on, true);
      t.eq('上沿记住', stored.top, 35);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.__irori && window.__irori.view);
      await sleep(300);
      const restored = await page.evaluate(() => ({
        on: document.body.classList.contains('focusmode'),
        top: document.getElementById('ftopR').value,
      }));
      t.eq('刷新后仍然开着', restored.on, true);
      t.eq('上沿仍是 35', restored.top, '35');
    },
  },
  {
    id: 'B-66',
    name: '焦点在抽屉输入框里时，⌘S / ⌘\\ / Esc 依然有效（v1 没有菜单栏兜底）',
    async run(t, ctx) {
      const page = await ctx.open({
        files: { '/n/a.md': '原文' },
        startup: '/n/a.md',
        settings: { autosave: false, autosaveDelay: 9000 },
      });
      await page.click('.cm-content');
      await page.keyboard.press('End');
      await page.keyboard.type('改动');
      await page.click('#hair');
      await sleep(320);
      await page.focus('#fontin');
      await page.keyboard.down(MOD);
      await page.keyboard.press('s');
      await page.keyboard.up(MOD);
      await sleep(250);
      const saved = await page.evaluate(() => window.__irori.platform.files.get('/n/a.md')?.text);
      t.eq('⌘S 仍然保存', saved, '原文改动');
      await page.keyboard.press('Escape');
      await sleep(300);
      t.ok('Esc 仍然关抽屉', !(await page.evaluate(() => document.body.classList.contains('menuopen'))), '');
      await page.focus('#fontin');
      await page.keyboard.down(MOD);
      await page.keyboard.press('\\');
      await page.keyboard.up(MOD);
      await sleep(300);
      t.ok('⌘\\ 仍然开抽屉', await page.evaluate(() => document.body.classList.contains('menuopen')), '');
      const savedOnce = await page.evaluate(() => window.__irori.doc.dirty);
      t.ok('没有重复触发保存（编辑器自己的快捷键与窗口层不打架）', savedOnce === false, String(savedOnce));
    },
  },
  {
    id: 'B-67',
    name: '焦点自愈：正文丢了焦点会自动拿回来，快捷键因此永远有依托',
    async run(t, ctx) {
      const page = await ctx.open({
        files: { '/n/a.md': '原文' },
        startup: '/n/a.md',
        settings: { autosave: false, autosaveDelay: 9000 },
      });
      await page.click('.cm-content');
      await sleep(120);
      // 正文被别的东西抢走焦点（原生窗口里就是「刚打开还没点过正文」的状态）
      await page.evaluate(() => window.__irori.view.contentDOM.blur());
      await sleep(250);
      const back = await page.evaluate(() => document.activeElement?.className || '');
      t.ok('焦点自己回到正文', back.includes('cm-content'), back);

      // 点正文两侧的空白（属于滚动容器，但不是文字）——焦点也要落回正文
      await page.evaluate(() => {
        const el = document.elementFromPoint(40, innerHeight - 200);
        el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      await sleep(150);
      const afterClick = await page.evaluate(() => document.activeElement?.className || '');
      t.ok('点空白后焦点在正文', afterClick.includes('cm-content'), afterClick);

      // 而在抽屉里打字时绝不能抢焦点
      await page.click('#hair');
      await sleep(320);
      await page.focus('#fontin');
      await sleep(250);
      const inDrawer = await page.evaluate(() => document.activeElement?.id || '');
      t.eq('抽屉输入框里的焦点不被抢走', inDrawer, 'fontin');
    },
  },
  {
    id: 'B-68',
    name: '界面 chrome（抽屉 / 目录 / 顶栏）双击不划出选区，输入框照常可用',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '# 标题\n\n正文' }, startup: '/n/a.md' });
      await page.click('#hair');
      await sleep(320);
      const dblAt = async (sel) => {
        const box = await page.evaluate((s) => {
          const r = document.querySelector(s).getBoundingClientRect();
          return { x: r.x + Math.min(30, r.width / 2), y: r.y + r.height / 2 };
        }, sel);
        await page.mouse.click(box.x, box.y, { clickCount: 2 });
        await sleep(100);
        return page.evaluate(() => (getSelection()?.toString() || '').length);
      };
      t.eq('抽屉标题双击没选中', await dblAt('.rhead .t'), 0);
      t.eq('设置项文字双击没选中', await dblAt('.secttitle'), 0);
      t.eq('快捷键说明双击没选中', await dblAt('.shortcuts'), 0);
      await page.click('#dclose');
      await sleep(320);
      t.eq('顶栏文件名双击没选中', await dblAt('#filename'), 0);

      // 但输入框还得能用（能聚焦、能全选）
      await page.click('#hair');
      await sleep(320);
      await page.click('#fontin');
      await page.evaluate(() => document.getElementById('fontin').select());
      const picked = await page.evaluate(() => {
        const el = document.getElementById('fontin');
        return el.selectionEnd - el.selectionStart;
      });
      t.ok('字体输入框仍可全选', picked > 0, String(picked));
      // 正文当然还要能选
      await page.click('#dclose');
      await sleep(320);
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: 0, head: 4 } });
        v.focus();
      });
      t.ok('正文仍可选', await page.evaluate(() => !window.__irori.view.state.selection.main.empty), '');
    },
  },
  {
    id: 'B-69',
    name: '在抽屉里点来点去，正文不会被拽回光标处',
    async run(t, ctx) {
      const DOC = ['# 顶部', '', ...Array.from({ length: 300 }, (_, i) => `第 ${i} 行的正文内容`)].join('\n');
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(300);
      const top = () => page.evaluate(() => Math.round(window.__irori.view.scrollDOM.scrollTop));
      // 光标留在开头，视口滚到很远的地方
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: 0 } });
        v.scrollDOM.scrollTop = 3000;
      });
      await sleep(200);
      const before = await top();
      t.ok('确实滚远了', before > 1000, String(before));

      await page.click('#hair');
      await sleep(350);
      t.eq('开抽屉不动正文', await top(), before);

      for (const sel of ['.rhead .t', '.secttitle', '.shortcuts', '#pathv']) {
        const box = await page.evaluate((s) => {
          const r = document.querySelector(s).getBoundingClientRect();
          return { x: r.x + 10, y: r.y + r.height / 2 };
        }, sel);
        await page.mouse.click(box.x, box.y);
        await sleep(200);
        t.eq('点 ' + sel + ' 不动正文', await top(), before);
      }

      // 重新聚焦正文这件事本身也不许改滚动位置（WebKit 会把光标滚进视野）
      await page.click('#dclose');
      await sleep(350);
      await page.evaluate(() => window.__irori.focusEditor());
      await sleep(250);
      t.eq('聚焦正文也不动滚动位置', await top(), before);
    },
  },
  {
    id: 'B-70b',
    name: '顶部整条是窗口拖拽区，且不属于编辑器',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '# 标题\n\n正文' }, startup: '/n/a.md' });
      await sleep(250);
      const bar = await page.evaluate(() => {
        const t = document.getElementById('topline');
        const r = t.getBoundingClientRect();
        const chip = document.getElementById('filechip');
        const editor = document.querySelector('.cm-editor').getBoundingClientRect();
        return {
          drag: t.hasAttribute('data-tauri-drag-region'),
          chipDrag: chip.hasAttribute('data-tauri-drag-region'),
          innerDrag: document.querySelector('.topline-inner').hasAttribute('data-tauri-drag-region'),
          fullWidth: Math.round(r.width) >= Math.round(window.innerWidth) - 140,
          height: Math.round(r.height),
          aboveEditor: r.bottom <= editor.top + 1,
          insideEditor: !!t.closest('.cm-editor'),
        };
      });
      t.ok('整条是拖拽区', bar.drag && bar.innerDrag, '');
      t.ok('保存指示那一块也能拖', bar.chipDrag, '');
      t.ok('横贯窗口', bar.fullWidth, String(bar.height));
      t.ok('有足够的抓手高度', bar.height >= 36, String(bar.height));
      t.ok('在编辑器之外', bar.aboveEditor && !bar.insideEditor, '');
    },
  },
  {
    id: 'B-70c',
    name: '透明标题栏：顶栏横贯整个窗口都能拖（连缩略图顶端），文件名在顶部居中（对着文字列），缩略图的选框让到它下面',
    async run(t, ctx) {
      // 拖拽靠 Tauri 的 drag.js 调 start_dragging —— 权限没开，data-tauri-drag-region 就只是个摆设
      const cap = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri/capabilities/default.json'), 'utf8'));
      t.ok('开了 start_dragging 权限', cap.permissions.includes('core:window:allow-start-dragging'), '');

      const page = await ctx.open({ files: { '/n/a.md': '# 标题\n\n正文' }, startup: '/n/a.md' });
      await sleep(250);
      const probe = () =>
        page.evaluate(() => {
          const bar = document.getElementById('topline').getBoundingClientRect();
          const chip = document.getElementById('filechip').getBoundingClientRect();
          const col = document.querySelector('.cm-content').getBoundingClientRect();
          const inBar = (x, y) => !!document.elementFromPoint(x, y)?.closest('#topline');
          return {
            left: bar.left,
            right: Math.round(bar.right - innerWidth),
            top: bar.top,
            bottom: bar.bottom,
            // 左缘留白、缩略图顶端：舞台之外的两头
            leftEdge: inBar(4, 10),
            overMini: inBar(innerWidth - 40, 10),
            chipX: chip.x + chip.width / 2 - (col.x + col.width / 2),
            chipY: chip.y + chip.height / 2,
            chipLeft: chip.left,
            chipRight: innerWidth - chip.right,
            vpTop: document.getElementById('vp').getBoundingClientRect().top,
            editorTop: document.querySelector('.cm-editor').getBoundingClientRect().top,
          };
        });

      const web = await probe();
      t.ok('浏览器里（没有透明标题栏）顶栏不盖缩略图', !web.overMini, '');
      t.near('浏览器里选框留白不变', web.vpTop, 10, 1);

      await page.evaluate(() => {
        document.body.classList.add('overlay-titlebar');
        dispatchEvent(new Event('resize'));
      });
      await sleep(150);
      const mac = await probe();
      t.ok('贴顶、横贯窗口', mac.left === 0 && mac.right === 0 && mac.top === 0, `${mac.left} ${mac.right} ${mac.top}`);
      t.near('只有红绿灯那一行高', mac.bottom, 28, 0.5);
      t.ok('左缘留白能拖', mac.leftEdge, '');
      t.ok('缩略图顶端能拖', mac.overMini, '');
      t.near('文件名与文字列同一条中线', mac.chipX, 0, 1);
      t.near('文件名与红绿灯同一水平线', mac.chipY, 14, 1.5);
      t.ok('正文在顶栏下面', mac.editorTop >= mac.bottom, `${mac.editorTop} ≥ ${mac.bottom}`);
      t.ok('选框在顶栏下面', mac.vpTop >= mac.bottom, `${mac.vpTop} ≥ ${mac.bottom}`);

      // 长文件名：截断，不许伸到红绿灯或缩略图上
      await page.evaluate(() => (document.getElementById('filename').textContent = '很长的文件名'.repeat(40)));
      const long = await probe();
      t.ok('长文件名不碰红绿灯与缩略图', long.chipLeft >= 80 && long.chipRight >= 113, `${long.chipLeft} / ${long.chipRight}`);

      // 抽屉开着时让给抽屉：✕ 要点得到
      await page.click('#hair');
      await sleep(350);
      const x = await page.evaluate(() => {
        const r = document.getElementById('dclose').getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.id;
      });
      t.eq('抽屉的 ✕ 不被顶栏挡住', x, 'dclose');
    },
  },
  {
    id: 'B-65b',
    name: '一屏放得下时页面不能滚、缩略图拖不动；放不下才留出「滚过末尾」的空白',
    async run(t, ctx) {
      const range = (page) =>
        page.evaluate(() => {
          const s = window.__irori.view.scrollDOM;
          return { canScroll: s.scrollHeight - s.clientHeight, noscroll: document.getElementById('mini').classList.contains('noscroll') };
        });
      for (const [label, doc] of [
        ['空文档', ''],
        ['三行', '# 标题\n\n一行正文'],
        ['一屏放得下的十行', Array.from({ length: 10 }, (_, i) => `第 ${i} 行`).join('\n')],
      ]) {
        const page = await ctx.open({ files: { '/n/a.md': doc }, startup: '/n/a.md', viewport: { width: 1200, height: 780 } });
        await sleep(350);
        const r = await range(page);
        t.ok(`${label}：不能滚`, r.canScroll <= 1, String(r.canScroll));
        t.ok(`${label}：缩略图标为不可拖`, r.noscroll, '');
        // 拖选框也拖不动
        const box = await page.evaluate(() => {
          const b = document.getElementById('vp').getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + Math.min(20, b.height / 2) };
        });
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        await page.mouse.move(box.x, box.y + 200, { steps: 5 });
        await page.mouse.up();
        await sleep(200);
        t.eq(`${label}：拖完仍在顶部`, await page.evaluate(() => Math.round(window.__irori.view.scrollDOM.scrollTop)), 0);
        await page.close();
      }

      // 长文：照旧留出空白，最后一行能滚到很靠上的位置
      const long = Array.from({ length: 80 }, (_, i) => `第 ${i} 行`).join('\n');
      const page = await ctx.open({ files: { '/n/b.md': long }, startup: '/n/b.md', viewport: { width: 1200, height: 780 } });
      await sleep(350);
      const r = await range(page);
      t.ok('长文可以滚', r.canScroll > 500, String(r.canScroll));
      t.ok('长文的缩略图可拖', !r.noscroll, '');
      const lastTop = await page.evaluate(async () => {
        const v = window.__irori.view;
        v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight;
        await new Promise((res) => setTimeout(res, 200));
        const line = v.state.doc.line(v.state.doc.lines);
        return v.documentTop + v.lineBlockAt(line.from).top - v.scrollDOM.getBoundingClientRect().top;
      });
      t.ok('最后一行能滚到视口上半部', lastTop < 780 / 2, String(Math.round(lastTop)));

      // 短文打字打到超过一屏：滚动范围随之出现；删回去：又消失
      const grow = await ctx.open({ files: { '/n/c.md': '开头' }, startup: '/n/c.md', viewport: { width: 1200, height: 780 } });
      await sleep(300);
      await grow.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ changes: { from: v.state.doc.length, insert: '\n' + Array.from({ length: 40 }, (_, i) => `新 ${i}`).join('\n') } });
      });
      await sleep(350);
      t.ok('写长了之后可以滚', (await range(grow)).canScroll > 500, '');
      await grow.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ changes: { from: 2, to: v.state.doc.length, insert: '' } });
      });
      await sleep(350);
      t.ok('删回一屏以内又不能滚', (await range(grow)).canScroll <= 1, String((await range(grow)).canScroll));

      // 专注模式：短文整个在聚焦带里，也不需要滚
      await grow.click('#hair');
      await sleep(320);
      await grow.click('#fseg');
      await sleep(500);
      t.ok('专注模式下短文也不能滚', (await range(grow)).canScroll <= 1, String((await range(grow)).canScroll));
    },
  },
  {
    id: 'B-64',
    name: 'v1 不提供菜单栏，快捷键是唯一入口（已记录的取舍）',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      const hints = await page.evaluate(() => document.querySelector('.shortcuts').textContent);
      t.ok('抽屉里列出了快捷键', hints.includes('⌘S') && hints.includes('⌘O') && hints.includes('⌘F'), hints);
    },
  },
  {
    id: 'B-65',
    name: '窗口滚动条不可见（缩略图的选框就是滚动指示）',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': Array.from({ length: 200 }, (_, i) => '第 ' + i + ' 行').join('\n') }, startup: '/n/a.md' });
      await sleep(200);
      const bars = await page.evaluate(() => {
        const s = document.querySelector('.cm-scroller');
        return { docOverflow: getComputedStyle(document.body).overflow, gutter: s.offsetWidth - s.clientWidth };
      });
      t.eq('页面本身不滚动', bars.docOverflow, 'hidden');
      t.eq('编辑器滚动条零宽', bars.gutter, 0);
    },
  },
];
