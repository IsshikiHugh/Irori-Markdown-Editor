/* 【已被取代】应用图标现在由 design/icon/appicon.gen.mjs 生成（等角投影的囲炉裏）。
   这里留作上一版扁平 # 图标的存档与候选对照。

   生成图标的 SVG 源。所有变体共用同一副「纸片」底座：macOS 图标网格（1024 画布、824 主体、
   100 边距）、连续圆角（超椭圆 n=5）、上浅下深的纸色渐变、一圈极淡的内描边、柔和投影。
   区别只在上面画什么。

   ── 图形的意思 ───────────────────────────────────────────────
   「囲炉裏（いろり）」是日式民居地板上那个方形的下沉火塘。「井」字画的就是它的井桁框
   （井桁纹本身也是一个很老的家纹），而这个「井」在 Markdown 里恰好就是 `#`。
   所以图标只有两层：淡下去的井桁框 = 一直都在的标记；框中央那点暖色 = 火，也是光标，
   是你正在写的地方。配色沿用应用本身：纸色底、#C3B7A4 的标记、#A27B5C 的暖褐。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

// 超椭圆（连续圆角），比 rx 圆角更像 macOS 的图标轮廓
function squircle(cx, cy, a, n = 5, steps = 256) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    const x = cx + a * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const y = cy + a * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}
const BODY = squircle(512, 512, 412);

const ACCENT = '#A27B5C';
const TOK = '#C3B7A4';

const base = (inner, extraDefs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FCF9F3"/>
      <stop offset="1" stop-color="#EFE6D8"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#5A3D22" flood-opacity="0.22"/>
    </filter>
    <clipPath id="clip"><path d="${BODY}"/></clipPath>
    ${extraDefs}
  </defs>
  <path d="${BODY}" fill="url(#paper)" filter="url(#shadow)"/>
  <g clip-path="url(#clip)">${inner}</g>
  <path d="${BODY}" fill="none" stroke="${ACCENT}" stroke-opacity="0.16" stroke-width="3"/>
</svg>`;

/* 井桁：两竖两横，中央围出一格火塘。
   half   —— 笔画从中心伸出多远（决定整个字的大小）
   gap    —— 中央那一格的半宽（决定火塘多大）
   w      —— 笔画粗细
   slant  —— 竖笔的倾斜量（0 = 正的井桁纹；>0 就更像 Markdown 里手写的 #）
   op     —— 整组的不透明度。注意是加在 <g> 上而不是每根线上：四个交叉点是两笔叠着的，
             用 stroke-opacity 会在那里叠出四块更深的方块。 */
const igeta = (stroke, { half = 232, gap = 92, w = 36, slant = 0, op = 1 } = {}) => `
    <g stroke="${stroke}" opacity="${op}" stroke-width="${w}" stroke-linecap="round" fill="none">
      <line x1="${512 - gap + slant}" y1="${512 - half}" x2="${512 - gap - slant}" y2="${512 + half}"/>
      <line x1="${512 + gap + slant}" y1="${512 - half}" x2="${512 + gap - slant}" y2="${512 + half}"/>
      <line x1="${512 - half}" y1="${512 - gap}" x2="${512 + half}" y2="${512 - gap}"/>
      <line x1="${512 - half}" y1="${512 + gap}" x2="${512 + half}" y2="${512 + gap}"/>
    </g>`;

/** 炉心的柔光。r 给到中央格子的对角线以外一点，四角才不会突然断掉。 */
const hearthGlow = (r = 200) => `<circle cx="512" cy="512" r="${r}" fill="url(#ember)"/>`;

const emberGrad = (op = 0.32) => `<radialGradient id="ember">
      <stop offset="0" stop-color="#C98A4E" stop-opacity="${op}"/>
      <stop offset="0.55" stop-color="${ACCENT}" stop-opacity="${(op * 0.32).toFixed(3)}"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>`;
const caretGrad = `<linearGradient id="caret" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#AF8868"/><stop offset="1" stop-color="#946E50"/></linearGradient>`;

/** 炉火：中央那格里的实体 + 外溢的光。深一号的橙（#C2702F）是整张图上唯一的高饱和色，
    32px 下也还认得出「中间有一点火」。 */
const fire = (kind) => {
  if (kind === 'square') return `<rect x="458" y="458" width="108" height="108" rx="30" fill="url(#fire)"/>`;
  if (kind === 'caret') return `<rect x="489" y="428" width="46" height="168" rx="23" fill="url(#fire)"/>`;
  return '';
};
const fireGrad = `<linearGradient id="fire" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#D2853B"/><stop offset="1" stop-color="#B25F27"/>
    </linearGradient>`;

const variants = {
  // A：暖褐木框 + 炉心一块烧着的炭。小尺寸下最稳：一个 # 加中间一点火
  'a-frame-ember': base(
    `${hearthGlow(210)}
    ${igeta(ACCENT, { op: 0.85 })}
    ${fire('square')}`,
    emberGrad(0.5) + fireGrad,
  ),
  // B：同样的框，炉心换成光标 —— 「你正在写的地方就是火」
  'b-frame-caret': base(
    `${hearthGlow(210)}
    ${igeta(ACCENT, { op: 0.85 })}
    ${fire('caret')}`,
    emberGrad(0.5) + fireGrad,
  ),
  // C：框退成标记色（源码装饰的「淡」），全部重量给炉火
  'c-pale-frame-ember': base(
    `${hearthGlow(215)}
    ${igeta(TOK)}
    ${fire('square')}`,
    emberGrad(0.55) + fireGrad,
  ),
  // D：框更细、字更大，火只剩一层光晕（最安静的一版）
  'd-quiet': base(
    `${hearthGlow(200)}
    ${igeta(ACCENT, { w: 30, half: 244, gap: 96, op: 0.8 })}
    <rect x="470" y="470" width="84" height="84" rx="24" fill="url(#fire)" fill-opacity="0.9"/>`,
    emberGrad(0.42) + fireGrad,
  ),
  // E：竖笔带倾斜 —— 离 Markdown 的 # 更近，离井桁纹更远
  'e-slant': base(
    `${hearthGlow(210)}
    ${igeta(ACCENT, { slant: 22, op: 0.85 })}
    ${fire('square')}`,
    emberGrad(0.5) + fireGrad,
  ),
  // 更早的「# 淡、光标浓」，只为并排比较时有个参照
  'prev-v011': base(
    `<g stroke="#BBAC96" stroke-width="32" stroke-linecap="round">
      <line x1="352" y1="392" x2="330" y2="632"/>
      <line x1="446" y1="392" x2="424" y2="632"/>
      <line x1="290" y1="472" x2="488" y2="472"/>
      <line x1="282" y1="556" x2="480" y2="556"/>
    </g>
    <rect x="596" y="352" width="42" height="320" rx="21" fill="url(#caret)"/>`,
    caretGrad,
  ),
};

fs.mkdirSync(path.join(here, 'out/variants'), { recursive: true });
for (const [name, svg] of Object.entries(variants)) {
  fs.writeFileSync(path.join(here, 'out/variants', name + '.svg'), svg);
  console.log('› out/variants/' + name + '.svg');
}

/* ---- 定稿 ----
   在 A 的基础上再磨一遍比例：框稍微收细一点点、炉心留出更明显的一圈余地（火不顶着框），
   光晕加到 32px 下也还能带出一点暖意。这一张就是 src-tauri/icons/ 的来源：
       node design/icon/gen.mjs && node design/icon/render.mjs out/irori.svg
       npx tauri icon design/icon/out/irori.png */
const FINAL = base(
  `${hearthGlow(224)}
    ${igeta(ACCENT, { w: 34, half: 236, gap: 94, op: 0.85 })}
    <rect x="462" y="462" width="100" height="100" rx="28" fill="url(#fire)"/>`,
  emberGrad(0.55) + fireGrad,
);
fs.writeFileSync(path.join(here, 'out/irori.svg'), FINAL);
console.log('› out/irori.svg（上一版定稿）');
