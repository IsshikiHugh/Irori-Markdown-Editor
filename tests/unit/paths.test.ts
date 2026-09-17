import { describe, expect, it } from 'vitest';
import { basename, dirname, resolveAgainst, sidecarDir, sidecarRef, stem, uniqueName } from '../../src/platform/paths';

describe('paths', () => {
  it('splits a path', () => {
    expect(dirname('/a/b/c.md')).toBe('/a/b');
    expect(basename('/a/b/c.md')).toBe('c.md');
    expect(stem('/a/b/c.md')).toBe('c');
    expect(stem('/a/b/c')).toBe('c');
  });

  it('puts images in a folder named after the document (v1 image strategy)', () => {
    expect(sidecarDir('/n/笔记.md')).toBe('/n/笔记');
    expect(sidecarRef('/n/笔记.md', 'a.png')).toBe('笔记/a.png');
  });

  it('resolves a markdown src against the document folder', () => {
    expect(resolveAgainst('/n/笔记.md', '笔记/a.png')).toBe('/n/笔记/a.png');
    expect(resolveAgainst('/n/笔记.md', './x.png')).toBe('/n/x.png');
    expect(resolveAgainst('/n/sub/笔记.md', '../up.png')).toBe('/n/up.png');
  });

  it('leaves remote and data urls alone', () => {
    expect(resolveAgainst('/n/a.md', 'https://x/y.png')).toBeNull();
    expect(resolveAgainst('/n/a.md', 'data:image/png;base64,AA')).toBeNull();
  });

  it('suffixes colliding names', () => {
    const taken = new Set(['a.png', 'a-1.png']);
    expect(uniqueName((n) => taken.has(n), 'a.png')).toBe('a-2.png');
    expect(uniqueName((n) => taken.has(n), 'b.png')).toBe('b.png');
  });
});
