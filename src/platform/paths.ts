/* Pure path helpers. Kept free of any host API so they can be unit-tested, and so the
   one place that decides where a pasted image lands (`sidecarDir`) is a single function —
   by design, with no abstraction built around it. */

export const SEP = '/';

export function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

export function join(...parts: string[]): string {
  return parts
    .map(normalize)
    .filter((x) => x !== '')
    .reduce((a, b) => (b.startsWith('/') ? b : a === '' ? b : a.replace(/\/+$/, '') + '/' + b), '');
}

export function dirname(p: string): string {
  const n = normalize(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? (i === 0 ? '/' : '') : n.slice(0, i);
}

export function basename(p: string): string {
  const n = normalize(p);
  return n.slice(n.lastIndexOf('/') + 1);
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}

export function stem(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? b : b.slice(0, i);
}

/** v1's ONLY image strategy: a folder next to the document, named after it. */
export function sidecarDir(docPath: string): string {
  return join(dirname(docPath), stem(docPath));
}

/** The markdown-relative path for a file inside the sidecar folder. */
export function sidecarRef(docPath: string, fileName: string): string {
  return `${stem(docPath)}/${fileName}`;
}

/** Resolve a markdown image src against the document's folder. Absolute/remote → null. */
export function resolveAgainst(docPath: string, src: string): string | null {
  if (!src) return null;
  if (/^(https?:|data:|file:)/i.test(src)) return null;
  const base = dirname(docPath);
  const parts = normalize(src).split('/');
  const out = normalize(base).split('/');
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** paste-1.png, paste-2.png … when the name is taken. */
export function uniqueName(taken: (name: string) => boolean, name: string): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? '' : name.slice(dot);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}
