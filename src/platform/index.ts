import type { Platform } from './types';
import { WebPlatform } from './web';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __irori?: Record<string, unknown>;
    /** set by the behaviour tests before boot: files on the virtual disk + which to open */
    __iroriSeed?: { files?: Record<string, string>; images?: Record<string, string>; startup?: string | null; settings?: unknown; update?: { version: string } };
  }
}

let current: Platform | null = null;

/** Tauri when the shell is there, the in-memory host otherwise (dev + every test). */
export async function getPlatform(): Promise<Platform> {
  if (current) return current;
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    const { TauriPlatform } = await import('./tauri');
    current = new TauriPlatform();
  } else {
    const web = new WebPlatform();
    const seed = window.__iroriSeed;
    if (seed) {
      for (const [path, text] of Object.entries(seed.files || {})) await web.writeText(path, text);
      for (const [path, b64] of Object.entries(seed.images || {})) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await web.writeBinary(path, bytes);
      }
      web.startup = seed.startup ?? null;
      if (seed.settings) web.settings = seed.settings as never;
      if (seed.update) web.update = seed.update;
    }
    current = web;
    window.__irori = { ...(window.__irori || {}), platform: web };
  }
  return current;
}

export * from './types';
export * from './paths';
