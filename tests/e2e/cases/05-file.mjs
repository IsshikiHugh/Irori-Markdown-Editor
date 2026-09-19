/* File lifecycle: open, autosave, blank page, external changes, writing images to disk. */
import { MOD, docText, sleep } from '../harness.mjs';

const read = (page, path) => page.evaluate((p) => window.__irori.platform.files.get(p)?.text ?? null, path);
const mod = async (page, key) => {
  await page.keyboard.down(MOD);
  await page.keyboard.press(key);
  await page.keyboard.up(MOD);
};

export const cases = [
  {
    id: 'B-40',
    name: 'opens the file passed in at startup; title bar and drawer show it',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/笔记.md': '# 内容' }, startup: '/n/笔记.md' });
      t.eq('content loaded', await docText(page), '# 内容');
      t.eq('top bar shows the file name', await page.evaluate(() => document.getElementById('filename').textContent), '笔记.md');
      t.eq('drawer shows the full path', await page.evaluate(() => document.getElementById('pathv').textContent), '/n/笔记.md');
      t.ok('window title', (await page.title()).includes('笔记.md'), await page.title());
    },
  },
  {
    id: 'B-54',
    name: 'after opening a file it stays at the start: caret on the first character, viewport at the top',
    async run(t, ctx) {
      const long = ['# 开头的标题', '', ...Array.from({ length: 80 }, (_, i) => `第 ${i} 行`)].join('\n');
      const page = await ctx.open({ files: { '/n/long.md': long }, startup: '/n/long.md' });
      await sleep(400);
      const st = await page.evaluate(() => ({
        caret: window.__irori.view.state.selection.main.head,
        scroll: window.__irori.view.scrollDOM.scrollTop,
        firstVisible: document.querySelector('.cm-content .cm-line')?.textContent,
      }));
      t.eq('caret at the start', st.caret, 0);
      t.eq('not scrolled', Math.round(st.scroll), 0);
      t.eq('first line is the heading', st.firstVisible, '# 开头的标题');
      // A reload caused by an external change, however, tries to stay where it was
      await page.evaluate(() => {
        const v = window.__irori.view;
        v.dispatch({ selection: { anchor: v.state.doc.line(40).from } });
        v.scrollDOM.scrollTop = 800;
      });
      await sleep(200);
      await page.evaluate(async () => {
        const text = window.__irori.view.state.doc.toString() + '\n补一行';
        window.__irori.platform.files.set('/n/long.md', { text, mtimeMs: Date.now() + 5000 });
        await window.__irori.doc.checkDisk();
      });
      await sleep(250);
      const after = await page.evaluate(() => ({
        caret: window.__irori.view.state.selection.main.head,
        scroll: window.__irori.view.scrollDOM.scrollTop,
      }));
      t.ok('not bounced back to the top after reload', after.scroll > 300, String(after.scroll));
      t.ok('caret roughly where it was', after.caret > 100, String(after.caret));
    },
  },
  {
    id: 'B-41',
    name: 'autosave: writes to disk after the configured delay once typing stops',
    async run(t, ctx) {
      const page = await ctx.open({
        files: { '/n/a.md': '原文' },
        startup: '/n/a.md',
        settings: { autosave: true, autosaveDelay: 300 },
      });
      await page.click('.cm-content');
      await page.keyboard.press('End');
      await page.keyboard.type('新增');
      const immediately = await read(page, '/n/a.md');
      t.eq('not yet written right after typing', immediately, '原文');
      t.eq('status dot turns red (unsaved)', await page.evaluate(() => document.getElementById('filechip').dataset.state), 'dirty');
      await sleep(700);
      t.eq('written to disk after the delay', await read(page, '/n/a.md'), '原文新增');
      t.eq('status dot turns green (saved)', await page.evaluate(() => document.getElementById('filechip').dataset.state), 'saved');
    },
  },
  {
    id: 'B-42',
    name: 'autosave can be turned off in settings; then only ⌘S writes to disk',
    async run(t, ctx) {
      const page = await ctx.open({
        files: { '/n/a.md': '原文' },
        startup: '/n/a.md',
        settings: { autosave: false, autosaveDelay: 200 },
      });
      await page.click('.cm-content');
      await page.keyboard.press('End');
      await page.keyboard.type('改动');
      await sleep(600);
      t.eq('no automatic write', await read(page, '/n/a.md'), '原文');
      await mod(page, 's');
      await sleep(200);
      t.eq('⌘S writes immediately', await read(page, '/n/a.md'), '原文改动');
    },
  },
  {
    id: 'B-43',
    name: 'settings panel: autosave toggle and delay can be changed and are persisted',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      await page.click('#hair');
      await sleep(320);
      await page.click('#aseg');
      await sleep(100);
      const off = await page.evaluate(() => window.__irori.settings.value.autosave);
      t.ok('toggle switched off', off === false, String(off));
      await page.evaluate(() => {
        const el = document.getElementById('aint');
        el.value = '1500';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await sleep(300);
      const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('irori.settings') || '{}'));
      t.eq('delay persisted', persisted.autosaveDelay, 1500);
      t.eq('toggle persisted', persisted.autosave, false);
    },
  },
  {
    id: 'B-44',
    name: 'blank page: lives only in memory until the first ⌘S, which asks where to save',
    async run(t, ctx) {
      const page = await ctx.open({ files: {}, startup: null });
      t.eq('top bar shows the untitled name', await page.evaluate(() => document.getElementById('filename').textContent), '未命名');
      await page.click('.cm-content');
      await page.keyboard.type('白纸上的字');
      await sleep(600);
      const files = await page.evaluate(() => [...window.__irori.platform.files.keys()]);
      t.eq('nothing on disk', files, []);
      await page.evaluate(() => window.__irori.platform.dialogQueue.push('/n/新文件.md'));
      await mod(page, 's');
      await sleep(200);
      t.eq('saved to the chosen location', await read(page, '/n/新文件.md'), '白纸上的字');
      t.eq('top bar updated', await page.evaluate(() => document.getElementById('filename').textContent), '新文件.md');
    },
  },
  {
    id: 'B-45',
    name: '⌘S with the save dialog cancelled → nothing is written',
    async run(t, ctx) {
      const page = await ctx.open({ files: {}, startup: null });
      await page.click('.cm-content');
      await page.keyboard.type('未命名内容');
      await page.evaluate(() => window.__irori.platform.dialogQueue.push(null));
      await mod(page, 's');
      await sleep(200);
      const files = await page.evaluate(() => [...window.__irori.platform.files.keys()]);
      t.eq('disk still empty', files, []);
      t.eq('content still there', await docText(page), '未命名内容');
    },
  },
  {
    id: 'B-46',
    name: 'external change + no unsaved local edits → silent reload',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '原来的内容' }, startup: '/n/a.md' });
      await page.evaluate(async () => {
        window.__irori.platform.files.set('/n/a.md', { text: '外面改过的内容', mtimeMs: Date.now() + 5000 });
        await window.__irori.doc.checkDisk();
      });
      await sleep(200);
      t.eq('editor updated', await docText(page), '外面改过的内容');
      const open = await page.evaluate(() => document.getElementById('conflict').classList.contains('open'));
      t.ok('no dialog interrupts', !open, '');
    },
  },
  {
    id: 'B-47',
    name: 'external change + unsaved local edits → stops to ask; both choices work',
    async run(t, ctx) {
      const page = await ctx.open({
        files: { '/n/a.md': '原来的内容' },
        startup: '/n/a.md',
        settings: { autosave: false, autosaveDelay: 5000 },
      });
      await page.click('.cm-content');
      await page.keyboard.type('我的');
      await page.evaluate(async () => {
        window.__irori.platform.files.set('/n/a.md', { text: '别处写入的内容', mtimeMs: Date.now() + 5000 });
        await window.__irori.doc.checkDisk();
      });
      await sleep(200);
      t.ok('choice dialog shown', await page.evaluate(() => document.getElementById('conflict').classList.contains('open')), '');
      await page.click('#ckeep');
      await sleep(150);
      t.eq('keep mine', await docText(page), '原来的内容我的');
      // Once more, this time choosing the disk version
      await page.evaluate(async () => {
        window.__irori.platform.files.set('/n/a.md', { text: '第二次外部写入', mtimeMs: Date.now() + 9000 });
        await window.__irori.doc.checkDisk();
      });
      await sleep(200);
      await page.click('#cload');
      await sleep(150);
      t.eq('use the disk version', await docText(page), '第二次外部写入');
    },
  },
  {
    id: 'B-48',
    name: 'file deleted → editor is not cleared, file is marked as gone',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '还在写的内容' }, startup: '/n/a.md' });
      await page.evaluate(async () => {
        window.__irori.platform.files.delete('/n/a.md');
        await window.__irori.doc.checkDisk();
      });
      await sleep(200);
      t.eq('text not lost', await docText(page), '还在写的内容');
      const name = await page.evaluate(() => document.getElementById('filename').textContent);
      t.ok('top bar marks it', name.includes('已不存在'), name);
      // The next save becomes Save As
      await page.evaluate(() => window.__irori.platform.dialogQueue.push('/n/b.md'));
      await page.click('.cm-content');
      await page.keyboard.type('！');
      await mod(page, 's');
      await sleep(250);
      t.ok('saved as a new path', (await read(page, '/n/b.md'))?.includes('还在写的内容'), '');
    },
  },
  {
    id: 'B-49',
    name: 'pasting an image → saved into a same-named folder, relative path inserted',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/笔记.md': '开头' }, startup: '/n/笔记.md' });
      await page.click('.cm-content');
      await page.keyboard.press('End');
      await page.evaluate(() => {
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        const file = new File([bytes], 'shot.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await sleep(300);
      t.ok('relative path inserted into the text', (await docText(page)).includes('![](笔记/shot.png)'), await docText(page));
      const wrote = await page.evaluate(() => [...window.__irori.platform.files.keys()]);
      t.ok('image lands in the same-named folder', wrote.includes('/n/笔记/shot.png'), JSON.stringify(wrote));
      // Name collisions get a suffix automatically
      await page.evaluate(() => {
        const bytes = new Uint8Array([137, 80, 78, 71]);
        const file = new File([bytes], 'shot.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await sleep(300);
      t.ok('second image becomes shot-1.png', (await docText(page)).includes('shot-1.png'), await docText(page));
    },
  },
  {
    id: 'B-50',
    name: 'pasting an image into a blank page is refused with a prompt to save first',
    async run(t, ctx) {
      const page = await ctx.open({ files: {}, startup: null });
      await page.click('.cm-content');
      await page.evaluate(() => {
        const file = new File([new Uint8Array([1, 2])], 'x.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await sleep(250);
      const toast = await page.evaluate(() => document.getElementById('toast').textContent);
      t.ok('prompts to save first', toast.includes('请先保存'), toast);
      t.eq('nothing inserted into the text', await docText(page), '');
      const files = await page.evaluate(() => [...window.__irori.platform.files.keys()]);
      t.eq('no files written', files, []);
    },
  },
  {
    id: 'B-53',
    name: 'before closing: a file with a path is flushed to disk, an untitled one is held back to ask',
    async run(t, ctx) {
      const page = await ctx.open({
        files: { '/n/a.md': '原文' },
        startup: '/n/a.md',
        settings: { autosave: false, autosaveDelay: 9000 },
      });
      await page.click('.cm-content');
      await page.keyboard.press('End');
      await page.keyboard.type('未保存的改动');
      const mayClose = await page.evaluate(() => window.__irori.doc.requestClose());
      t.ok('has a path → flush, then allow closing', mayClose, String(mayClose));
      t.eq('changes written to disk', await read(page, '/n/a.md'), '原文未保存的改动');

      const blank = await ctx.open({ files: {}, startup: null });
      await blank.click('.cm-content');
      await blank.keyboard.type('白纸上的字');
      await blank.evaluate(() => (window.__irori.platform.confirmAnswer = false));
      const blocked = await blank.evaluate(() => window.__irori.doc.requestClose());
      t.ok('untitled + changes → ask first; answering "Cancel" keeps it open', blocked === false, String(blocked));
      const asked = await blank.evaluate(() => window.__irori.platform.confirmed[0] || '');
      t.ok('the prompt is explicit: says changes will be lost', asked.includes('丢失'), asked);
      await blank.evaluate(() => (window.__irori.platform.confirmAnswer = true));
      const allowed = await blank.evaluate(() => window.__irori.doc.requestClose());
      t.ok('answering "Close" lets it close', allowed === true, String(allowed));
    },
  },
  {
    id: 'B-55',
    name: 'save state is the dot before the file name: red = unsaved, green = saved, no text',
    async run(t, ctx) {
      const page = await ctx.open({
        files: { '/n/a.md': '原文' },
        startup: '/n/a.md',
        settings: { autosave: false, autosaveDelay: 9000 },
      });
      const dot = () =>
        page.evaluate(() => {
          const chip = document.getElementById('filechip');
          const d = chip.querySelector('.d');
          const cs = getComputedStyle(d);
          return {
            state: chip.dataset.state,
            title: chip.title,
            chipText: chip.textContent,
            bg: cs.backgroundColor,
            size: cs.width + '/' + cs.borderRadius,
            rightSideGone: !document.getElementById('savest'),
          };
        });
      const saved = await dot();
      t.ok('the old top-right indicator is gone', saved.rightSideGone, '');
      t.eq('dot is a small circle', saved.size, '7px/50%');
      t.eq('saved is green', saved.bg, 'rgb(74, 122, 82)');
      t.eq('hover tooltip is the English "saved"', saved.title, 'saved');
      t.eq('pill contains only the file name', saved.chipText, 'a.md');
      await page.click('.cm-content');
      await page.keyboard.type('改');
      await sleep(350); // wait for the color transition to finish (0.2s)
      const dirty = await dot();
      t.eq('unsaved is red', dirty.bg, 'rgb(192, 86, 63)');
      t.eq('hover tooltip becomes unsaved', dirty.title, 'unsaved');
    },
  },
  {
    id: 'B-56',
    name: '⌘W closes the current window (via the unsaved-changes confirmation path)',
    async run(t, ctx) {
      const page = await ctx.open({
        files: { '/n/a.md': '原文' },
        startup: '/n/a.md',
        settings: { autosave: false, autosaveDelay: 9000 },
      });
      await page.click('.cm-content');
      await page.keyboard.press('End');
      await page.keyboard.type('改动');
      await page.keyboard.down(MOD);
      await page.keyboard.press('w');
      await page.keyboard.up(MOD);
      await sleep(300);
      t.eq('requested close from the host', await page.evaluate(() => window.__irori.platform.closeRequests), 1);
      t.eq('changes flushed to disk before closing', await read(page, '/n/a.md'), '原文改动');
    },
  },
  {
    id: 'B-51',
    name: '⌘N requests a new window (one document per window)',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      await page.click('.cm-content');
      await mod(page, 'n');
      await sleep(120);
      t.eq('asked the host for a new window', await page.evaluate(() => window.__irori.platform.newWindows), 1);
      t.eq('current window document unchanged', await docText(page), 'x');
    },
  },
  {
    id: 'B-52',
    name: '⌘O opens another file (replacing the current window content)',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '第一篇', '/n/b.md': '第二篇' }, startup: '/n/a.md' });
      await page.evaluate(() => window.__irori.platform.dialogQueue.push('/n/b.md'));
      await page.click('.cm-content');
      await mod(page, 'o');
      await sleep(300);
      t.eq('switched to the other document', await docText(page), '第二篇');
      t.eq('top bar follows', await page.evaluate(() => document.getElementById('filename').textContent), 'b.md');
    },
  },
  {
    id: 'B-91',
    name: 'While the external-change question is open nothing saves over the other version; closing waits for the answer',
    async run(t, ctx) {
      const page = await ctx.open({
        files: { '/n/a.md': '原来的内容' },
        startup: '/n/a.md',
        settings: { autosave: true, autosaveDelay: 300 },
      });
      const disk = () => page.evaluate(() => window.__irori.platform.files.get('/n/a.md').text);
      await page.click('.cm-content');
      await page.keyboard.type('我的');
      // the external write lands before the autosave fires
      await page.evaluate(async () => {
        window.__irori.platform.files.set('/n/a.md', { text: '别处写入的内容', mtimeMs: Date.now() + 5000 });
        await window.__irori.doc.checkDisk();
      });
      await sleep(600);
      t.ok('the question is open', await page.evaluate(() => document.getElementById('conflict').classList.contains('open')), '');
      t.eq('the pending autosave did not overwrite it', await disk(), '别处写入的内容');
      await page.keyboard.down(MOD);
      await page.keyboard.press('s');
      await page.keyboard.up(MOD);
      await sleep(150);
      t.eq('nor does ⌘S', await disk(), '别处写入的内容');

      // closing waits for the answer instead of saving over it
      const closed = page.evaluate(() => window.__irori.doc.requestClose());
      await sleep(200);
      t.eq('still the other version while it waits', await disk(), '别处写入的内容');
      await page.click('#ckeep');
      t.ok('then closing goes ahead', await closed, '');
      t.eq('keeping mine saves mine', await disk(), '原来的内容我的');
    },
  },
];
