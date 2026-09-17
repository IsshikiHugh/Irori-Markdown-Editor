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
};

export type Stat = { mtimeMs: number; size: number } | null;

export interface Platform {
  readonly kind: 'tauri' | 'web';

  /** the file this window was asked to open (file association / CLI arg), if any */
  startupPath(): Promise<string | null>;
  /** the host handed this window a file after it was already running (macOS open-with) */
  onOpenFile(handler: (path: string) => void): void;

  /** set by scripts/smoke.sh: write a boot report here and quit (null otherwise) */
  smokeOut(): Promise<{ out: string; menu: boolean; hold: boolean; dialog: boolean; close: boolean } | null>;
  /** this window's rectangle in logical points (smoke screenshots), null off-desktop */
  windowRect(): Promise<{ x: number; y: number; w: number; h: number } | null>;

  openDialog(): Promise<string | null>;
  /** a yes/no question (used when closing would throw away an unnamed buffer) */
  confirm(message: string): Promise<boolean>;
  saveDialog(suggestedName: string): Promise<string | null>;

  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
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

  loadSettings(): Promise<Partial<Settings> | null>;
  saveSettings(settings: Settings): Promise<void>;
}
