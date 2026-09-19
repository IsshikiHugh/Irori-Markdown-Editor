/* Source decoration: wherever the caret is, markers are visible and editable and every line's text is exactly its
   Markdown source; away from it, pictures, tables and links show rendered. */
import { MOD, docText, lineClasses, setDoc, sleep } from '../harness.mjs';

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
    name: 'Headings h1~h6 are decorated by level; # stays visible',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': SAMPLE }, startup: '/n/a.md' });
      const cls = await lineClasses(page);
      t.ok('h1', cls[0].includes('h1'), cls[0]);
      t.ok('h2', cls[1].includes('h2'), cls[1]);
      t.ok('h3', cls[2].includes('h3'), cls[2]);
      const shown = await page.evaluate(() => document.querySelector('.cm-content .cm-line').textContent);
      t.eq('# is still in the line', shown, '# 标题一');
      const tokDim = await page.evaluate(() => {
        const tok = document.querySelector('.cm-content .cm-line .tok');
        return { text: tok.textContent, color: getComputedStyle(tok).color };
      });
      t.eq('first marker is "# "', tokDim.text, '# ');
      t.ok('marker is dimmed', tokDim.color === 'rgb(195, 183, 164)', tokDim.color);
    },
  },
  {
    id: 'B-02',
    name: 'Inline decoration: bold/italic/bold-italic/code/link, asterisks do not disappear',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': SAMPLE }, startup: '/n/a.md' });
      // the caret at the link: it shows as source too (away from the caret only its text shows, B-89)
      await page.evaluate(() => {
        const v = window.__irori.view;
        const line = v.state.doc.line(5);
        v.dispatch({ selection: { anchor: line.from + line.text.indexOf('[') } });
      });
      await sleep(50);
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
      t.eq('line text === source', found.text, '正文有 **粗体**、*斜体*、***粗斜***、`代码` 和 [链接](https://example.com/x)。');
      t.ok('bold keeps its asterisks', found.bold.some((x) => x.includes('**粗体**')), JSON.stringify(found.bold));
      t.ok('italic keeps its asterisks', found.italic.some((x) => x.includes('*斜体*')), JSON.stringify(found.italic));
      t.ok('bold-italic matches both', found.bold.some((x) => x.includes('***粗斜***')) && found.italic.some((x) => x.includes('***粗斜***')), '');
      t.eq('inline code', found.code, ['`代码`']);
      t.eq('link url colored separately', found.url, ['https://example.com/x']);
      t.eq('bold font weight', found.weight, '700');
      t.eq('italic font style', found.style, 'italic');
    },
  },
  {
    id: 'B-03',
    name: 'Quote rail: consecutive quote lines and lazy continuations share one rail; a blank line ends it',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': SAMPLE }, startup: '/n/a.md' });
      const cls = await lineClasses(page);
      t.ok('quote line joins the group', cls[6].includes('quote'), cls[6]);
      t.ok('lazy continuation joins the group', cls[7].includes('quote'), cls[7]);
      t.ok('lazy continuation draws no marker (qlazy)', cls[7].includes('qlazy'), cls[7]);
      t.ok('blank line leaves the group', !cls[8].includes('quote'), cls[8]);
      t.ok('lines after the blank line are out of the group', !cls[10].includes('quote'), cls[10]);
      const rail = await page.evaluate(() => {
        const l = [...document.querySelectorAll('.cm-content .cm-line')][6];
        const s = getComputedStyle(l);
        return { border: s.borderLeftWidth, radius: s.borderTopLeftRadius, padLeft: s.paddingLeft, indent: s.textIndent };
      });
      t.eq('left rail 3px', rail.border, '3px');
      t.eq('no rounded corners (adjacent lines connect)', rail.radius, '0px');
      // Hanging indent: marker sits in the gutter, text stays aligned — this was once overridden by CodeMirror's built-in padding
      t.eq('quote line padding-left 30px', rail.padLeft, '30px');
      t.eq('first-line hang -18px', rail.indent, '-18px');
      const marker = await page.evaluate(() => {
        const l = [...document.querySelectorAll('.cm-content .cm-line')][6];
        const tok = l.querySelector('.tok');
        return { text: tok.textContent, x: Math.round(tok.getBoundingClientRect().left - l.getBoundingClientRect().left) };
      });
      t.eq('"> " marker is still shown', marker.text, '> ');
      t.ok('marker sits between the rail and the text', marker.x > 4 && marker.x < 30, String(marker.x));
    },
  },
  {
    id: 'B-04',
    name: '<!--more--> as a static divider',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': SAMPLE }, startup: '/n/a.md' });
      const cls = await lineClasses(page);
      t.ok('morecomment class', cls[10].includes('morecomment'), cls[10]);
    },
  },
  {
    id: 'B-09',
    name: 'The first line of an empty document is a normal line: the caret does not jump when typing the first character',
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
      t.ok('empty line also has the ln decoration class', before.cls.includes('ln'), before.cls);
      t.eq('empty line font size 19px', before.font, '19px');
      t.eq('empty line line-height 38.95px', before.lineHeight, '38.95px');
      await page.click('.cm-content');
      await page.keyboard.type('你');
      await sleep(150);
      const after = await probe();
      t.eq('line height unchanged', after.boxH, before.boxH);
      t.eq('caret top does not move', after.caretTop, before.caretTop);
      t.near('caret height roughly unchanged', after.caretH, before.caretH, 1);
    },
  },
  {
    id: 'B-09b',
    name: 'Head ornament: drawn in the space above the first line, takes no line, scrolls with the text, and follows the first line in focus mode',
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
            // Assert the shape too: a stale rule once survived a style swap — geometry was right, but it rendered as a slash
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
      t.ok('ornament exists (two hairlines + diamond)', plain.has, '');
      t.ok('a 6px hollow diamond in the middle (not the leftover stroke-start bar)', plain.diamond, '');
      t.ok('hairlines centered on the text column', plain.centered, '');
      t.ok('about 24px above the first line', Math.abs(plain.gap - 24) <= 2, plain.gap.toFixed(1));
      t.eq('it is a hairline', plain.ruleH, '1px');
      t.eq('takes no line: document line count unchanged', plain.lines, 62);
      t.eq('first line is still the heading', plain.firstText, '# 标题');

      // Scrolls with the text: once scrolled down it is out of the viewport
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 800));
      await sleep(200);
      const scrolled = await page.evaluate(() => {
        const c = document.querySelector('.cm-content');
        const y = c.getBoundingClientRect().top + parseFloat(getComputedStyle(c, '::before').top);
        return y < window.__irori.view.scrollDOM.getBoundingClientRect().top;
      });
      t.ok('after scrolling down it leaves the viewport with the text', scrolled, '');

      // Focus mode enlarges the top padding; the ornament must move down with it
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 0));
      await page.click('#hair');
      await sleep(320);
      await page.click('#fseg');
      await sleep(500);
      const focus = await probe();
      t.ok('still about 24px above the first line in focus mode', Math.abs(focus.gap - 24) <= 2, focus.gap.toFixed(1));
    },
  },
  {
    id: 'B-05',
    name: 'Core invariant: editor text equals the source on disk character for character',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': SAMPLE }, startup: '/n/a.md' });
      const inEditor = await page.evaluate(() => {
        // with everything selected every line shows source (links included, see B-89)
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
        // join the rendered lines back together — what a person would copy out
        return [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n');
      });
      t.eq('rendered text === file content', inEditor, SAMPLE);
      t.eq('document model === file content', await docText(page), SAMPLE);
    },
  },
  {
    id: 'B-06',
    name: 'Front matter is just the first few lines of text: not parsed, not hidden',
    async run(t, ctx) {
      const withFm = '---\ntitle: 短篇-《森林》\ntags: [随笔]\n---\n\n正文开始';
      const page = await ctx.open({ files: { '/n/a.md': withFm }, startup: '/n/a.md' });
      t.eq('kept verbatim', await docText(page), withFm);
      const first = await page.evaluate(() => document.querySelector('.cm-content .cm-line').textContent);
      t.eq('first line is ---', first, '---');
      const hasTitleField = await page.evaluate(() => !!document.querySelector('#title, .titlewrap'));
      t.ok('no title field control of any kind', !hasTitleField, '');
    },
  },
  {
    id: 'B-08',
    name: 'Layout geometry matches the old editor (line width / line height / padding / top space)',
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
      // These numbers are copied straight from blog/editor/app/style.css — CodeMirror's built-in styles have the same specificity,
      // so any rule not boosted with `.cm-editor` silently drifts (it was once off by 4px, which changed where paragraphs wrap)
      t.eq('content box is the text column itself 652', Math.round(g.columnW), 652);
      t.eq('text width 652', Math.round(g.textW), 652);
      t.eq('line width 652', Math.round(g.lineW), 652);
      // The scroller is much wider than the text column: the wheel also works over the blank space on both sides (see B-38)
      t.ok('scroller fills the stage', g.scrollerW > 900, String(g.scrollerW));
      t.eq('font size 19px', g.font, '19px');
      t.eq('line height 2.05', g.lineHeight, '38.95px');
      t.eq('left/right padding 2px', g.pad, '2px/2px');
      t.eq('word breaking', g.wrap, 'break-word');
      t.eq('top space 44px', g.padTop, '44px');
      t.eq('text color', g.color, 'rgb(109, 93, 89)');
    },
  },
  {
    id: 'B-07',
    name: 'Decorations catch up immediately after editing, without changing the text',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '普通一行' }, startup: '/n/a.md' });
      await setDoc(page, '');
      await page.click('.cm-content');
      await page.keyboard.type('## 新标题 **粗**');
      const cls = await lineClasses(page);
      t.ok('becomes h2 live', cls[0].includes('h2'), cls[0]);
      t.eq('text was not rewritten', await docText(page), '## 新标题 **粗**');
    },
  },
  {
    id: 'B-74',
    name: 'Lists: markers are dressed, numbers right-align on the dot, wrapped rows and nested items hang under the text',
    async run(t, ctx) {
      const long = '很长'.repeat(40);
      const doc = [
        '段落',
        '',
        '- 第一项',
        `- ${long}`,
        '  - 子项',
        '    续行',
        '',
        '9. 九',
        `10. ${long}`,
        '11. 十一',
      ].join('\n');
      const page = await ctx.open({ files: { '/n/a.md': doc }, startup: '/n/a.md' });
      await sleep(300);
      const g = await page.evaluate(() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')];
        const box = (el) => el.getBoundingClientRect();
        // x of a character inside a line (its text node, by offset)
        const charRects = (line, from, to) => {
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let pos = 0;
          const r = document.createRange();
          let started = false;
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const len = n.textContent.length;
            if (!started && from < pos + len) { r.setStart(n, from - pos); started = true; }
            if (started && to <= pos + len) { r.setEnd(n, to - pos); break; }
            pos += len;
          }
          return [...r.getClientRects()];
        };
        const textStart = (i, at) => charRects(lines[i], at, at + 1)[0].left;
        const wrapped = (i, at) => {
          const rects = charRects(lines[i], at, lines[i].textContent.length);
          return rects[rects.length - 1].left;
        };
        const mark = lines[2].querySelector('.lmark');
        return {
          cls: lines.map((l) => [...l.classList]),
          texts: lines.map((l) => l.textContent),
          markColor: getComputedStyle(mark).color,
          markText: mark.textContent,
          plainLeft: textStart(0, 0),
          bulletText: textStart(2, 2),
          bulletWrap: wrapped(3, 2),
          bulletTextRows: charRects(lines[3], 2, lines[3].textContent.length).length > 1,
          childBox: box(lines[4].querySelector('.lind')).right,
          childText: textStart(4, 4),
          contText: textStart(5, 4),
          dot9: charRects(lines[7], 1, 2)[0].right,
          dot10: charRects(lines[8], 2, 3)[0].right,
          dot11: charRects(lines[9], 2, 3)[0].right,
          text9: textStart(7, 3),
          text10: textStart(8, 4),
          wrap10: wrapped(8, 4),
          mini: document.querySelectorAll('.mini .content .ln.li').length,
        };
      });
      t.eq('editor text === source', await docText(page), doc);
      t.ok('item rows are list rows', [2, 3, 4, 7, 8, 9].every((i) => g.cls[i].includes('li')), JSON.stringify(g.cls));
      t.ok('the continuation line belongs to the list', g.cls[5].includes('li'), g.cls[5]);
      t.ok('a paragraph is not', !g.cls[0].includes('li'), g.cls[0]);
      t.eq('marker keeps its source (marker + blank)', g.markText, '- ');
      t.eq('marker in the accent color', g.markColor, 'rgb(162, 123, 92)');
      t.ok('item text sits right of the paragraph edge', g.bulletText > g.plainLeft + 8, `${g.bulletText} vs ${g.plainLeft}`);
      t.ok('long item really wraps', g.bulletTextRows, '');
      t.near('wrapped row hangs under the item text', g.bulletWrap, g.bulletText, 0.6);
      t.near('nested item starts where its parent text starts', g.childBox, g.bulletText, 0.6);
      t.near('indented continuation lines up with the nested item text', g.contText, g.childText, 0.6);
      t.near('"9." and "10." share the dot', g.dot9, g.dot10, 0.6);
      t.near('"10." and "11." share the dot', g.dot11, g.dot10, 0.6);
      t.near('text after one- and two-digit numbers starts at the same x', g.text9, g.text10, 0.6);
      t.near('wrapped row of a numbered item hangs under its text', g.wrap10, g.text10, 0.6);
      t.ok('minimap mirrors the list rows', g.mini >= 6, String(g.mini));

      // clicking the wrapped row puts the caret inside the item, not on a neighbour
      const at = await page.evaluate(() => {
        const v = window.__irori.view;
        const line = v.state.doc.line(9);
        const end = v.coordsAtPos(line.to);
        const pos = v.posAtCoords({ x: end.left - 4, y: (end.top + end.bottom) / 2 });
        return { pos, from: line.from, to: line.to };
      });
      t.ok('a click on the wrapped row lands in that item', at.pos > at.from + 4 && at.pos <= at.to, JSON.stringify(at));
    },
  },
  {
    id: 'B-88',
    name: 'A table away from the caret shows as a table; the caret in it (a click on a cell, or arrow keys) turns it back into source',
    async run(t, ctx) {
      const md = ['开头一行', '', '| 名称 | 数量 |', '| :-- | --: |', '| **苹果** | 3 |', '| [梨](https://x.y) | 12 |', '', '结尾一行'].join('\n');
      const page = await ctx.open({ files: { '/n/t.md': md }, startup: '/n/t.md' });
      await sleep(150);
      const shown = () =>
        page.evaluate(() => {
          const tbl = document.querySelector('.cm-content .mdtbl');
          return {
            table: !!tbl,
            cells: tbl ? [...tbl.querySelectorAll('th,td')].map((c) => c.innerText.trim()) : [],
            right: tbl ? getComputedStyle(tbl.querySelectorAll('th')[1]).textAlign : '',
            src: [...document.querySelectorAll('.cm-content .cm-line.tsrc')].length,
          };
        });
      let s = await shown();
      t.ok('rendered as a table', s.table, '');
      t.eq('cells show text without markup', s.cells, ['名称', '数量', '苹果', '3', '梨', '12']);
      t.eq('alignment from the delimiter row', s.right, 'right');
      t.eq('no source rows', s.src, 0);
      t.eq('the document is untouched', await docText(page), md);

      // a click on a cell puts the caret at that cell's text
      const cell = await page.evaluate(() => {
        const td = [...document.querySelectorAll('.mdtbl td')][3];
        const r = td.getBoundingClientRect();
        return { x: r.left + 6, y: r.top + r.height / 2 };
      });
      await page.mouse.click(cell.x, cell.y);
      await sleep(150);
      s = await shown();
      t.ok('now source', !s.table && s.src === 4, JSON.stringify(s));
      const caret = await page.evaluate(() => {
        const v = window.__irori.view;
        const head = v.state.selection.main.head;
        const line = v.state.doc.lineAt(head);
        return { line: line.number, col: head - line.from };
      });
      t.eq('caret on that row', caret.line, 6);
      t.ok('at the clicked cell', caret.col >= 20 && caret.col <= 22, JSON.stringify(caret));
      const pipes = await page.evaluate(() => [...document.querySelectorAll('.cm-line.tsrc .tok')].some((e) => e.textContent === '|'));
      t.ok('pipes are markup-coloured in source', pipes, '');

      // leaving turns it back
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: v.state.doc.line(8).from } });
      });
      await sleep(100);
      t.ok('caret gone: a table again', (await shown()).table, '');

      // arrow down from the line above steps into the table's first row
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: v.state.doc.line(2).from } });
        v.focus();
      });
      await page.keyboard.press('ArrowDown');
      await sleep(100);
      t.eq('ArrowDown lands on the header row', await page.evaluate(() => {
        const v = window.__irori.view;
        return v.state.doc.lineAt(v.state.selection.main.head).number;
      }), 3);
      t.ok('and it shows source', !(await shown()).table, '');
      // arrow up from below lands on the last row
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: v.state.doc.line(7).from } });
      });
      await sleep(100);
      await page.keyboard.press('ArrowUp');
      await sleep(100);
      t.eq('ArrowUp lands on the last row', await page.evaluate(() => {
        const v = window.__irori.view;
        return v.state.doc.lineAt(v.state.selection.main.head).number;
      }), 6);

      // the minimap shows it as a table too
      t.ok('minimap renders the table', await page.evaluate(() => !!document.querySelector('#miniContent .mdtbl')), '');
    },
  },
  {
    id: 'B-89',
    name: 'A link away from the caret shows only its text; the caret at it shows the whole source',
    async run(t, ctx) {
      const md = '看 [文档](https://x.y) 再说。\n\n第二行';
      const page = await ctx.open({ files: { '/n/l.md': md }, startup: '/n/l.md' });
      const first = () => page.evaluate(() => document.querySelector('.cm-content .cm-line').textContent);
      const put = (pos) =>
        page.evaluate((p) => {
          const v = window.__irori.view;
          v.dispatch({ selection: { anchor: p } });
        }, pos);
      await put(md.length);
      await sleep(80);
      t.eq('away: only the text', await first(), '看 文档 再说。');
      t.ok('still styled as a link', await page.evaluate(() => document.querySelector('.cm-content .lnk')?.textContent === '文档'), '');
      await put(1); // just before the link, not touching it
      await sleep(80);
      t.eq('same line, not touching: still only the text', await first(), '看 文档 再说。');
      await put(2); // touching its start
      await sleep(80);
      t.eq('caret at it: source', await first(), md.split('\n')[0]);
      await put(md.indexOf(')') + 1); // right after the closing paren
      await sleep(80);
      t.eq('caret right after it: source', await first(), md.split('\n')[0]);
      t.eq('the document is untouched', await docText(page), md);
      // the PDF shows links as their text
      const printed = await page.evaluate(async () => {
        await window.__irori.preparePrint();
        const row = document.querySelector('#print [data-line="1"]');
        // #print only shows in print media, so read what its styles hide rather than its innerText
        const hidden = [...row.querySelectorAll('.lnk > *')].filter((e) => getComputedStyle(e).display === 'none');
        const out = hidden.map((e) => e.textContent).join('');
        window.__irori.clearPrint();
        return out;
      });
      t.eq('PDF: the link markup is hidden', printed, '[](https://x.y)');
    },
  },
  {
    id: 'B-90',
    name: '⌘-click (Ctrl-click off macOS) on a link opens it — in text or in a rendered table; a plain click only places the caret',
    async run(t, ctx) {
      const md = ['看 [文档](https://x.y/doc "标题") 再说。', '', '| 名称 | 链接 |', '| --- | --- |', '| 梨 | [详情](https://x.y/pear) |', '', '末行'].join('\n');
      const page = await ctx.open({ files: { '/n/l.md': md }, startup: '/n/l.md' });
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: v.state.doc.length } });
      });
      await sleep(100);
      const opened = () => page.evaluate(() => window.__irori.platform.openedUrls);
      const centre = (sel) =>
        page.evaluate((s) => {
          const r = document.querySelector(s).getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, sel);
      const modClick = async (p) => {
        await page.keyboard.down(MOD);
        await page.mouse.click(p.x, p.y);
        await page.keyboard.up(MOD);
        await sleep(100);
      };

      // plain click: caret goes in, the link expands, nothing opens
      let at = await centre('.cm-line .lnk');
      await page.mouse.click(at.x, at.y);
      await sleep(100);
      t.eq('plain click opens nothing', await opened(), []);
      t.ok('plain click shows the source', (await page.evaluate(() => document.querySelector('.cm-line').textContent)).includes('](https'), '');

      // ⌘-click on the collapsed link
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: v.state.doc.length } });
      });
      await sleep(100);
      at = await centre('.cm-line .lnk');
      await modClick(at);
      t.eq('⌘-click opens the URL (title left out)', await opened(), ['https://x.y/doc']);
      t.ok('and does not move the caret into it', await page.evaluate(() => {
        const v = window.__irori.view;
        return v.state.selection.main.head === v.state.doc.length;
      }), '');

      // ⌘-click on a link inside the rendered table
      at = await centre('.mdtbl .lnk');
      await modClick(at);
      t.eq('opens a link in a table', (await opened()).at(-1), 'https://x.y/pear');
      t.ok('the table stays rendered', await page.evaluate(() => !!document.querySelector('.cm-content .mdtbl')), '');
    },
  },
];
