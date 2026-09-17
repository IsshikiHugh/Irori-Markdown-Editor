/* 文件生命周期：打开、自动保存、白纸、外部改动、图片落盘。 */
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
    name: '启动时打开传进来的文件，标题栏与抽屉显示它',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/笔记.md': '# 内容' }, startup: '/n/笔记.md' });
      t.eq('内容已载入', await docText(page), '# 内容');
      t.eq('顶栏显示文件名', await page.evaluate(() => document.getElementById('filename').textContent), '笔记.md');
      t.eq('抽屉显示完整路径', await page.evaluate(() => document.getElementById('pathv').textContent), '/n/笔记.md');
      t.ok('窗口标题', (await page.title()).includes('笔记.md'), await page.title());
    },
  },
  {
    id: 'B-54',
    name: '打开文件后停在开头：光标在第一个字符，视口在顶部',
    async run(t, ctx) {
      const long = ['# 开头的标题', '', ...Array.from({ length: 80 }, (_, i) => `第 ${i} 行`)].join('\n');
      const page = await ctx.open({ files: { '/n/long.md': long }, startup: '/n/long.md' });
      await sleep(400);
      const st = await page.evaluate(() => ({
        caret: window.__irori.view.state.selection.main.head,
        scroll: window.__irori.view.scrollDOM.scrollTop,
        firstVisible: document.querySelector('.cm-content .cm-line')?.textContent,
      }));
      t.eq('光标在开头', st.caret, 0);
      t.eq('没有滚动', Math.round(st.scroll), 0);
      t.eq('第一行就是标题', st.firstVisible, '# 开头的标题');
      // 外部改动导致的重载则尽量留在原处
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
      t.ok('重载后没有被弹回顶部', after.scroll > 300, String(after.scroll));
      t.ok('光标大致还在原处', after.caret > 100, String(after.caret));
    },
  },
  {
    id: 'B-41',
    name: '自动保存：停手后按设定间隔落盘',
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
      t.eq('敲击瞬间还没落盘', immediately, '原文');
      t.eq('状态点变红（未保存）', await page.evaluate(() => document.getElementById('filechip').dataset.state), 'dirty');
      await sleep(700);
      t.eq('间隔过后已落盘', await read(page, '/n/a.md'), '原文新增');
      t.eq('状态点变绿（已保存）', await page.evaluate(() => document.getElementById('filechip').dataset.state), 'saved');
    },
  },
  {
    id: 'B-42',
    name: '自动保存可以在设置里关掉，关掉后只有 ⌘S 才写盘',
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
      t.eq('不自动落盘', await read(page, '/n/a.md'), '原文');
      await mod(page, 's');
      await sleep(200);
      t.eq('⌘S 立即落盘', await read(page, '/n/a.md'), '原文改动');
    },
  },
  {
    id: 'B-43',
    name: '设置面板：自动保存开关与间隔可改并持久化',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      await page.click('#hair');
      await sleep(320);
      await page.click('#aseg');
      await sleep(100);
      const off = await page.evaluate(() => window.__irori.settings.value.autosave);
      t.ok('开关切换到关', off === false, String(off));
      await page.evaluate(() => {
        const el = document.getElementById('aint');
        el.value = '1500';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await sleep(300);
      const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('irori.settings') || '{}'));
      t.eq('间隔已保存', persisted.autosaveDelay, 1500);
      t.eq('开关已保存', persisted.autosave, false);
    },
  },
  {
    id: 'B-44',
    name: '白纸：在第一次 ⌘S 之前只在内存里，⌘S 时问去哪',
    async run(t, ctx) {
      const page = await ctx.open({ files: {}, startup: null });
      t.eq('顶栏显示未命名', await page.evaluate(() => document.getElementById('filename').textContent), '未命名');
      await page.click('.cm-content');
      await page.keyboard.type('白纸上的字');
      await sleep(600);
      const files = await page.evaluate(() => [...window.__irori.platform.files.keys()]);
      t.eq('磁盘上什么都没有', files, []);
      await page.evaluate(() => window.__irori.platform.dialogQueue.push('/n/新文件.md'));
      await mod(page, 's');
      await sleep(200);
      t.eq('保存到选定位置', await read(page, '/n/新文件.md'), '白纸上的字');
      t.eq('顶栏更新', await page.evaluate(() => document.getElementById('filename').textContent), '新文件.md');
    },
  },
  {
    id: 'B-45',
    name: '⌘S 取消保存对话框 → 什么也不写',
    async run(t, ctx) {
      const page = await ctx.open({ files: {}, startup: null });
      await page.click('.cm-content');
      await page.keyboard.type('未命名内容');
      await page.evaluate(() => window.__irori.platform.dialogQueue.push(null));
      await mod(page, 's');
      await sleep(200);
      const files = await page.evaluate(() => [...window.__irori.platform.files.keys()]);
      t.eq('磁盘仍为空', files, []);
      t.eq('内容还在', await docText(page), '未命名内容');
    },
  },
  {
    id: 'B-46',
    name: '外部改动 + 本地无未保存 → 静默重新载入',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '原来的内容' }, startup: '/n/a.md' });
      await page.evaluate(async () => {
        window.__irori.platform.files.set('/n/a.md', { text: '外面改过的内容', mtimeMs: Date.now() + 5000 });
        await window.__irori.doc.checkDisk();
      });
      await sleep(200);
      t.eq('编辑区已更新', await docText(page), '外面改过的内容');
      const open = await page.evaluate(() => document.getElementById('conflict').classList.contains('open'));
      t.ok('没有弹窗打扰', !open, '');
    },
  },
  {
    id: 'B-47',
    name: '外部改动 + 本地有未保存 → 停下来问，两个选择都有效',
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
      t.ok('弹出选择', await page.evaluate(() => document.getElementById('conflict').classList.contains('open')), '');
      await page.click('#ckeep');
      await sleep(150);
      t.eq('保留我的', await docText(page), '原来的内容我的');
      // 再来一次，这次选磁盘
      await page.evaluate(async () => {
        window.__irori.platform.files.set('/n/a.md', { text: '第二次外部写入', mtimeMs: Date.now() + 9000 });
        await window.__irori.doc.checkDisk();
      });
      await sleep(200);
      await page.click('#cload');
      await sleep(150);
      t.eq('用磁盘上的', await docText(page), '第二次外部写入');
    },
  },
  {
    id: 'B-48',
    name: '文件被删除 → 不清空编辑区，标记为已不存在',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '还在写的内容' }, startup: '/n/a.md' });
      await page.evaluate(async () => {
        window.__irori.platform.files.delete('/n/a.md');
        await window.__irori.doc.checkDisk();
      });
      await sleep(200);
      t.eq('正文没丢', await docText(page), '还在写的内容');
      const name = await page.evaluate(() => document.getElementById('filename').textContent);
      t.ok('顶栏标记', name.includes('已不存在'), name);
      // 下一次保存变成另存为
      await page.evaluate(() => window.__irori.platform.dialogQueue.push('/n/b.md'));
      await page.click('.cm-content');
      await page.keyboard.type('！');
      await mod(page, 's');
      await sleep(250);
      t.ok('另存为新路径', (await read(page, '/n/b.md'))?.includes('还在写的内容'), '');
    },
  },
  {
    id: 'B-49',
    name: '粘贴图片 → 存进同名文件夹并插入相对路径',
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
      t.ok('正文插入了相对路径', (await docText(page)).includes('![](笔记/shot.png)'), await docText(page));
      const wrote = await page.evaluate(() => [...window.__irori.platform.files.keys()]);
      t.ok('图片落在同名文件夹', wrote.includes('/n/笔记/shot.png'), JSON.stringify(wrote));
      // 重名自动加后缀
      await page.evaluate(() => {
        const bytes = new Uint8Array([137, 80, 78, 71]);
        const file = new File([bytes], 'shot.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await sleep(300);
      t.ok('第二张变成 shot-1.png', (await docText(page)).includes('shot-1.png'), await docText(page));
    },
  },
  {
    id: 'B-50',
    name: '白纸状态粘图被拒绝，并提示先保存',
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
      t.ok('提示先保存', toast.includes('请先保存'), toast);
      t.eq('正文没有被插入任何东西', await docText(page), '');
      const files = await page.evaluate(() => [...window.__irori.platform.files.keys()]);
      t.eq('没有写出任何文件', files, []);
    },
  },
  {
    id: 'B-53',
    name: '关窗前：有路径的先冲盘，未命名的拦下来问',
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
      t.ok('有路径 → 冲盘后允许关闭', mayClose, String(mayClose));
      t.eq('改动已落盘', await read(page, '/n/a.md'), '原文未保存的改动');

      const blank = await ctx.open({ files: {}, startup: null });
      await blank.click('.cm-content');
      await blank.keyboard.type('白纸上的字');
      await blank.evaluate(() => (window.__irori.platform.confirmAnswer = false));
      const blocked = await blank.evaluate(() => window.__irori.doc.requestClose());
      t.ok('未命名 + 有改动 → 先问人，答「取消」则不关', blocked === false, String(blocked));
      const asked = await blank.evaluate(() => window.__irori.platform.confirmed[0] || '');
      t.ok('问得明确：说清会丢失', asked.includes('丢失'), asked);
      await blank.evaluate(() => (window.__irori.platform.confirmAnswer = true));
      const allowed = await blank.evaluate(() => window.__irori.doc.requestClose());
      t.ok('答「关闭」则放行', allowed === true, String(allowed));
    },
  },
  {
    id: 'B-55',
    name: '保存状态就是文件名前那颗点：红 = unsaved，绿 = saved，没有文字',
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
      t.ok('右上角那个已经没有了', saved.rightSideGone, '');
      t.eq('点是个小圆', saved.size, '7px/50%');
      t.eq('已保存是绿的', saved.bg, 'rgb(74, 122, 82)');
      t.eq('hover 提示是英文 saved', saved.title, 'saved');
      t.eq('药丸里只有文件名', saved.chipText, 'a.md');
      await page.click('.cm-content');
      await page.keyboard.type('改');
      await sleep(350); // 等颜色过渡走完（0.2s）
      const dirty = await dot();
      t.eq('未保存是红的', dirty.bg, 'rgb(192, 86, 63)');
      t.eq('hover 提示变 unsaved', dirty.title, 'unsaved');
    },
  },
  {
    id: 'B-56',
    name: '⌘W 关闭当前窗口（走未保存确认那条路）',
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
      t.eq('向宿主请求了关闭', await page.evaluate(() => window.__irori.platform.closeRequests), 1);
      t.eq('关闭前把改动冲进了磁盘', await read(page, '/n/a.md'), '原文改动');
    },
  },
  {
    id: 'B-51',
    name: '⌘N 请求新窗口（一窗一文）',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': 'x' }, startup: '/n/a.md' });
      await page.click('.cm-content');
      await mod(page, 'n');
      await sleep(120);
      t.eq('向宿主要了一扇新窗口', await page.evaluate(() => window.__irori.platform.newWindows), 1);
      t.eq('当前窗口的文档没变', await docText(page), 'x');
    },
  },
  {
    id: 'B-52',
    name: '⌘O 打开另一个文件（替换当前窗口的内容）',
    async run(t, ctx) {
      const page = await ctx.open({ files: { '/n/a.md': '第一篇', '/n/b.md': '第二篇' }, startup: '/n/a.md' });
      await page.evaluate(() => window.__irori.platform.dialogQueue.push('/n/b.md'));
      await page.click('.cm-content');
      await mod(page, 'o');
      await sleep(300);
      t.eq('换成了另一篇', await docText(page), '第二篇');
      t.eq('顶栏跟着换', await page.evaluate(() => document.getElementById('filename').textContent), 'b.md');
    },
  },
];
