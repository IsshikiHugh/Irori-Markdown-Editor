/* 对照实验（ADR-0002 第三步 · 第一轮）：同一个 Chrome 引擎下，新编辑器 vs 旧编辑器。
 *
 * 这不是单元测试，而是「体验一致」的证据：同一篇文章，同一套几何与配色断言，两边各测一遍再比。
 * 旧编辑器（博客里那个）是基准，只读不改。
 *
 *   IRORI_LEGACY_BLOG=/path/to/blog node tests/compare/run.mjs --slug <文章的-slug>
 *   IRORI_LEGACY_BLOG=... node tests/compare/run.mjs --slug <文章的-slug> --shots
 *
 * 没有设 IRORI_LEGACY_BLOG 时直接跳过（CI 上没有那个仓库，这很正常）。
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
  console.log('› 跳过对照实验：未设置 IRORI_LEGACY_BLOG（指向旧编辑器所在的博客仓库）');
  process.exit(0);
}
if (!SLUG) {
  console.error('✗ 需要 --slug <文章的-slug>：拿博客里的哪一篇来比');
  process.exit(2);
}
if (!fs.existsSync(path.join(BLOG, 'editor/server.js'))) {
  console.error(`✗ ${BLOG} 里没有 editor/server.js —— IRORI_LEGACY_BLOG 应指向博客仓库根目录`);
  process.exit(2);
}

/* 旧编辑器跑在 source/_posts 的临时副本上，真实文章绝不被碰。 */
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
  throw new Error('旧编辑器没能启动');
};

/* 两边都测同一组东西。全部是「肉眼会注意到」的量。 */
const PROBE = `(() => {
  const rows = [...document.querySelectorAll(SELECTOR)];
  // 只比真正的文字段落：图片行（含「图片未找到」那种）在两边的 DOM 形态本来就不同（D-32）
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
  // 新编辑器是虚拟滚动的，视口外的行根本不存在 —— 所以对「某个类长什么样」这种问题，
  // 临时插一个空节点去量，两边问的就是同一个 CSS 规则，而不是碰运气看有没有渲染到。
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
    // 字体是否真的一样：量一段固定文字的实际宽度（族名可能不同，但字形度量必须一致）
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
    // 每个长段落占几行 —— 换行位置只要差一个字，这里就会变
    wraps: plain.slice(0, 6).map((r) => Math.round(r.getBoundingClientRect().height / lineH)),
  };
})()`;

const probe = (page, selector) => page.evaluate(PROBE.replace(/SELECTOR/g, JSON.stringify(selector)));

await up();
const post = await (await fetch(`http://127.0.0.1:${PORT}/api/posts/${encodeURIComponent(SLUG)}`)).json();
if (!post || !post.content) {
  console.error(`✗ 博客里没有 ${SLUG}`);
  legacy.kill();
  process.exit(2);
}

const { server, port } = await serveDist();
const browser = await launch();
browser.__base = `http://127.0.0.1:${port}`;

/* --- 旧 --- */
const old = await browser.newPage();
await old.setViewport({ width: 1440, height: 900 });
old.on('dialog', (d) => d.accept().catch(() => {}));
await old.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' });
await sleep(600);
await old.evaluate((s) => [...document.querySelectorAll('#listwrap .lrow')].find((r) => r.dataset.slug === s)?.click(), SLUG);
await sleep(1400);
const before = await probe(old, '#body .ln');

/* --- 新 --- 同一篇正文；图片路径按通用相对路径改写（Hexo 的「只写文件名」约定不兼容，见 D-08） */
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

/* --- 比 --- */
const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
const same = [];
const diff = [];
for (const k of keys) {
  let x = before[k];
  let y = after[k];
  // 虚拟滚动：新编辑器只渲染一屏，所以只比两边都有的那几段
  if (k === 'wraps' && Array.isArray(x) && Array.isArray(y)) {
    const n = Math.min(x.length, y.length);
    x = x.slice(0, n);
    y = y.slice(0, n);
  }
  const a = JSON.stringify(x);
  const b = JSON.stringify(y);
  (a === b ? same : diff).push({ k, a, b });
}
console.log(`\n对照：${SLUG}（旧 = blog/editor，新 = Irori，同一 Chrome 引擎）\n`);
console.log(`  ✓ 一致 ${same.length} 项：${same.map((x) => x.k).join(', ')}`);
if (diff.length) {
  console.log(`\n  ✗ 不一致 ${diff.length} 项：`);
  for (const d of diff) console.log(`     ${d.k}\n        旧 ${d.a}\n        新 ${d.b}`);
  console.log('\n  每一项要么修掉，要么写进 docs/acceptance/deviations.md 并获批准。');
}
if (SHOTS) console.log(`\n  截图：${OUT}/legacy.png · ${OUT}/irori.png`);
process.exit(diff.length ? 1 : 0);
