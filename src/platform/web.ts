/* The browser host: a virtual filesystem living in memory.

   This is not a toy stub — it is the host every automated behaviour test runs against,
   so it has to behave like a real disk (paths, directories, mtimes, name collisions,
   external modification). Tests seed and inspect it through `window.__irori`. */

import type { Platform, Settings, Stat } from './types';
import { dirname, normalize } from './paths';

type Entry = { text?: string; bytes?: Uint8Array; mtimeMs: number; dir?: boolean };

export class WebPlatform implements Platform {
  readonly kind = 'web' as const;
  files = new Map<string, Entry>();
  /** tests push the answer a dialog should give next */
  dialogQueue: (string | null)[] = [];
  settings: Partial<Settings> | null = null;
  startup: string | null = null;
  urls = new Map<string, string>();
  closeHandler: (() => boolean | Promise<boolean>) | null = null;
  title = '';
  newWindows = 0;

  private touch(path: string, e: Partial<Entry>) {
    const p = normalize(path);
    const prev = this.files.get(p);
    this.files.set(p, { mtimeMs: Date.now(), ...prev, ...e });
    let d = dirname(p);
    while (d && !this.files.has(d)) {
      this.files.set(d, { dir: true, mtimeMs: Date.now() });
      d = dirname(d);
    }
  }

  async startupPath() {
    return this.startup;
  }
  openFileHandler: ((path: string) => void) | null = null;
  onOpenFile(handler: (path: string) => void) {
    this.openFileHandler = handler;
  }
  async smokeOut() {
    return null;
  }
  async windowRect() {
    return null;
  }
  /** tests set this to answer the question without a native dialog */
  confirmAnswer = true;
  confirmed: string[] = [];
  async confirm(message: string) {
    this.confirmed.push(message);
    return this.confirmAnswer;
  }
  async openDialog() {
    return this.dialogQueue.shift() ?? null;
  }
  async saveDialog(_suggested: string, _kind?: 'markdown' | 'pdf') {
    return this.dialogQueue.shift() ?? null;
  }
  /** every export: where it went and how many pages were laid out for it (the actual PDF is
      rendered by the tests themselves, with the browser's own page.pdf()) */
  writesPdf = true;
  pdfs: { path: string | null; pages: number }[] = [];
  async printPdf(path: string | null) {
    this.pdfs.push({ path, pages: document.querySelectorAll('#print .pg').length });
    if (path) this.touch(path, { bytes: new Uint8Array(0), mtimeMs: Date.now() });
  }
  async readText(path: string) {
    const e = this.files.get(normalize(path));
    if (!e || e.text == null) throw new Error('ENOENT: ' + path);
    return e.text;
  }
  async writeText(path: string, content: string) {
    this.touch(path, { text: content, mtimeMs: Date.now() });
  }
  async writeBinary(path: string, data: Uint8Array) {
    this.touch(path, { bytes: data, mtimeMs: Date.now() });
    const blob = new Blob([data as unknown as BlobPart]);
    this.urls.set(normalize(path), URL.createObjectURL(blob));
  }
  async mkdirp(path: string) {
    this.touch(path, { dir: true });
  }
  async stat(path: string): Promise<Stat> {
    const e = this.files.get(normalize(path));
    if (!e) return null;
    return { mtimeMs: e.mtimeMs, size: e.text ? e.text.length : (e.bytes?.length ?? 0) };
  }
  async listDir(path: string) {
    const p = normalize(path).replace(/\/+$/, '');
    const out: string[] = [];
    for (const k of this.files.keys()) if (dirname(k) === p) out.push(k.slice(p.length + 1));
    return out;
  }
  assetUrl(path: string) {
    const p = normalize(path);
    return this.urls.get(p) ?? (this.files.has(p) ? 'about:blank#' + encodeURIComponent(p) : '');
  }
  async newWindow() {
    this.newWindows++;
  }
  closeRequests = 0;
  async closeWindow() {
    this.closeRequests++;
    if (this.closeHandler) await this.closeHandler();
  }
  async setTitle(t: string) {
    this.title = t;
    document.title = t;
  }
  onCloseRequested(handler: () => boolean | Promise<boolean>) {
    this.closeHandler = handler;
    addEventListener('beforeunload', (e) => {
      const r = handler();
      if (r === false) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }
  async loadSettings() {
    if (this.settings) return this.settings;
    try {
      const raw = localStorage.getItem('irori.settings');
      return raw ? (JSON.parse(raw) as Partial<Settings>) : null;
    } catch {
      return null;
    }
  }
  async saveSettings(s: Settings) {
    this.settings = s;
    try {
      localStorage.setItem('irori.settings', JSON.stringify(s));
    } catch {
      /* private mode: settings simply do not persist */
    }
  }
}
