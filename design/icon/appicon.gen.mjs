/* macOS 应用图标：把定稿的「囲炉裏」标摆进一枚圆角纸片。
 *   node design/icon/appicon.gen.mjs && node design/icon/render.mjs out/irori-app.svg
 *   npm run tauri -- icon design/icon/out/irori-app.png
 *
 * 标本身（hearth.gen.mjs）是透明底的纯矢量，这里只负责「底座 + 定位」两件事：
 *
 *   底座 —— macOS 图标网格：1024 画布、824 主体、四周各留 100。圆角用超椭圆（n = 5）
 *           而不是 rx 圆角，这样曲率是连续的，跟系统自带图标的轮廓对得上。
 *           纸色沿用应用本身的底色，上浅下深一点点，再加一层柔和投影 —— 这是整张图
 *           唯一用到渐变和半透明的地方，属于平台惯例（Big Sur 之后的图标都有盘面纵深），
 *           标本身仍然是七种纯色。想要绝对平涂就把 PLATE_FLAT 打开。
 *
 *   定位 —— 标在自己的 512 画布里包围盒是 (78.3, 76.9, 355.3, 354.9)，几乎正方。
 *           把它等比放到 MARK 那么大、居中摆进盘面。clipPath 用的是 userSpaceOnUse，
 *           跟着外层 transform 一起变换，所以直接套 <g transform> 就行，不用改标的坐标。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, ROUND } from './hearth.gen.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));

const PLATE = 824; //   盘面边长（1024 画布，四周各留 100）
const MARK = 600; //    标的包围盒放到多大
const MARK_DY = 8; //   往下挪一点点：标的视觉重心（台面）比包围盒中心低，烟占了上半
const PLATE_FLAT = false; // true = 盘面平涂，不用渐变和投影

const PAPER_TOP = '#FCF9F3';
const PAPER_BOT = '#EFE6D8';
const ACCENT = '#A27B5C';

/** 超椭圆（连续圆角）。n 越大越方；5 接近 macOS 图标的轮廓。 */
function squircle(cx, cy, a, n = 5, steps = 256) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push(
      `${(cx + a * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(2)},` +
        `${(cy + a * Math.sign(s) * Math.abs(s) ** (2 / n)).toFixed(2)}`,
    );
  }
  return `M${pts.join('L')}Z`;
}

const mark = build(ROUND);
const defs = mark.slice(mark.indexOf('<defs>') + 6, mark.indexOf('</defs>')).trim();
const body = mark.slice(mark.indexOf('</defs>') + 7, mark.lastIndexOf('</svg>')).trim();

// 标的包围盒（512 空间），由 getBBox 量得，见设计文稿第十二节的验收清单
const BB = { x: 78.34, y: 76.9, w: 355.32, h: 354.9 };
const k = MARK / Math.max(BB.w, BB.h);
const tx = (1024 - BB.w * k) / 2 - BB.x * k;
const ty = (1024 - BB.h * k) / 2 - BB.y * k + MARK_DY;

const BODY = squircle(512, 512, PLATE / 2);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="Irori">
  <defs>
${PLATE_FLAT ? '' : `    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${PAPER_TOP}"/>
      <stop offset="1" stop-color="${PAPER_BOT}"/>
    </linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#5A3D22" flood-opacity="0.22"/>
    </filter>
`}    <clipPath id="plateclip"><path d="${BODY}"/></clipPath>
    ${defs}
  </defs>

  <!-- 盘面 -->
  <path d="${BODY}" fill="${PLATE_FLAT ? PAPER_TOP : 'url(#plate)'}"${PLATE_FLAT ? '' : ' filter="url(#drop)"'}/>

  <!-- 标。剪到盘面里，万一以后放大溢出也不会糊出边 -->
  <g clip-path="url(#plateclip)">
    <g transform="translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${k.toFixed(5)})">
      ${body}
    </g>
  </g>

  <!-- 一圈极淡的内描边，给盘面收个边 -->
  <path d="${BODY}" fill="none" stroke="${ACCENT}" stroke-opacity="0.16" stroke-width="3"/>
</svg>
`;

fs.mkdirSync(path.join(here, 'out'), { recursive: true });
fs.writeFileSync(path.join(here, 'out/irori-app.svg'), svg);
console.log('› out/irori-app.svg  （盘面 ' + PLATE + '，标 ' + MARK + '，缩放 ' + k.toFixed(3) + '）');
