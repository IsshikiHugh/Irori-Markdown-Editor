import { describe, expect, it } from 'vitest';
import { clampAnchor, typewriterPads } from '../../src/features/typewriter';

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
