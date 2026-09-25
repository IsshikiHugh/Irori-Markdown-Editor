/* The remote panel (⇧⌘O, or the drawer's 远程文件 button): connect to an irori-host server and
   pick one of the files it shares.

   Two parts, top to bottom: the address (a port — the usual case, a server reached through a
   forwarded local port — or a full URL), then the list the server pushes. The list is whatever
   was shared from the server's command line, not a view of its disk: no folders, no browsing.
   It stays live while the panel is open (the server pushes it every few seconds and whenever a
   share changes), so a file shared a moment ago shows up without asking again.

   In a remote window the address is fixed: ⌘O there picks another file of the same server.

   A server this Irori is not trusted by yet shows the one command that trusts it, with a copy
   button, and keeps trying: once someone (or an agent) runs it there, the list appears. */
import { SignInError, remoteBaseUrl, signIn, type Identity, type Share } from '../platform/remote';
import { basename, dirname } from '../platform/paths';

export type RemotePick = { addr: string; base: string; path: string };

type Options = {
  /** what the address field starts with */
  addr: string;
  /** the server is given (a remote window's ⌘O): no address field */
  base?: string;
  /** this Irori's key pair (made on first use) */
  identity: () => Promise<Identity>;
};

/** how often a server that does not trust this Irori yet is asked again */
const TRUST_POLL = 1500;

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
        <div class="rtrust" hidden>
          <div class="rtrust-t"></div>
          <div class="rcmd"><input class="txtin" name="cmd" readonly spellcheck="false" /><button class="ubtn" type="button" name="copy">复制</button></div>
          <div class="rtrust-s">信任后这里会自动连上。</div>
        </div>
        <ul class="rlist" role="listbox"></ul>
        <div class="rfoot"><button class="rkey" type="button" title="在服务端运行 irori-host trust &lt;密钥&gt; 即可信任这台 Irori">复制本机密钥</button><span class="rhint">↑↓ 选择 · ↩ 打开 · esc 关闭</span></div>
      </div>`;
    const form = box.querySelector('.raddr') as HTMLFormElement;
    const input = form.elements.namedItem('addr') as HTMLInputElement;
    const status = box.querySelector('.rstatus') as HTMLElement;
    const ul = box.querySelector('.rlist') as HTMLElement;
    const trust = box.querySelector('.rtrust') as HTMLElement;
    const cmd = trust.querySelector('input') as HTMLInputElement;
    input.value = opts.addr;
    if (opts.base) form.hidden = true;

    let es: EventSource | null = null;
    let base: string | null = null;
    let addr = opts.addr;
    let shares: Share[] = [];
    let skew = 0; // server clock − ours: time left is counted on the server's clock
    let sel = 0;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    /** put `text` on the clipboard; where that is not allowed, leave it selected for ⌘C */
    const copy = async (text: string, field?: HTMLInputElement) => {
      try {
        await navigator.clipboard.writeText(text);
        say('已复制', status.dataset.kind as '' | 'ok' | 'err');
      } catch {
        field?.select();
      }
    };
    (trust.querySelector('button') as HTMLButtonElement).onclick = () => void copy(cmd.value, cmd);
    cmd.onfocus = () => cmd.select();
    (box.querySelector('.rkey') as HTMLButtonElement).onclick = async () => {
      const key = (await opts.identity()).key;
      try {
        await navigator.clipboard.writeText(key);
        say('已复制本机密钥：在服务端运行 irori-host trust <密钥>');
      } catch {
        say(key);
      }
    };

    const say = (text: string, kind: '' | 'ok' | 'err' = '') => {
      status.textContent = text;
      status.dataset.kind = kind;
    };

    const done = (v: RemotePick | null) => {
      attempt++; // stops a pending retry from connecting a closed panel
      clearTimeout(retry);
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

    const connect = async (b: string, typed: string, quiet = false) => {
      const mine = ++attempt;
      clearTimeout(retry);
      es?.close();
      es = null;
      base = null;
      shares = [];
      render();
      if (!quiet) say('连接中…');
      let host: string;
      let session: string;
      try {
        ({ host, session } = await signIn(b, await opts.identity()));
      } catch (err) {
        if (mine !== attempt) return;
        if (err instanceof SignInError && err.reason === 'untrusted') {
          // show the command, and ask again until the server's owner has run it
          say(`${err.host} 还没有信任这台 Irori`, 'err');
          box.querySelector('.rtrust-t')!.textContent = '在服务端运行这条命令（也可以交给那边的 agent）：';
          const want = `irori-host trust ${err.key}`;
          if (cmd.value !== want) cmd.value = want;
          trust.hidden = false;
          retry = setTimeout(() => void connect(b, typed, true), TRUST_POLL);
        } else {
          trust.hidden = true;
          say((err as Error).message, 'err');
        }
        return;
      }
      if (mine !== attempt) return;
      trust.hidden = true;
      base = b;
      addr = typed;
      say(`已连接 ${host}（${new URL(b).host}）`, 'ok');
      es = new EventSource(b + '/events?s=' + encodeURIComponent(session));
      es.addEventListener('shares', (e) => {
        const m = JSON.parse((e as MessageEvent).data) as { now: number; shares: Share[] };
        skew = m.now - Date.now();
        shares = m.shares;
        if (status.dataset.kind !== 'ok') say(`已连接 ${host}（${new URL(b).host}）`, 'ok');
        render();
      });
      // EventSource reconnects by itself; say so until the next list arrives. It gives up for
      // good on a refusal (this Irori was untrusted meanwhile): sign in again, which says why
      const stream = es;
      es.onerror = () => {
        say('连接中断，正在重连…', 'err');
        if (stream.readyState === EventSource.CLOSED) retry = setTimeout(() => void connect(b, typed, true), TRUST_POLL);
      };
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
      if (e.target === cmd) return;
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
