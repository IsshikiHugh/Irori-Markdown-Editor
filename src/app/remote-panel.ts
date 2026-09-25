/* The remote panel (⇧⌘O, or the drawer's 远程文件 button): connect to an irori-host server and
   pick one of the files it shares.

   Two parts, top to bottom: the address (a port — the usual case, a server reached through a
   forwarded local port — or a full URL), then the list the server pushes. The list is whatever
   was shared from the server's command line, not a view of its disk: no folders, no browsing.
   It stays live while the panel is open (the server pushes it every few seconds and whenever a
   share changes), so a file shared a moment ago shows up without asking again.

   In a remote window the address is fixed: ⌘O there picks another file of the same server. */
import { hello, remoteBaseUrl, type Share } from '../platform/remote';
import { basename, dirname } from '../platform/paths';

export type RemotePick = { addr: string; base: string; path: string };

type Options = {
  /** what the address field starts with */
  addr: string;
  /** the server is given (a remote window's ⌘O): no address field */
  base?: string;
};

let open: HTMLElement | null = null;

export function openRemotePanel(opts: Options): Promise<RemotePick | null> {
  if (open) return Promise.resolve(null);
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'rpanel';
    box.innerHTML = `
      <div class="rbox" role="dialog" aria-label="远程文件">
        <div class="rtitle">远程文件</div>
        <form class="raddr">
          <input class="txtin" name="addr" spellcheck="false" autocomplete="off" placeholder="端口，如 7420；或完整地址 http://host:port" />
          <button class="ubtn primary" type="submit">连接</button>
        </form>
        <div class="rstatus" aria-live="polite"></div>
        <ul class="rlist" role="listbox"></ul>
        <div class="rhint">↑↓ 选择 · ↩ 打开 · esc 关闭</div>
      </div>`;
    const form = box.querySelector('.raddr') as HTMLFormElement;
    const input = form.elements.namedItem('addr') as HTMLInputElement;
    const status = box.querySelector('.rstatus') as HTMLElement;
    const ul = box.querySelector('.rlist') as HTMLElement;
    input.value = opts.addr;
    if (opts.base) form.hidden = true;

    let es: EventSource | null = null;
    let base: string | null = null;
    let addr = opts.addr;
    let shares: Share[] = [];
    let skew = 0; // server clock − ours: time left is counted on the server's clock
    let sel = 0;
    let attempt = 0;

    const say = (text: string, kind: '' | 'ok' | 'err' = '') => {
      status.textContent = text;
      status.dataset.kind = kind;
    };

    const done = (v: RemotePick | null) => {
      es?.close();
      box.remove();
      removeEventListener('keydown', onKey, true);
      open = null;
      resolve(v);
    };

    const render = () => {
      ul.replaceChildren();
      if (base && !shares.length) {
        const li = document.createElement('li');
        li.className = 'rempty';
        li.innerHTML = '这个服务端还没有共享任何文件。<br>在服务端运行 <code>irori-host share &lt;文件&gt;</code>，它会立刻出现在这里。';
        ul.appendChild(li);
        return;
      }
      sel = Math.min(sel, Math.max(0, shares.length - 1));
      shares.forEach((s, i) => {
        const li = document.createElement('li');
        li.className = 'ritem' + (i === sel ? ' on' : '') + (s.missing ? ' missing' : '');
        li.setAttribute('role', 'option');
        const name = document.createElement('span');
        name.className = 'rname';
        name.textContent = s.name;
        const where = document.createElement('span');
        where.className = 'rpath';
        where.textContent = s.name === basename(s.path) ? dirname(s.path) : s.path;
        where.title = s.path;
        const left = document.createElement('span');
        left.className = 'rleft';
        left.textContent = s.missing ? '文件不存在' : timeLeft(s.expiresAt, skew);
        li.append(name, left, where);
        li.onmouseenter = () => {
          sel = i;
          mark();
        };
        li.onclick = () => pick(i);
        ul.appendChild(li);
      });
    };
    const mark = () => [...ul.children].forEach((li, i) => li.classList.toggle('on', i === sel));

    const pick = (i: number) => {
      const s = shares[i];
      if (!s || !base) return;
      if (s.missing) return say('这个文件在服务端已经不存在了', 'err');
      done({ addr, base, path: s.path });
    };

    const connect = async (b: string, typed: string) => {
      const mine = ++attempt;
      es?.close();
      es = null;
      base = null;
      shares = [];
      render();
      say('连接中…');
      let host: string;
      try {
        host = await hello(b);
      } catch (err) {
        if (mine === attempt) say((err as Error).message, 'err');
        return;
      }
      if (mine !== attempt) return;
      base = b;
      addr = typed;
      say(`已连接 ${host}（${new URL(b).host}）`, 'ok');
      es = new EventSource(b + '/events');
      es.addEventListener('shares', (e) => {
        const m = JSON.parse((e as MessageEvent).data) as { now: number; shares: Share[] };
        skew = m.now - Date.now();
        shares = m.shares;
        if (status.dataset.kind !== 'ok') say(`已连接 ${host}（${new URL(b).host}）`, 'ok');
        render();
      });
      // EventSource reconnects by itself; say so until the next list arrives
      es.onerror = () => say('连接中断，正在重连…', 'err');
    };

    form.onsubmit = (e) => {
      e.preventDefault();
      const b = remoteBaseUrl(input.value);
      if (!b) return say('填一个端口（如 7420）或完整地址', 'err');
      void connect(b, input.value.trim());
    };

    const onKey = (e: KeyboardEvent) => {
      // the panel owns the keyboard while it is open: nothing reaches the editor or ⌘-shortcuts
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        return done(null);
      }
      if (e.target === input && e.key !== 'ArrowDown') return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        if (!shares.length) return;
        // from the address field, ↓ steps into the list: onto the item already marked
        if (e.target === input) return input.blur();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shares.length) % shares.length;
        mark();
        ul.children[sel]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        pick(sel);
      }
    };
    addEventListener('keydown', onKey, true);
    box.onmousedown = (e) => e.target === box && done(null);

    document.body.appendChild(box);
    open = box;
    const start = opts.base ?? remoteBaseUrl(opts.addr);
    if (start) {
      void connect(start, opts.addr);
      if (!opts.base) input.focus();
    } else {
      say('');
      input.focus();
    }
  });
}

function timeLeft(expiresAt: number | null, skew: number): string {
  if (expiresAt == null) return '长期';
  const ms = expiresAt - (Date.now() + skew);
  if (ms <= 0) return '即将到期';
  if (ms < 36e5) return `剩 ${Math.max(1, Math.round(ms / 6e4))} 分钟`;
  if (ms < 864e5) return `剩 ${Math.round(ms / 36e5)} 小时`;
  return `剩 ${Math.round(ms / 864e5)} 天`;
}
