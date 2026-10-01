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
  /** writes under way: the watcher must not take our own write for someone else's */
  private saving = 0;
  /** writes started so far: a watcher check that saw one start while it was reading stands down */
  private writes = 0;
  /** bumped whenever another file is opened: late results for the one before are dropped */
  private epoch = 0;
  /** the write in progress, which the next one waits for */
  private queue: Promise<unknown> = Promise.resolve();
  /** the text the last write put on disk */
  private written = '';
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

  /** Open `path`. `prepare` runs on the text before anything here changes (the editor waits for
      KaTeX with it), so the document switches over in one step, with no await between this
      session taking the new path and the caller putting the new text in the buffer: a key
      pressed in that gap would otherwise be the old text, saved over the new file. */
  async open(path: string, prepare?: (text: string) => Promise<void>) {
    const text = await this.platform.readText(path);
    const mtime = (await this.platform.stat(path))?.mtimeMs ?? 0;
    await prepare?.(text);
    this.adopt(path, text, mtime);
    return text;
  }

  /** the switch itself — synchronous on purpose (see open) */
  private adopt(path: string, text: string, mtime: number) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.epoch++;
    this.path = path;
    this.text = text;
    this.diskText = text;
    this.diskMtime = mtime;
    this.dirty = false;
    this.missing = false;
    this.events.onPath(path, false);
    this.events.onState('saved');
    this.startWatch();
  }

  /** ⌘O. The current document's unsaved edits are kept the way closing keeps them: a buffer that
      only lives in memory is asked about BEFORE the file picker; a named one is saved before the
      new file is read (so re-opening the same file reads what was just saved), and again if more
      was typed while it was being read — the switch happens only once nothing is left unsaved. A
      file that went missing meanwhile is asked about like an unnamed buffer. Null if nothing was
      opened. */
  async openDialog(prepare?: (text: string) => Promise<void>): Promise<string | null> {
    if (this.asking) {
      this.events.onToast('文件在外部被改动了，请先选择保留哪个版本');
      return null;
    }
    /** the person already said the unsaved text may go */
    let discard = false;
    if (this.dirty && !this.flushable()) {
      if (!(await this.confirmDiscard('打开别的文件'))) return null;
      discard = true;
    }
    const p = await this.platform.openDialog();
    if (!p) return null;
    for (;;) {
      if (this.dirty && !discard) {
        if (this.flushable()) {
          await this.save();
          if (this.dirty) return null; // it could not be saved (the reason was shown): keep it on screen
        } else {
          if (!(await this.confirmDiscard('打开别的文件'))) return null;
          discard = true;
        }
      }
      const text = await this.platform.readText(p);
      const mtime = (await this.platform.stat(p))?.mtimeMs ?? 0;
      await prepare?.(text);
      // typed (or gone missing) while that was read: settle it first, then read again
      if (this.dirty && !discard) continue;
      this.adopt(p, text, mtime);
      return p;
    }
  }

  /** unsaved edits here can be saved in place, without asking where */
  private flushable() {
    return !!this.path && !this.missing;
  }

  /** Ask before throwing away a buffer that cannot be saved in place. `doing`: what would lose it. */
  private confirmDiscard(doing: string): Promise<boolean> {
    if (!this.path && this.text.trim() === '') return Promise.resolve(true); // a blank page has nothing to lose
    const why = this.path ? '这份文档的文件已不存在' : '这份文档还没有保存过';
    return this.platform.confirm(`${why}，${doing}就会丢失。确定${doing}吗？`);
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
    try {
      if (!(await this.write(this.path))) return false; // another file was opened meanwhile
    } catch (err) {
      this.events.onState('dirty');
      this.events.onToast('保存失败：' + (err as Error).message);
      return false;
    }
    this.settle();
    return true;
  }

  async saveAs(): Promise<boolean> {
    // an autosave firing during this would write the old path behind it
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const suggested = this.path ? basename(this.path) : '未命名.md';
    const target = await this.platform.saveDialog(suggested);
    if (!target) return false;
    try {
      if (!(await this.write(target))) return false; // another file was opened meanwhile
    } catch (err) {
      // nothing was written: the document keeps the path it had
      this.events.onState('dirty');
      this.events.onToast('保存失败：' + (err as Error).message);
      return false;
    }
    this.path = target;
    this.missing = false;
    this.events.onPath(target, false);
    this.startWatch();
    this.settle();
    return true;
  }

  /** Write the text to `path`; it becomes what is on disk. Writes run one after another, each with
      the text as it is when its turn comes — two at once (autosave and ⌘S) could otherwise land
      out of order and leave the older text in the file. False when another file was opened while
      it was being written: the result then belongs to a document no longer shown. */
  private write(path: string): Promise<boolean> {
    const epoch = this.epoch;
    this.saving++;
    this.writes++;
    this.events.onState('saving');
    const run = this.queue.then(async () => {
      if (epoch !== this.epoch) return false;
      const text = this.text;
      await this.platform.writeText(path, text);
      const mtime = (await this.platform.stat(path))?.mtimeMs ?? Date.now();
      if (epoch !== this.epoch) return false;
      this.diskMtime = mtime;
      this.diskText = text;
      this.written = text;
      return true;
    });
    const done = run.finally(() => this.saving--);
    this.queue = done.catch(() => false);
    return done;
  }

  /** After a write: what was typed while it was under way is not in the file — it stays dirty
      (and autosave picks it up again) instead of being marked saved. */
  private settle() {
    if (this.text === this.written) {
      this.dirty = false;
      this.events.onState('saved');
    } else {
      this.setText(this.text);
    }
  }

  /* ---------- external changes ---------- */

  startWatch() {
    this.stopWatch();
    this.watchTimer = setInterval(() => void this.checkDisk(), WATCH_INTERVAL);
  }
  stopWatch() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  async checkDisk() {
    if (!this.path || this.asking || this.saving) return;
    // what this check reads is only about the file as it was when it started: if one of our own
    // writes (or another file being opened) came in between, it is stale and the next tick decides
    const path = this.path;
    const writes = this.writes;
    const epoch = this.epoch;
    const stale = () => this.saving > 0 || this.writes !== writes || this.epoch !== epoch || this.path !== path;
    const st = await this.platform.stat(path);
    if (stale()) return;
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
    const disk = await this.platform.readText(path);
    if (stale()) return;
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
    if (this.flushable()) {
      await this.save();
      return !this.dirty;
    }
    // an unnamed buffer only lives in memory (by design) — so closing really would
    // throw it away, and that has to be an explicit answer, not a silent no-op
    return this.confirmDiscard('关闭');
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
