/* Word count — a GENERIC count, on purpose.

   The blog editor reproduced hexo-symbols-count-time's odd definition (non-whitespace
   characters of the rendered HTML) so its number would match the published page. That
   target no longer exists, so this counts what a person means: Chinese by character,
   English by word. This is the one deliberate, pre-approved deviation from the old
   editor's behaviour (see docs/acceptance/deviations.md). */

const FENCE = /^\s*(```|~~~)/;

/** Strip the parts of markdown that render to nothing, keep the parts that become text. */
export function plainText(md: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/`+/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
    .replace(/\|/g, '')
    .replace(/<[^>]+>/g, '');
}

// CJK ideographs + kana + full-width punctuation are counted one by one.
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g;
const WORD = /[A-Za-z0-9À-ɏ]+(?:['’-][A-Za-z0-9À-ɏ]+)*/g;

export type Counts = { chars: number; words: number; minutes: number };

export function countText(md: string): Counts {
  const text = plainText(md);
  const chars = (text.match(CJK) || []).length;
  const words = (text.replace(CJK, ' ').match(WORD) || []).length;
  const minutes = chars + words === 0 ? 0 : Math.max(1, Math.round(chars / 400 + words / 200));
  return { chars, words, minutes };
}

export function formatCounts(c: Counts): string {
  if (!c.chars && !c.words) return '—';
  const parts: string[] = [];
  if (c.chars) parts.push(`${c.chars.toLocaleString('en-US')} 字`);
  if (c.words) parts.push(`${c.words.toLocaleString('en-US')} 词`);
  parts.push(`预计 ${c.minutes} 分钟`);
  return parts.join(' · ');
}
