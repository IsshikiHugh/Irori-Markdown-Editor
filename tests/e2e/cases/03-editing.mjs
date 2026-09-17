/* 编辑行为：中文排版、撤销重做、⌘B/⌘I、整行复制剪切、输入法组字。 */
import { MOD, caret, docText, setCaret, setDoc, sleep } from '../harness.mjs';

const mod = async (page, key, fn = 'press') => {
  await page.keyboard.down(MOD);
  await page.keyboard[fn](key);
  await page.keyboard.up(MOD);
};

export const cases = [
  {
    id: 'B-20',
    name: '段首连打两个半角空格 → 两个全角空格',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '' }, startup: '/n/a.md' });
      await page.click('.cm-content');
      await page.keyboard.type('  正文');
      t.eq('替换成 U+3000', await docText(page), '　　正文');
    },
  },
  {
    id: 'B-21',
    name: '代码围栏内绝不替换空格（代码缩进不被动）',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '```js\n\n```' }, startup: '/n/a.md' });
      await setCaret(page, 6); // 第二行行首
      await page.keyboard.type('  code');
      t.eq('半角空格保留', await docText(page), '```js\n  code\n```');
    },
  },
  {
    id: 'B-22',
    name: '撤销 / 重做',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '起点' }, startup: '/n/a.md' });
      await page.click('.cm-content');
      await page.keyboard.press('End');
      await page.keyboard.type('一二三');
      await sleep(420); // 超过合并窗口
      await page.keyboard.type('四五六');
      await mod(page, 'z');
      const once = await docText(page);
      t.ok('撤销回到上一段输入', once === '起点一二三' || once === '起点', once);
      await page.keyboard.down(MOD);
      await page.keyboard.down('Shift');
      // 按物理键 KeyZ：按住 Shift 时 e.key 才是真实键盘给的 'Z'。按 'z' 的话 Linux / Windows 上
      // 出来的是 Ctrl + 'z'，CodeMirror 会把它当成撤销而不是重做
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Shift');
      await page.keyboard.up(MOD);
      t.eq('重做', await docText(page), '起点一二三四五六');
    },
  },
  {
    id: 'B-23',
    name: '⌘B / ⌘I 给选区加标记，无选区则插入空标记并把光标放中间',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '粗体测试' }, startup: '/n/a.md' });
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: 0, head: 2 } });
        v.focus();
      });
      await mod(page, 'b');
      t.eq('选区加粗', await docText(page), '**粗体**测试');
      await setCaret(page, 0);
      await mod(page, 'i');
      t.eq('空标记', await docText(page), '****粗体**测试');
      t.eq('光标在标记中间', await caret(page), 1);
    },
  },
  {
    id: 'B-24',
    name: '无选区时 ⌘X 剪切整行',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '第一行\n第二行\n第三行' }, startup: '/n/a.md' });
      await setCaret(page, 5); // 第二行中间
      // headless 下 ⌘X 不会产生真实剪贴板事件，直接派发一个 cut 事件驱动同一条代码路径
      await page.evaluate(() => {
        const dt = new DataTransfer();
        document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await sleep(60);
      t.eq('整行被剪掉', await docText(page), '第一行\n第三行');
    },
  },
  {
    id: 'B-25',
    name: '中文输入法组字期间不重建 DOM，落字正确',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '' }, startup: '/n/a.md' });
      await page.click('.cm-content');
      const cdp = await page.target().createCDPSession();
      // 模拟一次真实的拼音组字：预编辑 → 上屏
      await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
      const composing = await page.evaluate(() => document.querySelector('.cm-editor').classList.contains('ime'));
      t.ok('组字期间切到原生光标', composing, '');
      await cdp.send('Input.insertText', { text: '你好' });
      await sleep(80);
      t.eq('上屏结果正确', await docText(page), '你好');
      // 第二次组字（旧编辑器这里会「隔一次失败」）
      await cdp.send('Input.imeSetComposition', { text: 'shi', selectionStart: 3, selectionEnd: 3 });
      await cdp.send('Input.insertText', { text: '世界' });
      await sleep(80);
      t.eq('连续第二次组字也正确', await docText(page), '你好世界');
      const back = await page.evaluate(() => document.querySelector('.cm-editor').classList.contains('ime'));
      t.ok('组字结束后回到自绘光标', !back, '');
    },
  },
  {
    id: 'B-26',
    name: '点击正文下方空白 → 光标落到最后一个字符',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '第一行\n最后一行' }, startup: '/n/a.md' });
      const box = await page.evaluate(() => {
        const r = document.querySelector('.cm-content').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + 300 };
      });
      await page.mouse.click(box.x, box.y);
      const pos = await caret(page);
      t.eq('落在文档末尾', pos, '第一行\n最后一行'.length);
    },
  },
  {
    id: 'B-27',
    name: '当前行高亮跟随光标',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '一\n二\n三' }, startup: '/n/a.md' });
      await setCaret(page, 2);
      await sleep(50);
      const which = await page.evaluate(() =>
        [...document.querySelectorAll('.cm-content .cm-line')].findIndex((l) => l.classList.contains('aline')),
      );
      t.eq('第二行高亮', which, 1);
      const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-line.aline')).backgroundColor);
      // 浏览器会把 alpha 量化到 8 位再报回来，所以比色值、alpha 给一点容差
      const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(bg) || [];
      t.eq('高亮色与旧编辑器一致（暖褐）', [m[1], m[2], m[3]], ['162', '123', '92']);
      t.near('高亮透明度 0.08', Number(m[4]), 0.08, 0.006);
    },
  },
  {
    id: 'B-27b',
    name: '光标只有一条呼吸动画，且渐入渐出都在',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '一些正文' }, startup: '/n/a.md' });
      await page.click('.cm-content');
      await sleep(300);
      const anim = await page.evaluate(() => {
        const cs = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const s = getComputedStyle(el);
          return { name: s.animationName, dur: s.animationDuration, timing: s.animationTimingFunction };
        };
        return { layer: cs('.cm-cursorLayer'), cursor: cs('.cm-cursor') };
      });
      // CodeMirror 自带的是 steps(1) 硬切闪烁，周期又和我们的不一样，两条叠在一起会错相成「双闪」
      t.eq('CodeMirror 自带的闪烁已关掉', anim.layer.dur, '0s');
      t.eq('只留我们这条柔和呼吸', [anim.cursor.name, anim.cursor.dur, anim.cursor.timing], ['caretfade', '1.15s', 'ease-in-out']);
      // CodeMirror 的光标本体是一条黑色左边框，不去干净就会和我们的暖褐色块叠成一深一浅两条
      const bar = await page.evaluate(() => {
        const c = document.querySelector('.cm-cursor');
        const s = getComputedStyle(c);
        return { borderW: s.borderLeftWidth, borderStyle: s.borderLeftStyle, w: s.width, bg: s.backgroundColor, count: document.querySelectorAll('.cm-cursor').length };
      });
      t.eq('只有一条光标', bar.count, 1);
      t.eq('没有残留的黑色边框', bar.borderW + '/' + bar.borderStyle, '0px/none');
      t.eq('就是一条 2px 的暖褐色块', bar.w + ' ' + bar.bg, '2px rgb(162, 123, 92)');

      const samples = await page.evaluate(async () => {
        const cur = document.querySelector('.cm-cursor');
        const out = [];
        for (let i = 0; i < 30; i++) {
          out.push(Number(getComputedStyle(cur).opacity));
          await new Promise((r) => setTimeout(r, 40));
        }
        return out;
      });
      const deltas = samples.slice(1).map((v, i) => v - samples[i]);
      t.ok('有渐出（连续变暗）', deltas.filter((d) => d < -0.05).length >= 3, '');
      t.ok('有渐入（连续变亮）', deltas.filter((d) => d > 0.05).length >= 3, '');
      t.ok('没有硬切（相邻 40ms 的跳变都不大）', Math.max(...deltas.map(Math.abs)) < 0.45, String(Math.max(...deltas.map(Math.abs)).toFixed(2)));
      t.ok('有停在实心的时段', samples.filter((v) => v > 0.99).length >= 3, '');
    },
  },
  {
    id: 'B-28',
    name: '鼠标悬停行高亮（仅鼠标移动时出现）',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '一\n二\n三' }, startup: '/n/a.md' });
      const box = await page.evaluate(() => {
        const r = [...document.querySelectorAll('.cm-content .cm-line')][2].getBoundingClientRect();
        return { x: r.x + 5, y: r.y + r.height / 2 };
      });
      await page.mouse.move(box.x, box.y);
      await sleep(80);
      const hovered = await page.evaluate(() =>
        [...document.querySelectorAll('.cm-content .cm-line')].findIndex((l) => l.classList.contains('mhover')),
      );
      t.eq('第三行悬停高亮', hovered, 2);
      await page.keyboard.press('ArrowUp');
      await sleep(80);
      const gone = await page.evaluate(() => !document.querySelector('.cm-line.mhover'));
      t.ok('键盘接管后悬停高亮消失', gone, '');
    },
  },
  {
    id: 'B-30b',
    name: '跨行选区是规整的矩形：右缘齐平，也不比行高亮宽',
    async run(t, ctx) {
      const para = 'dsfsdfsdf'.repeat(12);
      const page = await ctx.open({ files: { '/n/a.md': ['开头', para, para, '结尾'].join('\n') }, startup: '/n/a.md' });
      await sleep(300);
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: 3, head: v.state.doc.length - 3 } });
        v.focus();
      });
      await sleep(250);
      const r = await page.evaluate(() => {
        const line = document.querySelectorAll('.cm-content .cm-line')[1].getBoundingClientRect();
        const rects = [...document.querySelectorAll('.cm-selectionBackground')].map((e) => {
          const b = e.getBoundingClientRect();
          return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom) };
        });
        return { line: { left: Math.round(line.left), right: Math.round(line.right) }, rects };
      });
      t.ok('选区被画出来了', r.rects.length >= 2, String(r.rects.length));
      // 折行处的矩形都顶到文字列右缘（最后一段除外 —— 它停在选区结束处）
      const full = r.rects.slice(0, -1);
      const ragged = full.filter((q) => Math.abs(q.right - r.line.right) > 3);
      t.eq('右缘齐平，没有参差', ragged.length, 0);
      const wider = r.rects.filter((q) => q.left < r.line.left - 1 || q.right > r.line.right + 1);
      t.eq('也没有比文字列宽', wider.length, 0);
      // 垂直方向连成一片，中间不留缝
      const gaps = r.rects.slice(1).filter((q, i) => q.top - r.rects[i].bottom > 1);
      t.eq('上下衔接没有断层', gaps.length, 0);
    },
  },
  {
    id: 'B-29',
    name: '粘贴纯文本保持源码模型（多行不塌成一行）',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '' }, startup: '/n/a.md' });
      await page.click('.cm-content');
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', '# 标题\n\n正文');
        document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await sleep(60);
      t.eq('三行原样粘入', await docText(page), '# 标题\n\n正文');
      await setDoc(page, '');
    },
  },
];
