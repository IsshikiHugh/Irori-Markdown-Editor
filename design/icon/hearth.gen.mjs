/* 「囲炉裏」立体标：等角投影下的方形火塘。
 *   node design/icon/hearth.gen.mjs && node design/icon/render.mjs out/hearth-round.svg
 *
 * 输出两版，共用同一套几何，差别只在两个圆角半径：
 *   out/hearth.svg        直角版（RS = RG = 0）
 *   out/hearth-round.svg  圆润版 ← 定稿
 * out/ 整个不进 git —— 一条命令就能重来的东西不该进版本库，发布用的副本在 assets/logo/。
 *
 * ── 为什么是生成的，不是画的 ────────────────────────────────
 * 这张图上所有「该等宽的」和「该对称的」都不靠眼力：炉缘的黑边、井桁的笔画、笔画到
 * 炉缘的留白，全部由下面一组世界坐标常量推出来，再过同一个等角投影。凹槽露出来的内壁
 * 也不是画上去的 —— 由开口多边形逐条边算出哪一面朝着镜头，只画那些。
 * 于是「透视关系」是算出来的结果，不是画出来的效果：改任何一个数，遮挡关系自己重排。
 *
 * ── 图形的意思 ───────────────────────────────────────────────
 * 外面一圈黑 = 炉缘（炉縁），也就是「囲」字外面那个口；
 * 里面四道凹槽 = 井桁框，也就是「囲」字里面那个井，同时是 Markdown 的 #；
 * 井字正中那一格再往下沉一层 = 火塘本身，亮着的是炭，升上来的是烟。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

/* ── 尺寸 ───────────────────────────────────────────────────
 * 世界坐标 = 俯视时的平面尺寸。沿着穿过中心的一条线看过去，从外到内是
 *
 *     炉缘 12 │ 留白 18 │ 笔画 12 │ 火塘 24 │ 笔画 12 │ 留白 18 │ 炉缘 12  = 108 = 2R
 *
 * 全部是 6 的整数倍。取 u = 6，从外到内就是 2u │ 3u │ 2u │ 4u │ 2u │ 3u │ 2u = 18u。
 * 该等宽的三样东西同为 2u：炉缘（「囲」外面那个口）、井桁笔画（里面那个井）、以及笔画
 * 越过交叉点的出头 —— 出头和笔画同长，「井」才读得出是四笔，而不是一圈带疙瘩的方环。
 * 火塘 4u 是唯一放大的那一格，因为它是主角；笔画端头离炉缘留 1u。
 * 留白 M 被出头和端头余地分掉：M = OUT + 余地，所以 OUT 一动，余地自己配平。 */
export const DEFAULTS = {
  R: 54, //   台面外沿半宽（= 9u）
  B: 12, //   炉缘黑边（2u）
  G: 12, //   井桁笔画宽度（2u）
  A: 12, //   中央火塘半宽（2u，火塘整格 4u）
  OUT: 12, // 笔画越过交叉点的出头（2u；端头离炉缘还剩 M - OUT = 1u）
  H: 24, //   台面厚度（向下挤出，4u）
  D1: 5, //   井桁凹槽深度
  D2: 6, //   火塘比凹槽再深的那一层
  RS: 0, //   台面外轮廓 / 顶面的圆角半径（世界单位，0 = 直角）
  RF: null, // 炉内地面的圆角半径；null = 取 RS - B（同心偏移），炉缘因此在角上也保持等宽
  RG: 0, //   井桁开口与火塘的圆角半径
  TIP: 1.5, // 左右两个尖角上圆弧的半径（屏幕像素）。切点落在距端点约 1.5×TIP 处，
  //          所以这个数不能大：7 就把尖角整个磨成了圆头，朝上的姿态全没了
  FIL: 5, //  竖缝两端等直角转角的圆头半径（屏幕像素）
  GAP: 5, //  台面各面之间的缝隙宽度（世界单位）。顶面与侧面之间让出这么高，
  //          近处那条竖棱左右各退 GAP/2 —— 两处缝在画面上的垂直宽度正好相等
  WMAX: 11.5, // 烟最粗处
  SPINE: null, // 烟的中轴线，默认见下
  SCALE: 2.08,
  CX: 256,
  CY: 280,
  SMOKE: null, // 烟的颜色，null = 编辑器的 --tok（源码标记色）
  FLOOR: null, // 炉内地面的颜色，null = 默认的炉灰色
  FIRE: true, // 中央那格烧不烧着；false = 只剩一个更深的坑
  BG: false, // 画不画纸色底；默认不画，底色留给使用方
};

/* 等角投影：+x 往右下、+y 往左下、+z 往上。镜头在 (+1,+1,+1) 方向，
   所以外法线与 (1,1,1) 点积为正的面才看得见 —— visibleWalls() 判的就是这个。 */
const C30 = Math.cos(Math.PI / 6);
const S30 = 0.5;

/* ── 配色 ───────────────────────────────────────────────────
 * 全是纯色：没有渐变，没有半透明，背景也不画 —— 底色留给使用方自己定。
 * 台面上下三个面共用同一个黑：立体感不再靠明暗差，而是靠面与面之间的缝隙（见 GAP）。
 * 只有凹槽内部还分两档明暗 —— 那不是接缝，那是「这里凹下去了」唯一的线索，
 * 换成缝隙就会漏出地面的纸色，看着像裂开而不是凹陷。 */
const INK = '#221C18'; //   台面：顶面和两个侧面同色
const FLOOR = '#F7F3EC'; // 炉内地面（炉灰）= 编辑器的 --paper
const GROOVE = '#231A15'; //凹槽底
const GWALL = '#33271F'; // 凹槽内壁
const PWALL = '#7E3D14'; // 火塘内壁，被炭从下面照着
const EMBER = '#F0A44B'; // 炭火（原来那圈高亮渐变的中段，取成一个平色）
/* 烟取编辑器的 --tok（#C3B7A4）—— 正文里那些「淡下去的」源码标记就是这个颜色，
   于是升起来的这道烟和你正在写的 # 是同一档灰。
   本来想用 --paper(#F7F3EC)，但那样标放到编辑器自己的底色上，出了炉缘的那一截烟
   会整根消失 —— 同色。--tok 比纸色深两档，在纸色底、白底、炉缘上都看得见。 */
const SMOKE = '#C3B7A4';

/* 烟：起笔在炭火正中，一个长右弯、一个左回锋，收笔勾一下。中轴线由三次贝塞尔串起来，
   每个拐点处切线竖直，S 形因此是连续曲率的；粗细由 width() 单独给，两端归零才收得出尖。
   左右换边刻意安排在 y≈-65，也就是越过炉缘最远那个角（y = -R = -54）之后 ——
   否则烟正好骑在那个角上，看着像被戳穿了。 */
const SPINE = [
  [0, 7],
  [0, -17], [13, -19], [13, -45],
  [13, -64], [-10, -66], [-10, -85],
  [-10, -93], [-4, -99], [3, -96],
];

/* ── 圆角：在世界平面里磨，不是在画面上磨 ────────────────────
   一开始我图省事直接对投影后的多边形倒角，结果台面顶面和侧面各磨各的，左右两个角
   上侧面支出一块黑 —— 因为顶面那个角是 60°、轮廓那个角是 150°，同一个半径磨出来
   的弧根本对不上。圆角必须发生在投影之前：把平面上的方角换成圆弧、采样成折线，
   再整条送进投影。这样顶面、侧面、遮挡边界全部自动一致。

   采样密度按半径走：弦高误差压在 0.1 个世界单位以内，肉眼看不出是折线。 */
function roundPlan(pts, r) {
  if (!(r > 0)) return pts;
  const m = pts.length;
  const out = [];
  for (let i = 0; i < m; i++) {
    const [x0, y0] = pts[(i - 1 + m) % m];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % m];
    const l1 = Math.hypot(x1 - x0, y1 - y0);
    const l2 = Math.hypot(x2 - x1, y2 - y1);
    const u1 = [(x0 - x1) / l1, (y0 - y1) / l1]; // 顶点指向前一个点
    const u2 = [(x2 - x1) / l2, (y2 - y1) / l2]; // 顶点指向后一个点
    const half = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))) / 2;
    // 沿边回退 t = r/tan(半角)：等角投影下角有 60° 也有 120°，固定回退量会让两者一胖一瘦。
    // 另外不许超过邻边的一半，短边上的圆角自动收小，不会互相吃掉。
    const t = Math.min(r / Math.tan(half), l1 / 2, l2 / 2);
    const rr = t * Math.tan(half);
    if (!(rr > 1e-6)) { out.push([x1, y1]); continue; }
    // 圆心在两条边的角平分线上（凸角凹角通用：平分线总是指向该磨的那一侧）
    const bx = u1[0] + u2[0], by = u1[1] + u2[1];
    const bl = Math.hypot(bx, by) || 1;
    const cx = x1 + (bx / bl) * (rr / Math.sin(half));
    const cy = y1 + (by / bl) * (rr / Math.sin(half));
    const a0 = Math.atan2(y1 + u1[1] * t - cy, x1 + u1[0] * t - cx);
    let d = Math.atan2(y1 + u2[1] * t - cy, x1 + u2[0] * t - cx) - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const steps = Math.max(4, Math.min(18, Math.ceil(rr * 1.5)));
    for (let k = 0; k <= steps; k++) {
      const a = a0 + (d * k) / steps;
      out.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
  }
  return out;
}

/* 逐段算这一小段侧壁朝不朝着镜头。竖直墙面的法线没有 z 分量，所以「朝镜头」就是
   n·(1,1) > 0。solid 说明实心在多边形的哪一侧：台面是实心在里（法线朝外），
   凹槽是实心在外（法线朝内）。绕向由带符号面积定，所以顶点怎么排都不影响结论。
   返回连续的若干段，并按法线偏 +x 还是偏 +y 分开 —— 这两侧的明暗不一样。 */
function wallRuns(pts, solid, split = false) {
  const m = pts.length;
  let area = 0;
  for (let i = 0; i < m; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % m];
    area += x1 * y2 - x2 * y1;
  }
  const sgn = (area > 0 ? 1 : -1) * (solid ? 1 : -1);
  const seg = pts.map((a, i) => {
    const b = pts[(i + 1) % m];
    const nx = sgn * (b[1] - a[1]);
    const ny = -sgn * (b[0] - a[0]);
    return { vis: nx + ny > 1e-9, x: nx > ny };
  });
  // split 时按法线偏 +x 还是偏 +y 再切一刀 —— 切口正好落在最近的那条棱上。
  // 不切的话一段连续侧壁就是一条路径，同色相邻不会留下抗锯齿的接缝。
  const key = (k) => (seg[k].vis ? (split ? (seg[k].x ? 'x' : 'y') : 'v') : '-');
  let s0 = 0;
  while (s0 < m && key(s0) === key((s0 - 1 + m) % m)) s0++; // 从一个分界处起步，别把环形的一段劈成两半
  if (s0 >= m) s0 = 0;
  const runs = [];
  for (let k = 0; k < m; ) {
    const i = (s0 + k) % m;
    let len = 1;
    while (k + len < m && key((s0 + k + len) % m) === key(i)) len++;
    if (seg[i].vis) {
      runs.push({
        start: i,
        len,
        head: seg[(i - 1 + m) % m].vis, // 上游也可见 → 这一端是切口，要退开留缝
        tail: seg[(i + len) % m].vis,
      });
    }
    k += len;
  }
  return runs;
}

/** 沿折线按弧长回退首尾各一段。 */
function trimArc(list, head, tail) {
  const cut = (pts, want) => {
    if (!(want > 0)) return pts;
    let rest = want;
    const out = pts.slice();
    // 注意 length === 2 也要能裁 —— 端面就是两个点的直线段，早先这里写成 length > 2，
    // 结果端面从没被裁过，那几个直角的圆头一次都没生效
    while (out.length >= 2) {
      const d = Math.hypot(out[1][0] - out[0][0], out[1][1] - out[0][1]);
      if (d > rest) {
        const t = rest / d;
        out[0] = [out[0][0] + (out[1][0] - out[0][0]) * t, out[0][1] + (out[1][1] - out[0][1]) * t];
        return out;
      }
      if (out.length === 2) return out; // 再裁就没有段了
      rest -= d;
      out.shift();
    }
    return out;
  };
  // reverse() 是原地的：cut(list, 0) 会把原数组原样返回，再 .reverse() 就把调用方的
  // 数组翻了面。裁剪结果看着没事，但调用方后面再拿 list[last] 就取到了另一头 ——
  // 侧壁上那根刺就是这么来的（FIL=0 时翻两次正好抵消，所以只在倒角开着时露出来）。
  const rev = (a) => a.slice().reverse();
  return rev(cut(rev(cut(list, head)), tail));
}

/* 从折线的一端往里退，直到**屏幕横向**位移达到 want。
   原来是按弧长退的，直边上没问题，可一磨圆就错了：近角上那条竖缝由两个端点的
   屏幕横坐标决定，而屏幕横坐标只跟 (x - y) 有关。沿直边退 c，(x-y) 正好变 c；
   沿半径 rr 的圆弧退同样的 c，(x-y) 却变了 √2·c —— 缝於是宽了 41%，
   正好是你圈出来的那一处。所以退让必须按 (x - y) 量，跟直边圆角无关。 */
function trimDelta(list, head, tail) {
  const key = ([x, y]) => x - y;
  const cut = (pts, want) => {
    if (!(want > 0)) return pts;
    const k0 = key(pts[0]);
    const out = pts.slice();
    while (out.length > 2) {
      const d0 = Math.abs(key(out[0]) - k0);
      const d1 = Math.abs(key(out[1]) - k0);
      if (d1 >= want) {
        const t = d1 > d0 ? (want - d0) / (d1 - d0) : 0;
        out[0] = [out[0][0] + (out[1][0] - out[0][0]) * t, out[0][1] + (out[1][1] - out[0][1]) * t];
        return out;
      }
      out.shift();
    }
    return out;
  };
  const rev = (a) => a.slice().reverse(); // 同上：不能原地翻转调用方的数组
  return rev(cut(rev(cut(list, head)), tail));
}

export function build(o = {}) {
  const { R, B, G, A, OUT, H, D1, D2, RS, RF, RG, GAP, TIP, FIL, WMAX, SCALE, CX, CY, BG } = { ...DEFAULTS, ...o };
  const spine = o.SPINE || SPINE;
  const smokeFill = o.SMOKE || SMOKE;
  const floorFill = o.FLOOR || FLOOR;
  const pitFill = o.FIRE === false ? GROOVE : (o.EMBER || EMBER);
  const pitWall = o.FIRE === false ? GWALL : PWALL;
  const F = R - B; //   炉内地面半宽
  // 圆角同心收缩：外圈半径 RS 的弧往里让 B，内圈就是 RS - B。不这么取的话，
  // 黑边在四个角上会比直边处窄一截 —— 等宽就破了。
  const rf = RF == null ? Math.max(0, RS - B) : RF;
  const BO = A + G; //  笔画外沿
  const M = F - BO; //  每侧留白
  const E = BO + OUT; //笔画伸出的半长
  if (OUT >= M) throw new Error(`笔画顶到炉缘了：OUT(${OUT}) 必须小于留白 M(${M})`);

  const px = (x, y) => CX + SCALE * (x - y) * C30;
  const py = (x, y, z = 0) => CY + SCALE * ((x + y) * S30 - z);
  const n = (v) => String(Math.round(v * 100) / 100);
  const pt = ([x, y], z) => `${n(px(x, y))},${n(py(x, y, z))}`;
  /** 一圈平面折线投影到某个高度，拼成闭合 path。 */
  const face = (pts, z = 0) => 'M' + pts.map((p) => pt(p, z)).join('L') + 'Z';
  /** 取出一段 run 对应的折线；gap 为真时把挨着别的 run 的那一端退开 GAP/2。 */
  const runPts = (ring, run, gap) => {
    const list = [];
    for (let k = 0; k <= run.len; k++) list.push(ring[(run.start + k) % ring.length]);
    // 只裁切口那一端（按 x-y 退 GAP/2，竖缝宽度由此定死）。自由端不动 —— 边界要留在原处。
    return gap ? trimDelta(list, run.head ? GAP / 2 : 0, run.tail ? GAP / 2 : 0) : list;
  };
  /** 一段侧壁：上缘走过去、下缘走回来。曲的直的一视同仁。 */
  const band = (list, z, d) =>
    'M' + list.map((p) => pt(p, z)).concat(list.slice().reverse().map((p) => pt(p, z - d))).join('L') + 'Z';

  /* 缝在画面上的宽度（垂直于缝量）。竖缝那道由 x-y 的退让直接定死在这个值上，
     横着那道则是侧壁整体下沉 GAP 的结果 —— 直边上正好也是这个值。 */
  const GW = C30 * SCALE * GAP;

  /* 侧壁的端面。左右两个尖角上原来是针状的：端面竖直，上缘在那里的切线也正好竖直
     —— 等角投影里轮廓的侧影点就定义在「切线转成竖直」的那一刻，两条边於是几乎平行地
     碰头，夹角接近零。

     这种角不能靠倒角处理（半径 r 的倒角要沿边回退 r/tan(半角)，半角趋零时发散），
     得**补一段与两边都相切的圆弧**。圆心取在距端面 r 处（横坐标 x0 + r），沿上缘找到
     切点 Q，圆弧从端面上的切点 A 转到 Q。因为圆心横坐标恰好是 x0 + r，A 就是圆的最左点
     —— 也就是说圆头的最左端仍然落在 x0 这条线上，**边界一点没往里收**，收的只是
     针尖那一小撮面积。 */
  const seglen = (sg) => sg.reduce((a, _, i) => (i ? a + Math.hypot(sg[i][0] - sg[i - 1][0], sg[i][1] - sg[i - 1][1]) : 0), 0);
  /** 曲线上第 i 点处的单位法线（屏幕坐标，y 朝下）。方向随遍历顺序翻转，所以调用方
      要自己决定正负 —— 见 roundTip 里那次一劳永逸的定向。 */
  const normalAt = (c, i) => {
    const a = c[Math.max(i - 1, 0)];
    const b = c[Math.min(i + 1, c.length - 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  };
  /** 给上缘的起点端补一个与端面相切的圆头，返回新的上缘（含弧上采样点）。 */
  const roundTip = (c, r) => {
    const x0 = c[0][0];
    const k = Math.min(10, c.length - 1);
    // 两件事一次定好，别靠切线在尖端的极限去猜（那里切线竖直，x 分量的正负没意义）：
    //   sgn  —— 侧壁往哪一侧铺开（左尖角 +1，右尖角 -1），看曲线走向哪边就行
    //   flip —— 法线要不要取反才指向侧壁内部（内部总在上缘下方，取 y > 0 的那个）
    const sgn = Math.sign(c[k][0] - x0) || 1;
    const flip = normalAt(c, k)[1] < 0;
    const inw = (i) => {
      const n = normalAt(c, i);
      return flip ? [-n[0], -n[1]] : n;
    };
    const f = (i) => sgn * (c[i][0] + r * inw(i)[0] - x0 - sgn * r); // 圆心横坐标是否已到 x0 + sgn·r
    let i = 1;
    while (i < c.length - 2 && f(i) < 0) i++;
    if (f(i) < 0) return c; // 这一段太短，放弃圆头
    const w = f(i) - f(i - 1) ? -f(i - 1) / (f(i) - f(i - 1)) : 0; // 在 i-1..i 之间插到切点
    const Q = [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * w, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * w];
    const nq = inw(i);
    const C = [Q[0] + r * nq[0], Q[1] + r * nq[1]];
    const a0 = sgn > 0 ? Math.PI : 0; // A：圆在端面那一侧的极点，横坐标正好还是 x0
    let d = Math.atan2(Q[1] - C[1], Q[0] - C[0]) - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const arc = [];
    for (let j = 0; j <= 8; j++) {
      const a = a0 + (d * j) / 8;
      arc.push([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)]);
    }
    return [...arc, ...c.slice(i)];
  };
  /** 把首尾相接的若干段拼成闭合 path；rs[i] 是第 i 段末尾那个接缝的圆头半径，0 = 不倒。 */
  const joinSegs = (segs, rs) => {
    const P = (q) => `${n(q[0])},${n(q[1])}`;
    const lens = segs.map(seglen);
    const r = rs.map((v, i) => Math.min(v, lens[i] / 2.2, lens[(i + 1) % segs.length] / 2.2));
    const cut = segs.map((sg, i) => trimArc(sg, r[(i - 1 + segs.length) % segs.length], r[i]));
    let d = `M${P(cut[0][0])}`;
    for (let i = 0; i < segs.length; i++) {
      d += 'L' + cut[i].slice(1).map(P).join('L');
      if (r[i] > 0.01) d += `Q${P(segs[i][segs[i].length - 1])} ${P(cut[(i + 1) % segs.length][0])}`;
      else d += `L${P(cut[(i + 1) % segs.length][0])}`;
    }
    return d + 'Z';
  };
  const slabBand = (list, freeHead, freeTail) => {
    const top = list.map((p) => [px(p[0], p[1]), py(p[0], p[1], -GAP)]);
    const bot = list.map((p) => [px(p[0], p[1]), py(p[0], p[1], -H)]);
    let upper = freeHead ? roundTip(top, TIP) : top;
    upper = freeTail ? roundTip(upper.slice().reverse(), TIP).reverse() : upper;
    const segs = [
      upper, //                                        上缘（两端已带圆头）
      [upper[upper.length - 1], bot[bot.length - 1]], // 尾端面
      bot.slice().reverse(), //                        下缘，尾 → 头
      [bot[0], upper[0]], //                           头端面
    ];
    /* 四个接缝的圆头半径，顺序跟 segs 对应：
         [0] 上缘→尾端面 = 尾部尖角   自由端已由圆弧相切收好，再倒角就会把边往里啃
         [1] 尾端面→下缘 = 尾部下角   实打实的直角，照常倒
         [2] 下缘→头端面 = 头部下角   同上
         [3] 头端面→上缘 = 头部尖角   同 [0]
       这里 [2][3] 一度写反，尖角於是被 FIL 回退了 5px —— 边界「还是往里收」就是这么来的。 */
    return joinSegs(segs, [freeTail ? 0 : FIL, FIL, FIL, freeHead ? 0 : FIL]);
  };

  const sq = (h) => [[-h, -h], [h, -h], [h, h], [-h, h]];

  /* 井桁凹槽的开口：四道笔画（两竖两横）与正中那一格并成一个连通的多边形，边界二十八个角。
     只写出四分之一，剩下的绕原点转 90° 生成 —— 四向对称由此保证，不靠对齐眼力。 */
  const rot90 = ([x, y]) => [-y, x];
  const U = [];
  {
    let q = [[E, BO], [BO, BO], [BO, E], [A, E], [A, BO], [-A, BO], [-A, E]];
    for (let k = 0; k < 4; k++, q = q.map(rot90)) U.push(...q);
  }
  const PIT = sq(A);

  /* 烟：沿中轴线左右各偏移半个粗细，再用 Catmull-Rom 串成闭合曲线。 */
  const bez = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return [0, 1].map((i) => u ** 3 * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t ** 3 * p3[i]);
  };
  const spineAt = (t) => {
    const segs = (spine.length - 1) / 3;
    const s = Math.min(Math.floor(t * segs), segs - 1);
    return bez(spine[s * 3], spine[s * 3 + 1], spine[s * 3 + 2], spine[s * 3 + 3], t * segs - s);
  };
  // 两端为 0，峰值落在约 40% 处（起笔胀得比收笔快，才像在上升）
  const width = (t) => WMAX * Math.sin(Math.PI * t ** 0.75) ** 1.1;
  const smoothClosed = (pts) => {
    const m = pts.length;
    const at = (i) => pts[(i + m) % m];
    let d = `M${n(at(0)[0])},${n(at(0)[1])}`;
    for (let i = 0; i < m; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${n(c1[0])},${n(c1[1])} ${n(c2[0])},${n(c2[1])} ${n(p2[0])},${n(p2[1])}`;
    }
    return d + 'Z';
  };
  const smoke = (N = 46) => {
    const L = [], Rt = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = spineAt(t);
      const [qx, qy] = spineAt(Math.min(t + 1e-3, 1));
      const [rx, ry] = spineAt(Math.max(t - 1e-3, 0));
      const len = Math.hypot(qx - rx, qy - ry) || 1;
      const nx = -(qy - ry) / len, ny = (qx - rx) / len;
      const w = width(t) / 2;
      Rt.push([CX + SCALE * (p[0] + nx * w), CY + SCALE * (p[1] + ny * w)]);
      L.push([CX + SCALE * (p[0] - nx * w), CY + SCALE * (p[1] - ny * w)]);
    }
    // 两端粗细为 0，两侧在那里重合；去掉重合点才收得出真正的尖
    return smoothClosed([...Rt.slice(1, -1), ...L.reverse().slice(0, -1)]);
  };

  // 先把四条轮廓在平面里磨圆，之后所有投影、侧壁、遮挡都从这些折线来
  const slabRing = roundPlan(sq(R), RS);
  const floorRing = roundPlan(sq(F), rf);
  const openRing = roundPlan(U, RG);
  const pitRing = roundPlan(PIT, RG);
  const openD = face(openRing); //        井桁开口（z = 0）
  const pitD = face(pitRing, -D1); //     火塘坑口（z = -D1）


  // 画布跟 irori.svg 一致：1024 见方，坐标仍按 512 算（viewBox 缩放），render.mjs 才拍得满
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512" role="img" aria-label="囲炉裏">
  <defs>
    <clipPath id="open"><path d="${openD}"/></clipPath>
    <clipPath id="pit"><path d="${pitD}"/></clipPath>
  </defs>
${BG ? `\n  <rect id="bg" width="512" height="512" fill="#F4F0E6"/>\n` : ''}
  <!-- 台面：顶面和侧壁同一个黑，立体感全靠缝隙。侧壁整体下沉 GAP，顶面与侧面之间
       让出一道；侧壁又在最近那条棱上切开、左右各退 GAP/2（按 x-y 量，不按弧长 ——
       见 trimDelta），近角上多一道竖缝。两道缝在直边处等宽，都是 GAP·cos30。

       下沉量刻意取成常数，也就是缝的**垂直距离**处处相等。试过另外两种：按切线补偿
       让垂直于缝的宽度恒定，绕到左右两个尖角时补偿量会发散；再让它在尖角收到零，
       侧壁上缘就跟顶面轮廓合拢了 —— 缝在尖上被焊死，比不均匀更难看。
       常数下沉的代价只是近角那一小段缝宽出 15%（棱在那里转成水平），换来缝一路
       等高地绕过两个尖角、干净地收口。 -->
  ${wallRuns(slabRing, true, true).map((r) => `<path d="${slabBand(runPts(slabRing, r, true), !r.head, !r.tail)}" fill="${INK}"/>`).join('\n  ')}
  <path d="${face(slabRing)}" fill="${INK}"/>
  <path d="${face(floorRing)}" fill="${floorFill}"/>

  <!-- 井桁凹槽：开口内先整块铺槽底（开口下沉 D1），再把朝镜头的内壁盖到上缘 ——
       没被槽底盖住的那一圈正好就是内壁，不用另算。火塘是槽底上又一个凹坑，同样
       的办法再来一次。两层深度都只可能透过开口看见，所以不必逐面排序 ——
       剪裁本身就是遮挡关系，圆角改了它也自己跟着走。 -->
  <g clip-path="url(#open)">
    <path d="${face(openRing, -D1)}" fill="${GROOVE}"/>
    ${wallRuns(openRing, false).map((r) => `<path d="${band(runPts(openRing, r), 0, D1)}" fill="${GWALL}"/>`).join('\n    ')}
    <g clip-path="url(#pit)">
      <path d="${face(pitRing, -D1 - D2)}" fill="${pitFill}"/>
      ${wallRuns(pitRing, false).map((r) => `<path d="${band(runPts(pitRing, r), -D1, D2)}" fill="${pitWall}"/>`).join('\n      ')}
    </g>
  </g>

  <!-- 烟画在最后：它从炉心升起，比炉缘最远那个角离镜头更近，本来就该盖住它 -->
  <path d="${smoke()}" fill="${smokeFill}"/>
</svg>
`;
}

/* 圆润版：台面外圈 16（内圈自动取 16 - B = 4，炉缘因此在角上仍然等宽），
   井桁和火塘 3。再大井桁的笔画端头就开始发胖，四笔的结构会糊掉。 */
export const ROUND = { RS: 16, RG: 3 };

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.join(here, 'out');
  fs.mkdirSync(out, { recursive: true });
  for (const [file, opts] of [['hearth.svg', {}], ['hearth-round.svg', ROUND]]) {
    fs.writeFileSync(path.join(out, file), build(opts));
    console.log('› out/' + file);
  }
}
