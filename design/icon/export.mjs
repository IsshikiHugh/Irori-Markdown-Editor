/* Exports the final mark to assets/logo/ — the published copies for outside use, kept apart from the
 * intermediate output in out/.
 *   node design/icon/export.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../tests/e2e/harness.mjs';
import { build, ROUND, UNLIT, ANIMATED } from './hearth.gen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '../../assets/logo');
fs.mkdirSync(out, { recursive: true });

/* Three published files, all from the rounded (final) geometry:
     irori-logo.svg           the still mark, plus PNGs
     irori-logo-unlit.svg     the fire is out, plus PNGs
     irori-logo-animated.svg  embers breathe, smoke drifts — SVG only, since the animation is SMIL
                              inside the file; the still PNGs are its poster frames */
const browser = await launch();
const page = await browser.newPage();
for (const [name, opts, pngs] of [['irori-logo', ROUND, true], ['irori-logo-unlit', UNLIT, true], ['irori-logo-animated', ANIMATED, false]]) {
  const svg = build(opts);
  fs.writeFileSync(path.join(out, `${name}.svg`), svg);
  console.log(`› assets/logo/${name}.svg`);
  if (!pngs) continue;
  for (const px of [1024, 512, 256, 128, 64]) {
    await page.setViewport({ width: px, height: px, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;line-height:0">${svg.replace(/width="\d+" height="\d+"/, `width="${px}" height="${px}"`)}</body></html>`,
    );
    const file = `${name}-${px}.png`;
    await page.screenshot({ path: path.join(out, file), omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
    console.log('› assets/logo/' + file);
  }
}
await browser.close();
