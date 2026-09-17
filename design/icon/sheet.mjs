/* 把 out/*.png 排成一张对照图：每个候选各出 256 / 64 / 32 三种尺寸（Dock、访达列表、菜单栏）。
 *   node design/icon/sheet.mjs            → out/finalists.png
 * 小尺寸是真正的取舍点：1024 上好看的笔画，到 32 上常常糊成一团。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../tests/e2e/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
// 定稿排在最前，后面是候选与上一版
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
