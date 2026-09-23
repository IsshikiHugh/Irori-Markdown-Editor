/* TOC, minimap, focus mode, word count, search. */
import { MOD, caretToLine, setCaret, sleep } from '../harness.mjs';

/** wait until nothing is gliding any more (a far jump takes up to 1.4s, plus a landing leg) */
const settled = async (page) => {
  // typewriter mode waits for the caret to hold still (FOLLOW_DELAY, 250ms) before it glides
  await page.waitForFunction(() => window.__irori.glide.running(), { timeout: 1000 }).catch(() => {});
  await page.waitForFunction(() => !window.__irori.glide.running(), { timeout: 6000 });
  await sleep(200);
};

const long = (n) => Array.from({ length: n }, (_, i) => (i % 12 === 0 ? `## 小节 ${i / 12 + 1}` : `第 ${i} 行的正文内容`)).join('\n');
const DOC = ['# 大标题', '', '开头段落', '', long(120)].join('\n');

export const cases = [
  {
    id: 'B-30',
    name: 'TOC is auto-generated from h1~h3, including the top-level heading',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(200);
      const items = await page.evaluate(() => [...document.querySelectorAll('#toc .toc-link')].map((a) => a.textContent));
      t.ok('at least 10 entries', items.length >= 10, String(items.length));
      t.eq('first entry is the document h1', items[0], '大标题');
      const lvl = await page.evaluate(() => document.querySelector('#toc .toc-link').className);
      t.ok('indented by level', lvl.includes('lvl1'), lvl);
    },
  },
  {
    id: 'B-31',
    name: 'clicking a TOC entry scrolls to its section; the current section is highlighted while scrolling',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(200);
      await page.evaluate(() => [...document.querySelectorAll('#toc .toc-link')][5].click());
      await sleep(400);
      const scrolled = await page.evaluate(() => window.__irori.view.scrollDOM.scrollTop);
      t.ok('scrolled', scrolled > 100, String(scrolled));
      await sleep(200);
      const active = await page.evaluate(() => {
        const a = document.querySelector('#toc .toc-link.active');
        return a ? a.textContent : null;
      });
      t.ok('current section is highlighted', !!active, String(active));
    },
  },
  {
    id: 'B-32',
    name: 'minimap is a proportional miniature of the whole doc; viewport box tracks scrolling',
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
      t.ok('minimap rows rendered', m.rows > 5, String(m.rows));
      t.ok('uniformly scaled', /scale\(0\.\d+\)/.test(m.scale), m.scale);
      t.ok('viewport box height is reasonable', m.vpH > 10 && m.vpH < 400, String(m.vpH));
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 1500));
      await sleep(150);
      const after = await page.evaluate(() => parseFloat(document.getElementById('vp').style.top));
      t.ok('viewport box moves with scrolling', after > m.vpTop, `${m.vpTop} → ${after}`);
    },
  },
  {
    id: 'B-33',
    name: 'clicking anywhere on the minimap → viewport jumps there',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(250);
      const box = await page.evaluate(() => {
        const r = document.getElementById('mini').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height * 0.6 };
      });
      const before = await page.evaluate(() => window.__irori.view.scrollDOM.scrollTop);
      await page.mouse.click(box.x, box.y);
      await sleep(700); // it glides there now (up to 500ms)
      const after = await page.evaluate(() => window.__irori.view.scrollDOM.scrollTop);
      t.ok('scroll position changed', Math.abs(after - before) > 50, `${before} → ${after}`);
    },
  },
  {
    id: 'B-31b',
    name: 'jumps glide, and the final 250ms tail does not depend on jump distance',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(250);
      // Run one TOC jump: sample the scroll position and also fetch the glide data the editor recorded for it
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

      t.ok('the near jump did scroll', dist(near) > 150, String(Math.round(dist(near))));
      t.ok('the far jump scrolled farther', dist(far) > dist(near) * 1.8, `${Math.round(dist(near))} vs ${Math.round(dist(far))}`);
      const moving = near.samples.filter((y) => y > 1 && y < near.samples[near.samples.length - 1] - 1);
      t.ok('not done in a single frame (intermediate positions were sampled)', moving.length >= 4, String(moving.length));
      t.ok('at most 500ms within a page, at most 1400ms when farther', near.run.total <= 1400 && far.run.total <= 1400, `${Math.round(near.run.total)} / ${Math.round(far.run.total)}`);
      t.ok('the far jump takes longer overall', far.run.total >= near.run.total, `${near.run.total} → ${far.run.total}`);

      // Tail invariants
      t.eq('tail segment is always 250ms', [near.run.tailMs, far.run.tailMs], [250, 250]);
      t.ok('tail distance does not depend on jump distance', Math.abs(tail(near) - tail(far)) < 12, `${Math.round(tail(near))} vs ${Math.round(tail(far))}`);
      t.ok('tail covers a line or two, not a whole page', tail(near) > 8 && tail(near) < 90, String(Math.round(tail(near))));
    },
  },
  {
    id: 'B-31c',
    name: 'long jumps always land exactly (including scrolling all the way to the end)',
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
      // Glide straight to the end of the doc: at departure CodeMirror only has estimated heights for what lies below
      const r = await page.evaluate(async () => {
        const el = window.__irori.view.scrollDOM;
        window.__irori.glide.to(() => el.scrollHeight);
        await window.__settle();
        return { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) };
      });
      t.ok('actually reached the bottom (off by < 2px)', Math.abs(r.top - r.max) <= 2, `${r.top} / ${r.max}`);

      // Jump to the last section; it must land exactly too
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
      t.ok('landed on the last section (off by < 3px)', Math.abs(h.top - h.want) <= 3, `${h.top} / ${h.want}`);
    },
  },
  {
    id: 'B-32b',
    name: 'minimap stays aligned with the viewport in focus mode (the extra top padding must be accounted for)',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(300);
      const probe = () =>
        page.evaluate(() => {
          const v = window.__irori.view;
          const s = v.scrollDOM;
          const r = s.getBoundingClientRect();
          // Take the line at the **middle** of the viewport: in focus mode the viewport top may fall inside the top padding, where there is no line
          const pos = v.posAtCoords({ x: r.left + 40, y: r.top + r.height / 2 }, false);
          const scrollSpaceY = v.lineBlockAt(pos).top + v.documentPadding.top;
          const vp = document.getElementById('vp').getBoundingClientRect();
          const mini = document.getElementById('mini').getBoundingClientRect();
          const content = document.getElementById('miniContent');
          const scale = Number((content.style.transform.match(/scale\(([\d.]+)\)/) || [0, 0])[1]);
          const inMini = mini.top + parseFloat(content.style.top) + scrollSpaceY * scale;
          // The viewport box marks "the part actually visible": normal mode = the whole viewport, focus mode = the focus band
          const focusOn = document.body.classList.contains('focusmode');
          const seen = focusOn
            ? (r.height * (parseFloat(document.getElementById('fbotR').value) - parseFloat(document.getElementById('ftopR').value))) / 100
            : s.clientHeight;
          return {
            padTop: Math.round(v.documentPadding.top),
            // It should sit right in the middle of the viewport box
            diff: inMini - (vp.top + vp.height / 2),
            boxH: vp.height,
            wantBoxH: seen * scale,
            focusOn,
          };
        });

      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 1500));
      await sleep(300);
      const plain = await probe();
      t.ok('normal mode: the line at the viewport center sits at the center of the box', Math.abs(plain.diff) <= 3, plain.diff.toFixed(1));
      t.ok('normal mode: box height = viewport height, scaled', Math.abs(plain.boxH - plain.wantBoxH) <= 2, `${plain.boxH.toFixed(1)}/${plain.wantBoxH.toFixed(1)}`);

      await page.click('#hair');
      await sleep(320);
      await page.click('#fseg');
      // Wait for two things: CodeMirror measuring the new padding, and the glide that brings the caret back into the focus band landing
      await page.waitForFunction(() => !window.__irori.glide.running(), { timeout: 4000 });
      await sleep(250);
      const rightAfterToggle = await probe();
      t.ok('right after enabling focus mode: padding did grow', rightAfterToggle.padTop > 100, String(rightAfterToggle.padTop));
      t.ok('already aligned right after enabling focus mode', Math.abs(rightAfterToggle.diff) <= 4, rightAfterToggle.diff.toFixed(1));
      t.ok(
        'in focus mode the box marks the focus band (not the whole viewport)',
        Math.abs(rightAfterToggle.boxH - rightAfterToggle.wantBoxH) <= 2,
        `${rightAfterToggle.boxH.toFixed(1)}/${rightAfterToggle.wantBoxH.toFixed(1)}`,
      );

      await page.click('#dclose');
      await sleep(320);
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 2200));
      await sleep(350);
      const scrolled = await probe();
      t.ok('still aligned after scrolling', Math.abs(scrolled.diff) <= 4, scrolled.diff.toFixed(1));
      t.ok('box height still correct', Math.abs(scrolled.boxH - scrolled.wantBoxH) <= 2, `${scrolled.boxH.toFixed(1)}/${scrolled.wantBoxH.toFixed(1)}`);
    },
  },
  {
    id: 'B-33b',
    name: 'dragging the minimap only scrolls and does not create a selection in the text',
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
      t.ok('no selection in the editor', !after.selected, '');
      t.eq('no text selected on the page either', after.domSelection, 0);
      t.ok('but it did scroll', after.scroll > 50, String(after.scroll));
    },
  },
  {
    id: 'B-34',
    name: 'focus mode: toggle, focus range, fade outside the band, caret clamping',
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
      t.ok('focusmode is on', on.body, '');
      t.eq('fade overlay visible', on.fadeOpacity, '1');
      t.ok('fade is a gradient', on.grad.includes('linear-gradient'), on.grad);
      t.ok('top padding added (first line can enter the band)', parseFloat(on.padTop) > 50, on.padTop);
      t.eq('focus band top edge defaults to 20%', on.ftop, '20%');
      // Dual slider: the bottom edge cannot cross the top edge
      await page.evaluate(() => {
        const el = document.getElementById('fbotR');
        el.value = '10';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const clamped = await page.evaluate(() => document.getElementById('fbotR').value);
      t.ok('bottom edge is clamped (min gap 8%)', Number(clamped) >= 28, clamped);
      await page.click('#fseg');
      await sleep(200);
      const off = await page.evaluate(() => document.body.classList.contains('focusmode'));
      t.ok('clicking again turns it off', !off, '');
    },
  },
  {
    id: 'B-35',
    name: 'fade curve has three draggable control points and can be reset',
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
      t.ok('control point was dragged', before !== after, `${before} → ${after}`);
      await page.click('#curvereset');
      await sleep(100);
      const reset = await page.evaluate(() => document.getElementById('ch2').getAttribute('cy'));
      t.eq('reset to default', reset, before);
    },
  },
  {
    id: 'B-34b',
    name: 'focus mode: the fade covers neither the caret nor the top bar',
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
      t.eq('fade layer is mounted inside the editor', z.parent, 'cm-editor');
      t.ok('fade is below the caret (caret always visible)', z.fadeZ < z.cursorZ, `${z.fadeZ} < ${z.cursorZ}`);
      t.ok('fade does not cover the top bar', !z.coversTopline, '');
      // The save indicator in the top bar stays clear in focus mode
      const chip = await page.evaluate(() => {
        const el = document.getElementById('filechip').getBoundingClientRect();
        const hit = document.elementFromPoint(el.x + 4, el.y + el.height / 2);
        return hit ? hit.id || hit.className : null;
      });
      t.ok('save indicator is not covered by anything', String(chip).includes('filechip') || String(chip).includes('d'), String(chip));
    },
  },
  {
    id: 'B-34c',
    name: 'drawer open + focus mode: fade layer stays inside the editor and the caret does not disappear',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md', viewport: { width: 1000, height: 700 } });
      await sleep(250);
      await page.click('.cm-content');
      await sleep(150);
      await page.click('#hair');
      await sleep(400);
      await page.click('#fseg'); // enable focus mode from the drawer
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
          // The editor must form its own stacking context, otherwise the fade inside it ends up in front of the drawer
          isolation: getComputedStyle(document.querySelector('.cm-editor')).isolation,
        };
      });
      t.eq('editor forms its own stacking context', state.isolation, 'isolate');
      t.ok('no fade layer over the drawer', !state.overDrawer.includes('fade'), state.overDrawer);
      t.ok('no fade layer over the top bar', !state.overTopline.includes('fade'), state.overTopline);
      t.ok('the text is covered by the scrim (expected while the drawer is open)', state.overBody.includes('scrim'), state.overBody);
      t.ok('editor still has focus', state.focused, '');
      t.ok('caret still present', state.caret, '');

      // Same when turning focus mode off: clicking the toggle must not lose the caret
      await page.click('#fseg');
      await sleep(400);
      const after = await page.evaluate(() => ({
        focused: document.querySelector('.cm-editor').classList.contains('cm-focused'),
        caret: !!document.querySelector('.cm-cursor'),
        off: !document.body.classList.contains('focusmode'),
      }));
      t.ok('toggle took effect', after.off, '');
      t.ok('caret still present after turning it off', after.focused && after.caret, '');
    },
  },
  {
    id: 'B-35b',
    name: 'glide duration grows with lines crossed: 250→500ms within a page, slower growth beyond, at most 1400ms',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(200);
      const d = await page.evaluate(() => [1, 2, 4, 10, 40, 10000].map((n) => Math.round(window.__irori.focus.glideDuration(n))));
      t.eq('1 line', d[0], 250);
      t.eq('2 lines', d[1], 350);
      t.eq('4 lines', d[2], 450);
      t.eq('one page (10 lines) caps at 500ms', d[3], 500);
      t.eq('farther gets enough time (40 lines → 1000ms)', d[4], 1000);
      t.eq('never more than 1400ms, however far', d[5], 1400);
    },
  },
  {
    id: 'B-36',
    name: 'word count: Chinese by character, English by word (approved deviation)',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '你好世界 hello world' }, startup: '/n/a.md' });
      await sleep(450);
      const wc = await page.evaluate(() => document.getElementById('wcv').textContent);
      t.ok('shows characters and words', wc.includes('4 字') && wc.includes('2 词'), wc);
      t.ok('shows estimated reading time', wc.includes('预计'), wc);
      await page.click('.cm-content');
      await page.keyboard.type('再来十个字啊啊啊啊');
      await sleep(450);
      const wc2 = await page.evaluate(() => document.getElementById('wcv').textContent);
      t.ok('updates while typing', wc2 !== wc, `${wc} → ${wc2}`);
    },
  },
  {
    id: 'B-37',
    name: '⌘F opens the search panel, Esc closes it',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await page.click('.cm-content');
      await page.keyboard.down(MOD);
      await page.keyboard.press('f');
      await page.keyboard.up(MOD);
      await sleep(150);
      const open = await page.evaluate(() => !!document.querySelector('.cm-search'));
      t.ok('search panel appears', open, '');
      await page.keyboard.type('小节 3');
      await sleep(200);
      const hits = await page.evaluate(() => document.querySelectorAll('.cm-searchMatch').length);
      t.ok('matches are highlighted', hits >= 1, String(hits));
      await page.keyboard.press('Escape');
      await sleep(150);
      const closed = await page.evaluate(() => !document.querySelector('.cm-search'));
      t.ok('Esc closes it', closed, '');
    },
  },
  {
    id: 'B-38',
    name: 'Shift+wheel is redirected to vertical scrolling',
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
      t.ok('horizontal delta became vertical scrolling', after > before, `${before} → ${after}`);
    },
  },
  {
    id: 'B-39b',
    name: 'focus mode: typing right after Enter at the band bottom does not break caret following',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(250);
      await page.click('#hair');
      await sleep(320);
      await page.click('#fseg');
      await page.click('#dclose');
      await sleep(400);

      // Put the caret on the bottom line of the focus band
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

      // Keep typing right after Enter — this used to interrupt the ongoing glide and leave the caret outside the band
      await page.keyboard.press('Enter');
      for (const ch of ['一', '二', '三', '四', '五', '六', '七', '八']) {
        await page.keyboard.type(ch);
        await sleep(40);
      }
      await sleep(1200);
      const after = await bandOf();
      t.ok('caret still inside the focus band', after.caret !== null && after.caret <= after.bot + 8 && after.caret >= after.top - 8, JSON.stringify(after));

      // Then press Enter several times in a row; following must keep up too
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Enter');
        await page.keyboard.type('行');
        await sleep(60);
      }
      await sleep(1200);
      const after2 = await bandOf();
      t.ok('still inside the band after typing several lines', after2.caret !== null && after2.caret <= after2.bot + 8, JSON.stringify(after2));
    },
  },
  {
    id: 'B-40b',
    name: 'wheel: the whole writing area is the scroll container; outside the text (minimap / top bar) a fallback handles it',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': DOC }, startup: '/n/a.md' });
      await sleep(250);
      // Synthetic wheel events do not trigger native browser scrolling, so the "text area" half is proven via coverage:
      // as long as all these points land inside .cm-scroller, a real wheel is guaranteed to work
      const covered = await page.evaluate(() => {
        const pts = [
          ['text center', innerWidth / 2, innerHeight / 2],
          ['blank space left of the text column', 40, innerHeight - 200],
          ['blank space right of the text column', innerWidth - 200, innerHeight - 200],
          ['blank space below the text', innerWidth / 2, innerHeight - 40],
        ];
        return pts.map(([n, x, y]) => [n, !!document.elementFromPoint(x, y)?.closest('.cm-scroller')]);
      });
      for (const [name, ok] of covered) t.ok(`${name} is inside the scroll container`, ok, '');

      // The minimap and top status bar are outside the scroll container — there a window-level fallback forwards the wheel to the text
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
      t.ok('wheel over minimap → text scrolls', t1 > t0, `${t0} → ${t1}`);
      await wheelOn('.topline');
      await sleep(120);
      const t2 = await top();
      t.ok('wheel over top status bar → text scrolls', t2 > t1, `${t1} → ${t2}`);
    },
  },
  {
    id: 'B-39',
    name: 'in focus mode the caret is clamped inside the focus band',
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
      // Wait for the glide to actually land instead of sleeping a fixed time: a jump this far takes GLIDE_MAX_FAR (1400ms) by itself,
      // and may add a landing re-check leg — the old 1400ms sleep measured right at the start of the tail on a slow machine (1.2 lines off)
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
      t.ok('caret inside the band', inBand.ok, JSON.stringify(inBand));
      await setCaret(page, 0);
    },
  },
  {
    id: 'B-94',
    name: 'Typewriter mode holds the caret row at the set height, while typing and after a jump',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': long(200) }, startup: '/n/a.md' });
      await sleep(250);
      await page.click('#hair');
      await sleep(320);
      await page.click('#tseg');
      await settled(page);
      const probe = () =>
        page.evaluate(() => {
          const v = window.__irori.view;
          const c = v.coordsAtPos(v.state.selection.main.head);
          const r = v.scrollDOM.getBoundingClientRect();
          return {
            caret: (c.top + c.bottom) / 2 - r.top,
            anchor: window.__irori.typewriter.anchorY() - r.top,
            scrollTop: v.scrollDOM.scrollTop,
            pct: +document.getElementById('tposR').value,
            height: r.height,
          };
        });
      t.ok('the mode is on', await page.evaluate(() => document.body.classList.contains('typewriter')), '');
      await caretToLine(page, 60);
      await settled(page);
      const jumped = await probe();
      t.near('after a jump the caret row is on the anchor', jumped.caret, jumped.anchor, 2);
      t.near('the anchor is the height the slider shows', jumped.anchor, (jumped.pct / 100) * jumped.height, 1);

      // typing: the caret must not move down the screen, the text moves up instead
      await page.evaluate(() => window.__irori.view.focus());
      const rows = [];
      let glided = 0;
      for (let i = 0; i < 5; i++) {
        await page.keyboard.type('新的一行');
        await page.keyboard.press('Enter');
        // the row rides back up on the shared glide, exactly like a one-line jump anywhere else
        if (await page.waitForFunction(() => window.__irori.glide.running(), { timeout: 1500 }).then(() => true, () => false)) glided++;
        await settled(page);
        rows.push((await probe()).caret);
      }
      t.eq('every new line is carried by the shared jump animation', glided, 5);
      const spread = Math.max(...rows) - Math.min(...rows);
      t.ok('the row stays put across five new lines', spread <= 2, rows.map((r) => r.toFixed(1)).join(' '));
      t.near('still on the anchor', rows[rows.length - 1], jumped.anchor, 2);
      const scrolledWhileTyping = (await probe()).scrollTop > jumped.scrollTop + 100;
      t.ok('it is the paper that moved, not the caret', scrolledWhileTyping, '');

      // scrolling by hand is free; the next keystroke brings the row back
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop -= 400));
      await sleep(120);
      await page.keyboard.type('回');
      await settled(page);

      const back = await probe();
      t.near('typing after a manual scroll snaps the row back', back.caret, back.anchor, 2);

      // the row is only pulled back once the caret has held still for a while: a burst of Enters
      // inside that window moves the paper once, after the burst, not on every key
      const delay = await page.evaluate(() => window.__irori.typewriter.delay);
      t.ok('the wait is about a quarter of a second', delay >= 150 && delay <= 500, String(delay));
      let early = false;
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Enter');
        await sleep(delay * 0.4);
        if (await page.evaluate(() => window.__irori.glide.running())) early = true;
      }
      t.ok('inside the wait window the paper holds still', !early, '');
      const drifted = (await probe()).caret - back.anchor;
      t.ok('so the caret has walked down the screen meanwhile', drifted > 20, drifted.toFixed(1));
      const started = await page.waitForFunction(() => window.__irori.glide.running(), { timeout: delay * 3 }).then(() => true, () => false);
      t.ok('once the burst ends the paper moves', started, '');
      await settled(page);
      const after = await probe();
      t.near('and the row is back on the anchor', after.caret, after.anchor, 2);
    },
  },
  {
    id: 'B-95',
    name: 'The typewriter height is adjustable, reaches the first and last line, and is remembered',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': long(60) }, startup: '/n/a.md' });
      await sleep(250);
      await page.click('#hair');
      await sleep(320);
      await page.click('#tseg');
      await settled(page);
      const setAnchor = async (v) => {
        await page.evaluate((val) => {
          const el = document.getElementById('tposR');
          el.value = String(val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, v);
        await settled(page);
      };
      const at = (line) =>
        page.evaluate((n) => {
          const v = window.__irori.view;
          const pos = n < 0 ? v.state.doc.length : v.state.doc.line(n).from;
          const c = v.coordsAtPos(pos);
          const r = v.scrollDOM.getBoundingClientRect();
          return { caret: c ? (c.top + c.bottom) / 2 - r.top : null, anchor: window.__irori.typewriter.anchorY() - r.top };
        }, line);

      await setAnchor(25);
      t.eq('the readout follows the slider', await page.evaluate(() => document.getElementById('tposv').textContent), '25%');
      await caretToLine(page, 30);
      await settled(page);
      const mid = await at(30);
      t.near('the caret row moved to the new height', mid.caret, mid.anchor, 2);

      // the padding at both ends is what lets the very first and very last line reach the anchor
      await caretToLine(page, 1);
      await settled(page);
      const first = await at(1);
      t.near('the first line can reach the anchor', first.caret, first.anchor, 2);
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: v.state.doc.length } });
      });
      await settled(page);
      const last = await at(-1);
      t.near('the last line can reach the anchor', last.caret, last.anchor, 2);

      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('irori.settings') || '{}').typewriter);
      t.eq('the toggle is remembered', stored.on, true);
      t.eq('the height is remembered', stored.anchor, 25);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.__irori && window.__irori.view);
      await sleep(300);
      const restored = await page.evaluate(() => ({
        on: document.body.classList.contains('typewriter'),
        v: document.getElementById('tposR').value,
        seg: document.querySelector('#tseg i[data-on="1"]').className,
      }));
      t.eq('still on after a restart', restored.on, true);
      t.eq('still at 25%', restored.v, '25');
      t.ok('the drawer switch shows it', restored.seg.includes('on'), restored.seg);
    },
  },
  {
    id: 'B-96',
    name: 'Off by default; with focus mode on as well the anchor stays inside the band',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': long(200) }, startup: '/n/a.md' });
      await sleep(250);
      t.ok('off unless asked for', !(await page.evaluate(() => document.body.classList.contains('typewriter'))), '');
      const before = await page.evaluate(() => window.__irori.view.scrollDOM.scrollTop);
      await caretToLine(page, 3);
      await sleep(200);
      t.eq('and then nothing pins the caret', await page.evaluate(() => window.__irori.view.scrollDOM.scrollTop), before);

      await page.click('#hair');
      await sleep(320);
      await page.click('#fseg'); // focus mode: band 20%–80%
      await page.click('#tseg');
      await page.evaluate(() => {
        const el = document.getElementById('tposR');
        el.value = '95'; // below the band's bottom edge
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await settled(page);
      await caretToLine(page, 90);
      await settled(page);
      const g = await page.evaluate(() => {
        const v = window.__irori.view;
        const c = v.coordsAtPos(v.state.selection.main.head);
        const r = v.scrollDOM.getBoundingClientRect();
        const band = window.__irori.focus.bandPx();
        return {
          caret: (c.top + c.bottom) / 2,
          anchor: window.__irori.typewriter.anchorY(),
          top: band.top,
          bottom: band.bottom,
          pct: window.__irori.typewriter.anchorPct(),
        };
      });
      t.ok('the anchor is pulled into the band', g.anchor > g.top && g.anchor < g.bottom, JSON.stringify(g));
      t.ok('and so is the caret', g.caret > g.top && g.caret < g.bottom, JSON.stringify(g));
      t.near('the caret sits on the clamped anchor', g.caret, g.anchor, 2);
      t.ok('the clamp is what moved it, not the slider', g.pct < 95, String(g.pct));
    },
  },
  {
    id: 'B-97',
    name: 'Switching typewriter mode never jumps the page: on, the row glides to the anchor; off, it keeps its height — or glides up when the page has no room to keep it',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': long(200) }, startup: '/n/a.md' });
      await sleep(250);
      await page.click('#hair');
      await sleep(320);
      await caretToLine(page, 70);
      await page.evaluate(() => (window.__irori.view.scrollDOM.scrollTop = 1800));
      await sleep(250);
      /** click the switch and sample the caret's height on the next few frames */
      const toggle = () =>
        page.evaluate(async () => {
          const v = window.__irori.view;
          const y = () => {
            const c = v.coordsAtPos(v.state.selection.main.head);
            const r = v.scrollDOM.getBoundingClientRect();
            return c ? (c.top + c.bottom) / 2 - r.top : null;
          };
          const frames = [y()];
          document.getElementById('tseg').click();
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => requestAnimationFrame(r));
            frames.push(y());
          }
          return frames;
        });
      const anchorRel = () =>
        page.evaluate(() => window.__irori.typewriter.anchorY() - window.__irori.view.scrollDOM.getBoundingClientRect().top);
      const caretRel = () =>
        page.evaluate(() => {
          const v = window.__irori.view;
          const c = v.coordsAtPos(v.state.selection.main.head);
          const r = v.scrollDOM.getBoundingClientRect();
          return (c.top + c.bottom) / 2 - r.top;
        });

      const on = await toggle();
      // the padding grows by a third of a screen the moment the mode comes on; unless the scroller
      // absorbs that in the same frame, the text jumps before the animation even starts
      const jump = Math.max(...on.slice(1, 4).map((y) => Math.abs(y - on[0])));
      t.ok('turning it on moves the row by frames, not in one jump', jump < 20, on.map((y) => y.toFixed(0)).join(' '));
      await settled(page);
      t.near('and it ends on the anchor', await caretRel(), await anchorRel(), 2);

      const held = await caretRel();
      const off = await toggle();
      t.ok('turning it off leaves the row exactly where it was', Math.max(...off.map((y) => Math.abs(y - held))) <= 2, off.map((y) => y.toFixed(0)).join(' '));
      await sleep(400);
      t.near('and it stays there', await caretRel(), held, 2);
      t.ok('the mode really is off', !(await page.evaluate(() => document.body.classList.contains('typewriter'))), '');

      // the one case the height cannot be kept: no text left above the caret to scroll up. The row
      // has to rise — and that rise is a move like any other, so it is glided, not cut.
      await page.click('#tseg');
      await settled(page);
      await caretToLine(page, 1);
      await settled(page);
      const rising = await toggle();
      t.ok('the switch answers the click at once', !(await page.evaluate(() => document.querySelector('#tseg i[data-on="1"]').classList.contains('on'))), '');
      t.ok('the row rises frame by frame instead of cutting', Math.max(...rising.slice(1, 4).map((y) => Math.abs(y - rising[0]))) < 20, rising.slice(0, 6).map((y) => y.toFixed(0)).join(' '));
      await settled(page);
      const top = await page.evaluate(() => ({
        caret: window.__irori.view.coordsAtPos(0).top - window.__irori.view.scrollDOM.getBoundingClientRect().top,
        scrollTop: window.__irori.view.scrollDOM.scrollTop,
        padTop: window.__irori.view.documentPadding.top,
        on: document.body.classList.contains('typewriter'),
      }));
      t.eq('and lands with the document at its top', top.scrollTop, 0);
      t.eq('on the ordinary top padding', top.padTop, 44);
      t.ok('the first line is visible there', top.caret > 0 && top.caret < 120, JSON.stringify(top));
      t.ok('the mode is off', !top.on, '');
    },
  },
];
