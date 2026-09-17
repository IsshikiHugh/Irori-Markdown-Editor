/* Comparison run (ADR-0002 step 3 · round 1): new editor vs legacy editor on the same Chrome engine.
 *
 * This is not a unit test but evidence that the experience matches: same post, same set of geometry and
 * color probes, measured on both sides and then compared.
 * The legacy editor (the one in the blog) is the baseline; it is read, never modified.
 *
 *   IRORI_LEGACY_BLOG=/path/to/blog node tests/compare/run.mjs --slug <post-slug>
 *   IRORI_LEGACY_BLOG=... node tests/compare/run.mjs --slug <post-slug> --shots
 *
 * Skipped when IRORI_LEGACY_BLOG is not set (CI does not have that repo, which is expected).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launch, openApp, serveDist, sleep } from '../e2e/harness.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const BLOG = process.env.IRORI_LEGACY_BLOG || arg('--blog', null);
const SLUG = arg('--slug', null);
const SHOTS = args.includes('--shots');
const OUT = arg('--out', path.join(os.tmpdir(), 'irori-compare'));

if (!BLOG) {
  console.log('› skipping comparison: IRORI_LEGACY_BLOG is not set (point it at the blog repo that has the legacy editor)');
  process.exit(0);
}
if (!SLUG) {
  console.error('✗ --slug <post-slug> is required: which blog post to compare');
  process.exit(2);
}
if (!fs.existsSync(path.join(BLOG, 'editor/server.js'))) {
  console.error(`✗ no editor/server.js in ${BLOG} — IRORI_LEGACY_BLOG should point at the blog repo root`);
  process.exit(2);
}

/* The legacy editor runs on a temporary copy of source/_posts; real posts are never touched. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'irori-compare-'));
fs.mkdirSync(path.join(root, 'source/_posts'), { recursive: true });
fs.cpSync(path.join(BLOG, 'source/_posts'), path.join(root, 'source/_posts'), { recursive: true });
const PORT = 4394;
const legacy = spawn('node', [path.join(BLOG, 'editor/server.js')], {
  env: { ...process.env, EDITOR_BLOG_ROOT: root, EDITOR_PORT: String(PORT) },
  stdio: 'ignore',
});
const up = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/posts`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('legacy editor failed to start');
};

/* Both sides measure the same set of things, all of them quantities the eye would notice. */
const PROBE = `(() => {
  const rows = [...document.querySelectorAll(SELECTOR)];
  // Compare real text paragraphs only: image rows (including "image not found" ones) have different DOM shapes on each side by design (D-32)
  const plain = rows.filter(
    (r) => /^[^#>!]/.test(r.textContent) && r.textContent.trim().length > 30 && !r.querySelector('.imgwrap,.imgmiss'),
  );
  const cs = (el) => getComputedStyle(el);
  const of = (sel) => { const el = document.querySelector(sel); return el ? cs(el) : null; };
  const body = plain[0] ? cs(plain[0]) : null;
  const h2 = rows.find((r) => r.className.includes('h2'));
  const quote = rows.find((r) => r.className.includes('quote'));
  const tok = document.querySelector(SELECTOR + ' .tok');
  const lnk = document.querySelector(SELECTOR + ' .lnk');
  const url = document.querySelector(SELECTOR + ' .url');
  // The new editor uses virtual scrolling, so lines outside the viewport do not exist at all — for questions like
  // "what does this class look like", insert a temporary empty node and measure it, so both sides query the same
  // CSS rule instead of depending on whether such a line happens to be rendered.
  const probeClass = (cls, prop) => {
    const host = document.querySelector(SELECTOR) || document.body;
    const el = document.createElement('span');
    el.className = cls;
    host.appendChild(el);
    const v = getComputedStyle(el)[prop];
    el.remove();
    return v;
  };
  const lineH = body ? parseFloat(body.lineHeight) : 0;
  return {
    contentWidth: Math.round(rows[0] ? rows[0].getBoundingClientRect().width : 0),
    bodyFont: body && body.fontSize,
    bodyLineHeight: body && body.lineHeight,
    bodyColor: body && body.color,
    bodyPadding: body && (body.paddingLeft + '/' + body.paddingRight),
    bodyWrap: body && body.overflowWrap,
    h2Font: h2 && cs(h2).fontSize,
    h2Weight: h2 && cs(h2).fontWeight,
    quoteBorder: quote && cs(quote).borderLeftWidth + ' ' + cs(quote).borderLeftColor,
    quotePadding: quote && cs(quote).paddingLeft,
    quoteIndent: quote && cs(quote).textIndent,
    tokColor: tok && cs(tok).color,
    codeBg: probeClass('code', 'backgroundColor'),
    codeFont: probeClass('code', 'fontFamily'),
    linkColor: lnk && cs(lnk).color,
    urlColor: url && cs(url).color,
    paperBg: getComputedStyle(document.body).backgroundColor,
    // Whether the font is really the same: measure the actual width of a fixed string (family names may differ, but glyph metrics must match)
    sampleWidth: (() => {
      const host = document.querySelector(SELECTOR) || document.body;
      const el = document.createElement('span');
      el.textContent = '中文示例文字 with latin 123';
      el.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:19px';
      host.appendChild(el);
      const w = Math.round(el.getBoundingClientRect().width * 10) / 10;
      el.remove();
      return w;
    })(),
    tocCount: document.querySelectorAll('#toc .toc-link').length,
    tocFirst: (document.querySelector('#toc .toc-link') || {}).textContent,
    minimapWidth: document.getElementById('mini').clientWidth,
    minimapScale: document.getElementById('miniContent').style.transform,
    // How many lines each long paragraph wraps to — if a wrap point moves by even one character, this changes
    wraps: plain.slice(0, 6).map((r) => Math.round(r.getBoundingClientRect().height / lineH)),
  };
})()`;

const probe = (page, selector) => page.evaluate(PROBE.replace(/SELECTOR/g, JSON.stringify(selector)));

await up();
const post = await (await fetch(`http://127.0.0.1:${PORT}/api/posts/${encodeURIComponent(SLUG)}`)).json();
if (!post || !post.content) {
  console.error(`✗ no post ${SLUG} in the blog`);
  legacy.kill();
  process.exit(2);
}

const { server, port } = await serveDist();
const browser = await launch();
browser.__base = `http://127.0.0.1:${port}`;

/* --- legacy --- */
const old = await browser.newPage();
await old.setViewport({ width: 1440, height: 900 });
old.on('dialog', (d) => d.accept().catch(() => {}));
await old.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' });
await sleep(600);
await old.evaluate((s) => [...document.querySelectorAll('#listwrap .lrow')].find((r) => r.dataset.slug === s)?.click(), SLUG);
await sleep(1400);
const before = await probe(old, '#body .ln');

/* --- new --- same post body; image paths rewritten as plain relative paths (Hexo's bare-file-name convention is not supported, see D-08) */
const assets = {};
const assetDir = path.join(root, 'source/_posts', SLUG);
if (fs.existsSync(assetDir))
  for (const f of fs.readdirSync(assetDir)) assets[`/posts/${SLUG}/${f}`] = fs.readFileSync(path.join(assetDir, f)).toString('base64');
const text = post.content.replace(/^\n+/, '').replace(/!\[([^\]]*)\]\(([^)/]+)\)/g, (_m, a, f) => `![${a}](${SLUG}/${f})`);
const page = await openApp(browser, { files: { [`/posts/${SLUG}.md`]: text }, images: assets, startup: `/posts/${SLUG}.md` });
await sleep(1400);
const after = await probe(page, '.cm-content .cm-line.ln');

if (SHOTS) {
  fs.mkdirSync(OUT, { recursive: true });
  await old.screenshot({ path: path.join(OUT, 'legacy.png') });
  await page.screenshot({ path: path.join(OUT, 'irori.png') });
}

await browser.close();
server.close();
legacy.kill();

/* --- compare --- */
const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
const same = [];
const diff = [];
for (const k of keys) {
  let x = before[k];
  let y = after[k];
  // Virtual scrolling: the new editor renders only one screen, so compare only the paragraphs both sides have
  if (k === 'wraps' && Array.isArray(x) && Array.isArray(y)) {
    const n = Math.min(x.length, y.length);
    x = x.slice(0, n);
    y = y.slice(0, n);
  }
  const a = JSON.stringify(x);
  const b = JSON.stringify(y);
  (a === b ? same : diff).push({ k, a, b });
}
console.log(`\nComparison: ${SLUG} (old = blog/editor, new = Irori, same Chrome engine)\n`);
console.log(`  ✓ ${same.length} matching: ${same.map((x) => x.k).join(', ')}`);
if (diff.length) {
  console.log(`\n  ✗ ${diff.length} differing:`);
  for (const d of diff) console.log(`     ${d.k}\n        old ${d.a}\n        new ${d.b}`);
  console.log('\n  Each one must either be fixed or recorded in docs/acceptance/deviations.md and approved.');
}
if (SHOTS) console.log(`\n  Screenshots: ${OUT}/legacy.png · ${OUT}/irori.png`);
process.exit(diff.length ? 1 : 0);
