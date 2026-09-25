/* The remote host: a window that edits one file shared by an irori-host server
   (server/irori-host.mjs, wire format in server/PROTOCOL.md).

   A window is remote from birth — its page is loaded with `?remote=<server>&file=<path>` — and
   stays remote; a local window never becomes one. It wraps the real host (the Tauri shell, or
   the in-memory web host): the file operations go to the server, everything else —
   confirmations, windows, settings, updates, opening links — is the host's. The writing app
   does not know the file is elsewhere. */

import type { Platform, RestartReady, Settings, Stat, UpdateInfo } from './types';

export const PROTOCOL = 2;

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

/** The handshake: the server is there and speaks our protocol. Resolves with its host name. */
export async function hello(base: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(base + '/hello');
  } catch {
    throw new Error('连不上 ' + base);
  }
  const v = (await res.json().catch(() => null)) as { protocol?: number; host?: string } | null;
  if (!res.ok || !v || typeof v.protocol !== 'number') throw new Error(base + ' 不是 irori-host');
  if (v.protocol !== PROTOCOL) throw new Error(`服务端协议版本 ${v.protocol}，这个版本的 Irori 需要 ${PROTOCOL}`);
  return v.host ?? base;
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

  constructor(
    readonly base: string,
    readonly host: Platform,
    /** the shared file this window edits */
    readonly file: string | null,
  ) {
    this.hostName = new URL(base).host;
  }

  async connect(): Promise<void> {
    this.hostName = await hello(this.base);
  }

  /** how the window names where its file is: the address itself (forwarded ports all say
      127.0.0.1, but the port tells them apart) */
  get label(): string {
    return new URL(this.base).host;
  }

  private url(route: string, path: string) {
    return this.base + route + '?path=' + encodeURIComponent(path);
  }

  private async call<T>(method: string, route: string, path: string, body?: BodyInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(route, path), { method, body });
    } catch {
      throw new Error('连不上 ' + this.label);
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
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
  async listDir(path: string) {
    return (await this.call<{ name: string }[]>('GET', '/list', path)).map((e) => e.name);
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
