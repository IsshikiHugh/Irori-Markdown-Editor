import { describe, expect, it } from 'vitest';
import { glideDuration, glideProfile, TAIL_MS } from '../../src/features/glide';

const LH = 39; // 19px × 2.05

describe('跳转滚动的运动曲线', () => {
  it('时长随跨越行数递进：一页以内按用户定的节奏，一页封顶 500ms', () => {
    expect(Math.round(glideDuration(1))).toBe(250);
    expect(Math.round(glideDuration(2))).toBe(350);
    expect(Math.round(glideDuration(4))).toBe(450);
    expect(Math.round(glideDuration(10))).toBe(500);
  });

  it('再远则给足时间：两头要容得下看得见的起步与收尾，中间才不至于是瞬移', () => {
    expect(Math.round(glideDuration(20))).toBe(707);
    expect(Math.round(glideDuration(40))).toBe(1000);
    expect(Math.round(glideDuration(160))).toBe(1400);
    expect(Math.round(glideDuration(10000))).toBe(1400); // 封顶
    // 单调不回头，且在一页处接得上
    let prev = 0;
    for (const l of [1, 2, 5, 10, 10.1, 20, 100, 1000]) {
      const d = glideDuration(l);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = d;
    }
  });

  it('起步是静止的，而且是加速起来的（渐入）', () => {
    const S = 40 * LH;
    const p = glideProfile(S, LH);
    expect(p.at(0)).toBe(0);
    // 头 10ms 几乎没动（不是「啪」地弹出去）
    expect(p.at(10) / S).toBeLessThan(0.005);
    // 头段前半程速度是递增的
    const v = (t: number) => p.at(t + 5) - p.at(t);
    expect(v(10)).toBeGreaterThan(v(0));
    expect(v(40)).toBeGreaterThan(v(10));
    expect(v(80)).toBeGreaterThan(v(40));
  });

  it('尾段是减速的，最后一帧几乎停住（渐出）', () => {
    const p = glideProfile(40 * LH, LH);
    const v = (t: number) => p.at(t + 5) - p.at(t);
    expect(v(p.total - 200)).toBeGreaterThan(v(p.total - 100));
    expect(v(p.total - 100)).toBeGreaterThan(v(p.total - 20));
    expect(v(p.total - 10)).toBeLessThan(v(p.total - 200) / 5);
  });

  it('收尾永远一样：距结束同样时间时，走过的距离与速度都一致', () => {
    const far = glideProfile(40 * LH, LH);
    const mid = glideProfile(8 * LH, LH);
    const near = glideProfile(3 * LH, LH);

    // 「距结束还剩 τ 毫秒」时，剩余距离应当相同
    for (const tau of [250, 180, 120, 60, 20]) {
      const remain = (p: ReturnType<typeof glideProfile>, S: number) => S - p.at(p.total - tau);
      const a = remain(far, 40 * LH);
      const b = remain(mid, 8 * LH);
      const c = remain(near, 3 * LH);
      expect(Math.abs(a - b)).toBeLessThan(1);
      expect(Math.abs(a - c)).toBeLessThan(1);
    }
  });

  it('收尾段固定走 1.2 行、固定 250ms', () => {
    for (const lines of [3, 8, 20, 60]) {
      const S = lines * LH;
      const p = glideProfile(S, LH);
      const tail = S - p.at(p.total - TAIL_MS);
      expect(tail).toBeCloseTo(1.2 * LH, 0);
      expect(p.total - p.headMs).toBeCloseTo(TAIL_MS, 5);
    }
  });

  it('始终单调向前，不会先冲过头再退回来', () => {
    for (const lines of [1, 1.5, 2, 3, 5, 10, 40, 200]) {
      const S = lines * LH;
      const p = glideProfile(S, LH);
      let prev = -1;
      for (let t = 0; t <= p.total; t += 5) {
        const v = p.at(t);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
      expect(p.at(p.total)).toBeCloseTo(S, 6);
    }
  });

  it('远距离是三段：起步 250ms / 中段 / 收尾 250ms，起步与收尾对称', () => {
    const S = 60 * LH;
    const p = glideProfile(S, LH);
    const ramp = 1.2 * LH;
    // 起步段：前 250ms 走 1.2 行，且是从零加速起来的
    expect(p.at(250)).toBeCloseTo(ramp, 0);
    expect(p.at(125) / ramp).toBeCloseTo(0.25, 1); // x² 曲线：一半时间走四分之一
    // 收尾段：最后 250ms 同样走 1.2 行
    expect(S - p.at(p.total - 250)).toBeCloseTo(ramp, 0);
    // 两头对称：起步走过的距离 == 收尾走过的距离
    expect(p.at(250)).toBeCloseTo(S - p.at(p.total - 250), 6);
    // 交接速度相同
    const v = (t: number) => p.at(t + 1) - p.at(t);
    expect(v(249)).toBeCloseTo(v(p.total - 250), 1);
  });

  it('远距离的中段才是快的那一段（起步不是瞬移）', () => {
    const S = 60 * LH;
    const p = glideProfile(S, LH);
    // 前 250ms 只走了全程的很小一部分
    expect(p.at(250) / S).toBeLessThan(0.05);
    // 中段的峰值速度远高于起步段
    const v = (t: number) => p.at(t + 5) - p.at(t);
    expect(v(p.total / 2)).toBeGreaterThan(v(200) * 3);
  });

  it('跨一行时整段就是收尾段（250ms，全程减速）', () => {
    const p = glideProfile(LH, LH);
    expect(Math.round(p.total)).toBe(250);
    expect(p.headMs).toBe(0);
    expect(p.tailDistance).toBeCloseTo(LH, 6);
  });
});
