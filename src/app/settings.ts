/* Settings live in one file next to the app, never next to the document. v1 holds
   exactly what was decided: autosave on/off + interval, the writing font, where pasted
   images go, and the view
   preferences (focus mode, typewriter mode) the blog editor used to keep in localStorage. */

import { DEFAULT_SETTINGS } from '../platform/types';
import type { Platform, Settings } from '../platform/types';

export class SettingsStore {
  value: Settings = structuredClone(DEFAULT_SETTINGS);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private platform: Platform) {}

  async load(): Promise<Settings> {
    const raw = await this.platform.loadSettings().catch(() => null);
    if (raw) this.value = merge(DEFAULT_SETTINGS, raw);
    return this.value;
  }

  patch(part: Partial<Settings>) {
    this.value = merge(this.value, part);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.write(), 200);
  }

  /** write now (before this page is replaced, which would lose the pending write) */
  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.write();
  }

  /** The remote key may have been made (by this window or another) since these settings were
      read: keep the one on disk rather than writing it away — servers trust that key. */
  private async write() {
    if (!this.value.remoteKey) {
      const disk = await this.platform.loadSettings().catch(() => null);
      if (disk?.remoteKey) this.value = { ...this.value, remoteKey: disk.remoteKey };
    }
    await this.platform.saveSettings(this.value);
  }
}

function merge(base: Settings, part: Partial<Settings>): Settings {
  return {
    ...base,
    ...part,
    focus: { ...base.focus, ...(part.focus || {}) },
    typewriter: { ...base.typewriter, ...(part.typewriter || {}) },
  };
}
