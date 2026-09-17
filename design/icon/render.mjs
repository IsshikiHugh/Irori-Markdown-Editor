/* Icon rendering: SVG source → 1024×1024 transparent PNG (rasterized with the local Chromium, which
 * guarantees proper anti-aliasing and transparent rounded corners).
 *   node design/icon/render.mjs                 render out/variants/*.svg into out/
 *   node design/icon/render.mjs irori.svg   render just one, writing out/<name>.png
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
