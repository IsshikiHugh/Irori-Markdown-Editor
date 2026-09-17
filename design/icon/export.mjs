/* 把定稿导出到 assets/logo/ —— 那是给外面用的发布件，和 out/ 里的过程产物分开。
 *   node design/icon/export.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../tests/e2e/harness.mjs';
import { build, ROUND } from './hearth.gen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '../../assets/logo');
fs.mkdirSync(out, { recursive: true });

const svg = build(ROUND); // 圆润版 = 定稿
fs.writeFileSync(path.join(out, 'irori-logo.svg'), svg);
console.log('› assets/logo/irori-logo.svg');

const browser = await launch();
const page = await browser.newPage();
for (const px of [1024, 512, 256, 128, 64]) {
  await page.setViewport({ width: px, height: px, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;line-height:0">${svg.replace(/width="\d+" height="\d+"/, `width="${px}" height="${px}"`)}</body></html>`,
  );
  const file = `irori-logo-${px}.png`;
  await page.screenshot({ path: path.join(out, file), omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
  console.log('› assets/logo/' + file);
}
await browser.close();
