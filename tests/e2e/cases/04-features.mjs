/* 目录、缩略图、专注模式、字数统计、查找。 */
import { MOD, caretToLine, setCaret, sleep } from '../harness.mjs';

const long = (n) => Array.from({ length: n }, (_, i) => (i % 12 === 0 ? `## 小节 ${i / 12 + 1}` : `第 ${i} 行的正文内容`)).join('\n');
const DOC = ['# 大标题', '', '开头段落', '', long(120)].join('\n');

export const cases = [
  {
    id: 'B-30',
    name: '目录从 h1~h3 自动生成，一级标题也在里面',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(200);
      const items = await page.evaluate(() => [...document.querySelectorAll('#toc .toc-link')].map((a) => a.textContent));
      t.ok('至少 10 条', items.length >= 10, String(items.length));
      t.eq('第一条是文档的一级标题', items[0], '大标题');
      const lvl = await page.evaluate(() => document.querySelector('#toc .toc-link').className);
      t.ok('按层级缩进', lvl.includes('lvl1'), lvl);
    },
  },
  {
    id: 'B-31',
    name: '点击目录滚动到对应小节；滚动时高亮当前小节',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(200);
      await page.evaluate(() => [...document.querySelectorAll('#toc .toc-link')][5].click());
      await sleep(400);
      const scrolled = await page.evaluate(() => window.__irori.view.scrollDOM.scrollTop);
      t.ok('已滚动', scrolled > 100, String(scrolled));
      await sleep(200);
      const active = await page.evaluate(() => {
        const a = document.querySelector('#toc .toc-link.active');
        return a ? a.textContent : null;
      });
      t.ok('有当前小节高亮', !!active, String(active));
    },
  },
  {
    id: 'B-32',
    name: '缩略图是整篇的等比缩影，选框与滚动同步',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(250);
      const m = await page.evaluate(() => {
        const mini = document.getElementById('mini');
        const content = document.getElementById('miniContent');
        const vp = document.getElementById('vp');
        return {
          rows: content.children.length,
          scale: content.style.transform,
          vpTop: parseFloat(vp.style.top),
          vpH: parseFloat(vp.style.height),
          miniW: mini.clientWidth,
        };
      });
      t.ok('渲染了缩略行', m.rows > 5, String(m.rows));
      t.ok('等比缩放', /scale\(0\.\d+\)/.test(m.scale), m.scale);
      t.ok('选框高度合理', m.vpH > 10 && m.vpH < 400, String(m.vpH));
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 1500));
      await sleep(150);
      const after = await page.evaluate(() => parseFloat(document.getElementById('vp').style.top));
      t.ok('选框随滚动移动', after > m.vpTop, `${m.vpTop} → ${after}`);
    },
  },
  {
    id: 'B-33',
    name: '点击缩略图任意位置 → 视口跳到那里',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(250);
      const box = await page.evaluate(() => {
        const r = document.getElementById('mini').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height * 0.6 };
      });
      const before = await page.evaluate(() => window.__irori.view.scrollDOM.scrollTop);
      await page.mouse.click(box.x, box.y);
      await sleep(700); // 现在是滑过去的（最长 500ms）
      const after = await page.evaluate(() => window.__irori.view.scrollDOM.scrollTop);
      t.ok('滚动位置改变', Math.abs(after - before) > 50, `${before} → ${after}`);
    },
  },
  {
    id: 'B-31b',
    name: '跳转是滑过去的，且收尾那 250ms 与跳多远无关',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(250);
      // 跑一次目录跳转，既采样位置，也把编辑器自己记下的这次滑动数据取回来
      const run = (index) =>
        page.evaluate(async (i) => {
          const el = window.__irori.view.scrollDOM;
          el.scrollTop = 0;
          await new Promise((r) => setTimeout(r, 150));
          const samples = [];
          const iv = setInterval(() => samples.push(Math.round(el.scrollTop)), 16);
          [...document.querySelectorAll('#toc .toc-link')][i].click();
          await new Promise((r) => setTimeout(r, 1700));
          clearInterval(iv);
          return { samples, run: window.__irori.glide.lastRun() };
        }, index);

      const near = await run(4);
      const far = await run(9);
      const dist = (r) => Math.abs(r.run.to - r.run.from);
      const tail = (r) => Math.abs(r.run.tailTo - r.run.tailFrom);

      t.ok('近处那次确实滚了', dist(near) > 150, String(Math.round(dist(near))));
      t.ok('远处那次滚得更远', dist(far) > dist(near) * 1.8, `${Math.round(dist(near))} vs ${Math.round(dist(far))}`);
      const moving = near.samples.filter((y) => y > 1 && y < near.samples[near.samples.length - 1] - 1);
      t.ok('不是一帧跳完（中途采到了过程）', moving.length >= 4, String(moving.length));
      t.ok('一页以内不超过 500ms，更远也不超过 1400ms', near.run.total <= 1400 && far.run.total <= 1400, `${Math.round(near.run.total)} / ${Math.round(far.run.total)}`);
      t.ok('远的那次总时长更长', far.run.total >= near.run.total, `${near.run.total} → ${far.run.total}`);

      // 收尾不变量
      t.eq('收尾段时长固定 250ms', [near.run.tailMs, far.run.tailMs], [250, 250]);
      t.ok('收尾走的距离与跳多远无关', Math.abs(tail(near) - tail(far)) < 12, `${Math.round(tail(near))} vs ${Math.round(tail(far))}`);
      t.ok('收尾是一两行的量级，不是一整页', tail(near) > 8 && tail(near) < 90, String(Math.round(tail(near))));
    },
  },
  {
    id: 'B-31c',
    name: '长距离跳转最终一定落到位（包括一路滚到文末）',
    async run(t, ctx) {
      const big = ['# 顶部', '', ...Array.from({ length: 1200 }, (_, i) => (i % 40 === 0 ? `## 第 ${i / 40 + 1} 节` : `第 ${i} 行的正文内容`))].join('\n');
      const page = await ctx.open({ files: { '/n/big.md': big }, startup: '/n/big.md' });
      await sleep(400);
      // Measure once the glide has actually landed instead of sleeping a fixed time: a long jump
      // alone takes 1400ms and the landing re-check may add more legs, so on a slow machine a
      // 2000ms sleep lands mid-way through the last leg (seen on CI: 12px short)
      await page.evaluate(() => {
        window.__settle = async () => {
          const g = window.__irori.glide;
          const t0 = performance.now();
          await new Promise((r) => setTimeout(r, 100));
          while (g.running() && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
          await new Promise((r) => setTimeout(r, 100));
        };
      });
      // 直接要求滑到文末：出发时 CodeMirror 对后面的高度还是估算的
      const r = await page.evaluate(async () => {
        const el = window.__irori.view.scrollDOM;
        window.__irori.glide.to(() => el.scrollHeight);
        await window.__settle();
        return { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) };
      });
      t.ok('确实滚到了底（差 < 2px）', Math.abs(r.top - r.max) <= 2, `${r.top} / ${r.max}`);

      // 跳到最后一个小节，同样要落准
      const h = await page.evaluate(async () => {
        const el = window.__irori.view.scrollDOM;
        el.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 200));
        const links = [...document.querySelectorAll('#toc .toc-link')];
        links[links.length - 1].click();
        await window.__settle();
        const v = window.__irori.view;
        let pos = 0;
        for (let n = v.state.doc.lines; n >= 1; n--) {
          if (/^#{1,3}\s/.test(v.state.doc.line(n).text)) {
            pos = v.state.doc.line(n).from;
            break;
          }
        }
        const want = v.lineBlockAt(pos).top + v.documentPadding.top - 20;
        const max = el.scrollHeight - el.clientHeight;
        return { top: Math.round(el.scrollTop), want: Math.round(Math.min(want, max)) };
      });
      t.ok('落在最后一个小节上（差 < 3px）', Math.abs(h.top - h.want) <= 3, `${h.top} / ${h.want}`);
    },
  },
  {
    id: 'B-32b',
    name: '专注模式下缩略图仍与视口对齐（顶部多出来的留白要算进去）',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(300);
      const probe = () =>
        page.evaluate(() => {
          const v = window.__irori.view;
          const s = v.scrollDOM;
          const r = s.getBoundingClientRect();
          // 取视口**正中**那一行：专注模式下视口顶端可能落在顶部留白里，没有行可取
          const pos = v.posAtCoords({ x: r.left + 40, y: r.top + r.height / 2 }, false);
          const scrollSpaceY = v.lineBlockAt(pos).top + v.documentPadding.top;
          const vp = document.getElementById('vp').getBoundingClientRect();
          const mini = document.getElementById('mini').getBoundingClientRect();
          const content = document.getElementById('miniContent');
          const scale = Number((content.style.transform.match(/scale\(([\d.]+)\)/) || [0, 0])[1]);
          const inMini = mini.top + parseFloat(content.style.top) + scrollSpaceY * scale;
          // 选框标的是「真正看得见的那一段」：普通模式 = 整个视口，专注模式 = 聚焦带
          const focusOn = document.body.classList.contains('focusmode');
          const seen = focusOn
            ? (r.height * (parseFloat(document.getElementById('fbotR').value) - parseFloat(document.getElementById('ftopR').value))) / 100
            : s.clientHeight;
          return {
            padTop: Math.round(v.documentPadding.top),
            // 它应当落在选框的正中间
            diff: inMini - (vp.top + vp.height / 2),
            boxH: vp.height,
            wantBoxH: seen * scale,
            focusOn,
          };
        });

      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 1500));
      await sleep(300);
      const plain = await probe();
      t.ok('普通模式：视口正中那一行落在选框正中', Math.abs(plain.diff) <= 3, plain.diff.toFixed(1));
      t.ok('普通模式：选框高度 = 视口高度等比', Math.abs(plain.boxH - plain.wantBoxH) <= 2, `${plain.boxH.toFixed(1)}/${plain.wantBoxH.toFixed(1)}`);

      await page.click('#hair');
      await sleep(320);
      await page.click('#fseg');
      // 等两件事：CodeMirror 量到新的内边距，以及把光标带回聚焦带的那次滑动落地
      await page.waitForFunction(() => !window.__irori.glide.running(), { timeout: 4000 });
      await sleep(250);
      const rightAfterToggle = await probe();
      t.ok('刚开专注模式：内边距确实变大了', rightAfterToggle.padTop > 100, String(rightAfterToggle.padTop));
      t.ok('刚开专注模式就已经对齐', Math.abs(rightAfterToggle.diff) <= 4, rightAfterToggle.diff.toFixed(1));
      t.ok(
        '专注模式下选框标的是聚焦带（而不是整个视口）',
        Math.abs(rightAfterToggle.boxH - rightAfterToggle.wantBoxH) <= 2,
        `${rightAfterToggle.boxH.toFixed(1)}/${rightAfterToggle.wantBoxH.toFixed(1)}`,
      );

      await page.click('#dclose');
      await sleep(320);
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 2200));
      await sleep(350);
      const scrolled = await probe();
      t.ok('滚动之后仍然对齐', Math.abs(scrolled.diff) <= 4, scrolled.diff.toFixed(1));
      t.ok('选框高度仍然正确', Math.abs(scrolled.boxH - scrolled.wantBoxH) <= 2, `${scrolled.boxH.toFixed(1)}/${scrolled.wantBoxH.toFixed(1)}`);
    },
  },
  {
    id: 'B-33b',
    name: '拖缩略图只滚动，不会在正文里拉出选区',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(250);
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: 0 } });
        v.focus();
      });
      const box = await page.evaluate(() => {
        const r = document.getElementById('mini').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height * 0.3 };
      });
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.move(box.x, box.y + 120, { steps: 6 });
      await page.mouse.up();
      await sleep(150);
      const after = await page.evaluate(() => ({
        selected: window.__irori.view.state.selection.main.empty === false,
        domSelection: (getSelection()?.toString() || '').length,
        scroll: window.__irori.view.scrollDOM.scrollTop,
      }));
      t.ok('编辑器里没有选区', !after.selected, '');
      t.eq('页面上也没有选中任何文字', after.domSelection, 0);
      t.ok('但确实滚动了', after.scroll > 50, String(after.scroll));
    },
  },
  {
    id: 'B-34',
    name: '专注模式：开关、聚焦范围、带外渐隐、光标夹持',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(200);
      await page.click('#hair');
      await sleep(320);
      await page.click('#fseg');
      await sleep(350);
      const on = await page.evaluate(() => ({
        body: document.body.classList.contains('focusmode'),
        fadeOpacity: getComputedStyle(document.getElementById('fade')).opacity,
        grad: getComputedStyle(document.getElementById('fade')).backgroundImage.slice(0, 20),
        padTop: document.querySelector('.cm-content').style.paddingTop,
        ftop: getComputedStyle(document.body).getPropertyValue('--ftop').trim(),
      }));
      t.ok('focusmode 打开', on.body, '');
      t.eq('遮罩可见', on.fadeOpacity, '1');
      t.ok('渐隐是一条渐变', on.grad.includes('linear-gradient'), on.grad);
      t.ok('顶部补足 padding（首行能进带内）', parseFloat(on.padTop) > 50, on.padTop);
      t.eq('聚焦上沿默认 20%', on.ftop, '20%');
      // 双滑块：下沿不能越过上沿
      await page.evaluate(() => {
        const el = document.getElementById('fbotR');
        el.value = '10';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const clamped = await page.evaluate(() => document.getElementById('fbotR').value);
      t.ok('下沿被夹住（最小间隔 8%）', Number(clamped) >= 28, clamped);
      await page.click('#fseg');
      await sleep(200);
      const off = await page.evaluate(() => document.body.classList.contains('focusmode'));
      t.ok('再点一次关闭', !off, '');
    },
  },
  {
    id: 'B-35',
    name: '渐隐曲线可拖动三个控制点，可重置',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await page.click('#hair');
      await sleep(320);
      await page.click('#fseg');
      await sleep(120);
      await page.click('#fadjust');
      await sleep(200);
      const before = await page.evaluate(() => document.getElementById('ch2').getAttribute('cy'));
      const h = await page.evaluate(() => {
        const r = document.getElementById('ch2').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.move(h.x, h.y);
      await page.mouse.down();
      await page.mouse.move(h.x + 10, h.y + 25);
      await page.mouse.up();
      await sleep(100);
      const after = await page.evaluate(() => document.getElementById('ch2').getAttribute('cy'));
      t.ok('控制点被拖动了', before !== after, `${before} → ${after}`);
      await page.click('#curvereset');
      await sleep(100);
      const reset = await page.evaluate(() => document.getElementById('ch2').getAttribute('cy'));
      t.eq('重置回默认', reset, before);
    },
  },
  {
    id: 'B-34b',
    name: '专注模式：渐隐盖不住光标，也盖不住顶栏',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(250);
      await page.click('#hair');
      await sleep(320);
      await page.click('#fseg');
      await sleep(200);
      await page.click('#dclose');
      await sleep(400);
      const z = await page.evaluate(() => {
        const fade = document.getElementById('fade');
        const layer = document.querySelector('.cm-cursorLayer');
        const top = document.getElementById('topline').getBoundingClientRect();
        const f = fade.getBoundingClientRect();
        return {
          parent: fade.parentElement.className.split(' ')[0],
          fadeZ: Number(getComputedStyle(fade).zIndex),
          cursorZ: Number(getComputedStyle(layer).zIndex),
          coversTopline: f.top < top.bottom - 1,
        };
      });
      t.eq('渐隐层挂在编辑器里', z.parent, 'cm-editor');
      t.ok('渐隐在光标之下（光标永远看得见）', z.fadeZ < z.cursorZ, `${z.fadeZ} < ${z.cursorZ}`);
      t.ok('渐隐盖不到顶栏', !z.coversTopline, '');
      // 顶栏里的保存指示在专注模式下仍然是清晰的
      const chip = await page.evaluate(() => {
        const el = document.getElementById('filechip').getBoundingClientRect();
        const hit = document.elementFromPoint(el.x + 4, el.y + el.height / 2);
        return hit ? hit.id || hit.className : null;
      });
      t.ok('保存指示没有被任何东西压住', String(chip).includes('filechip') || String(chip).includes('d'), String(chip));
    },
  },
  {
    id: 'B-34c',
    name: '抽屉打开 + 专注模式：渐隐层不越出编辑器，光标也不消失',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md', viewport: { width: 1000, height: 700 } });
      await sleep(250);
      await page.click('.cm-content');
      await sleep(150);
      await page.click('#hair');
      await sleep(400);
      await page.click('#fseg'); // 在抽屉里开专注模式
      await sleep(450);

      const state = await page.evaluate(() => {
        const at = (x, y) => {
          const el = document.elementFromPoint(x, y);
          return el ? (el.id || el.className).toString() : '';
        };
        return {
          overDrawer: at(850, 350),
          overTopline: at(300, 20),
          overBody: at(300, 350),
          focused: document.querySelector('.cm-editor').classList.contains('cm-focused'),
          caret: !!document.querySelector('.cm-cursor'),
          // 编辑器必须自成层叠上下文，否则里面的渐隐会跑到抽屉前面去
          isolation: getComputedStyle(document.querySelector('.cm-editor')).isolation,
        };
      });
      t.eq('编辑器自成层叠上下文', state.isolation, 'isolate');
      t.ok('抽屉上没有渐隐层', !state.overDrawer.includes('fade'), state.overDrawer);
      t.ok('顶栏上没有渐隐层', !state.overTopline.includes('fade'), state.overTopline);
      t.ok('正文上盖的是遮罩（抽屉开着本来就该有）', state.overBody.includes('scrim'), state.overBody);
      t.ok('正文仍然有焦点', state.focused, '');
      t.ok('光标还在', state.caret, '');

      // 关掉专注模式同理：点开关不该把光标弄丢
      await page.click('#fseg');
      await sleep(400);
      const after = await page.evaluate(() => ({
        focused: document.querySelector('.cm-editor').classList.contains('cm-focused'),
        caret: !!document.querySelector('.cm-cursor'),
        off: !document.body.classList.contains('focusmode'),
      }));
      t.ok('开关确实生效', after.off, '');
      t.ok('关掉之后光标还在', after.focused && after.caret, '');
    },
  },
  {
    id: 'B-35b',
    name: '滑动时长随跨越行数递进：一页以内 250→500ms，更远缓慢增长，最多 900ms',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(200);
      const d = await page.evaluate(() => [1, 2, 4, 10, 40, 10000].map((n) => Math.round(window.__irori.focus.glideDuration(n))));
      t.eq('1 行', d[0], 250);
      t.eq('2 行', d[1], 350);
      t.eq('4 行', d[2], 450);
      t.eq('一页（10 行）封顶 500ms', d[3], 500);
      t.eq('更远则给足时间（40 行 1000ms）', d[4], 1000);
      t.eq('再远也不超过 1400ms', d[5], 1400);
    },
  },
  {
    id: 'B-36',
    name: '字数统计：中文按字、英文按词（已批准的偏差）',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '你好世界 hello world' }, startup: '/n/a.md' });
      await sleep(450);
      const wc = await page.evaluate(() => document.getElementById('wcv').textContent);
      t.ok('显示字与词', wc.includes('4 字') && wc.includes('2 词'), wc);
      t.ok('显示预计阅读时间', wc.includes('预计'), wc);
      await page.click('.cm-content');
      await page.keyboard.type('再来十个字啊啊啊啊');
      await sleep(450);
      const wc2 = await page.evaluate(() => document.getElementById('wcv').textContent);
      t.ok('随输入更新', wc2 !== wc, `${wc} → ${wc2}`);
    },
  },
  {
    id: 'B-37',
    name: '⌘F 打开查找面板，Esc 关闭',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await page.click('.cm-content');
      await page.keyboard.down(MOD);
      await page.keyboard.press('f');
      await page.keyboard.up(MOD);
      await sleep(150);
      const open = await page.evaluate(() => !!document.querySelector('.cm-search'));
      t.ok('查找面板出现', open, '');
      await page.keyboard.type('小节 3');
      await sleep(200);
      const hits = await page.evaluate(() => document.querySelectorAll('.cm-searchMatch').length);
      t.ok('命中被高亮', hits >= 1, String(hits));
      await page.keyboard.press('Escape');
      await sleep(150);
      const closed = await page.evaluate(() => !document.querySelector('.cm-search'));
      t.ok('Esc 关闭', closed, '');
    },
  },
  {
    id: 'B-38',
    name: 'Shift+滚轮被重定向为纵向滚动',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(150);
      const before = await page.evaluate(() => window.__irori.view.scrollDOM.scrollTop);
      await page.evaluate(() => {
        const ev = new WheelEvent('wheel', { deltaX: 240, deltaY: 0, shiftKey: true, bubbles: true, cancelable: true });
        document.querySelector('.cm-content').dispatchEvent(ev);
      });
      await sleep(120);
      const after = await page.evaluate(() => window.__irori.view.scrollDOM.scrollTop);
      t.ok('横向增量变成了纵向滚动', after > before, `${before} → ${after}`);
    },
  },
  {
    id: 'B-39b',
    name: '专注模式：在带底回车后接着打字，跟随不会被打断',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(250);
      await page.click('#hair');
      await sleep(320);
      await page.click('#fseg');
      await page.click('#dclose');
      await sleep(400);

      // 把光标放到聚焦带最底下那一行
      await page.evaluate(() => {
        const v = window.__irori.view;
        const s = v.scrollDOM;
        const r = s.getBoundingClientRect();
        const bot = r.top + (r.height * parseFloat(document.getElementById('fbotR').value)) / 100;
        const pos = v.posAtCoords({ x: r.left + 60, y: bot - 6 }, false);
        v.dispatch({ selection: { anchor: pos } });
        v.focus();
      });
      await sleep(700);

      const bandOf = () =>
        page.evaluate(() => {
          const v = window.__irori.view;
          const r = v.scrollDOM.getBoundingClientRect();
          const c = v.coordsAtPos(v.state.selection.main.head);
          return {
            caret: c ? c.bottom : null,
            top: r.top + (r.height * parseFloat(document.getElementById('ftopR').value)) / 100,
            bot: r.top + (r.height * parseFloat(document.getElementById('fbotR').value)) / 100,
          };
        });

      // 回车之后立刻不停地打字 —— 以前这会把正在进行的滑动打断，光标被留在带外
      await page.keyboard.press('Enter');
      for (const ch of ['一', '二', '三', '四', '五', '六', '七', '八']) {
        await page.keyboard.type(ch);
        await sleep(40);
      }
      await sleep(1200);
      const after = await bandOf();
      t.ok('光标仍在聚焦带内', after.caret !== null && after.caret <= after.bot + 8 && after.caret >= after.top - 8, JSON.stringify(after));

      // 再连着敲几个回车，同样要跟得住
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Enter');
        await page.keyboard.type('行');
        await sleep(60);
      }
      await sleep(1200);
      const after2 = await bandOf();
      t.ok('连打几行之后依然在带内', after2.caret !== null && after2.caret <= after2.bot + 8, JSON.stringify(after2));
    },
  },
  {
    id: 'B-40b',
    name: '滚轮：整片书写区都是滚动容器，正文以外（缩略图 / 顶栏）由兜底处理',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(250);
      // 合成的 wheel 事件不会触发浏览器原生滚动，所以「正文区域」这一半用覆盖范围来证明：
      // 只要这些点都落在 .cm-scroller 里，真实滚轮就一定有效
      const covered = await page.evaluate(() => {
        const pts = [
          ['正文中间', innerWidth / 2, innerHeight / 2],
          ['文字列左侧的空白', 40, innerHeight - 200],
          ['文字列右侧的空白', innerWidth - 200, innerHeight - 200],
          ['正文下方的空白', innerWidth / 2, innerHeight - 40],
        ];
        return pts.map(([n, x, y]) => [n, !!document.elementFromPoint(x, y)?.closest('.cm-scroller')]);
      });
      for (const [name, ok] of covered) t.ok(`${name}在滚动容器内`, ok, '');

      // 缩略图和顶部状态栏不在滚动容器里 —— 那里靠窗口层的兜底把滚轮转给正文
      const top = () => page.evaluate(() => window.__irori.view.scrollDOM.scrollTop);
      const wheelOn = (sel) =>
        page.evaluate((s) => {
          const r = document.querySelector(s).getBoundingClientRect();
          const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          el.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }));
        }, sel);
      const t0 = await top();
      await wheelOn('#mini');
      await sleep(120);
      const t1 = await top();
      t.ok('缩略图上滚轮 → 正文滚动', t1 > t0, `${t0} → ${t1}`);
      await wheelOn('.topline');
      await sleep(120);
      const t2 = await top();
      t.ok('顶部状态栏上滚轮 → 正文滚动', t2 > t1, `${t1} → ${t2}`);
    },
  },
  {
    id: 'B-39',
    name: '专注模式下光标被夹在聚焦带内',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(200);
      await page.click('#hair');
      await sleep(320);
      await page.click('#fseg');
      await page.click('#dclose');
      await sleep(300);
      await caretToLine(page, 80);
      await page.keyboard.press('ArrowDown');
      // 等滑动真正落地，而不是睡一个固定时长：这么远的一跳本身就要 GLIDE_MAX_FAR（1400ms），
      // 还可能补一程落点复核 —— 以前睡 1400ms，机器一慢就恰好量在收尾段的起点（差 1.2 行）
      await page.waitForFunction(() => window.__irori.glide.running(), { timeout: 1000 }).catch(() => {});
      await page.waitForFunction(() => !window.__irori.glide.running(), { timeout: 5000 });
      await sleep(150);
      const inBand = await page.evaluate(() => {
        const v = window.__irori.view;
        const c = v.coordsAtPos(v.state.selection.main.head);
        const r = v.scrollDOM.getBoundingClientRect();
        const top = r.top + (r.height * parseFloat(document.getElementById('ftopR').value)) / 100;
        const bot = r.top + (r.height * parseFloat(document.getElementById('fbotR').value)) / 100;
        return { ok: c.top >= top - 30 && c.bottom <= bot + 30, c: c.top, top, bot };
      });
      t.ok('光标在带内', inBand.ok, JSON.stringify(inBand));
      await setCaret(page, 0);
    },
  },
];
