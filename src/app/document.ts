/* The document session: one window, one file.

   Four rules live here, and they are the reason this file exists at all:
   1. autosave writes only to a file that already has a path; a blank page (unnamed buffer)
      lives in memory until ⌘S — by choice, not by omission;
   2. the file is watched, because autosave + "no Git safety net" means a silent
      overwrite would destroy someone else's edit;
   3. an external change with no local edits reloads silently; with local edits it stops
      and asks;
   4. a deleted/moved file never clears the buffer — the next save becomes a Save As. */

import type { Platform } from '../platform/types';
import { basename, dirname, stem } from '../platform/paths';

export type SaveState = 'saved' | 'dirty' | 'saving';

export type DocumentEvents = {
  onState: (state: SaveState) => void;
  onPath: (path: string | null, missing: boolean) => void;
  /** disk changed under us while we had unsaved edits — ask the human */
  onConflict: (disk: string, keepMine: () => void, useDisk: () => void) => void;
  /** disk changed and we had nothing unsaved: the buffer is replaced */
  onReload: (text: string) => void;
  onToast: (msg: string) => void;
};

export const WATCH_INTERVAL = 1500;

export class DocumentSession {
  path: string | null = null;
  dirty = false;
  missing = false;
  text = '';
  private diskText = '';
  private diskMtime = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private asking = false;
  /** waiting for the external-change question to be answered */
  private decided: (() => void)[] = [];

  constructor(
    private platform: Platform,
    private events: DocumentEvents,
    private settings: () => { autosave: boolean; autosaveDelay: number },
  ) {}

  get name(): string {
    return this.path ? basename(this.path) : '未命名';
  }
  get stemName(): string {
    return this.path ? stem(this.path) : '未命名';
  }
  get dir(): string | null {
    return this.path ? dirname(this.path) : null;
  }

  /* ---------- edits ---------- */

  setText(text: string) {
    this.text = text;
    if (text === this.diskText && this.path) {
      this.dirty = false;
      this.events.onState('saved');
      return;
    }
    this.dirty = true;
    this.events.onState('dirty');
    const { autosave, autosaveDelay } = this.settings();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (autosave && this.path && !this.missing) {
      // never while the external-change question is open: that would overwrite the other version
      this.saveTimer = setTimeout(() => void (this.asking || this.save()), autosaveDelay);
    }
  }

  /* ---------- open / save ---------- */

  async open(path: string) {
    const text = await this.platform.readText(path);
    this.path = path;
    this.text = text;
    this.diskText = text;
    this.diskMtime = (await this.platform.stat(path))?.mtimeMs ?? 0;
    this.dirty = false;
    this.missing = false;
    this.events.onPath(path, false);
    this.events.onState('saved');
    this.startWatch();
    return text;
  }

  async openDialog(): Promise<string | null> {
    const p = await this.platform.openDialog();
    if (!p) return null;
    await this.open(p);
    return p;
  }

  /** ⌘S. A buffer with no path asks where to go first. Returns false if cancelled. */
  async save(): Promise<boolean> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.asking) {
      this.events.onToast('文件在外部被改动了，请先选择保留哪个版本');
      return false;
    }
    if (!this.path || this.missing) return this.saveAs();
    if (!this.dirty) return true;
    this.events.onState('saving');
    try {
      await this.platform.writeText(this.path, this.text);
      this.diskText = this.text;
      this.diskMtime = (await this.platform.stat(this.path))?.mtimeMs ?? Date.now();
      this.dirty = false;
      this.events.onState('saved');
      return true;
    } catch (err) {
      this.events.onState('dirty');
      this.events.onToast('保存失败：' + (err as Error).message);
      return false;
    }
  }

  async saveAs(): Promise<boolean> {
    const suggested = this.path ? basename(this.path) : '未命名.md';
    const target = await this.platform.saveDialog(suggested);
    if (!target) return false;
    this.path = target;
    this.missing = false;
    this.events.onPath(target, false);
    this.events.onState('saving');
    await this.platform.writeText(target, this.text);
    this.diskText = this.text;
    this.diskMtime = (await this.platform.stat(target))?.mtimeMs ?? Date.now();
    this.dirty = false;
    this.events.onState('saved');
    this.startWatch();
    return true;
  }

  /* ---------- external changes ---------- */

  startWatch() {
    this.stopWatch();
    // a check that fails (a remote file whose server is not answering) is simply tried again next round
    this.watchTimer = setInterval(() => void this.checkDisk().catch(() => {}), WATCH_INTERVAL);
  }
  stopWatch() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  async checkDisk() {
    if (!this.path || this.asking) return;
    const st = await this.platform.stat(this.path);
    if (!st) {
      if (!this.missing) {
        this.missing = true;
        this.events.onPath(this.path, true);
        this.events.onToast('文件已不存在 · 下次保存将另存为');
      }
      return;
    }
    if (this.missing) {
      this.missing = false;
      this.events.onPath(this.path, false);
    }
    if (st.mtimeMs === this.diskMtime) return;
    const disk = await this.platform.readText(this.path);
    this.diskMtime = st.mtimeMs;
    if (disk === this.text) {
      this.diskText = disk;
      this.dirty = false;
      this.events.onState('saved');
      return;
    }
    if (!this.dirty) {
      this.diskText = disk;
      this.text = disk;
      this.events.onReload(disk);
      this.events.onToast('文件在外部被修改 · 已重新载入');
      return;
    }
    this.asking = true;
    this.events.onConflict(
      disk,
      () => {
        // keep mine: the next save overwrites, which is now an informed choice
        this.diskText = disk;
        this.asking = false;
        this.setText(this.text); // dirty again, and autosave (if on) picks it up
        this.answered();
      },
      () => {
        this.diskText = disk;
        this.text = disk;
        this.dirty = false;
        this.asking = false;
        this.events.onReload(disk);
        this.events.onState('saved');
        this.answered();
      },
    );
  }

  private answered() {
    for (const done of this.decided.splice(0)) done();
  }

  /** Resolves once the external-change question (if one is open) has been answered: closing
      or restarting must not decide it by saving over the other version. */
  private whenDecided(): Promise<void> {
    return this.asking ? new Promise((done) => this.decided.push(done)) : Promise.resolve();
  }

  /** window is closing: true = may close */
  async requestClose(): Promise<boolean> {
    await this.whenDecided();
    if (!this.dirty) return true;
    if (this.path && !this.missing) {
      await this.save();
      return !this.dirty;
    }
    // an unnamed buffer only lives in memory (by design) — so closing really would
    // throw it away, and that has to be an explicit answer, not a silent no-op
    return this.platform.confirm('这份文档还没有保存过，关闭就会丢失。确定关闭吗？');
  }

  /** the app is restarting into an update: true = this window may go. A named file is saved in
      place, as closing does; an unnamed one with text asks to be saved first — it only lives in
      memory — and declining calls the restart off. */
  async prepareRestart(): Promise<boolean> {
    await this.whenDecided();
    if (!this.dirty) return true;
    if (this.path && !this.missing) {
      await this.save();
      return !this.dirty;
    }
    if (!this.path && this.text.trim() === '') return true; // a blank page has nothing to lose
    const why = this.path ? '这份文档的文件已不存在' : '这份文档还没有保存过';
    if (!(await this.platform.confirm(`${why}。保存之后，Irori 会重启以完成更新。`, '保存'))) return false;
    return this.save();
  }
}
