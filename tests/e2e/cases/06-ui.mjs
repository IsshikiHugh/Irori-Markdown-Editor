/* The drawer, the shortcut layer, font settings, and the fact that v1 has no menu bar. */
import fs from 'node:fs';
import path from 'node:path';
import { MOD, ROOT, sleep } from '../harness.mjs';

export const cases = [
  {
    id: 'B-60',
    name: 'The hairline on the right edge pulls out the drawer; ⌘\\ toggles it; Esc and the scrim close it',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      const hair = await page.evaluate(() => {
        const r = document.getElementById('hair').getBoundingClientRect();
        return { w: r.width, h: r.height, right: Math.round(window.innerWidth - r.right) };
      });
      t.eq('hairline is 3px wide', Math.round(hair.w), 3);
      t.eq('hairline is 96px tall', Math.round(hair.h), 96);
      t.eq('flush with the right edge', hair.right, 0);
      await page.click('#hair');
      await sleep(350);
      t.ok('drawer opens', await page.evaluate(() => document.body.classList.contains('menuopen')), '');
      const x = await page.evaluate(() => document.querySelector('.drawer').getBoundingClientRect().right - window.innerWidth);
      t.near('drawer fully slides in', x, 0, 1);
      await page.click('#scrim');
      await sleep(350);
      t.ok('clicking the scrim closes it', !(await page.evaluate(() => document.body.classList.contains('menuopen'))), '');
      await page.click('.cm-content');
      await page.keyboard.down(MOD);
      await page.keyboard.press('\\');
      await page.keyboard.up(MOD);
      await sleep(300);
      t.ok('⌘\\ opens', await page.evaluate(() => document.body.classList.contains('menuopen')), '');
      await page.keyboard.press('Escape');
      await sleep(300);
      t.ok('Esc closes', !(await page.evaluate(() => document.body.classList.contains('menuopen'))), '');
    },
  },
  {
    id: 'B-61',
    name: 'The drawer holds only view, word count and settings — none of the blog fields remain',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      const gone = await page.evaluate(() => ({
        slug: !!document.getElementById('slugin'),
        tags: !!document.getElementById('tagrow'),
        publish: !!document.getElementById('pubbtn'),
        list: !!document.getElementById('listwrap'),
        date: !!document.getElementById('datev'),
      }));
      t.eq('slug is gone', gone.slug, false);
      t.eq('tags are gone', gone.tags, false);
      t.eq('publish button is gone', gone.publish, false);
      t.eq('post list is gone', gone.list, false);
      t.eq('date field is gone', gone.date, false);
      const kept = await page.evaluate(() => ({
        focus: !!document.getElementById('fseg'),
        wc: !!document.getElementById('wcv'),
        settings: !!document.getElementById('aseg'),
      }));
      t.eq('focus mode is still there', kept.focus, true);
      t.eq('word count is still there', kept.wc, true);
      t.eq('settings are there', kept.settings, true);
    },
  },
  {
    id: 'B-62',
    name: 'Fonts come from the local machine and can be changed in settings',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      const noWebfont = await page.evaluate(() =>
        [...document.querySelectorAll('link[rel=stylesheet]')].every((l) => !/fonts|jsdelivr|googleapis/.test(l.href)),
      );
      t.ok('no web font dependencies at all', noWebfont, '');
      await page.click('#hair');
      await sleep(320);
      await page.evaluate(() => {
        const el = document.getElementById('fontin');
        el.value = 'Courier New, monospace';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await sleep(200);
      const applied = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).fontFamily);
      t.ok('takes effect immediately', applied.includes('Courier'), applied);
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('irori.settings') || '{}').fontFamily);
      t.ok('persisted', String(saved).includes('Courier'), String(saved));
    },
  },
  {
    id: 'B-63',
    name: 'Focus mode preferences persist across sessions',
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
      t.eq('toggle is remembered', stored.on, true);
      t.eq('top edge is remembered', stored.top, 35);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.__irori && window.__irori.view);
      await sleep(300);
      const restored = await page.evaluate(() => ({
        on: document.body.classList.contains('focusmode'),
        top: document.getElementById('ftopR').value,
      }));
      t.eq('still on after reload', restored.on, true);
      t.eq('top edge is still 35', restored.top, '35');
    },
  },
  {
    id: 'B-66',
    name: 'With focus in a drawer input, ⌘S / ⌘\\ / Esc still work (v1 has no menu bar to fall back on)',
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
      t.eq('⌘S still saves', saved, '原文改动');
      await page.keyboard.press('Escape');
      await sleep(300);
      t.ok('Esc still closes the drawer', !(await page.evaluate(() => document.body.classList.contains('menuopen'))), '');
      await page.focus('#fontin');
      await page.keyboard.down(MOD);
      await page.keyboard.press('\\');
      await page.keyboard.up(MOD);
      await sleep(300);
      t.ok('⌘\\ still opens the drawer', await page.evaluate(() => document.body.classList.contains('menuopen')), '');
      const savedOnce = await page.evaluate(() => window.__irori.doc.dirty);
      t.ok('save is not triggered twice (editor shortcuts and the window layer do not conflict)', savedOnce === false, String(savedOnce));
    },
  },
  {
    id: 'B-67',
    name: 'Focus self-heals: when the text loses focus it takes it back, so shortcuts always have a target',
    async run(t, ctx) {
      const page = await ctx.open({
        files: { '/n/a.md': '原文' },
        startup: '/n/a.md',
        settings: { autosave: false, autosaveDelay: 9000 },
      });
      await page.click('.cm-content');
      await sleep(120);
      // Something else steals focus from the text (in the native window this is the "just opened, text not clicked yet" state)
      await page.evaluate(() => window.__irori.view.contentDOM.blur());
      await sleep(250);
      const back = await page.evaluate(() => document.activeElement?.className || '');
      t.ok('focus returns to the text on its own', back.includes('cm-content'), back);

      // Clicking the blank margins beside the text (part of the scroll container, but not text) must also put focus back on the text
      await page.evaluate(() => {
        const el = document.elementFromPoint(40, innerHeight - 200);
        el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      await sleep(150);
      const afterClick = await page.evaluate(() => document.activeElement?.className || '');
      t.ok('focus is on the text after clicking blank space', afterClick.includes('cm-content'), afterClick);

      // But focus must never be stolen while typing in the drawer
      await page.click('#hair');
      await sleep(320);
      await page.focus('#fontin');
      await sleep(250);
      const inDrawer = await page.evaluate(() => document.activeElement?.id || '');
      t.eq('focus in the drawer input is not stolen', inDrawer, 'fontin');
    },
  },
  {
    id: 'B-68',
    name: 'Double-clicking UI chrome (drawer / TOC / top bar) does not create a selection; inputs still work',
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
      t.eq('double-clicking the drawer title selects nothing', await dblAt('.rhead .t'), 0);
      t.eq('double-clicking a settings label selects nothing', await dblAt('.secttitle'), 0);
      t.eq('double-clicking the shortcut hints selects nothing', await dblAt('.shortcuts'), 0);
      await page.click('#dclose');
      await sleep(320);
      t.eq('double-clicking the top bar file name selects nothing', await dblAt('#filename'), 0);

      // But inputs must still work (focusable, select-all)
      await page.click('#hair');
      await sleep(320);
      await page.click('#fontin');
      await page.evaluate(() => document.getElementById('fontin').select());
      const picked = await page.evaluate(() => {
        const el = document.getElementById('fontin');
        return el.selectionEnd - el.selectionStart;
      });
      t.ok('font input can still select all', picked > 0, String(picked));
      // And the text must of course still be selectable
      await page.click('#dclose');
      await sleep(320);
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: 0, head: 4 } });
        v.focus();
      });
      t.ok('text is still selectable', await page.evaluate(() => !window.__irori.view.state.selection.main.empty), '');
    },
  },
  {
    id: 'B-69',
    name: 'Clicking around in the drawer does not yank the text back to the caret',
    async run(t, ctx) {
      const DOC = ['# 顶部', '', ...Array.from({ length: 300 }, (_, i) => `第 ${i} 行的正文内容`)].join('\n');
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(300);
      const top = () => page.evaluate(() => Math.round(window.__irori.view.scrollDOM.scrollTop));
      // Caret stays at the start, viewport scrolled far away
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: 0 } });
        v.scrollDOM.scrollTop = 3000;
      });
      await sleep(200);
      const before = await top();
      t.ok('actually scrolled far', before > 1000, String(before));

      await page.click('#hair');
      await sleep(350);
      t.eq('opening the drawer does not move the text', await top(), before);

      for (const sel of ['.rhead .t', '.secttitle', '.shortcuts', '#pathv']) {
        const box = await page.evaluate((s) => {
          const r = document.querySelector(s).getBoundingClientRect();
          return { x: r.x + 10, y: r.y + r.height / 2 };
        }, sel);
        await page.mouse.click(box.x, box.y);
        await sleep(200);
        t.eq('clicking ' + sel + ' does not move the text', await top(), before);
      }

      // Refocusing the text must not change the scroll position either (WebKit scrolls the caret into view)
      await page.click('#dclose');
      await sleep(350);
      await page.evaluate(() => window.__irori.focusEditor());
      await sleep(250);
      t.eq('focusing the text does not move the scroll position', await top(), before);
    },
  },
  {
    id: 'B-70b',
    name: 'The whole top strip is a window drag region and is not part of the editor',
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
      t.ok('whole strip is a drag region', bar.drag && bar.innerDrag, '');
      t.ok('the save indicator area is draggable too', bar.chipDrag, '');
      t.ok('spans the window', bar.fullWidth, String(bar.height));
      t.ok('tall enough to grab', bar.height >= 36, String(bar.height));
      t.ok('outside the editor', bar.aboveEditor && !bar.insideEditor, '');
    },
  },
  {
    id: 'B-70c',
    name: 'Transparent title bar: the top bar is draggable across the whole window (including above the minimap), the file name is centered at the top (aligned with the text column), and the minimap viewport box sits below it',
    async run(t, ctx) {
      // Dragging relies on Tauri's drag.js calling start_dragging — without the permission, data-tauri-drag-region does nothing
      const cap = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri/capabilities/default.json'), 'utf8'));
      t.ok('start_dragging permission is granted', cap.permissions.includes('core:window:allow-start-dragging'), '');

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
            // Left margin and minimap top: the two ends outside the stage
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
      t.ok('in the browser (no transparent title bar) the top bar does not cover the minimap', !web.overMini, '');
      t.near('in the browser the viewport box margin is unchanged', web.vpTop, 10, 1);

      await page.evaluate(() => {
        document.body.classList.add('overlay-titlebar');
        dispatchEvent(new Event('resize'));
      });
      await sleep(150);
      const mac = await probe();
      t.ok('flush with the top, spans the window', mac.left === 0 && mac.right === 0 && mac.top === 0, `${mac.left} ${mac.right} ${mac.top}`);
      t.near('only as tall as the traffic-light row', mac.bottom, 28, 0.5);
      t.ok('left margin is draggable', mac.leftEdge, '');
      t.ok('minimap top is draggable', mac.overMini, '');
      t.near('file name shares the text column center line', mac.chipX, 0, 1);
      t.near('file name is level with the traffic lights', mac.chipY, 14, 1.5);
      t.ok('text is below the top bar', mac.editorTop >= mac.bottom, `${mac.editorTop} ≥ ${mac.bottom}`);
      t.ok('viewport box is below the top bar', mac.vpTop >= mac.bottom, `${mac.vpTop} ≥ ${mac.bottom}`);

      // Long file name: truncated, must not reach the traffic lights or the minimap
      await page.evaluate(() => (document.getElementById('filename').textContent = '很长的文件名'.repeat(40)));
      const long = await probe();
      t.ok('long file name does not touch the traffic lights or the minimap', long.chipLeft >= 80 && long.chipRight >= 113, `${long.chipLeft} / ${long.chipRight}`);

      // When the drawer is open the top bar yields to it: ✕ must be clickable
      await page.click('#hair');
      await sleep(350);
      const x = await page.evaluate(() => {
        const r = document.getElementById('dclose').getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.id;
      });
      t.eq('drawer ✕ is not covered by the top bar', x, 'dclose');
    },
  },
  {
    id: 'B-65b',
    name: 'When the doc fits on one screen the page cannot scroll and the minimap cannot be dragged; only overflowing docs get scroll-past-end space',
    async run(t, ctx) {
      const range = (page) =>
        page.evaluate(() => {
          const s = window.__irori.view.scrollDOM;
          return { canScroll: s.scrollHeight - s.clientHeight, noscroll: document.getElementById('mini').classList.contains('noscroll') };
        });
      for (const [label, doc] of [
        ['empty doc', ''],
        ['three lines', '# 标题\n\n一行正文'],
        ['ten lines that fit on one screen', Array.from({ length: 10 }, (_, i) => `第 ${i} 行`).join('\n')],
      ]) {
        const page = await ctx.open({ files: { '/n/a.md': doc }, startup: '/n/a.md', viewport: { width: 1200, height: 780 } });
        await sleep(350);
        const r = await range(page);
        t.ok(`${label}: cannot scroll`, r.canScroll <= 1, String(r.canScroll));
        t.ok(`${label}: minimap marked as not draggable`, r.noscroll, '');
        // Dragging the viewport box does nothing either
        const box = await page.evaluate(() => {
          const b = document.getElementById('vp').getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + Math.min(20, b.height / 2) };
        });
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        await page.mouse.move(box.x, box.y + 200, { steps: 5 });
        await page.mouse.up();
        await sleep(200);
        t.eq(`${label}: still at the top after dragging`, await page.evaluate(() => Math.round(window.__irori.view.scrollDOM.scrollTop)), 0);
        await page.close();
      }

      // Long doc: blank space is kept as before, the last line can scroll far up
      const long = Array.from({ length: 80 }, (_, i) => `第 ${i} 行`).join('\n');
      const page = await ctx.open({ files: { '/n/b.md': long }, startup: '/n/b.md', viewport: { width: 1200, height: 780 } });
      await sleep(350);
      const r = await range(page);
      t.ok('long doc can scroll', r.canScroll > 500, String(r.canScroll));
      t.ok('long doc minimap is draggable', !r.noscroll, '');
      const lastTop = await page.evaluate(async () => {
        const v = window.__irori.view;
        v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight;
        await new Promise((res) => setTimeout(res, 200));
        const line = v.state.doc.line(v.state.doc.lines);
        return v.documentTop + v.lineBlockAt(line.from).top - v.scrollDOM.getBoundingClientRect().top;
      });
      t.ok('last line can scroll into the top half of the viewport', lastTop < 780 / 2, String(Math.round(lastTop)));

      // Typing a short doc past one screen: scroll range appears; deleting back: it disappears again
      const grow = await ctx.open({ files: { '/n/c.md': '开头' }, startup: '/n/c.md', viewport: { width: 1200, height: 780 } });
      await sleep(300);
      await grow.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ changes: { from: v.state.doc.length, insert: '\n' + Array.from({ length: 40 }, (_, i) => `新 ${i}`).join('\n') } });
      });
      await sleep(350);
      t.ok('can scroll once it grows long', (await range(grow)).canScroll > 500, '');
      await grow.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ changes: { from: 2, to: v.state.doc.length, insert: '' } });
      });
      await sleep(350);
      t.ok('cannot scroll again after deleting back within one screen', (await range(grow)).canScroll <= 1, String((await range(grow)).canScroll));

      // Focus mode: a short doc sits entirely inside the focus band, so no scrolling is needed either
      await grow.click('#hair');
      await sleep(320);
      await grow.click('#fseg');
      await sleep(500);
      t.ok('short doc cannot scroll in focus mode either', (await range(grow)).canScroll <= 1, String((await range(grow)).canScroll));
    },
  },
  {
    id: 'B-64',
    name: 'v1 has no menu bar; shortcuts are the only entry point (a documented trade-off)',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      const hints = await page.evaluate(() => document.querySelector('.shortcuts').textContent);
      t.ok('drawer lists the shortcuts', hints.includes('⌘S') && hints.includes('⌘O') && hints.includes('⌘F'), hints);
    },
  },
  {
    id: 'B-65',
    name: 'Window scrollbars are invisible (the minimap viewport box is the scroll indicator)',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': Array.from({ length: 200 }, (_, i) => '第 ' + i + ' 行').join('\n') }, startup: '/n/a.md' });
      await sleep(200);
      const bars = await page.evaluate(() => {
        const s = document.querySelector('.cm-scroller');
        return { docOverflow: getComputedStyle(document.body).overflow, gutter: s.offsetWidth - s.clientWidth };
      });
      t.eq('page itself does not scroll', bars.docOverflow, 'hidden');
      t.eq('editor scrollbar has zero width', bars.gutter, 0);
    },
  },
];
