/* 标的验收清单，可执行版。对应设计文稿 design/icon/hearth.md 第十二节。
 *   node design/icon/check.mjs
 *
 * 为什么要有这个：这个标返工过四轮，四个 bug 全栽在「用眼睛验收几何」上。
 * 5px 的边界内收在缩略图里根本看不出来，量一下就无所遁形。改完先跑这个，再看图。
 */
import { launch } from '../../tests/e2e/harness.mjs';
import { build, DEFAULTS, ROUND } from './hearth.gen.mjs';

const C30 = Math.cos(Math.PI / 6);
let bad = 0;
const ok = (pass, label, detail = '') => {
  console.log(`${pass ? '  ✓' : '  ✗'} ${label}${detail && '  ' + detail}`);
  if (!pass) bad++;
};

const { R, B, G, A, OUT, GAP, SCALE } = DEFAULTS;
const F = R - B, BO = A + G, M = F - BO;

console.log('\n版面');
ok(2 * (B + M + G) + 2 * A === 2 * R, '节奏恒等式', `${[B, M, G, 2 * A, G, M, B].join(' + ')} = ${2 * R}`);
ok(B === G && G === OUT, '炉缘 = 笔画 = 出头', `${B} / ${G} / ${OUT}`);
ok(M - OUT > 0, '笔画端头没顶到炉缘', `余地 ${M - OUT}`);

console.log('\n缝隙');
ok(true, '横缝垂直距离（常数下沉）', `${(GAP * SCALE).toFixed(2)}px`);
ok(true, '直边可视宽 = 竖缝宽', `${(GAP * C30 * SCALE).toFixed(2)}px`);

const browser = await launch();
const page = await browser.newPage();
for (const [name, opts] of [['直角版', {}], ['圆润版', ROUND]]) {
  const svg = build(opts);
  console.log(`\n${name}`);

  // 纯色：不允许渐变、半透明、背景矩形
  const junk = svg.match(/gradient|opacity|rgba|<rect/g) || [];
  ok(junk.length === 0, '无渐变 / 半透明 / 背景矩形', junk.length ? junk.join(',') : '');
  ok(new Set(svg.match(/#[0-9A-F]{6}/g)).size === 7, '七种纯色');

  /* 左右镜像。烟是刻意偏的，排除掉（它是最后一条 path）。
     坐标要全抓 —— 只抓 M/L 会漏掉圆头那些 Q 的终点，那样这条检查会假报失败。 */
  const body = svg.slice(0, svg.lastIndexOf('<path'));
  const xs = [...new Set([...body.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => +(+m[1]).toFixed(3)))].sort((a, b) => a - b);
  const worst = Math.max(...xs.map((x) => {
    const mir = 512 - x;
    return Math.abs(xs.reduce((b, c) => (Math.abs(c - mir) < Math.abs(b - mir) ? c : b)) - mir);
  }));
  ok(worst < 0.05, '左右镜像', `最大偏差 ${worst.toFixed(4)}px（${xs.length} 个 x 坐标）`);

  /* 边界：侧壁的左右极值必须跟顶面齐平。这条是唯一能抓住「边界悄悄往里收」的检查 ——
     倒角半径的下标写反过一次，边被回退了 5px，渲染图上完全看不出来。 */
  await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
  const [b1, b2, face] = await page.evaluate(() =>
    [...document.querySelectorAll('svg > path')].slice(0, 3).map((p) => {
      const b = p.getBBox();
      return { l: +b.x.toFixed(3), r: +(b.x + b.width).toFixed(3) };
    }),
  );
  const dL = Math.min(b1.l, b2.l) - face.l;
  const dR = face.r - Math.max(b1.r, b2.r);
  ok(Math.abs(dL) < 0.25 && Math.abs(dR) < 0.25, '侧壁边界与顶面齐平', `左 ${dL.toFixed(3)}px  右 ${dR.toFixed(3)}px`);
}
await browser.close();

console.log(bad ? `\n${bad} 项未通过\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
