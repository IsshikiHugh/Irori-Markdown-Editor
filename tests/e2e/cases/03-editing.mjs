/* Editing behavior: list continuation, undo/redo, ⌘B/⌘I, whole-line copy/cut, IME composition. */
import { MOD, caret, docText, setCaret, setDoc, sleep } from '../harness.mjs';

const mod = async (page, key, fn = 'press') => {
  await page.keyboard.down(MOD);
  await page.keyboard[fn](key);
  await page.keyboard.up(MOD);
};

export const cases = [
  {
    id: 'B-75',
    name: 'Enter in a list item opens the next item; on an empty item it steps out, then ends the list',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '' }, startup: '/n/a.md' });
      await page.click('.cm-content');
      await page.keyboard.type('- 一');
      await page.keyboard.press('Enter');
      await page.keyboard.type('二');
      t.eq('bullet continues', await docText(page), '- 一\n- 二');

      await setDoc(page, '9. 九');
      await setCaret(page, 4);
      await page.keyboard.press('Enter');
      await page.keyboard.type('十');
      t.eq('number counts up', await docText(page), '9. 九\n10. 十');

      await setDoc(page, '1. 甲乙');
      await setCaret(page, 4); // between 甲 and 乙
      await page.keyboard.press('Enter');
      t.eq('split at the caret', await docText(page), '1. 甲\n2. 乙');

      await setDoc(page, '1. 父\n   - 子\n   - ');
      await setCaret(page, 17);
      await page.keyboard.press('Enter');
      t.eq('empty nested item becomes the next sibling of its parent', await docText(page), '1. 父\n   - 子\n2. ');
      await page.keyboard.press('Enter');
      t.eq('empty top-level item: the marker goes', await docText(page), '1. 父\n   - 子\n');
      await page.keyboard.press('Enter');
      t.eq('outside a list Enter is a plain newline', await docText(page), '1. 父\n   - 子\n\n');
    },
  },
  {
    id: 'B-22',
    name: 'Undo / redo',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '起点' }, startup: '/n/a.md' });
      await page.click('.cm-content');
      await page.keyboard.press('End');
      await page.keyboard.type('一二三');
      await sleep(420); // longer than the merge window
      await page.keyboard.type('四五六');
      await mod(page, 'z');
      const once = await docText(page);
      t.ok('undo goes back to the previous chunk of input', once === '起点一二三' || once === '起点', once);
      await page.keyboard.down(MOD);
      await page.keyboard.down('Shift');
      // Press the physical key KeyZ: only then is e.key the real keyboard's 'Z' while Shift is held. Pressing 'z' yields
      // Ctrl + 'z' on Linux / Windows, which CodeMirror treats as undo rather than redo
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Shift');
      await page.keyboard.up(MOD);
      t.eq('redo', await docText(page), '起点一二三四五六');
    },
  },
  {
    id: 'B-23',
    name: '⌘B / ⌘I wrap the selection in markers; with no selection, insert empty markers and put the caret between them',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '粗体测试' }, startup: '/n/a.md' });
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: 0, head: 2 } });
        v.focus();
      });
      await mod(page, 'b');
      t.eq('selection made bold', await docText(page), '**粗体**测试');
      await setCaret(page, 0);
      await mod(page, 'i');
      t.eq('empty markers', await docText(page), '****粗体**测试');
      t.eq('caret between the markers', await caret(page), 1);
    },
  },
  {
    id: 'B-24',
    name: '⌘X with no selection cuts the whole line',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '第一行\n第二行\n第三行' }, startup: '/n/a.md' });
      await setCaret(page, 5); // middle of the second line
      // In headless mode ⌘X produces no real clipboard event, so dispatch a cut event directly to drive the same code path
      await page.evaluate(() => {
        const dt = new DataTransfer();
        document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await sleep(60);
      t.eq('whole line cut', await docText(page), '第一行\n第三行');
    },
  },
  {
    id: 'B-25',
    name: 'Chinese IME composition does not rebuild the DOM and commits the right text',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '' }, startup: '/n/a.md' });
      await page.click('.cm-content');
      const cdp = await page.target().createCDPSession();
      // Simulate a real pinyin composition: preedit → commit
      await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
      const composing = await page.evaluate(() => document.querySelector('.cm-editor').classList.contains('ime'));
      t.ok('switches to the native caret while composing', composing, '');
      await cdp.send('Input.insertText', { text: '你好' });
      await sleep(80);
      t.eq('committed text is correct', await docText(page), '你好');
      // Second composition (the old editor "failed every other time" here)
      await cdp.send('Input.imeSetComposition', { text: 'shi', selectionStart: 3, selectionEnd: 3 });
      await cdp.send('Input.insertText', { text: '世界' });
      await sleep(80);
      t.eq('a second consecutive composition is also correct', await docText(page), '你好世界');
      const back = await page.evaluate(() => document.querySelector('.cm-editor').classList.contains('ime'));
      t.ok('back to the custom-drawn caret after composing', !back, '');
    },
  },
  {
    id: 'B-26',
    name: 'Clicking the blank space below the text → caret lands on the last character',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '第一行\n最后一行' }, startup: '/n/a.md' });
      const box = await page.evaluate(() => {
        const r = document.querySelector('.cm-content').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + 300 };
      });
      await page.mouse.click(box.x, box.y);
      const pos = await caret(page);
      t.eq('lands at the end of the document', pos, '第一行\n最后一行'.length);
    },
  },
  {
    id: 'B-27',
    name: 'Current-line highlight follows the caret',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '一\n二\n三' }, startup: '/n/a.md' });
      await setCaret(page, 2);
      await sleep(50);
      const which = await page.evaluate(() =>
        [...document.querySelectorAll('.cm-content .cm-line')].findIndex((l) => l.classList.contains('aline')),
      );
      t.eq('second line highlighted', which, 1);
      const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-line.aline')).backgroundColor);
      // The browser quantizes alpha to 8 bits before reporting it, so compare the color and allow some tolerance on alpha
      const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(bg) || [];
      t.eq('highlight color matches the old editor (warm brown)', [m[1], m[2], m[3]], ['162', '123', '92']);
      t.near('highlight opacity 0.08', Number(m[4]), 0.08, 0.006);
    },
  },
  {
    id: 'B-27b',
    name: 'The caret has only one breathing animation, with both fade-in and fade-out',
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
      // CodeMirror's built-in blink is a hard steps(1) toggle with a different period than ours; stacked, they drift out of phase into a "double blink"
      t.eq('CodeMirror\'s built-in blink is turned off', anim.layer.dur, '0s');
      t.eq('only our soft breathing remains', [anim.cursor.name, anim.cursor.dur, anim.cursor.timing], ['caretfade', '1.15s', 'ease-in-out']);
      // CodeMirror's caret itself is a black left border; unless fully removed it stacks with our warm-brown bar into one dark and one light line
      const bar = await page.evaluate(() => {
        const c = document.querySelector('.cm-cursor');
        const s = getComputedStyle(c);
        return { borderW: s.borderLeftWidth, borderStyle: s.borderLeftStyle, w: s.width, bg: s.backgroundColor, count: document.querySelectorAll('.cm-cursor').length };
      });
      t.eq('only one caret', bar.count, 1);
      t.eq('no leftover black border', bar.borderW + '/' + bar.borderStyle, '0px/none');
      t.eq('just a 2px warm-brown bar', bar.w + ' ' + bar.bg, '2px rgb(162, 123, 92)');

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
      t.ok('has a fade-out (consecutive dimming)', deltas.filter((d) => d < -0.05).length >= 3, '');
      t.ok('has a fade-in (consecutive brightening)', deltas.filter((d) => d > 0.05).length >= 3, '');
      t.ok('no hard cuts (no large jump between samples 40ms apart)', Math.max(...deltas.map(Math.abs)) < 0.45, String(Math.max(...deltas.map(Math.abs)).toFixed(2)));
      t.ok('has a period where it stays solid', samples.filter((v) => v > 0.99).length >= 3, '');
    },
  },
  {
    id: 'B-28',
    name: 'Mouse hover line highlight (only appears while the mouse moves)',
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
      t.eq('third line hover-highlighted', hovered, 2);
      await page.keyboard.press('ArrowUp');
      await sleep(80);
      const gone = await page.evaluate(() => !document.querySelector('.cm-line.mhover'));
      t.ok('hover highlight disappears once the keyboard takes over', gone, '');
    },
  },
  {
    id: 'B-30b',
    name: 'A multi-line selection is a tidy rectangle: flush right edge, no wider than the line highlight',
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
      t.ok('selection is drawn', r.rects.length >= 2, String(r.rects.length));
      // Rectangles at wrap points all reach the text column's right edge (except the last — it stops where the selection ends)
      const full = r.rects.slice(0, -1);
      const ragged = full.filter((q) => Math.abs(q.right - r.line.right) > 3);
      t.eq('right edge flush, not ragged', ragged.length, 0);
      const wider = r.rects.filter((q) => q.left < r.line.left - 1 || q.right > r.line.right + 1);
      t.eq('not wider than the text column either', wider.length, 0);
      // Vertically continuous, with no gaps in between
      const gaps = r.rects.slice(1).filter((q, i) => q.top - r.rects[i].bottom > 1);
      t.eq('no breaks between rows', gaps.length, 0);
    },
  },
  {
    id: 'B-103',
    name: 'Several carets: ⌥-click adds one, a middle-button (or ⌥⇧) drag makes a column of them under the pointer, Esc goes back to one',
    async run(t, ctx) {
      const md = ['第一行文字', 'second line here', 'third line here too', 'x', 'fifth line of text', '', '- 项目一', '- 项目二', '', '![](a.png)', '', '结尾'].join('\n');
      const page = await ctx.open({ files: { '/n/a.md': md }, startup: '/n/a.md' });
      await sleep(200);
      const sel = () =>
        page.evaluate(() => {
          const v = window.__irori.view;
          return v.state.selection.ranges.map((r) => [v.state.doc.lineAt(r.head).number, r.anchor - v.state.doc.lineAt(r.anchor).from, r.head - v.state.doc.lineAt(r.head).from]);
        });
      const at = (n, col) =>
        page.evaluate(
          (n, col) => {
            const v = window.__irori.view;
            const c = v.coordsAtPos(v.state.doc.line(n).from + col);
            return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
          },
          n,
          col,
        );
      let p = await at(2, 3);
      await page.mouse.click(p.x, p.y);
      p = await at(3, 5);
      await page.keyboard.down('Alt');
      await page.mouse.click(p.x, p.y);
      await page.keyboard.up('Alt');
      await sleep(80);
      t.eq('⌥-click adds a caret', await sel(), [[2, 3, 3], [3, 5, 5]]);
      t.eq('both are drawn, both lines highlighted', await page.evaluate(() => [document.querySelectorAll('.cm-cursor').length, document.querySelectorAll('.cm-line.aline').length]), [2, 2]);
      await page.keyboard.type('Z');
      t.eq('typing goes in at every caret', (await docText(page)).split('\n').slice(1, 3), ['secZond line here', 'thirdZ line here too']);
      await page.keyboard.press('Escape');
      t.eq('Esc: back to one caret, the last one added', await sel(), [[3, 6, 6]]);

      // a middle-button drag straight down: one caret per line, each right under the pointer
      const a = await at(1, 2);
      const z = await at(5, 2);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(a.x, z.y, { steps: 5 });
      await page.mouse.up({ button: 'middle' });
      const col = await page.evaluate(() => {
        const v = window.__irori.view;
        return v.state.selection.ranges.map((r) => ({ empty: r.empty, x: Math.round(v.coordsAtPos(r.head).left) }));
      });
      t.eq('five carets', col.length, 5);
      t.ok('all empty', col.every((c) => c.empty), JSON.stringify(col));
      t.ok('each under the pointer (the short line: at its end)', col.filter((_, i) => i !== 3).every((c) => Math.abs(c.x - a.x) < 12), `${a.x} ${JSON.stringify(col)}`);
      // dragged across: one range per line
      const z2 = await at(5, 8);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(z2.x, z2.y, { steps: 5 });
      await page.mouse.up({ button: 'middle' });
      const box = await sel();
      t.ok('a strip of every line is selected', box.length === 5 && box.filter((_, i) => i !== 3).every(([, f, h]) => h > f), JSON.stringify(box));
      // the same with ⌥⇧ and the left button (a trackpad has no middle one)
      await page.keyboard.press('Escape');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Shift');
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(z2.x, z2.y, { steps: 5 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await page.keyboard.up('Alt');
      t.eq('⌥⇧-drag does the same', await sel(), box);
      t.eq('the text is untouched by selecting', (await docText(page)).split('\n')[4], 'fifth line of text');

      // Enter with a caret on each of two list items continues both lists
      await page.evaluate(() => {
        const v = window.__irori.view;
        const S = v.state.selection.constructor;
        v.dispatch({ selection: S.create([S.cursor(v.state.doc.line(7).to), S.cursor(v.state.doc.line(8).to)], 1) });
        v.focus();
      });
      await page.keyboard.press('Enter');
      await sleep(60);
      t.eq('each list continues', (await docText(page)).split('\n').slice(6, 10), ['- 项目一', '- ', '- 项目二', '- ']);
      // a second caret on the picture line turns it into source, like the first would
      await page.evaluate(() => {
        const v = window.__irori.view;
        const S = v.state.selection.constructor;
        let n = 1;
        while (!v.state.doc.line(n).text.startsWith('![')) n++;
        v.dispatch({ selection: S.create([S.cursor(0), S.cursor(v.state.doc.line(n).from + 1)], 0) });
      });
      await sleep(100);
      t.ok('a secondary caret shows the picture line as source', await page.evaluate(() => !document.querySelector('.cm-content .imgwrap')), '');
    },
  },
  {
    id: 'B-102',
    name: '⌘A in a code or math block selects what is between its fences first, the whole document on the second press',
    async run(t, ctx) {
      const md = ['开头', '', '```js', 'const a = 1;', 'const b = 2;', '```', '', '$$', 'x^2', '$$', '', '$$ y_1 $$', '', '```', '```', '', '结尾'].join('\n');
      const page = await ctx.open({ files: { '/n/a.md': md }, startup: '/n/a.md' });
      await sleep(200);
      const sel = () =>
        page.evaluate(() => {
          const v = window.__irori.view;
          return v.state.selection.ranges.map((r) => v.state.sliceDoc(r.from, r.to));
        });
      const selectAll = () => page.keyboard.down(MOD).then(() => page.keyboard.press('a')).then(() => page.keyboard.up(MOD)).then(() => sleep(60));
      const put = (line, col = 0) =>
        page.evaluate(
          (n, c) => {
            const v = window.__irori.view;
            v.dispatch({ selection: { anchor: v.state.doc.line(n).from + c } });
            v.focus();
          },
          line,
          col,
        );
      await put(4, 3);
      await selectAll();
      t.eq('first ⌘A: the code between the fences', await sel(), ['const a = 1;\nconst b = 2;']);
      await selectAll();
      t.eq('second ⌘A: the whole document', await sel(), [md]);
      await put(3, 2);
      await selectAll();
      t.eq('from the opening fence line too', await sel(), ['const a = 1;\nconst b = 2;']);
      // a selection inside the block, not yet all of it, still goes to the block first
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: v.state.doc.line(4).from + 1, head: v.state.doc.line(5).from + 3 } });
      });
      await selectAll();
      t.eq('a partial selection grows to the block', await sel(), ['const a = 1;\nconst b = 2;']);
      await put(9);
      await selectAll();
      t.eq('a math block: the TeX between the $$ lines', await sel(), ['x^2']);
      await selectAll();
      t.eq('then the document', await sel(), [md]);
      await put(12, 4);
      await selectAll();
      t.eq('a one-line $$…$$: the TeX inside', await sel(), [' y_1 ']);
      await put(14);
      await selectAll();
      t.eq('an empty code block: the document at once', await sel(), [md]);
      await put(1);
      await selectAll();
      t.eq('outside any block: the document at once', await sel(), [md]);
      // a selection reaching out of the block: the document
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: v.state.doc.line(2).from, head: v.state.doc.line(4).from + 2 } });
      });
      await selectAll();
      t.eq('a selection that leaves the block: the document', await sel(), [md]);
      t.eq('the text is untouched', await docText(page), md);
    },
  },
  {
    id: 'B-30c',
    name: 'A selection inside a code block can be seen: the band is a tint over the selection, not a lid on it',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': ['开头', '```js', 'const a = 1;', 'const b = 2;', '```', '结尾'].join('\n') }, startup: '/n/a.md' });
      await sleep(300);
      await page.evaluate(() => {
        const v = window.__irori.view;
        const from = v.state.doc.line(3).from + 2;
        const to = v.state.doc.line(4).to - 2;
        v.dispatch({ selection: { anchor: from, head: to } });
        v.focus();
      });
      await sleep(250);
      const r = await page.evaluate(() => {
        const alpha = (el) => {
          const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
          const parts = m ? m[1].split(',').map((x) => parseFloat(x)) : [];
          return parts.length === 4 ? parts[3] : 1;
        };
        const lines = [...document.querySelectorAll('.cm-content .cm-line.cb')];
        const layer = document.querySelector('.cm-selectionLayer');
        return {
          bands: lines.length,
          alphas: lines.map(alpha),
          inline: [...document.querySelectorAll('.cm-content .code')].map(alpha),
          layerBelow: layer ? parseInt(getComputedStyle(layer).zIndex, 10) < 0 : null,
          drawn: document.querySelectorAll('.cm-selectionBackground').length,
        };
      });
      t.ok('the code block is decorated', r.bands >= 3, String(r.bands));
      t.ok('the selection is drawn on the layer behind the text', r.layerBelow === true && r.drawn >= 1, JSON.stringify(r));
      t.ok('so every code line lets it show through (translucent band)', r.alphas.every((a) => a < 1), r.alphas.join(' '));
    },
  },
  {
    id: 'B-29',
    name: 'Pasting plain text keeps the source model (multiple lines do not collapse into one)',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '' }, startup: '/n/a.md' });
      await page.click('.cm-content');
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', '# 标题\n\n正文');
        document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await sleep(60);
      t.eq('three lines pasted verbatim', await docText(page), '# 标题\n\n正文');
      await setDoc(page, '');
    },
  },
];
