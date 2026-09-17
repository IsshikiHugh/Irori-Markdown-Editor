/* 所有「跳转式」滚动都走这里：目录点击、缩略图点击、专注模式把光标拉回聚焦带。

   三条要求决定了这里的曲线：

   1. **时长随跨越的行数递进**，而不是浏览器 `behavior:'smooth'` 那种不分远近的固定节奏。
      一页以内：1 行 250ms · 2 行 350ms · 4 行 450ms · 一页封顶 500ms。

   2. **收尾永远长一个样**。最后 250ms 固定走完 1.2 行、固定的减速曲线 —— 也就是说
      「距结束还有 t 毫秒」时的速度，跨 2 行和跨 40 行完全相同。不论跳多远，眼睛都能在
      最后那一段看清它是往哪个方向、以什么节奏停下来的。

   3. **起步也要看得见**。远距离时另有一段与收尾对称的起步段（250ms / 1.2 行 / 二次 ease-in），
      否则中段一快，整段看起来就像「瞬移了一下再慢慢停住」。

   于是：
       近距离（一页以内）两段 —— 从静止加速的三次 Hermite + 固定收尾；
       远距离三段 —— 固定起步 + 中段（三次 Hermite，两端速度都等于交接速度）+ 固定收尾。
   所有交接点速度连续，不会有一脚急刹。

   目标点每一帧重新解析：CodeMirror 对没渲染过的区域是估算行高的，滚过去的路上会被实测值
   修正 —— 目标写死的话，动画会在中途被那次修正顶到终点，落点还是错的。 */

import type { EditorView } from '@codemirror/view';

export const GLIDE_MIN = 250;
/** 一页（约 10 行）以内的上限 */
export const GLIDE_MAX = 500;
/** 再远也不会超过这个 —— 超长距离硬压在 500ms 里，正文是从眼前「糊」过去的，谈不上丝滑 */
export const GLIDE_MAX_FAR = 1400;
/** 起步段：和收尾段对称的固定一段（远距离才用得上） */
export const HEAD_MS = 250;
/** 收尾段的时长：固定不变，这是「渐出永远一致」的前提 */
export const TAIL_MS = 250;
/** 收尾段走过的距离，按行算 */
export const TAIL_LINES = 1.2;

export function glideDuration(lines: number): number {
  const l = Math.max(1, lines);
  // 一页以内：1 行 250ms、2 行 350ms、4 行 450ms，到 10 行封顶 500ms（用户定的节奏，原样保留）
  if (l <= 10) return Math.min(GLIDE_MAX, GLIDE_MIN + 100 * Math.log2(l));
  // 更远：给足时间，两头才容得下看得见的起步与收尾段（否则中间那段就是「瞬移」）
  return Math.min(GLIDE_MAX_FAR, GLIDE_MAX * Math.sqrt(l / 10));
}

export type GlideProfile = {
  /** 总时长 ms */
  total: number;
  /** 头段时长 ms（可能为 0：短跳只有收尾段） */
  headMs: number;
  /** 收尾段走过的距离 px */
  tailDistance: number;
  /** 交接处的速度 px/ms */
  joinSpeed: number;
  /** 已过 t 毫秒时走过的距离 px */
  at: (t: number) => number;
};

/** 纯函数，便于直接测：给定距离与行高，算出整条运动曲线。

    远距离（时间放得下两头的固定段时）是三段：
        起步 250ms / 1.2 行（二次 ease-in）→ 中段（三次 Hermite，两端速度都等于交接速度）
        → 收尾 250ms / 1.2 行（二次 ease-out）
    起步与收尾对称、且与跳多远无关，所以两头都看得清方向；中段才是「快」的部分。
    近距离（一页以内）时间不够摆三段，退回「从静止加速 + 固定收尾」的两段式，节奏与之前完全一致。 */
export function glideProfile(distance: number, lineHeight: number): GlideProfile {
  const S = Math.abs(distance);
  const total = glideDuration(S / lineHeight);
  const ramp = Math.min(TAIL_LINES * lineHeight, S / 2);

  if (total >= HEAD_MS + TAIL_MS + 60 && S > 2 * ramp + 1) {
    const midMs = total - HEAD_MS - TAIL_MS;
    const mid = S - 2 * ramp;
    const joinSpeed = (2 * ramp) / TAIL_MS;
    const m = (joinSpeed * midMs) / mid;
    const c3 = 2 * (m - 1);
    const c2 = 3 * (1 - m);
    const at = (t: number): number => {
      if (t <= 0) return 0;
      if (t >= total) return S;
      if (t < HEAD_MS) {
        const x = t / HEAD_MS;
        return ramp * x * x;
      }
      if (t < HEAD_MS + midMs) {
        const x = (t - HEAD_MS) / midMs;
        return ramp + mid * (c3 * x * x * x + c2 * x * x + m * x);
      }
      const x = (t - HEAD_MS - midMs) / TAIL_MS;
      return ramp + mid + ramp * (1 - (1 - x) * (1 - x));
    };
    return { total, headMs: HEAD_MS + midMs, tailDistance: ramp, joinSpeed, at };
  }

  const headMs = Math.max(0, total - TAIL_MS);
  let D = Math.min(S, TAIL_LINES * lineHeight);
  // 头段必须单调（不能先倒退再前进）。三次 Hermite 的末速度斜率 m = v_join·headMs/H，
  // m > 3 就会出现倒退 —— 真遇上就把收尾段的距离压一压。
  if (headMs > 0 && S - D > 0) {
    const m = ((2 * D) / TAIL_MS) * (headMs / (S - D));
    if (m > 3) D = (3 * TAIL_MS * S) / (2 * headMs + 3 * TAIL_MS);
  }
  const H = S - D;
  const joinSpeed = (2 * D) / TAIL_MS;
  const m = H > 0 ? (joinSpeed * headMs) / H : 0;
  const a = m - 2;
  const b = 3 - m;

  const at = (t: number): number => {
    if (t <= 0) return 0;
    if (t >= total) return S;
    if (t < headMs) {
      const x = t / headMs;
      return H * (a * x * x * x + b * x * x);
    }
    const x = (t - headMs) / TAIL_MS;
    return H + D * (1 - (1 - x) * (1 - x));
  };

  return { total, headMs, tailDistance: D, joinSpeed, at };
}

/** 上一次滑动的实际数据 —— 让「收尾恒定」这条可以被直接断言，而不是靠采样去猜。 */
export type GlideRun = {
  from: number;
  to: number;
  total: number;
  headMs: number;
  tailMs: number;
  /** 收尾段的起点与终点（两者之差就是收尾走过的距离） */
  tailFrom: number;
  tailTo: number;
};

export type Glide = {
  by: (delta: number) => void;
  to: (scrollTop: number | (() => number)) => void;
  cancel: () => void;
  running: () => boolean;
  duration: (lines: number) => number;
  profile: (distance: number, lineHeight?: number) => GlideProfile;
  lastRun: () => GlideRun | null;
};

export function createGlide(view: EditorView): Glide {
  let frame = 0;
  let last: GlideRun | null = null;

  function cancel() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function to(target: number | (() => number), depth = 0) {
    const el = view.scrollDOM;
    cancel();
    const resolve = () => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      return Math.max(0, Math.min(max, typeof target === 'function' ? target() : target));
    };
    const from = el.scrollTop;
    const dist = resolve() - from;
    if (Math.abs(dist) < 1) return;
    const dir = Math.sign(dist);
    const p = glideProfile(dist, view.defaultLineHeight || 39);
    const headDist0 = Math.abs(dist) - p.tailDistance;
    const start = performance.now();
    let tailFrom: number | null = null;
    let tailGoal = 0;
    let tailStart = 0;
    last = { from, to: resolve(), total: p.total, headMs: p.headMs, tailMs: TAIL_MS, tailFrom: NaN, tailTo: NaN };

    const step = (now: number) => {
      const t = now - start;

      if (tailFrom === null && t >= p.headMs) {
        // 进入收尾段：把目标定死，并把位置对齐到「距终点正好 D」的地方。
        // 这一下对齐最多几十像素，发生在高速段的末尾，看不出来；换来的是
        // **收尾那 250ms 永远走同样的距离、同样的减速曲线**，不论这次跳了多远。
        tailGoal = resolve();
        tailFrom = tailGoal - dir * p.tailDistance;
        tailStart = now;
        el.scrollTop = tailFrom;
        if (last) {
          last.tailFrom = tailFrom;
          last.tailTo = tailGoal;
          last.to = tailGoal;
        }
      }

      if (tailFrom === null) {
        // 头段：跟着目标走（CodeMirror 会在路上修正它对未渲染区域的高度估算），按比例伸缩
        const goal = resolve();
        const headNow = Math.max(0, Math.abs(goal - from) - p.tailDistance);
        const scale = headDist0 > 0 ? headNow / headDist0 : 0;
        el.scrollTop = from + dir * p.at(t) * scale;
        frame = requestAnimationFrame(step);
        return;
      }

      const x = Math.min(1, (now - tailStart) / TAIL_MS);
      el.scrollTop = tailFrom + (tailGoal - tailFrom) * (1 - (1 - x) * (1 - x));
      if (x >= 1) {
        cancel();
        // 落点复核：滚动途中 CodeMirror 还在测量没渲染过的区域，文档总高度会往上长，
        // 这一刻算出来的终点可能比出发时远（往文末跳时尤其明显 —— 表现就是「没滚到底」）。
        // 差得多就再补一程（补的那一程同样带固定收尾），最多三轮，避免来回追。
        const err = resolve() - el.scrollTop;
        if (Math.abs(err) > 2 && depth < 3) to(target, depth + 1);
        return;
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
  }

  return {
    by: (delta: number) => to(view.scrollDOM.scrollTop + delta),
    to,
    cancel,
    running: () => frame !== 0,
    lastRun: () => last,
    duration: glideDuration,
    profile: (distance: number, lineHeight = view.defaultLineHeight || 39) => glideProfile(distance, lineHeight),
  };
}
