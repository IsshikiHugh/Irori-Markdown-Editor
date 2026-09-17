/* 源码装饰：标记永远可见、永远可编辑；每一行的文本恒等于它的 Markdown 源码。 */
import { docText, lineClasses, setDoc, sleep } from '../harness.mjs';

const SAMPLE = [
  '# 标题一',
  '## 标题二',
  '### 标题三',
  '',
  '正文有 **粗体**、*斜体*、***粗斜***、`代码` 和 [链接](https://example.com/x)。',
  '',
  '> 引用第一行',
  '引用的懒延续',
  '',
  '不在引用里',
  '<!--more-->',
].join('\n');

export const cases = [
  {
    id: 'B-01',
    name: '标题 h1~h6 按级别装饰，# 号始终可见',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': SAMPLE }, startup: '/n/a.md' });
      const cls = await lineClasses(page);
      t.ok('h1', cls[0].includes('h1'), cls[0]);
      t.ok('h2', cls[1].includes('h2'), cls[1]);
      t.ok('h3', cls[2].includes('h3'), cls[2]);
      const shown = await page.evaluate(() => document.querySelector('.cm-content .cm-line').textContent);
      t.eq('# 号仍在行内', shown, '# 标题一');
      const tokDim = await page.evaluate(() => {
        const tok = document.querySelector('.cm-content .cm-line .tok');
        return { text: tok.textContent, color: getComputedStyle(tok).color };
      });
      t.eq('第一个标记是 "# "', tokDim.text, '# ');
      t.ok('标记被淡化', tokDim.color === 'rgb(195, 183, 164)', tokDim.color);
    },
  },
  {
    id: 'B-02',
    name: '行内装饰：粗体/斜体/粗斜/代码/链接，星号不消失',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': SAMPLE }, startup: '/n/a.md' });
      const found = await page.evaluate(() => {
        const line = [...document.querySelectorAll('.cm-content .cm-line')][4];
        const q = (s) => [...line.querySelectorAll(s)].map((e) => e.textContent);
        return {
          text: line.textContent,
          bold: q('.b'),
          italic: q('.i'),
          code: q('.code'),
          link: q('.lnk'),
          url: q('.url'),
          weight: getComputedStyle(line.querySelector('.b')).fontWeight,
          style: getComputedStyle(line.querySelector('.i')).fontStyle,
        };
      });
      t.eq('行文本 === 源码', found.text, '正文有 **粗体**、*斜体*、***粗斜***、`代码` 和 [链接](https://example.com/x)。');
      t.ok('粗体带星号', found.bold.some((x) => x.includes('**粗体**')), JSON.stringify(found.bold));
      t.ok('斜体带星号', found.italic.some((x) => x.includes('*斜体*')), JSON.stringify(found.italic));
      t.ok('粗斜同时命中', found.bold.some((x) => x.includes('***粗斜***')) && found.italic.some((x) => x.includes('***粗斜***')), '');
      t.eq('行内代码', found.code, ['`代码`']);
      t.eq('链接 url 单独着色', found.url, ['https://example.com/x']);
      t.eq('粗体字重', found.weight, '700');
      t.eq('斜体字形', found.style, 'italic');
    },
  },
  {
    id: 'B-03',
    name: '引用左边线：连续引用与懒延续共用一条线，空行终止',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': SAMPLE }, startup: '/n/a.md' });
      const cls = await lineClasses(page);
      t.ok('引用行入组', cls[6].includes('quote'), cls[6]);
      t.ok('懒延续入组', cls[7].includes('quote'), cls[7]);
      t.ok('懒延续不画标记（qlazy）', cls[7].includes('qlazy'), cls[7]);
      t.ok('空行出组', !cls[8].includes('quote'), cls[8]);
      t.ok('空行之后出组', !cls[10].includes('quote'), cls[10]);
      const rail = await page.evaluate(() => {
        const l = [...document.querySelectorAll('.cm-content .cm-line')][6];
        const s = getComputedStyle(l);
        return { border: s.borderLeftWidth, radius: s.borderTopLeftRadius, padLeft: s.paddingLeft, indent: s.textIndent };
      });
      t.eq('左边线 3px', rail.border, '3px');
      t.eq('无圆角（相邻行接得上）', rail.radius, '0px');
      // 悬挂缩进：标记在沟里，文字对齐 —— 这条被 CodeMirror 的内置 padding 覆盖过一次
      t.eq('引用行左内边距 30px', rail.padLeft, '30px');
      t.eq('首行悬挂 -18px', rail.indent, '-18px');
      const marker = await page.evaluate(() => {
        const l = [...document.querySelectorAll('.cm-content .cm-line')][6];
        const tok = l.querySelector('.tok');
        return { text: tok.textContent, x: Math.round(tok.getBoundingClientRect().left - l.getBoundingClientRect().left) };
      });
      t.eq('"> " 标记仍然显示', marker.text, '> ');
      t.ok('标记落在左边线与文字之间', marker.x > 4 && marker.x < 30, String(marker.x));
    },
  },
  {
    id: 'B-04',
    name: '<!--more--> 作为静态分界线',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': SAMPLE }, startup: '/n/a.md' });
      const cls = await lineClasses(page);
      t.ok('morecomment 类', cls[10].includes('morecomment'), cls[10]);
    },
  },
  {
    id: 'B-09',
    name: '空文档的第一行就是正常的一行：光标不会在打下第一个字时跳一下',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/empty.md': '' }, startup: '/n/empty.md' });
      const probe = () =>
        page.evaluate(() => {
          const v = window.__irori.view;
          const line = document.querySelector('.cm-content .cm-line');
          const cs = getComputedStyle(line);
          const c = v.coordsAtPos(v.state.selection.main.head);
          return {
            cls: line.className,
            font: cs.fontSize,
            lineHeight: cs.lineHeight,
            boxH: Math.round(line.getBoundingClientRect().height * 10) / 10,
            caretTop: c ? Math.round(c.top) : null,
            caretH: c ? Math.round(c.bottom - c.top) : null,
          };
        });
      const before = await probe();
      t.ok('空行也带 ln 装饰类', before.cls.includes('ln'), before.cls);
      t.eq('空行字号 19px', before.font, '19px');
      t.eq('空行行高 38.95px', before.lineHeight, '38.95px');
      await page.click('.cm-content');
      await page.keyboard.type('你');
      await sleep(150);
      const after = await probe();
      t.eq('行高不变', after.boxH, before.boxH);
      t.eq('光标顶端不动', after.caretTop, before.caretTop);
      t.near('光标高度基本不变', after.caretH, before.caretH, 1);
    },
  },
  {
    id: 'B-09b',
    name: '卷首花饰：画在第一行上方的留白里，不占行、跟着正文滚，专注模式下也跟着第一行',
    async run(t, ctx) {
      const doc = ['# 标题', '', ...Array.from({ length: 60 }, (_, i) => `第 ${i} 行`)].join('\n');
      const page = await ctx.open({ files: { '/n/a.md': doc }, startup: '/n/a.md' });
      await sleep(300);
      const probe = () =>
        page.evaluate(() => {
          const c = document.querySelector('.cm-content');
          const b = getComputedStyle(c, '::before');
          const a = getComputedStyle(c, '::after');
          const top = c.getBoundingClientRect().top;
          const first = window.__irori.view.lineBlockAt(0).top + window.__irori.view.documentTop;
          const col = c.getBoundingClientRect();
          return {
            // 形状也要断言：之前替换样式时残留了旧规则，几何对了、画出来却是一根斜杠
            diamond: a.width === '6px' && a.height === '6px' && a.borderTopWidth === '1px' && a.transform !== 'none',
            centered: Math.abs(col.left + parseFloat(b.left) + parseFloat(b.width) / 2 - (col.left + col.width / 2)) <= 1.5,
            has: b.content !== 'none' && a.content !== 'none',
            gap: first - (top + parseFloat(b.top)),
            ruleH: b.height,
            lines: window.__irori.view.state.doc.lines,
            firstText: document.querySelector('.cm-content .cm-line')?.textContent,
          };
        });
      const plain = await probe();
      t.ok('花饰存在（两根发丝 + 菱形）', plain.has, '');
      t.ok('中间是一颗 6px 的空心菱形（不是残留的起笔短条）', plain.diamond, '');
      t.ok('发丝在文字列正中', plain.centered, '');
      t.ok('在第一行上方约 24px', Math.abs(plain.gap - 24) <= 2, plain.gap.toFixed(1));
      t.eq('是一根发丝', plain.ruleH, '1px');
      t.eq('不占行：文档行数不变', plain.lines, 62);
      t.eq('第一行仍然是标题', plain.firstText, '# 标题');

      // 跟着正文滚：滚下去以后它就不在视口里了
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 800));
      await sleep(200);
      const scrolled = await page.evaluate(() => {
        const c = document.querySelector('.cm-content');
        const y = c.getBoundingClientRect().top + parseFloat(getComputedStyle(c, '::before').top);
        return y < window.__irori.view.scrollDOM.getBoundingClientRect().top;
      });
      t.ok('滚下去以后它随正文离开视口', scrolled, '');

      // 专注模式把顶部留白撑大，它要跟着下移
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 0));
      await page.click('#hair');
      await sleep(320);
      await page.click('#fseg');
      await sleep(500);
      const focus = await probe();
      t.ok('专注模式下仍在第一行上方约 24px', Math.abs(focus.gap - 24) <= 2, focus.gap.toFixed(1));
    },
  },
  {
    id: 'B-05',
    name: '核心不变量：编辑区文本逐字等于磁盘上的源码',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': SAMPLE }, startup: '/n/a.md' });
      const inEditor = await page.evaluate(() => {
        // join the rendered lines back together — what a person would copy out
        return [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n');
      });
      t.eq('渲染出来的正文 === 文件内容', inEditor, SAMPLE);
      t.eq('文档模型 === 文件内容', await docText(page), SAMPLE);
    },
  },
  {
    id: 'B-06',
    name: 'front-matter 只是正文的头几行，不被解析、不被藏起来',
    async run(t, ctx) {
      const withFm = '---\ntitle: 短篇-《森林》\ntags: [随笔]\n---\n\n正文开始';
      const page = await ctx.open({ files: { '/n/a.md': withFm }, startup: '/n/a.md' });
      t.eq('原样保留', await docText(page), withFm);
      const first = await page.evaluate(() => document.querySelector('.cm-content .cm-line').textContent);
      t.eq('第一行就是 ---', first, '---');
      const hasTitleField = await page.evaluate(() => !!document.querySelector('#title, .titlewrap'));
      t.ok('没有任何标题字段控件', !hasTitleField, '');
    },
  },
  {
    id: 'B-08',
    name: '版面几何与旧编辑器一致（行宽 / 行高 / 内边距 / 顶部留白）',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': SAMPLE }, startup: '/n/a.md' });
      const g = await page.evaluate(() => {
        const content = document.querySelector('.cm-content');
        const line = [...document.querySelectorAll('.cm-content .cm-line.ln')].find((l) => l.textContent.startsWith('正文有'));
        const cs = getComputedStyle(line);
        const cc = getComputedStyle(content);
        const ccs = getComputedStyle(content);
        return {
          scrollerW: document.querySelector('.cm-scroller').getBoundingClientRect().width,
          columnW: content.getBoundingClientRect().width,
          textW:
            content.getBoundingClientRect().width -
            parseFloat(ccs.paddingLeft) -
            parseFloat(ccs.paddingRight),
          lineW: line.getBoundingClientRect().width,
          font: cs.fontSize,
          lineHeight: cs.lineHeight,
          pad: cs.paddingLeft + '/' + cs.paddingRight,
          wrap: cs.overflowWrap,
          padTop: cc.paddingTop,
          color: cs.color,
        };
      });
      // 这些数字直接抄自 blog/editor/app/style.css —— CodeMirror 的内置样式与它们同权重，
      // 一旦某条规则没被 `.cm-editor` 提权就会悄悄跑偏（曾经差 4px，段落换行位置就变了）
      t.eq('内容盒就是文字列本身 652', Math.round(g.columnW), 652);
      t.eq('正文宽度 652', Math.round(g.textW), 652);
      t.eq('行宽 652', Math.round(g.lineW), 652);
      // 滚动区比文字列宽得多：滚轮在正文两侧的空白上也能用（见 B-38）
      t.ok('滚动区占满舞台', g.scrollerW > 900, String(g.scrollerW));
      t.eq('字号 19px', g.font, '19px');
      t.eq('行高 2.05', g.lineHeight, '38.95px');
      t.eq('左右内边距 2px', g.pad, '2px/2px');
      t.eq('断词方式', g.wrap, 'break-word');
      t.eq('顶部留白 44px', g.padTop, '44px');
      t.eq('正文颜色', g.color, 'rgb(109, 93, 89)');
    },
  },
  {
    id: 'B-07',
    name: '编辑后装饰立即跟上，且不改动文本',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '普通一行' }, startup: '/n/a.md' });
      await setDoc(page, '');
      await page.click('.cm-content');
      await page.keyboard.type('## 新标题 **粗**');
      const cls = await lineClasses(page);
      t.ok('实时变成 h2', cls[0].includes('h2'), cls[0]);
      t.eq('文本没有被改写', await docText(page), '## 新标题 **粗**');
    },
  },
];
