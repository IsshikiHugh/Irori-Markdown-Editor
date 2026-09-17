/* Lays out out/*.png as one comparison sheet: each candidate at three sizes, 256 / 64 / 32 (Dock,
 * Finder list, menu bar).
 *   node design/icon/sheet.mjs            → out/finalists.png
 * The small sizes are where the real trade-offs are: strokes that look good at 1024 often blur into a blob at 32. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../tests/e2e/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
// The final goes first, followed by the candidates and the previous version
const names = fs
  .readdirSync(out)
  .filter((f) => f.endsWith('.png') && f !== 'finalists.png')
  .sort((a, b) => (a === 'irori.png' ? -1 : b === 'irori.png' ? 1 : a.localeCompare(b)));

const cell = (f) => {
  const src = 'data:image/png;base64,' + fs.readFileSync(path.join(out, f)).toString('base64');
  return `<div class="row">
    <div class="name">${path.basename(f, '.png')}</div>
    <img src="${src}" style="width:256px;height:256px">
    <img src="${src}" style="width:64px;height:64px">
    <img src="${src}" style="width:32px;height:32px">
  </div>`;
};

const html = `<!doctype html><html><body style="margin:0;background:#F7F3EC;font:13px -apple-system,sans-serif;color:#6D5D59">
<div style="display:flex;flex-direction:column;gap:28px;padding:36px">
  ${names.map(cell).join('')}
</div>
<style>
  .row{display:flex;align-items:center;gap:28px}
  .name{width:150px;text-align:right;opacity:.75}
  img{image-rendering:auto}
</style>
</body></html>`;

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 700, height: 200 * names.length, deviceScaleFactor: 2 });
await page.setContent(html);
await page.screenshot({ path: path.join(out, 'finalists.png'), fullPage: true });
await browser.close();
console.log('› out/finalists.png');
