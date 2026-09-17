import { describe, expect, it } from 'vitest';
import { countText, formatCounts, plainText } from '../../src/features/wordcount';

describe('word count (generic: Chinese by character, English by word)', () => {
  it('counts Chinese characters', () => {
    expect(countText('你好世界').chars).toBe(4);
  });

  it('counts English words, not letters', () => {
    const c = countText('the quick brown fox');
    expect(c.words).toBe(4);
    expect(c.chars).toBe(0);
  });

  it('mixes both in one document', () => {
    const c = countText('这是 a mixed 句子');
    expect(c.chars).toBe(4);
    expect(c.words).toBe(2);
  });

  it('drops markup but keeps the words it wraps', () => {
    expect(countText('**粗体**').chars).toBe(2);
    expect(countText('[文字](https://example.com/very/long)').chars).toBe(2);
    expect(countText('![](img.png)').chars + countText('![](img.png)').words).toBe(0);
  });

  it('ignores punctuation and whitespace', () => {
    expect(countText('，。！\n\n  ').chars).toBe(0);
  });

  it('keeps code block bodies out of the fence markers', () => {
    expect(plainText('```js\ncode here\n```')).not.toContain('```');
    expect(countText('```js\ncode here\n```').words).toBe(2);
  });

  it('estimates reading time and never shows zero minutes for real text', () => {
    expect(countText('字').minutes).toBe(1);
    expect(countText('').minutes).toBe(0);
    expect(countText('四'.repeat(2000)).minutes).toBe(5);
  });

  it('formats what the drawer shows', () => {
    expect(formatCounts(countText(''))).toBe('—');
    expect(formatCounts({ chars: 1234, words: 0, minutes: 3 })).toBe('1,234 字 · 预计 3 分钟');
    expect(formatCounts({ chars: 10, words: 5, minutes: 1 })).toBe('10 字 · 5 词 · 预计 1 分钟');
  });
});
