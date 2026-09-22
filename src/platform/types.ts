/* The ONLY seam between the writing app and its host.

   Nothing above this layer may know whether it is running inside Tauri or a plain
   browser. That is what lets every behaviour test drive the real application code in
   headless Chromium, and what keeps the rule "no platform-specific patches in the
   writing core" honest. */

export type Settings = {
  /** write to disk automatically after edits stop */
  autosave: boolean;
  /** how long the pause has to be, in ms */
  autosaveDelay: number;
  /** CSS font stack; taken from fonts installed on this machine (nothing is bundled) */
  fontFamily: string;
  /** focus mode preferences (kept here so one file holds all persisted state) */
  focus: { on: boolean; top: number; bottom: number; curve: { x: number; y: number }[] };
  /** typewriter mode: whether the caret's row is pinned, and at what height (percent) */
  typewriter: { on: boolean; anchor: number };
  /** where pasted images go: a folder relative to the document's (or absolute); `{name}` is
      the document's name without its extension (paths.ts: imageDir) */
  imageDir: string;
};

export const DEFAULT_SETTINGS: Settings = {
  autosave: true,
  autosaveDelay: 800,
  fontFamily: '"LXGW WenKai GB Fusion","LXGW WenKai GB","LXGW WenKai Mono","LXGW WenKai","霞鹜文楷","PingFang SC","Microsoft YaHei",Arial,sans-serif',
  focus: {
    on: false,
    top: 20,
    bottom: 80,
    curve: [
      { x: 0.08, y: 0.62 },
      { x: 0.26, y: 0.9 },
      { x: 0.55, y: 0.99 },
    ],
  },
  typewriter: { on: false, anchor: 45 },
  imageDir: '{name}',
};

export type Stat = { mtimeMs: number; size: number } | null;

/** a newer published release */
export type UpdateInfo = { version: string };

/** a window's answer when the app is about to restart: may it go, and which file to reopen */
export type RestartReady = { ok: boolean; path: string | null };

export interface Platform {
  readonly kind: 'tauri' | 'web';

  /** the file this window was asked to open (file association / CLI arg), if any */
  startupPath(): Promise<string | null>;

  /** set by scripts/smoke.sh: write a boot report here and quit (null otherwise) */
  smokeOut(): Promise<{ out: string; menu: boolean; hold: boolean; dialog: boolean; close: boolean; pdf: boolean } | null>;
  /** this window's rectangle in logical points (smoke screenshots), null off-desktop */
  windowRect(): Promise<{ x: number; y: number; w: number; h: number } | null>;

  openDialog(): Promise<string | null>;
  /** a yes/no question; `ok` labels the yes button (default 关闭 — the question closing asks) */
  confirm(message: string, ok?: string): Promise<boolean>;
  /** `kind` picks the file type offered: Markdown (default) or a PDF export */
  saveDialog(suggestedName: string, kind?: 'markdown' | 'pdf'): Promise<string | null>;

  /** whether printPdf can write a file itself; otherwise export goes through the system print
      dialog (whose "save as PDF" is the export) */
  readonly writesPdf: boolean;
  /** Print the page (its print stylesheet decides what shows) to PDF: into `path` when given —
      only when writesPdf — or through the system print dialog when null. */
  printPdf(path: string | null): Promise<void>;

  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  /** Write a new file, never replacing one: false when the name is already taken. */
  createBinary(path: string, data: Uint8Array): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  stat(path: string): Promise<Stat>;
  listDir(path: string): Promise<string[]>;

  /** absolute fs path → something an <img> can load */
  assetUrl(path: string): string;

  newWindow(): Promise<void>;
  /** ⌘W — goes through the same close flow as clicking the red traffic light (triggers the
      unsaved-changes confirmation) */
  closeWindow(): Promise<void>;
  setTitle(title: string): Promise<void>;
  /** ask the host to confirm before the window closes while there are unsaved edits */
  onCloseRequested(handler: () => boolean | Promise<boolean>): void;

  /** open a web or mail link in the default app (⌘/Ctrl-click on a link) */
  openUrl(url: string): Promise<void>;

  appVersion(): Promise<string>;
  /** a newer release, if one is published. The automatic check runs once per app run, is
      offered in one window only and says nothing on failure (null); a `manual` one always asks
      and rejects with the reason it could not. */
  checkUpdate(manual: boolean): Promise<UpdateInfo | null>;
  /** download and verify the release checkUpdate found; nothing is installed yet */
  downloadUpdate(): Promise<void>;
  /** install it and restart into it, after every window has got ready (onPrepareRestart);
      false if one declined, and then nothing was installed */
  applyUpdate(): Promise<boolean>;
  /** the app is about to restart: save what needs saving, and answer */
  onPrepareRestart(handler: () => Promise<RestartReady>): void;
  /** the restart was called off (a window declined, or installing failed): carry on */
  onRestartCancelled(handler: () => void): void;

  loadSettings(): Promise<Partial<Settings> | null>;
  saveSettings(settings: Settings): Promise<void>;
}
