#!/usr/bin/env node
/* irori-host: share single files with Irori's remote mode. Zero dependencies (Node >= 18).

   Two halves that only meet in one file, the share registry (<home>/shares.json):
   - the command line manages the registry: share / ls / set / unshare. It works whether or
     not a server is running.
   - `serve` answers clients on a port: the handshake, the list of shared files (pushed every
     few seconds and whenever the registry changes), and reads/writes of exactly those files.

   Only what the registry holds can be read: a shared file, and the pictures registered with it
   (the ones its document shows when it is shared, and the ones pasted into it since). The one
   thing a client can add is a new picture — never a replacement, never another kind of file,
   never in a hidden folder — somewhere below a shared file's folder; the server registers it
   with that share, and that is the only registering the server does.

   Only trusted Irori installs are served. Each Irori has its own key pair and signs in with it;
   the command line keeps the public keys it trusts (<home>/clients.json, like ssh's
   authorized_keys), so another user or program that reaches the port gets nothing. Requests must
   also name this machine as their Host (no DNS rebinding) and, when a browser says where they
   come from, come from Irori (no web page can use the port). Wire format: server/PROTOCOL.md. */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PROTOCOL = 4;
const DEFAULT_PORT = 7420;
const DEFAULT_FOR = '12h';
/** how often the list is pushed even when nothing changed (it also carries the time left) */
const PUSH_EVERY = 5000;
/** the largest request body accepted (a document or a pasted picture) */
const MAX_BODY = 64 * 1024 * 1024;

const HOME = path.resolve(process.env.IRORI_HOST_HOME || path.join(os.homedir(), '.irori-host'));
const REGISTRY = path.join(HOME, 'shares.json');
/** the Irori installs allowed in: their public keys */
const CLIENTS = path.join(HOME, 'clients.json');
/** what sessions are signed with; made on first use, never leaves this machine */
const SECRET = path.join(HOME, 'secret');

/** the pictures that can be registered with a share, and how they are served */
const PICTURE = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};
const isPicture = (p) => Object.hasOwn(PICTURE, path.extname(p).toLowerCase());

/** The canonical form of an existing path: symlinks resolved and, on case-blind file systems,
    the case on disk — so one file always compares equal to itself. null when it does not exist. */
function real(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/* ---------- registry ---------- */

/** @typedef {{ id: string, path: string, name: string, addedAt: number, expiresAt: number | null, pictures?: string[] }} Share */

/** The live shares; expired ones are dropped (and the file rewritten) on the way. */
function loadShares() {
  let shares = [];
  try {
    shares = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).shares ?? [];
  } catch {
    return [];
  }
  const now = Date.now();
  const live = shares.filter((s) => s.expiresAt == null || s.expiresAt > now);
  if (live.length !== shares.length) saveShares(live);
  return live;
}

/** Private to this user (they say which files are open to editing, and to whom), and replaced
    in one step so a reader never sees half of one. */
function saveJson(file, value) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(HOME, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  // on Windows the rename fails while another process (the server) has the file open for a
  // moment: try again briefly instead of failing the command
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(tmp, file);
    } catch (e) {
      if (process.platform !== 'win32' || i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

const saveShares = (shares) => saveJson(REGISTRY, { shares });

/** "90s" / "30m" / "2h" / "7d" → milliseconds */
function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(String(s).trim());
  if (!m) throw new UsageError(`not a duration: ${s} (use e.g. 90s, 30m, 2h, 7d)`);
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase()];
}

/** a share by id, or by the file it points at */
function findShare(shares, key) {
  const byId = shares.find((s) => s.id === key);
  if (byId) return byId;
  const abs = real(path.resolve(key)) ?? path.resolve(key);
  return shares.find((s) => s.path === abs);
}

/** The pictures a document shows that exist on this machine: ![](src) and <img src="">, relative
    to the document or absolute. Remote ones (http:, data:) are not files here. */
function picturesOf(doc) {
  let text;
  try {
    text = fs.readFileSync(doc, 'utf8');
  } catch {
    return [];
  }
  const srcs = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)/g)) srcs.push(m[1].replace(/^<|>$/g, ''));
  for (const m of text.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) srcs.push(m[1] ?? m[2]);
  const found = new Set();
  for (let src of srcs) {
    if (!src || (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src))) continue; // a URL, not a Windows drive
    src = src.replace(/[?#].*$/, '');
    try {
      src = decodeURI(src);
    } catch {}
    const p = real(path.resolve(path.dirname(doc), src));
    if (p && isPicture(p) && fs.statSync(p).isFile()) found.add(p);
  }
  return [...found];
}

/** Registers the pictures `s`'s document shows now, keeping those registered before that
    still exist (pasted ones the text may no longer mention are harmless: they are pictures). */
function refreshPictures(s) {
  s.pictures = [...new Set([...(s.pictures ?? []).filter((p) => real(p) === p), ...picturesOf(s.path)])];
}

/* ---------- trusted clients ---------- */

/** @typedef {{ id: string, name: string, key: string, addedAt: number }} Client */

/** How Irori writes its public key: the P-256 point, uncompressed, in base64url. */
const KEY_PREFIX = 'irori-p256.';

/** The public key a key string names, or null when it is not one. */
function publicKey(str) {
  if (typeof str !== 'string' || !str.startsWith(KEY_PREFIX)) return null;
  const raw = Buffer.from(str.slice(KEY_PREFIX.length), 'base64url');
  if (raw.length !== 65 || raw[0] !== 4) return null;
  try {
    // checks that the point is on the curve
    const jwk = { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') };
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return null;
  }
}

/** a short, stable name for a key: the start of its SHA-256 */
const keyId = (str) => crypto.createHash('sha256').update(str).digest('hex').slice(0, 12);

function loadClients() {
  try {
    return JSON.parse(fs.readFileSync(CLIENTS, 'utf8')).clients ?? [];
  } catch {
    return [];
  }
}
const saveClients = (clients) => saveJson(CLIENTS, { clients });

/** a client by id, name or key */
const findClient = (clients, k) => clients.find((c) => c.id === k || c.name === k || c.key === k);

/** This machine's session secret, made the first time it is needed. */
function secret() {
  try {
    return fs.readFileSync(SECRET);
  } catch {}
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(SECRET, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e; // another process made it first: use theirs
  }
  return fs.readFileSync(SECRET);
}

/* ---------- command line ---------- */

class UsageError extends Error {}

const HELP = `irori-host — share files with Irori's remote mode

usage:
  irori-host serve [--port ${DEFAULT_PORT}]
      Answer Irori on 127.0.0.1:<port> (forward that port to reach it from elsewhere).
      Serves whatever the registry holds, and picks up changes to it while running.

  irori-host share <file>... [--for <duration> | --keep] [--name <name>]
      Make files editable from Irori. Default: --for ${DEFAULT_FOR}.
      --for 30m|2h|7d   stop sharing after that long
      --keep            share until unshared
      --name            what clients see in the list (default: the file name; one file only)
      The pictures a document shows are registered with it, so Irori can display them.
      Sharing a file that is already shared updates it instead.

  irori-host ls [--json]
      The shared files: id, time left, name, path (and how many pictures go with each).

  irori-host set <id|file> [--for <duration> | --keep] [--name <name>] [--refresh]
      Change how long a file stays shared (counted from now), or its name. Any set, or
      --refresh alone, also registers pictures the document has started to show since.

  irori-host unshare <id|file>... | --all
      Stop sharing (a file and its pictures).

  irori-host trust <key> [--name <name>]
      Let an Irori in: <key> is what its remote panel shows (irori-p256.…). Only trusted
      Irori installs can see or edit anything. Trusting a key again renames it.

  irori-host clients [--json]
      The trusted Irori installs: id, name, when trusted.

  irori-host untrust <id|name|key>... | --all
      Stop trusting (it is signed out at once).

The registry lives in ${HOME} (set IRORI_HOST_HOME to use another).`;

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  const flags = ['--keep', '--all', '--json', '--refresh', '--help', '-h'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.includes(a)) opt[a.replace(/^-+/, '')] = true;
    else if (a === '--for' || a === '--name' || a === '--port') {
      if (argv[i + 1] == null) throw new UsageError(`${a} needs a value`);
      opt[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else pos.push(a);
  }
  if (opt.keep && opt.for) throw new UsageError('--for and --keep contradict each other');
  return { pos, opt };
}

function left(expiresAt) {
  if (expiresAt == null) return 'kept';
  const ms = expiresAt - Date.now();
  if (ms < 6e4) return `${Math.max(0, Math.round(ms / 1e3))}s`;
  if (ms < 36e5) return `${Math.round(ms / 6e4)}m`;
  if (ms < 864e5) return `${(ms / 36e5).toFixed(1).replace(/\.0$/, '')}h`;
  return `${(ms / 864e5).toFixed(1).replace(/\.0$/, '')}d`;
}

function printShares(shares) {
  if (!shares.length) return console.log('(nothing shared)');
  const note = (s) => {
    const n = s.pictures?.length ?? 0;
    return (fs.existsSync(s.path) ? '' : '  (missing)') + (n ? `  (+${n} picture${n > 1 ? 's' : ''})` : '');
  };
  const rows = shares.map((s) => [s.id, left(s.expiresAt), s.name, s.path + note(s)]);
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length), ['ID', 'LEFT', 'NAME'][i].length));
  const line = (r) => r.map((c, i) => (i < 3 ? c.padEnd(w[i]) : c)).join('  ');
  console.log(line(['ID', 'LEFT', 'NAME', 'PATH']));
  for (const r of rows) console.log(line(r));
}

const commands = {
  share({ pos, opt }) {
    if (!pos.length) throw new UsageError('share: which file?');
    if (opt.name && pos.length > 1) throw new UsageError('--name takes one file');
    const expiresAt = opt.keep ? null : Date.now() + parseDuration(opt.for ?? DEFAULT_FOR);
    const shares = loadShares();
    const touched = [];
    for (const f of pos) {
      const abs = real(path.resolve(f));
      if (!abs) throw new UsageError(`no such file: ${f}`);
      if (!fs.statSync(abs).isFile()) throw new UsageError(`not a file: ${f}`);
      let s = shares.find((x) => x.path === abs);
      if (s) {
        s.expiresAt = expiresAt;
        if (opt.name) s.name = opt.name;
      } else {
        s = { id: newId(shares), path: abs, name: opt.name ?? path.basename(abs), addedAt: Date.now(), expiresAt, pictures: [] };
        shares.push(s);
      }
      refreshPictures(s);
      touched.push(s);
    }
    saveShares(shares);
    printShares(touched);
  },

  ls({ opt }) {
    const shares = loadShares();
    if (opt.json) console.log(JSON.stringify(shares, null, 2));
    else printShares(shares);
  },

  set({ pos, opt }) {
    if (pos.length !== 1) throw new UsageError('set: one id or file');
    if (!opt.keep && !opt.for && !opt.name && !opt.refresh) throw new UsageError('set: nothing to change (--for, --keep, --name or --refresh)');
    const shares = loadShares();
    const s = findShare(shares, pos[0]);
    if (!s) throw new UsageError(`not shared: ${pos[0]}`);
    if (opt.keep) s.expiresAt = null;
    if (opt.for) s.expiresAt = Date.now() + parseDuration(opt.for);
    if (opt.name) s.name = opt.name;
    refreshPictures(s);
    saveShares(shares);
    printShares([s]);
  },

  unshare({ pos, opt }) {
    let shares = loadShares();
    if (opt.all) {
      saveShares([]);
      return console.log(`unshared ${shares.length} file(s)`);
    }
    if (!pos.length) throw new UsageError('unshare: which id or file? (or --all)');
    const gone = pos.map((key) => {
      const s = findShare(shares, key);
      if (!s) throw new UsageError(`not shared: ${key} (nothing was unshared)`);
      return s;
    });
    saveShares(shares.filter((x) => !gone.includes(x)));
    for (const s of gone) console.log(`unshared ${s.id}  ${s.path}`);
  },

  trust({ pos, opt }) {
    if (pos.length !== 1) throw new UsageError('trust: one key (what Irori\'s remote panel shows)');
    const key = pos[0].trim();
    if (!publicKey(key)) throw new UsageError(`not an Irori key: ${key} (it starts with ${KEY_PREFIX})`);
    const clients = loadClients();
    const id = keyId(key);
    if (opt.name && clients.some((c) => c.name === opt.name && c.id !== id)) throw new UsageError(`the name ${opt.name} is taken`);
    let c = clients.find((x) => x.id === id);
    if (c) {
      if (opt.name) c.name = opt.name;
    } else {
      c = { id, name: opt.name ?? `irori-${id.slice(0, 6)}`, key, addedAt: Date.now() };
      clients.push(c);
    }
    saveClients(clients);
    printClients([c]);
  },

  clients({ opt }) {
    const clients = loadClients();
    if (opt.json) console.log(JSON.stringify(clients, null, 2));
    else printClients(clients);
  },

  untrust({ pos, opt }) {
    const clients = loadClients();
    if (opt.all) {
      saveClients([]);
      return console.log(`untrusted ${clients.length} client(s)`);
    }
    if (!pos.length) throw new UsageError('untrust: which id, name or key? (or --all)');
    const gone = pos.map((k) => {
      const c = findClient(clients, k);
      if (!c) throw new UsageError(`not trusted: ${k} (nothing was untrusted)`);
      return c;
    });
    saveClients(clients.filter((c) => !gone.includes(c)));
    for (const c of gone) console.log(`untrusted ${c.id}  ${c.name}`);
  },

  serve({ opt }) {
    serve(Number(opt.port ?? DEFAULT_PORT));
  },
};

function printClients(clients) {
  if (!clients.length) return console.log('(no Irori trusted yet: irori-host trust <key>)');
  const rows = clients.map((c) => [c.id, c.name, new Date(c.addedAt).toISOString().slice(0, 16).replace('T', ' ')]);
  const w = [0, 1].map((i) => Math.max(...rows.map((r) => r[i].length), ['ID', 'NAME'][i].length));
  const line = (r) => r.map((c, i) => (i < 2 ? c.padEnd(w[i]) : c)).join('  ');
  console.log(line(['ID', 'NAME', 'TRUSTED']));
  for (const r of rows) console.log(line(r));
}

function newId(shares) {
  for (;;) {
    const id = crypto.randomBytes(3).toString('hex');
    if (!shares.some((s) => s.id === id)) return id;
  }
}

/* ---------- server ---------- */

class HttpError extends Error {
  /** `auth` tells the client why it is not in: 'required', 'expired', 'bad-signature', 'untrusted' */
  constructor(status, message, auth) {
    super(message);
    this.status = status;
    this.auth = auth;
  }
}

/** What a client sees for each share: no ids needed, the path is the handle. */
function publicList() {
  return loadShares().map((s) => {
    let st = null;
    try {
      st = fs.statSync(s.path);
    } catch {}
    return {
      name: s.name,
      path: s.path,
      size: st?.size ?? 0,
      mtimeMs: st?.mtimeMs ?? 0,
      missing: !st,
      addedAt: s.addedAt,
      expiresAt: s.expiresAt,
    };
  });
}

/** the list plus the server's clock: time left is `expiresAt - now`, whatever the client's clock says */
const listMessage = () => ({ now: Date.now(), shares: publicList() });

function requirePath(p) {
  if (typeof p !== 'string' || !p) throw new HttpError(400, 'path is required');
  return path.resolve(p);
}

/** The registered path `p` names (a shared file itself when `picturesToo` is false), compared in
    canonical form so no symlink or spelling leads anywhere else. A shared file that has been
    deleted keeps its registered path (writing it creates it again). */
function registered(p, picturesToo) {
  const abs = requirePath(p);
  const canon = real(abs) ?? abs;
  for (const s of loadShares()) {
    if (s.path === canon) return s.path;
    if (picturesToo && s.pictures?.includes(canon)) return canon;
  }
  throw new HttpError(403, `未共享的文件：${p}`);
}

/** Where a new picture may go: below a shared file's folder, in no hidden folder, and — with
    symlinks resolved — still there. Returns the path and the shares whose folder holds it. */
function newPictureSpot(p) {
  const abs = requirePath(p);
  const owners = loadShares().filter((s) => {
    const rel = path.relative(path.dirname(s.path), abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false; // '' is the folder itself
    if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) return false;
    // the deepest folder that exists already must really be inside (not a symlink out of it)
    let dir = path.dirname(abs);
    while (!fs.existsSync(dir)) dir = path.dirname(dir);
    const r = real(dir);
    const top = path.dirname(s.path);
    return r != null && (r === top || r.startsWith(top.endsWith(path.sep) ? top : top + path.sep));
  });
  if (!owners.length) throw new HttpError(403, `只能在共享文件的文件夹里新建图片：${p}`);
  return { abs, owners };
}

/** Reads a request body, refusing one larger than MAX_BODY: the rest is read and dropped (not
    kept), so the client gets the 413 rather than a reset connection. */
const readBody = (req) =>
  new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
      else chunks.length = 0;
    });
    req.on('end', () => (size > MAX_BODY ? fail(new HttpError(413, 'too large')) : ok(Buffer.concat(chunks))));
    req.on('error', fail);
  });

/** temp file beside the target, then rename: another program never reads a half-written file */
async function writeAtomic(abs, data) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fh = await fsp.open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  // the file keeps its permissions (the temp file was created private)
  try {
    await fsp.chmod(tmp, (await fsp.stat(abs)).mode & 0o7777);
  } catch {}
  await fsp.rename(tmp, abs);
}

/* ---------- signing in ----------
   /hello hands out a one-time challenge; the client signs it with its private key and sends it
   to /auth with its public key; if that key is trusted, the reply is a session: `<client id>.<an
   HMAC of the id under this machine's secret>`. Every other route wants it as `?s=`. A session
   needs no memory on the server (it survives restarts) and dies the moment its key is untrusted,
   because each request checks the key is still in the list. */

/** issued challenges → when they expire; each is good for one sign-in, for a minute */
const challenges = new Map();
const CHALLENGE_TTL = 60e3;

function challenge() {
  const now = Date.now();
  for (const [c, exp] of challenges) if (exp < now || challenges.size > 256) challenges.delete(c);
  const c = crypto.randomBytes(24).toString('base64url');
  challenges.set(c, now + CHALLENGE_TTL);
  return c;
}

/** what a client signs: the challenge, under a label so the signature means nothing elsewhere */
const signedText = (c) => Buffer.from(`irori-host sign-in\n${c}`);

const sessionFor = (id) => `${id}.${crypto.createHmac('sha256', secret()).update('session:' + id).digest('base64url')}`;

/** the trusted client a session belongs to, or null */
function sessionClient(s) {
  if (typeof s !== 'string') return null;
  const id = s.slice(0, s.indexOf('.'));
  const want = Buffer.from(sessionFor(id));
  const got = Buffer.from(s);
  if (!id || want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return loadClients().find((c) => c.id === id) ?? null;
}

const notFound = (e, p) => (e.code === 'ENOENT' ? new HttpError(404, 'ENOENT: ' + p) : e);

const routes = {
  'GET /hello': async () => ({ protocol: PROTOCOL, host: os.hostname(), challenge: challenge() }),

  'POST /auth': async ({ body }) => {
    let m;
    try {
      m = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'bad sign-in');
    }
    const exp = challenges.get(m?.challenge);
    challenges.delete(m?.challenge);
    if (!exp || exp < Date.now()) throw new HttpError(401, '登录已过期，请重试', 'expired');
    const pub = publicKey(m.key);
    if (!pub || typeof m.signature !== 'string') throw new HttpError(400, 'bad sign-in');
    const ok = crypto.verify('sha256', signedText(m.challenge), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m.signature, 'base64url'));
    if (!ok) throw new HttpError(401, '签名不对', 'bad-signature');
    const c = loadClients().find((x) => x.key === m.key);
    if (!c) throw new HttpError(401, `${os.hostname()} 还没有信任这台 Irori`, 'untrusted');
    return { session: sessionFor(c.id), name: c.name };
  },

  'GET /shares': async () => listMessage(),

  'GET /read': async ({ q }) => {
    const abs = registered(q.get('path'), false);
    try {
      return { text: await fsp.readFile(abs, 'utf8') };
    } catch (e) {
      throw notFound(e, q.get('path'));
    }
  },

  'PUT /write': async ({ q, body }) => {
    await writeAtomic(registered(q.get('path'), false), body);
    return { ok: true };
  },

  'GET /stat': async ({ q }) => {
    try {
      const s = await fsp.stat(registered(q.get('path'), true));
      return { mtimeMs: s.mtimeMs, size: s.size, dir: s.isDirectory() };
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  },

  'POST /mkdirp': async ({ q }) => {
    await fsp.mkdir(newPictureSpot(q.get('path')).abs, { recursive: true });
    return { ok: true };
  },

  // a new picture only, never a replacement: O_EXCL makes the check and the create one step (and
  // refuses to follow a symlink planted at the name). Then it is registered with its share(s).
  'POST /create': async ({ q, body }) => {
    const { abs, owners } = newPictureSpot(q.get('path'));
    if (!isPicture(abs)) throw new HttpError(403, `只能新建图片：${q.get('path')}`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    try {
      const fh = await fsp.open(abs, 'wx');
      try {
        await fh.writeFile(body);
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (e) {
      if (e.code === 'EEXIST') return { ok: false };
      throw e;
    }
    const canon = real(abs);
    const shares = loadShares();
    for (const s of shares) if (owners.some((o) => o.id === s.id)) s.pictures = [...new Set([...(s.pictures ?? []), canon])];
    saveShares(shares);
    return { ok: true };
  },

  'GET /asset': async ({ q, res }) => {
    const abs = registered(q.get('path'), true);
    if (!isPicture(abs)) throw new HttpError(403, `不是图片：${q.get('path')}`);
    let data;
    try {
      data = await fsp.readFile(abs);
    } catch (e) {
      throw notFound(e, q.get('path'));
    }
    res.writeHead(200, { 'content-type': PICTURE[path.extname(abs).toLowerCase()], 'cache-control': 'no-cache' });
    res.end(data);
  },
};

/** This machine, however the forwarded port is spelled (the port itself may differ). */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Irori's own pages: the desktop app (tauri://localhost on macOS / Linux, http(s)://tauri.localhost
    on Windows) and a page served from this machine (the dev server, the tests). */
function fromIrori(origin) {
  if (origin === 'tauri://localhost') return true;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'tauri.localhost' || LOCAL_HOSTS.has(u.hostname));
}

/** Refuses what did not come from Irori: a Host that is not this machine is DNS rebinding; an
    Origin a browser added that is not Irori is some web page. A request without an Origin is not
    a page's script reading the reply (a picture being displayed, a command-line tool). */
function checkCaller(req) {
  let host;
  try {
    host = new URL('http://' + (req.headers.host ?? '')).hostname;
  } catch {}
  if (!LOCAL_HOSTS.has(host)) return 'bad host';
  const origin = req.headers.origin;
  if (origin != null && !fromIrori(origin)) return 'origin not allowed';
  return null;
}

function serve(port) {
  /** open /events streams */
  const streams = new Set();
  const push = () => {
    const msg = `event: shares\ndata: ${JSON.stringify(listMessage())}\n\n`;
    for (const res of streams) res.write(msg);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const refused = checkCaller(req);
    if (refused) return json(res, 403, { error: refused });
    // Irori's page is on another origin (tauri://, a dev server): let exactly that one read replies
    if (req.headers.origin) {
      res.setHeader('access-control-allow-origin', req.headers.origin);
      res.setHeader('vary', 'origin');
    }
    res.setHeader('access-control-allow-methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    // nothing served here is a page: an SVG opened directly runs no script on this origin
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    const open = (req.method === 'GET' && url.pathname === '/hello') || (req.method === 'POST' && url.pathname === '/auth');
    if (!open && !sessionClient(url.searchParams.get('s'))) {
      return json(res, 401, { error: '需要先登录（这台 Irori 可能已不再被信任）', auth: 'required' });
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      streams.add(res);
      req.on('close', () => streams.delete(res));
      res.write(`event: shares\ndata: ${JSON.stringify(listMessage())}\n\n`);
      return;
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return json(res, 404, { error: `no route ${req.method} ${url.pathname}` });
    try {
      const body = req.method === 'GET' ? null : await readBody(req);
      const out = await handler({ q: url.searchParams, body, res });
      if (!res.headersSent) json(res, 200, out);
    } catch (e) {
      if (!res.headersSent) json(res, e instanceof HttpError ? e.status : 500, e?.auth ? { error: e.message, auth: e.auth } : { error: e.message });
    }
  });

  // the registry changes from the command line: tell the clients right away (where the file
  // system cannot say, e.g. some network file systems, the regular push still does)
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  let pending = null;
  fs.watch(HOME, (_ev, name) => {
    if ((name != null && name !== 'shares.json') || pending) return;
    pending = setTimeout(() => {
      pending = null;
      push();
    }, 100);
  });
  setInterval(push, PUSH_EVERY);

  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `irori-host: port ${port} is already in use` : `irori-host: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    // --port 0 picks a free one (the tests do): report the one actually bound
    console.log(`irori-host: serving on http://127.0.0.1:${server.address().port} (protocol ${PROTOCOL})`);
    console.log(`registry: ${REGISTRY}  —  ${loadShares().length} file(s) shared, ${loadClients().length} Irori trusted`);
    if (!loadClients().length) console.log('no Irori is trusted yet: run irori-host trust <key> with the key its remote panel shows');
  });
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

/* ---------- main ---------- */

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
  } else if (!commands[cmd]) {
    throw new UsageError(`unknown command: ${cmd}`);
  } else {
    commands[cmd](parseArgs(rest));
  }
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(`irori-host: ${e.message}\n(run irori-host help)`);
  process.exit(2);
}
