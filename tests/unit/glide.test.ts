import { describe, expect, it } from 'vitest';
import { glideDuration, glideProfile, TAIL_MS } from '../../src/features/glide';

const LH = 39; // 19px × 2.05

describe('jump-scroll motion curve', () => {
  it('duration grows with lines crossed: user-set pacing within a page, capped at 500ms for one page', () => {
    expect(Math.round(glideDuration(1))).toBe(250);
    expect(Math.round(glideDuration(2))).toBe(350);
    expect(Math.round(glideDuration(4))).toBe(450);
    expect(Math.round(glideDuration(10))).toBe(500);
  });

  it('farther jumps get enough time: both ends need room for a visible start and finish so the middle is not a teleport', () => {
    expect(Math.round(glideDuration(20))).toBe(707);
    expect(Math.round(glideDuration(40))).toBe(1000);
    expect(Math.round(glideDuration(160))).toBe(1400);
    expect(Math.round(glideDuration(10000))).toBe(1400); // cap
    // Monotonic, never goes back, and continuous at the one-page mark
    let prev = 0;
    for (const l of [1, 2, 5, 10, 10.1, 20, 100, 1000]) {
      const d = glideDuration(l);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = d;
    }
  });

  it('starts from rest and accelerates (ease-in)', () => {
    const S = 40 * LH;
    const p = glideProfile(S, LH);
    expect(p.at(0)).toBe(0);
    // Barely moves in the first 10ms (does not "snap" away)
    expect(p.at(10) / S).toBeLessThan(0.005);
    // Speed increases over the first half of the head segment
    const v = (t: number) => p.at(t + 5) - p.at(t);
    expect(v(10)).toBeGreaterThan(v(0));
    expect(v(40)).toBeGreaterThan(v(10));
    expect(v(80)).toBeGreaterThan(v(40));
  });

  it('the tail decelerates and nearly stops by the last frame (ease-out)', () => {
    const p = glideProfile(40 * LH, LH);
    const v = (t: number) => p.at(t + 5) - p.at(t);
    expect(v(p.total - 200)).toBeGreaterThan(v(p.total - 100));
    expect(v(p.total - 100)).toBeGreaterThan(v(p.total - 20));
    expect(v(p.total - 10)).toBeLessThan(v(p.total - 200) / 5);
  });

  it('the finish is always the same: at equal time before the end, distance and speed match', () => {
    const far = glideProfile(40 * LH, LH);
    const mid = glideProfile(8 * LH, LH);
    const near = glideProfile(3 * LH, LH);

    // With τ ms left before the end, the remaining distance should be the same
    for (const tau of [250, 180, 120, 60, 20]) {
      const remain = (p: ReturnType<typeof glideProfile>, S: number) => S - p.at(p.total - tau);
      const a = remain(far, 40 * LH);
      const b = remain(mid, 8 * LH);
      const c = remain(near, 3 * LH);
      expect(Math.abs(a - b)).toBeLessThan(1);
      expect(Math.abs(a - c)).toBeLessThan(1);
    }
  });

  it('the tail segment always covers 1.2 lines in a fixed 250ms', () => {
    for (const lines of [3, 8, 20, 60]) {
      const S = lines * LH;
      const p = glideProfile(S, LH);
      const tail = S - p.at(p.total - TAIL_MS);
      expect(tail).toBeCloseTo(1.2 * LH, 0);
      expect(p.total - p.headMs).toBeCloseTo(TAIL_MS, 5);
    }
  });

  it('always moves forward monotonically, never overshoots and comes back', () => {
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

  it('long distances have three segments: 250ms start / middle / 250ms finish, with start and finish symmetric', () => {
    const S = 60 * LH;
    const p = glideProfile(S, LH);
    const ramp = 1.2 * LH;
    // Start segment: covers 1.2 lines in the first 250ms, accelerating from zero
    expect(p.at(250)).toBeCloseTo(ramp, 0);
    expect(p.at(125) / ramp).toBeCloseTo(0.25, 1); // x² curve: half the time covers a quarter of the distance
    // Finish segment: the last 250ms also covers 1.2 lines
    expect(S - p.at(p.total - 250)).toBeCloseTo(ramp, 0);
    // Both ends symmetric: distance covered in the start == distance covered in the finish
    expect(p.at(250)).toBeCloseTo(S - p.at(p.total - 250), 6);
    // Same speed at the handoffs
    const v = (t: number) => p.at(t + 1) - p.at(t);
    expect(v(249)).toBeCloseTo(v(p.total - 250), 1);
  });

  it('for long distances the middle is the fast part (the start is not a teleport)', () => {
    const S = 60 * LH;
    const p = glideProfile(S, LH);
    // The first 250ms covers only a small fraction of the total
    expect(p.at(250) / S).toBeLessThan(0.05);
    // Peak speed in the middle is far higher than in the start segment
    const v = (t: number) => p.at(t + 5) - p.at(t);
    expect(v(p.total / 2)).toBeGreaterThan(v(200) * 3);
  });

  it('crossing one line is entirely the tail segment (250ms, decelerating throughout)', () => {
    const p = glideProfile(LH, LH);
    expect(Math.round(p.total)).toBe(250);
    expect(p.headMs).toBe(0);
    expect(p.tailDistance).toBeCloseTo(LH, 6);
  });
});
