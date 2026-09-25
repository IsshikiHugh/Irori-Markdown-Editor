/* irori-host on its own, without a browser: the command line, signing in, and what the server
   refuses. Runs
   on every platform CI has (the behaviour suite only runs on Linux), against the script by
   default or, with IRORI_HOST_CMD=<binary>, against a compiled binary.

     node --test tests/host/irori-host.test.mjs */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../server/irori-host.mjs', import.meta.url));
const CMD = process.env.IRORI_HOST_CMD ? [path.resolve(process.env.IRORI_HOST_CMD)] : [process.execPath, SCRIPT];
const WIN = process.platform === 'win32';

/** a 1×1 PNG */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'irori-host-test-')));
const env = { ...process.env, IRORI_HOST_HOME: path.join(root, '.home') };
const files = path.join(root, 'files');
const F = (...p) => path.join(files, ...p);
const put = (name, data) => {
  fs.mkdirSync(path.dirname(F(name)), { recursive: true });
  fs.writeFileSync(F(name), data);
  return F(name);
};

function cli(...args) {
  const r = spawnSync(CMD[0], [...CMD.slice(1), ...args], { env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const ok = (...args) => {
  const r = cli(...args);
  assert.equal(r.status, 0, r.err);
  return r.out;
};
const registry = () => JSON.parse(ok('ls', '--json'));

/** A key pair as Irori makes one, and its public key as `trust` takes it. */
function makeKey() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { privateKey, pub: 'irori-p256.' + raw.toString('base64url') };
}
/** what Irori signs (the same bytes and signature format as WebCrypto's ECDSA) */
const sign = (k, challenge) =>
  crypto.sign('sha256', Buffer.from('irori-host sign-in\n' + challenge), { key: k.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');

/** the session requests carry unless they say otherwise (`s: null` for none) */
let session = '';

/** a raw request, with whatever Host / Origin a caller might send */
function req(method, route, { path: p, body, headers = {}, s = session, to = port } = {}) {
  const params = new URLSearchParams();
  if (p != null) params.set('path', p);
  if (s != null) params.set('s', s);
  const q = [...params].length ? '?' + params : '';
  return new Promise((done, fail) => {
    const r = http.request({ host: '127.0.0.1', port: to, method, path: route + q, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', fail);
    r.end(body);
  });
}
const get = (route, p, headers) => req('GET', route, { path: p, headers });

/** the whole sign-in: challenge, signature → the /auth reply */
async function signIn(k, { key = k.pub, to = port } = {}) {
  const { challenge } = JSON.parse((await req('GET', '/hello', { to, s: null })).body);
  const body = JSON.stringify({ key, challenge, signature: sign(k, challenge) });
  const r = await req('POST', '/auth', { to, s: null, body, headers: { 'content-type': 'application/json' } });
  return { status: r.status, ...JSON.parse(r.body), challenge };
}

/** another `serve` on the same registry (a restart, as far as a client can tell) */
async function startServer() {
  const proc = spawn(CMD[0], [...CMD.slice(1), 'serve', '--port', '0'], { env });
  const p = await new Promise((done, fail) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /127\.0\.0\.1:(\d+)/.exec(out);
      if (m) done(Number(m[1]));
    });
    proc.on('exit', (c) => fail(new Error('irori-host exited ' + c + ': ' + out)));
  });
  return { proc, port: p };
}

const me = makeKey();
const create = (p, body = PNG) => req('POST', '/create', { path: p, body });

let server;
let port;
let doc;
let linked = true;

// one outer suite: Node 18 runs top-level hooks only around top-level tests
describe('irori-host', () => {
  before(async () => {
    doc = put('doc.md', '![](img/old.png)\n\n<img src="pic%20two.png">\n\n![](../outside.png) ![](notes.txt) ![](https://example.com/x.png)\n');
    put('.env', 'SECRET');
    put('img/old.png', PNG);
    put('pic two.png', PNG);
    put('notes.txt', 'not a picture');
    fs.writeFileSync(path.join(root, 'outside.png'), PNG);
    fs.writeFileSync(path.join(root, 'key'), 'KEY');
    try {
      fs.symlinkSync(path.join(root, 'key'), F('link.png'));
      fs.symlinkSync(root, F('up'), 'dir');
    } catch {
      linked = false; // Windows without the right to make symlinks
    }
    ({ proc: server, port } = await startServer());
    ok('trust', me.pub, '--name', 'laptop');
    const r = await signIn(me);
    assert.equal(r.status, 200, JSON.stringify(r));
    session = r.session;
  });

  after(() => {
    server?.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('command line', () => {
    test('share registers the file and the pictures its document shows', () => {
      ok('share', doc, '--for', '2h');
      const [s] = registry();
      assert.equal(s.path, doc);
      assert.deepEqual(s.pictures.map((p) => path.basename(p)).sort(), ['old.png', 'outside.png', 'pic two.png']);
    });

    test('re-sharing keeps the id; set changes the lifetime and refreshes the pictures', () => {
      const id = registry()[0].id;
      ok('share', doc, '--keep');
      assert.equal(registry()[0].id, id);
      assert.equal(registry()[0].expiresAt, null);
      put('later.png', PNG);
      fs.appendFileSync(doc, '![](later.png)\n');
      ok('set', id, '--refresh');
      assert.ok(registry()[0].pictures.some((p) => path.basename(p) === 'later.png'));
      assert.equal(registry()[0].expiresAt, null, '--refresh alone leaves the lifetime alone');
    });

    test('folders, missing files and unknown ids are usage errors that change nothing', () => {
      assert.equal(cli('share', files).status, 2);
      assert.equal(cli('share', F('nope.md')).status, 2);
      const before = registry();
      const r = cli('unshare', doc, 'ffffff');
      assert.equal(r.status, 2);
      assert.deepEqual(registry(), before, 'a failed unshare saves nothing');
    });

    test('the registry is private', { skip: WIN && 'no POSIX modes on Windows' }, () => {
      assert.equal((fs.statSync(env.IRORI_HOST_HOME).mode & 0o777).toString(8), '700');
      assert.equal((fs.statSync(path.join(env.IRORI_HOST_HOME, 'shares.json')).mode & 0o777).toString(8), '600');
    });
  });

  describe('server: only registered files can be read', () => {
    test('the shared file reads and writes, keeping its permissions', async () => {
      assert.equal(JSON.parse((await get('/read', doc)).body).text.startsWith('![](img/old.png)'), true);
      if (!WIN) fs.chmodSync(doc, 0o640);
      const w = await req('PUT', '/write', { path: doc, body: '# new\n' });
      assert.equal(w.status, 200, w.body);
      assert.equal(fs.readFileSync(doc, 'utf8'), '# new\n');
      if (!WIN) assert.equal((fs.statSync(doc).mode & 0o777).toString(8), '640');
      assert.deepEqual(fs.readdirSync(files).filter((n) => n.endsWith('.tmp')), []);
    });

    test('client paths spelled with / work on every platform (Irori normalizes separators)', async () => {
      assert.equal((await get('/read', doc.split(path.sep).join('/'))).status, 200);
    });

    test('registered pictures are served, with their type', async () => {
      const r = await get('/asset', F('img', 'old.png'));
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'image/png');
      assert.equal((await get('/asset', path.join(root, 'outside.png'))).status, 200);
    });

    test('nothing else: not a file beside it, not as text, not its size, not a folder listing', async () => {
      assert.equal((await get('/asset', F('.env'))).status, 403);
      assert.equal((await get('/read', F('.env'))).status, 403);
      assert.equal((await get('/stat', F('.env'))).status, 403);
      assert.equal((await get('/read', F('img', 'old.png'))).status, 403, 'a picture is not a document');
      assert.equal((await get('/asset', F('notes.txt'))).status, 403);
      assert.equal((await get('/list', files)).status, 404);
      assert.equal((await get('/asset', F('img', '..', '..', 'key'))).status, 403);
    });

    test('symlinks do not lead out', { skip: !linked && 'cannot make symlinks here' }, async () => {
      assert.equal((await get('/asset', F('link.png'))).status, 403);
      assert.equal((await create(F('up', 'planted.png'))).status, 403);
      assert.ok(!fs.existsSync(path.join(root, 'planted.png')));
    });
  });

  describe('server: the only thing added is a new picture', () => {
    test('not in a hidden folder, not another kind of file, not outside the folder', async () => {
      assert.equal((await create(F('.git', 'hooks', 'x.png'))).status, 403);
      assert.ok(!fs.existsSync(F('.git')));
      assert.equal((await create(F('evil.sh'), 'x')).status, 403);
      assert.ok(!fs.existsSync(F('evil.sh')));
      assert.equal((await create(path.join(root, 'x.png'))).status, 403);
      assert.equal((await req('POST', '/mkdirp', { path: F('.ssh') })).status, 403);
    });

    test('never a replacement', async () => {
      assert.equal(JSON.parse((await create(F('img', 'old.png'), 'x')).body).ok, false);
      assert.deepEqual(fs.readFileSync(F('img', 'old.png')), PNG);
    });

    test('a new picture is created and registered, so it can be shown', async () => {
      assert.equal((await req('POST', '/mkdirp', { path: F('doc') })).status, 200);
      assert.equal(JSON.parse((await create(F('doc', 'new.png'))).body).ok, true);
      assert.equal((await get('/asset', F('doc', 'new.png'))).status, 200);
      assert.ok(registry()[0].pictures.includes(F('doc', 'new.png')));
    });

    test('an oversized body is refused', async () => {
      const r = await req('PUT', '/write', { path: doc, body: Buffer.alloc(65 * 1024 * 1024) });
      assert.equal(r.status, 413);
      assert.equal(fs.readFileSync(doc, 'utf8'), '# new\n');
    });
  });

  describe('server: only Irori is answered', () => {
    test('a web page, its preflight, and a sandboxed page are refused', async () => {
      assert.equal((await get('/read', doc, { origin: 'https://evil.example' })).status, 403);
      assert.equal((await req('OPTIONS', '/write', { path: doc, headers: { origin: 'https://evil.example' } })).status, 403);
      assert.equal((await get('/read', doc, { origin: 'null' })).status, 403);
    });

    test('DNS rebinding (a Host that is not this machine) is refused', async () => {
      assert.equal((await get('/hello', null, { host: 'evil.example:' + port })).status, 403);
    });

    test('the desktop app on every platform, and a forwarded port of another number, are answered', async () => {
      const r = await get('/read', doc, { origin: 'tauri://localhost' });
      assert.equal(r.status, 200);
      assert.equal(r.headers['access-control-allow-origin'], 'tauri://localhost');
      assert.equal((await get('/hello', null, { origin: 'http://tauri.localhost' })).status, 200);
      assert.equal((await get('/hello', null, { host: 'localhost:9999' })).status, 200);
      assert.equal(JSON.parse((await get('/hello')).body).protocol, 4);
    });
  });

  describe('server: only trusted Irori installs get in', () => {
    test('without a session nothing but the handshake answers', async () => {
      for (const route of ['/shares', '/events', '/read', '/stat', '/asset']) {
        const r = await req('GET', route, { path: doc, s: null });
        assert.equal(r.status, 401, route);
        assert.equal(JSON.parse(r.body).auth, 'required');
      }
      assert.equal((await req('PUT', '/write', { path: doc, s: null, body: 'x' })).status, 401);
      assert.equal((await req('POST', '/create', { path: F('z.png'), s: null, body: PNG })).status, 401);
      assert.ok(!fs.existsSync(F('z.png')));
    });

    test('a made-up session, or one with another id, does not', async () => {
      const [id] = session.split('.');
      assert.equal((await req('GET', '/shares', { s: id + '.AAAA' })).status, 401);
      assert.equal((await req('GET', '/shares', { s: 'ffffffffffff' + session.slice(12) })).status, 401);
    });

    test('a key nobody trusted is told so', async () => {
      const r = await signIn(makeKey());
      assert.equal(r.status, 401);
      assert.equal(r.auth, 'untrusted');
    });

    test('a trusted public key without its private key is refused', async () => {
      const r = await signIn(makeKey(), { key: me.pub });
      assert.equal(r.status, 401);
      assert.equal(r.auth, 'bad-signature');
    });

    test('a challenge works once', async () => {
      const r = await signIn(me);
      assert.equal(r.status, 200);
      const again = await req('POST', '/auth', { s: null, body: JSON.stringify({ key: me.pub, challenge: r.challenge, signature: sign(me, r.challenge) }) });
      assert.equal(again.status, 401);
      assert.equal(JSON.parse(again.body).auth, 'expired');
    });

    test('a session outlives a restart of the server', async () => {
      const other = await startServer();
      try {
        assert.equal((await req('GET', '/shares', { to: other.port })).status, 200);
      } finally {
        other.proc.kill();
      }
    });

    test('untrusting signs a client out at once', async () => {
      const k = makeKey();
      ok('trust', k.pub, '--name', 'phone');
      const r = await signIn(k);
      assert.equal(r.name, 'phone');
      assert.equal((await req('GET', '/shares', { s: r.session })).status, 200);
      ok('untrust', 'phone');
      assert.equal((await req('GET', '/shares', { s: r.session })).status, 401);
      assert.equal((await signIn(k)).auth, 'untrusted');
    });
  });

  describe('command line: trusted clients', () => {
    test('trust takes only an Irori key; trusting again renames, keeping the id', () => {
      assert.equal(cli('trust', 'ssh-ed25519 AAAA').status, 2);
      assert.equal(cli('trust', 'irori-p256.' + Buffer.alloc(65, 4).toString('base64url')).status, 2, 'a point off the curve');
      const before = JSON.parse(ok('clients', '--json')).find((c) => c.key === me.pub);
      ok('trust', me.pub, '--name', 'desk');
      const now = JSON.parse(ok('clients', '--json')).find((c) => c.key === me.pub);
      assert.equal(now.id, before.id);
      assert.equal(now.name, 'desk');
      assert.equal(cli('trust', makeKey().pub, '--name', 'desk').status, 2, 'names are unique');
    });

    test('untrust with one unknown name changes nothing', () => {
      const before = ok('clients', '--json');
      assert.equal(cli('untrust', 'desk', 'nobody').status, 2);
      assert.equal(ok('clients', '--json'), before);
    });

    test('the list and the secret are private', { skip: WIN && 'no POSIX modes on Windows' }, () => {
      for (const f of ['clients.json', 'secret']) assert.equal((fs.statSync(path.join(env.IRORI_HOST_HOME, f)).mode & 0o777).toString(8), '600', f);
    });
  });
});
