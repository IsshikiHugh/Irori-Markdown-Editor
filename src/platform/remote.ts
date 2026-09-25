/* The remote host: a window that edits one file shared by an irori-host server
   (server/irori-host.mjs, wire format in server/PROTOCOL.md).

   A window is remote from birth — its page is loaded with `?remote=<server>&file=<path>` — and
   stays remote; a local window never becomes one. It wraps the real host (the Tauri shell, or
   the in-memory web host): the file operations go to the server, everything else —
   confirmations, windows, settings, updates, opening links — is the host's. The writing app
   does not know the file is elsewhere.

   Signing in: each Irori has its own key pair (identity, below), kept in its settings. A server
   lets in only the public keys its owner trusted (`irori-host trust <key>`): the client signs the
   server's one-time challenge and gets a session back, which every other request carries. */

import { DEFAULT_SETTINGS, type Platform, type RestartReady, type Settings, type Stat, type UpdateInfo } from './types';

export const PROTOCOL = 4;

/** One shared file, as the server lists it. `expiresAt` null = shared until unshared. */
export type Share = { name: string; path: string; size: number; mtimeMs: number; missing: boolean; addedAt: number; expiresAt: number | null };

/** What the address field holds → the server's base URL. A bare port means this machine
    ("7420" → http://127.0.0.1:7420): the server is reached through a forwarded local port. A
    host without a scheme gets http:// ("box:7420"). */
export function remoteBaseUrl(input: string): string | null {
  const v = input.trim().replace(/\/+$/, '');
  if (!v) return null;
  if (/^\d+$/.test(v)) return `http://127.0.0.1:${v}`;
  if (/^https?:\/\//i.test(v)) return v;
  return `http://${v}`;
}

/** The query a window is booted with to edit `path` on the server at `base`. */
export function remoteQuery(base: string, path: string): string {
  return `remote=${encodeURIComponent(base)}&file=${encodeURIComponent(path)}`;
}

/* ---------- identity ---------- */

/** How a public key is written for `irori-host trust`: the P-256 point, uncompressed, base64url. */
const KEY_PREFIX = 'irori-p256.';
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** This Irori as servers know it: its public key, and a way to sign a challenge. */
export type Identity = { key: string; sign(challenge: string): Promise<string> };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function fromJwk(jwk: JsonWebKey): Promise<Identity> {
  const priv = await crypto.subtle.importKey('jwk', jwk, ECDSA, false, ['sign']);
  const key = KEY_PREFIX + b64url(new Uint8Array([4, ...unb64url(jwk.x!), ...unb64url(jwk.y!)]));
  return {
    key,
    async sign(challenge) {
      const text = new TextEncoder().encode('irori-host sign-in\n' + challenge);
      return b64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, text)));
    },
  };
}

let mine: Promise<Identity> | null = null;

/** This Irori's key pair: the one in the settings, or — the first time — a new one saved there.
    Kept for good: replacing it would lock this Irori out of every server that trusts it. */
export function identity(host: Platform): Promise<Identity> {
  mine ??= (async () => {
    const saved = await host.loadSettings().catch(() => null);
    if (saved?.remoteKey?.d) return fromJwk(saved.remoteKey);
    const pair = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    // settings.ts keeps a key found on disk when another window writes its (older) settings
    await host.saveSettings({ ...DEFAULT_SETTINGS, ...saved, remoteKey: jwk } as Settings);
    return fromJwk(jwk);
  })();
  mine.catch(() => (mine = null));
  return mine;
}

/* ---------- handshake ---------- */

/** Why a server did not let this Irori in. `untrusted`: the key is not on its list yet — run
    `irori-host trust <key>` there. */
export class SignInError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly key: string,
    readonly host: string,
  ) {
    super(message);
  }
}

/** The handshake: the server is there, speaks our protocol, and lets this Irori in. Resolves
    with its host name and the session every other request carries. */
export async function signIn(base: string, me: Identity): Promise<{ host: string; session: string }> {
  let res: Response;
  try {
    res = await fetch(base + '/hello');
  } catch {
    throw new Error('连不上 ' + base);
  }
  const v = (await res.json().catch(() => null)) as { protocol?: number; host?: string; challenge?: string } | null;
  if (!res.ok || !v || typeof v.protocol !== 'number') throw new Error(base + ' 不是 irori-host');
  if (v.protocol !== PROTOCOL) throw new Error(`服务端协议版本 ${v.protocol}，这个版本的 Irori 需要 ${PROTOCOL}：两边都更新到最新版`);
  const host = v.host ?? new URL(base).host;
  let a: { session?: string; error?: string; auth?: string } | null;
  try {
    const body = JSON.stringify({ key: me.key, challenge: v.challenge, signature: await me.sign(v.challenge ?? '') });
    const r = await fetch(base + '/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    a = await r.json().catch(() => null);
  } catch {
    throw new Error('连不上 ' + base);
  }
  if (a?.session) return { host, session: a.session };
  if (a?.auth === 'untrusted') throw new SignInError(`${host} 还没有信任这台 Irori：在服务端运行 irori-host trust ${me.key}`, 'untrusted', me.key, host);
  throw new SignInError(a?.error ?? '登录失败', a?.auth ?? 'failed', me.key, host);
}

export class RemotePlatform implements Platform {
  readonly kind = 'remote' as const;
  /** the server's host name, learned at the handshake */
  hostName: string;
  /** a message for the person (set by the app once it has somewhere to show one) */
  notify: (msg: string) => void = () => {};
  /** ⌘O in a remote window picks another file shared by the same server (set by the app: the
      panel lives there) */
  pickShared: () => Promise<string | null> = async () => null;

  /** what the server handed out at sign-in; every request but the handshake carries it */
  private session = '';

  constructor(
    readonly base: string,
    readonly host: Platform,
    /** the shared file this window edits */
    readonly file: string | null,
  ) {
    this.hostName = new URL(base).host;
  }

  async connect(): Promise<void> {
    const r = await signIn(this.base, await identity(this.host));
    this.hostName = r.host;
    this.session = r.session;
  }

  /** how the window names where its file is: the address itself (forwarded ports all say
      127.0.0.1, but the port tells them apart) */
  get label(): string {
    return new URL(this.base).host;
  }

  private url(route: string, path: string) {
    return this.base + route + '?path=' + encodeURIComponent(path) + '&s=' + encodeURIComponent(this.session);
  }

  private async call<T>(method: string, route: string, path: string, body?: BodyInit, again = true): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(route, path), { method, body });
    } catch {
      throw new Error('连不上 ' + this.label);
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string; auth?: string }) | null;
    // not signed in (the server was not answering at boot, or its owner trusted this Irori only
    // since): sign in and try once more; still out → say why
    if (res.status === 401 && data?.auth && again) {
      await this.connect();
      return this.call(method, route, path, body, false);
    }
    if (!res.ok) throw new Error(data?.error ?? `${res.status} ${route}`);
    return data as T;
  }

  /* ---------- the file operations ---------- */
  async readText(path: string) {
    return (await this.call<{ text: string }>('GET', '/read', path)).text;
  }
  async writeText(path: string, content: string) {
    await this.call('PUT', '/write', path, content);
  }
  async createBinary(path: string, data: Uint8Array) {
    return (await this.call<{ ok: boolean }>('POST', '/create', path, data as unknown as BodyInit)).ok;
  }
  async mkdirp(path: string) {
    await this.call('POST', '/mkdirp', path);
  }
  async stat(path: string): Promise<Stat> {
    const s = await this.call<{ mtimeMs: number; size: number } | null>('GET', '/stat', path);
    return s ? { mtimeMs: s.mtimeMs, size: s.size } : null;
  }
  /** The server lists no folders (only registered files can be seen): a pasted picture's name is
      found by createBinary refusing the taken ones instead. */
  async listDir(_path: string) {
    return [];
  }
  assetUrl(path: string) {
    return this.url('/asset', path);
  }

  /* ---------- opening and saving ---------- */
  async startupPath() {
    return this.file;
  }
  openDialog() {
    return this.pickShared();
  }
  /** Only files shared from the server's side can be written: there is nowhere to "save as". */
  async saveDialog(_suggestedName: string, _kind?: 'markdown' | 'pdf') {
    this.notify('远程文件不能另存为；要编辑别的文件，请在服务端用 irori-host share 共享它');
    return null;
  }
  /** the shell could write a PDF, but only to this machine's disk — so the system print dialog it is */
  readonly writesPdf = false;
  printPdf(_path: string | null) {
    return this.host.printPdf(null);
  }

  /* ---------- everything else is the host's ---------- */
  smokeOut() {
    return this.host.smokeOut();
  }
  windowRect() {
    return this.host.windowRect();
  }
  confirm(message: string, ok?: string) {
    return this.host.confirm(message, ok);
  }
  newWindow(query?: string) {
    return this.host.newWindow(query);
  }
  closeWindow() {
    return this.host.closeWindow();
  }
  /** the title says which server the file is on */
  setTitle(title: string) {
    return this.host.setTitle(title.replace(/ — Irori$/, '') + ' — ' + this.label);
  }
  onCloseRequested(handler: () => boolean | Promise<boolean>) {
    this.host.onCloseRequested(handler);
  }
  openUrl(url: string) {
    return this.host.openUrl(url);
  }
  appVersion() {
    return this.host.appVersion();
  }
  checkUpdate(manual: boolean): Promise<UpdateInfo | null> {
    return this.host.checkUpdate(manual);
  }
  downloadUpdate() {
    return this.host.downloadUpdate();
  }
  applyUpdate() {
    return this.host.applyUpdate();
  }
  onRestartCancelled(handler: () => void) {
    this.host.onRestartCancelled(handler);
  }
  onPrepareRestart(handler: () => Promise<RestartReady>) {
    this.host.onPrepareRestart(handler);
  }
  loadSettings() {
    return this.host.loadSettings();
  }
  saveSettings(s: Settings) {
    return this.host.saveSettings(s);
  }
}
