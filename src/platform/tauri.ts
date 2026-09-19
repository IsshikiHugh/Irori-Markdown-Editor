/* The Tauri host. Every call is a single `invoke` into the Rust shell — no filesystem
   or dialog plugin is used from JavaScript, so this file stays a thin, replaceable
   adapter (the escape hatch: swapping the shell must not touch the app). */

import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { Platform, RestartReady, Settings, Stat, UpdateInfo } from './types';

export class TauriPlatform implements Platform {
  readonly kind = 'tauri' as const;

  startupPath() {
    return invoke<string | null>('startup_path');
  }
  smokeOut() {
    return invoke<{ out: string; menu: boolean; hold: boolean; dialog: boolean; close: boolean; pdf: boolean } | null>('smoke_out');
  }
  windowRect() {
    return invoke<{ x: number; y: number; w: number; h: number } | null>('window_rect');
  }
  openDialog() {
    return invoke<string | null>('open_dialog');
  }
  confirm(message: string, ok?: string) {
    return invoke<boolean>('confirm_dialog', { message, ok });
  }
  saveDialog(suggestedName: string, kind: 'markdown' | 'pdf' = 'markdown') {
    return invoke<string | null>('save_dialog', { suggestedName, kind });
  }
  // only the macOS shell drives the webview's print operation straight into a file
  readonly writesPdf = /Mac/.test(navigator.userAgent);
  printPdf(path: string | null) {
    return invoke<void>('print_pdf', { path });
  }
  readText(path: string) {
    return invoke<string>('read_text', { path });
  }
  writeText(path: string, content: string) {
    return invoke<void>('write_text', { path, content });
  }
  writeBinary(path: string, data: Uint8Array) {
    return invoke<void>('write_binary', { path, data: Array.from(data) });
  }
  mkdirp(path: string) {
    return invoke<void>('mkdirp', { path });
  }
  stat(path: string) {
    return invoke<Stat>('stat_path', { path });
  }
  listDir(path: string) {
    return invoke<string[]>('list_dir', { path });
  }
  assetUrl(path: string) {
    return convertFileSrc(path);
  }
  newWindow() {
    return invoke<void>('new_window');
  }
  closeWindow() {
    return invoke<void>('close_window');
  }
  setTitle(title: string) {
    return invoke<void>('set_title', { title });
  }
  onCloseRequested(handler: () => boolean | Promise<boolean>) {
    const win = getCurrentWindow();
    void win.onCloseRequested(async (event) => {
      // Once this listener is registered, Tauri intercepts the native close and calls destroy()
      // itself after the callback returns — but destroy needs the core:window:allow-destroy
      // permission, and without it it **fails silently** and the window stays open (symptom:
      // "clicked Close in the dialog, but the window didn't close"). So we always decide and
      // destroy it ourselves, and a failure must be visible.
      event.preventDefault();
      if (!(await handler())) return;
      try {
        await win.destroy();
      } catch (err) {
        console.error('Failed to close window', err);
        alert('关闭窗口失败：' + String(err));
      }
    });
  }
  openUrl(url: string) {
    return invoke<void>('open_url', { url });
  }
  appVersion() {
    return invoke<string>('app_version');
  }
  checkUpdate(manual: boolean) {
    return invoke<UpdateInfo | null>('check_update', { manual });
  }
  downloadUpdate() {
    return invoke<void>('download_update');
  }
  applyUpdate() {
    return invoke<boolean>('apply_update');
  }
  onRestartCancelled(handler: () => void) {
    void getCurrentWebviewWindow().listen('irori://restart-cancelled', () => handler());
  }
  onPrepareRestart(handler: () => Promise<RestartReady>) {
    // addressed to this window only: the shell asks the windows one at a time
    void getCurrentWebviewWindow().listen('irori://prepare-restart', async () => {
      // "heard it" first: a window that stays silent is taken to be gone
      await invoke('restart_ack');
      let ready: RestartReady = { ok: false, path: null };
      try {
        ready = await handler();
      } finally {
        await invoke('restart_ready', ready);
      }
    });
  }
  async loadSettings() {
    return invoke<Partial<Settings> | null>('load_settings');
  }
  saveSettings(settings: Settings) {
    return invoke<void>('save_settings', { settings });
  }
}
