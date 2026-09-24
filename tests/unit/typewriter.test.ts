import { describe, expect, it } from 'vitest';
import { DEFAULT_FOLLOW_DELAY, MAX_FOLLOW_DELAY, clampAnchor, clampDelay, typewriterPads } from '../../src/features/typewriter';

describe('typewriter padding', () => {
  it('reserves the space above the anchor, and the space below it', () => {
    expect(typewriterPads(1000, 45)).toEqual({ top: 450, bottom: 550 });
    // the first line reaches the anchor at scrollTop 0, the last one at the very bottom
    const { top, bottom } = typewriterPads(800, 30);
    expect(top).toBe(240);
    expect(top + bottom).toBe(800);
  });

  it('never asks for negative space, however low the anchor sits', () => {
    expect(typewriterPads(300, 100).bottom).toBe(0);
  });
});

describe('typewriter anchor', () => {
  it('is left alone when focus mode is off', () => {
    expect(clampAnchor(90, null, 5)).toBe(90);
  });

  it('is pulled inside the focus band, a whole line clear of its edges', () => {
    const band = { top: 20, bottom: 80 };
    expect(clampAnchor(90, band, 6)).toBe(77);
    expect(clampAnchor(5, band, 6)).toBe(23);
    expect(clampAnchor(50, band, 6)).toBe(50);
  });

  it('falls back to the middle of a band too narrow for a line', () => {
    expect(clampAnchor(90, { top: 40, bottom: 44 }, 20)).toBe(42);
  });
});

describe('typewriter follow delay', () => {
  it('defaults to a quarter of a second', () => {
    expect(DEFAULT_FOLLOW_DELAY).toBe(250);
  });

  it('keeps what was typed, as whole milliseconds inside the range', () => {
    expect(clampDelay('100')).toBe(100);
    expect(clampDelay(0)).toBe(0);
    expect(clampDelay(99.6)).toBe(100);
    expect(clampDelay(-5)).toBe(0);
    expect(clampDelay('99999')).toBe(MAX_FOLLOW_DELAY);
  });

  it('falls back to the default when the field is not a number', () => {
    expect(clampDelay('')).toBe(0); // an empty field reads as 0: at once
    expect(clampDelay('abc')).toBe(DEFAULT_FOLLOW_DELAY);
    expect(clampDelay(undefined)).toBe(DEFAULT_FOLLOW_DELAY);
  });
});
