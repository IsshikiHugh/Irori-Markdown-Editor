/* Remote files: a real irori-host server (server/irori-host.mjs) on a free port, sharing files
   from a temporary folder; the app reaches it the way the desktop app does, over HTTP.
   A window is local or remote for its whole life; the list is what the command line shared,
   pushed live; only shared files can be written; an unreachable server never turns a remote
   window into a local one. */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MOD, ROOT, docText, setDoc, sleep } from '../harness.mjs';

const CLI = path.join(ROOT, 'server/irori-host.mjs');

/** A server with its own registry and a folder of files; `share` runs the real command line. */
async function startHost() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'irori-host-')));
  const env = { ...process.env, IRORI_HOST_HOME: path.join(dir, '.home') };
  const files = path.join(dir, 'files');
  fs.mkdirSync(files);
  const proc = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { env });
  const port = await new Promise((ok, fail) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /127\.0\.0\.1:(\d+)/.exec(out);
      if (m) ok(Number(m[1]));
    });
    proc.on('exit', (c) => fail(new Error('irori-host exited ' + c + ': ' + out)));
  });
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  return {
    port,
    files,
    file: (name, text) => {
      const p = path.join(files, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
      return p;
    },
    share: (...args) => cli('share', ...args),
    unshare: (...args) => cli('unshare', ...args),
    stop: () => {
      proc.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const remoteQuery = (port, file) => `remote=${encodeURIComponent('http://127.0.0.1:' + port)}&file=${encodeURIComponent(file)}`;

const panelItems = (page) => page.$$eval('.rpanel .ritem .rname', (els) => els.map((e) => e.textContent));
const shortcut = async (page, key, shift = false) => {
  await page.keyboard.down(MOD);
  if (shift) await page.keyboard.down('Shift');
  // the physical key (KeyS, not 's'): only then does e.key follow Shift on Linux / Windows, as
  // the redo case in 03-editing explains
  await page.keyboard.press('Key' + key.toUpperCase());
  if (shift) await page.keyboard.up('Shift');
  await page.keyboard.up(MOD);
};
/** wait until `fn` (run in the page) is truthy */
const until = (page, fn, arg, timeout = 5000) => page.waitForFunction(fn, { timeout }, arg);

export const cases = [
  {
    id: 'B-110',
    name: 'Remote panel: a port connects; the list is what was shared and updates live; picking turns a blank window into that file',
    async run(t, ctx) {
      const host = await startHost();
      try {
        const a = host.file('a.md', '# 远程一\n\n正文');
        host.file('not-shared.md', 'x');
        host.share(a);
        const page = await ctx.open({});
        await shortcut(page, 'o', true);
        await page.waitForSelector('.rpanel .raddr input');
        t.ok('the panel opens on ⇧⌘O with the address field focused', await page.evaluate(() => document.activeElement?.name === 'addr'));
        await page.keyboard.type(String(host.port));
        await page.keyboard.press('Enter');
        await until(page, () => document.querySelectorAll('.rpanel .ritem').length === 1);
        t.eq('only the shared file is listed', await panelItems(page), ['a.md']);
        t.ok('the status says connected', /已连接/.test(await page.$eval('.rstatus', (e) => e.textContent)));
        t.eq('time left is shown', await page.$eval('.ritem .rleft', (e) => e.textContent), '剩 12 小时');

        // shared from the command line while the panel is open: it appears without asking again
        const b = host.file('sub/b.md', '# 二');
        host.share(b, '--keep', '--name', '第二篇');
        await until(page, () => document.querySelectorAll('.rpanel .ritem').length === 2);
        t.eq('a file shared later shows up by itself', await panelItems(page), ['a.md', '第二篇']);
        t.eq('a kept share says so', await page.$$eval('.ritem .rleft', (els) => els[1].textContent), '长期');

        // ↓ leaves the address field for the list; ↓↑ walk it (and wrap) back to the first
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowUp');
        t.eq('the arrows walk the list', await page.$$eval('.ritem', (els) => els.findIndex((e) => e.classList.contains('on'))), 0);
        const nav = page.waitForNavigation({ waitUntil: 'load' });
        await page.keyboard.press('Enter');
        await nav;
        await until(page, () => window.__irori?.view?.state.doc.length > 0);
        t.eq('the window now holds the remote file', await docText(page), '# 远程一\n\n正文');
        t.ok('the page was booted as a remote window', (await page.evaluate(() => location.search)).includes('remote='));
        t.eq('the title names the server', await page.title(), `a.md — 127.0.0.1:${host.port}`);
        t.ok('the drawer names the server too', (await page.$eval('#pathv', (e) => e.textContent)).startsWith(`127.0.0.1:${host.port} : `));
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('irori.settings') || '{}').remoteAddr);
        t.eq('the address is remembered for next time', saved, String(host.port));
      } finally {
        host.stop();
      }
    },
  },
  {
    id: 'B-111',
    name: 'Remote window: edits autosave to the server’s disk, outside edits reload, unsharing stops the writes',
    async run(t, ctx) {
      const host = await startHost();
      try {
        const a = host.file('a.md', '第一行');
        host.share(a);
        const page = await ctx.open({ query: remoteQuery(host.port, a) });
        await until(page, () => window.__irori.view.state.doc.length > 0);
        t.eq('the shared file opens at boot', await docText(page), '第一行');

        await setDoc(page, '第一行\n客户端写的');
        await sleep(1400);
        t.eq('autosave wrote the file on the server side', fs.readFileSync(a, 'utf8'), '第一行\n客户端写的');
        t.eq('the save dot is green', await page.$eval('#filechip', (e) => e.dataset.state), 'saved');
        t.eq('no temp file is left beside it', fs.readdirSync(host.files).filter((n) => n.endsWith('.tmp')), []);

        fs.writeFileSync(a, '服务端改的');
        await until(page, () => window.__irori.view.state.doc.toString() === '服务端改的', null, 8000);
        t.ok('an edit made on the server reloads the clean buffer', true);

        host.unshare(a);
        await setDoc(page, '服务端改的\n再写一行');
        await sleep(1400);
        t.eq('an unshared file is not written', fs.readFileSync(a, 'utf8'), '服务端改的');
        t.eq('the dot stays unsaved', await page.$eval('#filechip', (e) => e.dataset.state), 'dirty');
        t.ok('the reason is shown', /未共享/.test(await page.$eval('#toast', (e) => e.textContent)), await page.$eval('#toast', (e) => e.textContent));
      } finally {
        host.stop();
      }
    },
  },
  {
    id: 'B-112',
    name: 'Picking a remote file from a window already holding a document opens a new window; ⌘O in a remote window lists that server only',
    async run(t, ctx) {
      const host = await startHost();
      try {
        const a = host.file('a.md', 'A');
        const b = host.file('b.md', 'B');
        host.share(a, b);
        const local = await ctx.open({ files: { '/n/x.md': '本地' }, startup: '/n/x.md', settings: { remoteAddr: String(host.port) } });
        await local.evaluate(() => document.body.classList.add('menuopen'));
        await sleep(300);
        await local.click('#remotebtn');
        await until(local, () => document.querySelectorAll('.rpanel .ritem').length === 2);
        t.ok('the remembered address connects by itself', true);
        await local.click('.rpanel .ritem:nth-child(2)');
        await sleep(100);
        const q = await local.evaluate(() => window.__irori.platform.windowQueries);
        t.eq('a new window was asked for, booted on the picked file', q, [remoteQuery(host.port, b)]);
        t.eq('this window keeps its own document', await docText(local), '本地');

        const remote = await ctx.open({ query: remoteQuery(host.port, a) });
        await until(remote, () => window.__irori.view.state.doc.length > 0);
        await shortcut(remote, 'o');
        await until(remote, () => document.querySelectorAll('.rpanel .ritem').length === 2);
        t.ok('⌘O shows no address field: it is this server', await remote.$eval('.raddr', (e) => e.hidden));
        await remote.click('.rpanel .ritem:nth-child(2)');
        await until(remote, () => window.__irori.view.state.doc.toString() === 'B');
        t.ok('the other shared file opens in the same window', !(await remote.$('.rpanel')));

        await shortcut(remote, 's', true);
        // wait for the message rather than a fixed time: CI runners are several times slower
        const said = await until(remote, () => /不能另存为/.test(document.querySelector('#toast').textContent), null, 3000)
          .then(() => true)
          .catch(() => false);
        t.ok('save-as explains itself instead of writing anywhere', said, await remote.$eval('#toast', (e) => e.textContent));
      } finally {
        host.stop();
      }
    },
  },
  {
    id: 'B-113',
    name: 'An unreachable server: the panel says so, and a remote window stays remote instead of saving to the local disk',
    async run(t, ctx) {
      const page = await ctx.open({});
      await shortcut(page, 'o', true);
      await page.waitForSelector('.rpanel .raddr input');
      await page.keyboard.type('1');
      await page.keyboard.press('Enter');
      await until(page, () => document.querySelector('.rstatus').dataset.kind === 'err');
      t.ok('the panel says it cannot connect', /连不上/.test(await page.$eval('.rstatus', (e) => e.textContent)));
      await page.keyboard.press('Escape');
      t.ok('esc closes the panel', !(await page.$('.rpanel')));

      const win = await ctx.open({ query: remoteQuery(1, '/srv/a.md') });
      await sleep(300);
      t.eq('the window is still remote', await win.evaluate(() => window.__irori.remote?.kind), 'remote');
      t.ok('it says why', /连不上/.test(await win.$eval('#toast', (e) => e.textContent)), await win.$eval('#toast', (e) => e.textContent));
      await setDoc(win, '写点东西');
      await shortcut(win, 's');
      await sleep(200);
      const disk = await win.evaluate(() => [...window.__irori.remote.host.files.keys()]);
      t.eq('nothing was written to the local disk', disk.filter((k) => k.endsWith('.md')), []);
    },
  },
];
