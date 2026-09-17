/* 图标渲染：SVG 源 → 1024×1024 透明 PNG（用本机 Chromium 光栅化，保证抗锯齿与透明圆角）。
 *   node design/icon/render.mjs                 渲染 out/variants/*.svg 到 out/
 *   node design/icon/render.mjs irori.svg   只渲染一个，输出 out/<名字>.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../tests/e2e/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });

const only = process.argv[2];
const files = only
  ? [path.resolve(here, only)]
  : fs.readdirSync(path.join(here, 'out/variants')).filter((f) => f.endsWith('.svg')).sort().map((f) => path.join(here, 'out/variants', f));

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
for (const file of files) {
  const svg = fs.readFileSync(file, 'utf8');
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const name = path.basename(file, '.svg');
  await page.screenshot({ path: path.join(out, name + '.png'), omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
  console.log('› ' + name + '.png');
}
await browser.close();
