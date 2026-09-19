import { describe, expect, it } from 'vitest';
import { fenceLanguage, highlightBlock, loadLanguages } from '../../src/editor/highlight';

describe('code block colouring', () => {
  it('reads the language from the fence, aliases included', () => {
    expect(fenceLanguage('```ts')?.name).toBe('TypeScript');
    expect(fenceLanguage('~~~ python {.numberLines}')?.name).toBe('Python');
    expect(fenceLanguage('```')).toBeNull();
    expect(fenceLanguage('```没有这种语言')).toBeNull();
  });

  it('is plain until the language has loaded, then coloured per line', async () => {
    const body = ['/* 跨两行的', '   注释 */', 'const a = "字";'];
    expect(highlightBlock('```js', body)).toBeNull();
    await loadLanguages(['```js']);
    const marks = highlightBlock('```js', body)!;
    const at = (line: number, cls: string) =>
      marks[line].filter((m) => m.cls.includes(cls)).map((m) => body[line].slice(m.from, m.to));
    // a comment spanning lines is cut into one mark per line
    expect(at(0, 'tok-comment')).toEqual(['/* 跨两行的']);
    expect(at(1, 'tok-comment')).toEqual(['   注释 */']);
    expect(at(2, 'tok-keyword')).toEqual(['const']);
    expect(at(2, 'tok-string')).toEqual(['"字"']);
  });

  it('leaves an unknown language plain', async () => {
    await loadLanguages(['```nosuch']);
    expect(highlightBlock('```nosuch', ['x'])).toBeNull();
  });
});
