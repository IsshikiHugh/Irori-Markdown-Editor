/* Behaviour-test harness.
 *
 * The application under test is the REAL app (built bundle), running in headless
 * Chromium against the in-memory host (src/platform/web.ts). Nothing is mocked inside
 * the editor — the tests drive keys and mouse, and read the DOM, exactly like a person.
 *
 * The browser binary is whatever Playwright already installed on this machine; nothing
 * is downloaded. CI installs one explicitly (see .github/workflows/ci.yml).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Serve dist/ so the bundle runs from a real origin (module scripts need one). */
export function serveDist(dir = path.join(ROOT, 'dist')) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(dir, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

export function findChromium() {
  if (process.env.IRORI_CHROME) return process.env.IRORI_CHROME;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      const base = path.join(root, dir);
      candidates.push(
        path.join(base, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        path.join(base, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        path.join(base, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'),
        path.join(base, 'chrome-linux/chrome'),
        path.join(base, 'chrome-linux/headless_shell'),
        path.join(base, 'chrome-headless-shell-linux64/chrome-headless-shell'),
        path.join(base, 'chrome-win/chrome.exe'),
      );
    }
  }
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']) {
    candidates.push(p);
  }
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('no Chromium found — set IRORI_CHROME=/path/to/chrome');
  return hit;
}

export async function launch() {
  return puppeteer.launch({
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox', '--font-render-hinting=none'],
  });
}

/** Boot the app with a seeded virtual disk (and, with `query`, the page's query string: how a
    remote window is opened). */
export async function openApp(browser, { files = {}, images = {}, startup = null, settings = null, update = null, viewport, query = '' } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport || { width: 1440, height: 900 });
  page.on('pageerror', (e) => console.log('   [page error] ' + e.message));
  await page.evaluateOnNewDocument(
    (seed) => {
      window.__iroriSeed = seed;
      // wipe persisted settings once per test page, but NOT on a reload — B-63 checks
      // that preferences survive a restart
      try {
        if (!sessionStorage.getItem('irori-test-started')) {
          localStorage.clear();
          sessionStorage.setItem('irori-test-started', '1');
        }
      } catch {}
    },
    { files, images, startup, settings, update },
  );
  await page.goto(`${browser.__base}/index.html${query ? '?' + query : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__irori && window.__irori.view, { timeout: 10000 });
  return page;
}

/* ---------- assertions ---------- */

export function createReporter() {
  const results = [];
  let current = null;
  return {
    results,
    start(c) {
      current = { id: c.id, name: c.name, checks: [], ok: true, error: null };
      results.push(current);
      return current;
    },
    ok(name, cond, detail = '') {
      current.checks.push({ name, ok: !!cond, detail: String(detail) });
      if (!cond) current.ok = false;
    },
    eq(name, actual, expected) {
      const cond = JSON.stringify(actual) === JSON.stringify(expected);
      current.checks.push({ name, ok: cond, detail: cond ? '' : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}` });
      if (!cond) current.ok = false;
    },
    near(name, actual, expected, tol) {
      const cond = Math.abs(actual - expected) <= tol;
      current.checks.push({ name, ok: cond, detail: cond ? '' : `got ${actual} want ${expected}±${tol}` });
      if (!cond) current.ok = false;
    },
    fail(err) {
      current.ok = false;
      current.error = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
    },
  };
}

/* ---------- page helpers (kept here so cases stay readable) ---------- */

export const docText = (page) => page.evaluate(() => window.__irori.view.state.doc.toString());

export const setDoc = (page, text) =>
  page.evaluate((t) => {
    const v = window.__irori.view;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
  }, text);

/** Which key tests press for "⌘": Meta on macOS, Ctrl on Linux / Windows — matching CodeMirror's `Mod-`.
    The browser and the tests run on the same machine, so the host platform decides. Always pressing Meta
    meant none of the editor's own shortcuts (⌘Z / ⌘B / ⌘F) fired on CI (Linux); the window layer's ⌘S / ⌘\
    accept both keys, which is why that went unnoticed. */
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

export const caret = (page) => page.evaluate(() => window.__irori.view.state.selection.main.head);

export const setCaret = (page, pos) =>
  page.evaluate((p) => {
    const v = window.__irori.view;
    v.dispatch({ selection: { anchor: p } });
    v.focus();
  }, pos);

/** Put the caret at the start of a 1-based line. */
export const caretToLine = (page, n) =>
  page.evaluate((ln) => {
    const v = window.__irori.view;
    const line = v.state.doc.line(ln);
    v.dispatch({ selection: { anchor: line.from } });
    v.focus();
  }, n);

/** Class list of every rendered editor line, in order. */
export const lineClasses = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((el) => el.className));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
