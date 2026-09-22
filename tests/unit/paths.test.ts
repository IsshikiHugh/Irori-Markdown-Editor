import { describe, expect, it } from 'vitest';
import { basename, dirname, imageDir, imageRef, relativeTo, resolveAgainst, safeFileName, stem, uniqueName } from '../../src/platform/paths';

describe('paths', () => {
  it('splits a path', () => {
    expect(dirname('/a/b/c.md')).toBe('/a/b');
    expect(basename('/a/b/c.md')).toBe('c.md');
    expect(stem('/a/b/c.md')).toBe('c');
    expect(stem('/a/b/c')).toBe('c');
  });

  it('puts images in a folder named after the document by default', () => {
    expect(imageDir('/n/笔记.md')).toBe('/n/笔记');
    expect(imageRef('/n/笔记.md', imageDir('/n/笔记.md'), 'a.png')).toBe('笔记/a.png');
  });

  it('takes the image folder from a template', () => {
    const at = (t: string) => {
      const dir = imageDir('/n/sub/笔记.md', t);
      return [dir, imageRef('/n/sub/笔记.md', dir, 'a.png')];
    };
    expect(at('assets')).toEqual(['/n/sub/assets', 'assets/a.png']);
    expect(at('assets/{name}/')).toEqual(['/n/sub/assets/笔记', 'assets/笔记/a.png']);
    expect(at('.')).toEqual(['/n/sub', 'a.png']);
    expect(at('../images')).toEqual(['/n/images', '../images/a.png']);
    expect(at('/pics/{name}')).toEqual(['/pics/笔记', '../../pics/笔记/a.png']);
    expect(at('  ')).toEqual(['/n/sub/笔记', '笔记/a.png']);
    expect(imageDir('C:\\docs\\a.md', 'img')).toBe('C:/docs/img');
  });

  it('writes a path relative to a folder, or absolute across drives', () => {
    expect(relativeTo('/a/b', '/a/b/c/x.png')).toBe('c/x.png');
    expect(relativeTo('/a/b', '/a/x.png')).toBe('../x.png');
    expect(relativeTo('C:/docs', 'D:/pics/x.png')).toBe('D:/pics/x.png');
    expect(relativeTo('C:/docs', 'C:/docs/x.png')).toBe('x.png');
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

  it('makes a pasted name safe to write and to link', () => {
    expect(safeFileName('截图 2026-09-22 (1).png')).toBe('截图-2026-09-22-1.png');
    expect(safeFileName('../../etc/passwd')).toBe('etcpasswd');
    expect(safeFileName('a\\b:c*?.PNG')).toBe('abc.PNG');
    expect(safeFileName('.hidden.png')).toBe('hidden.png');
    expect(safeFileName('CON.png')).toBe('img-CON.png');
    expect(safeFileName('...')).toBeNull();
    expect(safeFileName('x'.repeat(300) + '.png')).toBe('x'.repeat(100) + '.png');
  });

  it('suffixes colliding names', () => {
    const taken = new Set(['a.png', 'a-1.png']);
    expect(uniqueName((n) => taken.has(n), 'a.png')).toBe('a-2.png');
    expect(uniqueName((n) => taken.has(n), 'b.png')).toBe('b.png');
  });
});
