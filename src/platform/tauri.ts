/* The Tauri host. Every call is a single `invoke` into the Rust shell — no filesystem
   or dialog plugin is used from JavaScript, so this file stays a thin, replaceable
   adapter (ADR-0001's escape hatch: swapping the shell must not touch the app). */

import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import type { Platform, Settings, Stat } from './types';

export class TauriPlatform implements Platform {
  readonly kind = 'tauri' as const;

  startupPath() {
    return invoke<string | null>('startup_path');
  }
  onOpenFile(handler: (path: string) => void) {
    void listen<string>('irori://open-file', (e) => handler(e.payload));
  }
  smokeOut() {
    return invoke<{ out: string; menu: boolean; hold: boolean; dialog: boolean; close: boolean } | null>('smoke_out');
  }
  windowRect() {
    return invoke<{ x: number; y: number; w: number; h: number } | null>('window_rect');
  }
  openDialog() {
    return invoke<string | null>('open_dialog');
  }
  confirm(message: string) {
    return invoke<boolean>('confirm_dialog', { message });
  }
  saveDialog(suggestedName: string) {
    return invoke<string | null>('save_dialog', { suggestedName });
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
      // 一旦注册了这个监听，Tauri 就会先拦下原生关闭，等回调结束后再自己去 destroy() ——
      // 而 destroy 需要 core:window:allow-destroy 权限，没有的话它**静默失败**，窗口就一直在
      // （表现为「弹窗里点了关闭，窗口却没关」）。所以这里统一由我们自己决定、自己销毁，失败要看得见。
      event.preventDefault();
      if (!(await handler())) return;
      try {
        await win.destroy();
      } catch (err) {
        console.error('关闭窗口失败', err);
        alert('关闭窗口失败：' + String(err));
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
