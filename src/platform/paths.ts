/* Pure path helpers. Kept free of any host API so they can be unit-tested, and so the
   one place that decides where a pasted image lands (`imageDir`) is a single function —
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

/** Where pasted images go unless the settings say otherwise: a folder next to the document,
    named after it. */
export const DEFAULT_IMAGE_DIR = '{name}';

const isAbsolute = (p: string) => /^([a-zA-Z]:)?\//.test(p);

/** The folder a pasted image lands in. `template` is a folder relative to the document's own
    (`..` allowed, `.` is that folder itself) or an absolute one; `{name}` stands for the
    document's name without its extension. */
export function imageDir(docPath: string, template = DEFAULT_IMAGE_DIR): string {
  const t = normalize(template.trim() || DEFAULT_IMAGE_DIR)
    .split('{name}')
    .join(stem(docPath))
    .replace(/(.)\/+$/, '$1');
  if (isAbsolute(t)) return t;
  return resolveAgainst(docPath, t) ?? join(dirname(docPath), stem(docPath));
}

/** The path of `target` as seen from the folder `from` (both absolute), as markdown writes it.
    Across drives there is no relative path, so the absolute one is returned. */
export function relativeTo(from: string, target: string): string {
  const a = normalize(from).split('/').filter((x, i) => x || i === 0);
  const b = normalize(target).split('/').filter((x, i) => x || i === 0);
  if (a[0] !== b[0]) return normalize(target);
  let k = 0;
  while (k < a.length && k < b.length - 1 && a[k] === b[k]) k++;
  return [...a.slice(k).map(() => '..'), ...b.slice(k)].join('/');
}

/** The markdown path, relative to the document, of an image stored in `dir`. */
export function imageRef(docPath: string, dir: string, fileName: string): string {
  return relativeTo(dirname(docPath), join(dir, fileName));
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

/** A pasted file's name made safe to write and to put in markdown: no path separators or
    characters Windows forbids, no leading dot (hidden file, `..`), no blanks or brackets (they
    would break `![](…)`), not a Windows device name, and not absurdly long. Null when nothing
    usable is left. */
export function safeFileName(name: string): string | null {
  const raw = name
    .normalize('NFC')
    .replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/[\s()[\]]+/g, '-')
    .replace(/-{2,}/g, '-');
  const trim = (x: string) => x.replace(/^[.\-]+|[.\-]+$/g, '');
  const bare = trim(raw);
  const dot = bare.lastIndexOf('.');
  let base = trim(dot > 0 ? bare.slice(0, dot) : bare).slice(0, 100);
  const ext = dot > 0 ? trim(bare.slice(dot + 1)).slice(0, 10) : '';
  if (!base) return null;
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = 'img-' + base;
  return ext ? `${base}.${ext}` : base;
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
