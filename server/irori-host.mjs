#!/usr/bin/env node
/* irori-host: share single files with Irori's remote mode. Zero dependencies (Node >= 18).

   Two halves that only meet in one file, the share registry (<home>/shares.json):
   - the command line manages the registry: share / ls / set / unshare. It works whether or
     not a server is running.
   - `serve` answers clients on a port: the handshake, the list of shared files (pushed every
     few seconds and whenever the registry changes), and reads/writes of exactly those files.
     It never registers anything itself.

   Nothing outside the registry is reachable: a client can read and write a shared file, and —
   so pasted pictures work as they do locally — list, create (never overwrite) and read files in
   that file's own folder and below. Wire format: server/PROTOCOL.md. */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PROTOCOL = 2;
const DEFAULT_PORT = 7420;
const DEFAULT_FOR = '12h';
/** how often the list is pushed even when nothing changed (it also carries the time left) */
const PUSH_EVERY = 5000;

const HOME = path.resolve(process.env.IRORI_HOST_HOME || path.join(os.homedir(), '.irori-host'));
const REGISTRY = path.join(HOME, 'shares.json');

/* ---------- registry ---------- */

/** @typedef {{ id: string, path: string, name: string, addedAt: number, expiresAt: number | null }} Share */

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

function saveShares(shares) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${REGISTRY}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ shares }, null, 2) + '\n');
  fs.renameSync(tmp, REGISTRY);
}

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
  let abs;
  try {
    abs = fs.realpathSync(path.resolve(key));
  } catch {
    abs = path.resolve(key);
  }
  return shares.find((s) => s.path === abs);
}

/* ---------- command line ---------- */

class UsageError extends Error {}

const HELP = `irori-host — share files with Irori's remote mode

usage:
  irori-host serve [--port ${DEFAULT_PORT}]
      Answer Irori clients on 127.0.0.1:<port> (forward that port to reach it from elsewhere).
      Serves whatever the registry holds, and picks up changes to it while running.

  irori-host share <file>... [--for <duration> | --keep] [--name <name>]
      Make files editable from Irori. Default: --for ${DEFAULT_FOR}.
      --for 30m|2h|7d   stop sharing after that long
      --keep            share until unshared
      --name            what clients see in the list (default: the file name; one file only)
      Sharing a file that is already shared updates it instead.

  irori-host ls [--json]
      The shared files: id, time left, name, path.

  irori-host set <id|file> [--for <duration> | --keep] [--name <name>]
      Change how long a file stays shared (counted from now), or its name.

  irori-host unshare <id|file>... | --all
      Stop sharing.

The registry lives in ${HOME} (set IRORI_HOST_HOME to use another).`;

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep' || a === '--all' || a === '--json' || a === '--help' || a === '-h') opt[a.replace(/^-+/, '')] = true;
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
  const rows = shares.map((s) => [s.id, left(s.expiresAt), s.name, s.path + (fs.existsSync(s.path) ? '' : '  (missing)')]);
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
      let abs;
      try {
        abs = fs.realpathSync(path.resolve(f));
      } catch {
        throw new UsageError(`no such file: ${f}`);
      }
      if (!fs.statSync(abs).isFile()) throw new UsageError(`not a file: ${f}`);
      let s = shares.find((x) => x.path === abs);
      if (s) {
        s.expiresAt = expiresAt;
        if (opt.name) s.name = opt.name;
      } else {
        s = { id: newId(shares), path: abs, name: opt.name ?? path.basename(abs), addedAt: Date.now(), expiresAt };
        shares.push(s);
      }
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
    if (!opt.keep && !opt.for && !opt.name) throw new UsageError('set: nothing to change (--for, --keep or --name)');
    const shares = loadShares();
    const s = findShare(shares, pos[0]);
    if (!s) throw new UsageError(`not shared: ${pos[0]}`);
    if (opt.keep) s.expiresAt = null;
    if (opt.for) s.expiresAt = Date.now() + parseDuration(opt.for);
    if (opt.name) s.name = opt.name;
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
    for (const key of pos) {
      const s = findShare(shares, key);
      if (!s) throw new UsageError(`not shared: ${key}`);
      shares = shares.filter((x) => x !== s);
      console.log(`unshared ${s.id}  ${s.path}`);
    }
    saveShares(shares);
  },

  serve({ opt }) {
    serve(Number(opt.port ?? DEFAULT_PORT));
  },
};

function newId(shares) {
  for (;;) {
    const id = crypto.randomBytes(3).toString('hex');
    if (!shares.some((s) => s.id === id)) return id;
  }
}

/* ---------- server ---------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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

/** `file` must be a shared file itself */
function sharedFile(p) {
  const abs = requirePath(p);
  if (!loadShares().some((s) => s.path === abs)) throw new HttpError(403, `未共享的文件：${p}`);
  return abs;
}

/** `p` must be a shared file, or lie in the folder of one (pictures beside a document) */
function besideShared(p) {
  const abs = requirePath(p);
  const ok = loadShares().some((s) => {
    const dir = path.dirname(s.path);
    return abs === s.path || abs === dir || abs.startsWith(dir + path.sep);
  });
  if (!ok) throw new HttpError(403, `不在任何共享文件的文件夹里：${p}`);
  return abs;
}

function requirePath(p) {
  if (typeof p !== 'string' || !p) throw new HttpError(400, 'path is required');
  return path.resolve(p);
}

const readBody = (req) =>
  new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

/** temp file beside the target, then rename: another program never reads a half-written file */
async function writeAtomic(abs, data) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, abs);
}

const notFound = (e, p) => (e.code === 'ENOENT' ? new HttpError(404, 'ENOENT: ' + p) : e);

const routes = {
  'GET /hello': async () => ({ protocol: PROTOCOL, host: os.hostname() }),

  'GET /shares': async () => listMessage(),

  'GET /read': async ({ q }) => {
    const abs = sharedFile(q.get('path'));
    try {
      return { text: await fsp.readFile(abs, 'utf8') };
    } catch (e) {
      throw notFound(e, q.get('path'));
    }
  },

  'PUT /write': async ({ q, body }) => {
    await writeAtomic(sharedFile(q.get('path')), body);
    return { ok: true };
  },

  'GET /stat': async ({ q }) => {
    try {
      const s = await fsp.stat(besideShared(q.get('path')));
      return { mtimeMs: s.mtimeMs, size: s.size, dir: s.isDirectory() };
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  },

  'GET /list': async ({ q }) => {
    const abs = besideShared(q.get('path'));
    try {
      return (await fsp.readdir(abs, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() }));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  },

  'POST /mkdirp': async ({ q }) => {
    await fsp.mkdir(besideShared(q.get('path')), { recursive: true });
    return { ok: true };
  },

  // never replaces: O_EXCL makes the check and the create one step (as the desktop shell does)
  'POST /create': async ({ q, body }) => {
    const abs = besideShared(q.get('path'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    try {
      const fh = await fsp.open(abs, 'wx');
      try {
        await fh.writeFile(body);
        await fh.sync();
      } finally {
        await fh.close();
      }
      return { ok: true };
    } catch (e) {
      if (e.code === 'EEXIST') return { ok: false };
      throw e;
    }
  },

  'GET /asset': async ({ q, res }) => {
    const abs = besideShared(q.get('path'));
    let data;
    try {
      data = await fsp.readFile(abs);
    } catch (e) {
      throw notFound(e, q.get('path'));
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  },
};

function serve(port) {
  /** open /events streams */
  const streams = new Set();
  const push = () => {
    const msg = `event: shares\ndata: ${JSON.stringify(listMessage())}\n\n`;
    for (const res of streams) res.write(msg);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // clients are pages from another origin (tauri://, a dev server), so replies are CORS-open
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

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
      json(res, e instanceof HttpError ? e.status : 500, { error: e.message });
    }
  });

  // the registry changes from the command line: tell the clients right away
  fs.mkdirSync(HOME, { recursive: true });
  let pending = null;
  fs.watch(HOME, (_ev, name) => {
    if (name !== 'shares.json' || pending) return;
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
    console.log(`registry: ${REGISTRY}  —  ${loadShares().length} file(s) shared`);
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
