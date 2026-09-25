import type { Platform } from './types';
import { WebPlatform } from './web';
import { RemotePlatform } from './remote';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __irori?: Record<string, unknown>;
    /** why this remote window's handshake failed (shown once after boot) */
    __iroriRemoteError?: string;
    /** set by the behaviour tests before boot: files on the virtual disk + which to open */
    __iroriSeed?: { files?: Record<string, string>; images?: Record<string, string>; startup?: string | null; settings?: unknown; update?: { version: string } };
  }
}

let current: Platform | null = null;

/** Tauri when the shell is there, the in-memory host otherwise (dev + every test). A window
    opened on a remote file (its page loaded with `?remote=<server>&file=<path>`) wraps that
    host: the file operations go to the server, everything else stays with the shell. Remote or
    not is fixed for the window's life. */
export async function getPlatform(): Promise<Platform> {
  if (current) return current;
  let host: Platform;
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    const { TauriPlatform } = await import('./tauri');
    host = new TauriPlatform();
  } else {
    const web = new WebPlatform();
    const seed = window.__iroriSeed;
    if (seed) {
      for (const [path, text] of Object.entries(seed.files || {})) await web.writeText(path, text);
      for (const [path, b64] of Object.entries(seed.images || {})) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await web.createBinary(path, bytes);
      }
      web.startup = seed.startup ?? null;
      if (seed.settings) web.settings = seed.settings as never;
      if (seed.update) web.update = seed.update;
    }
    host = web;
    window.__irori = { ...(window.__irori || {}), platform: web };
  }
  current = host;
  const q = new URLSearchParams(location.search);
  const base = q.get('remote');
  if (base) {
    // a remote window stays remote even when the server is not answering: falling back to the
    // local disk would quietly save somewhere else than the person thinks
    const r = new RemotePlatform(base, host, q.get('file'));
    current = r;
    window.__irori = { ...(window.__irori || {}), remote: r };
    await r.connect().catch((err: Error) => {
      window.__iroriRemoteError = err.message;
    });
  }
  return current;
}

export * from './types';
export * from './paths';
