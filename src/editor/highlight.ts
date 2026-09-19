/* Syntax colouring inside fenced code blocks.

   The language comes from the fence (```ts, ```python, ```sh …), matched against CodeMirror's
   language list; each language's parser is loaded the first time a block asks for it, so a
   document without code never loads any. Until it has arrived the block shows plain, and the
   renderers are told (onLanguageLoaded) to draw it again. A block with no language, or one
   that is not known, stays plain.

   The whole block is parsed at once — a comment or a string may span lines — and the result
   is cut into per-line marks, so the editor, the minimap and the PDF all colour it the same. */

import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Parser } from '@lezer/common';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import type { Mark } from './tokens';

/** a parser once loaded (null: failed to load); `loads` holds the load while it is under way */
const parsers = new Map<LanguageDescription, Parser | null>();
const loads = new Map<LanguageDescription, Promise<void>>();
const listeners = new Set<() => void>();

/** Called whenever a language has finished loading; returns the unsubscribe. */
export function onLanguageLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The language a fence names (```ts → TypeScript), if CodeMirror knows it. */
export function fenceLanguage(openLine: string): LanguageDescription | null {
  const info = openLine.replace(/^ {0,3}(`+|~+)/, '').trim().split(/[\s{]/)[0];
  return info ? LanguageDescription.matchLanguageName(languages, info, false) : null;
}

function load(desc: LanguageDescription): Promise<void> {
  let pending = loads.get(desc);
  if (!pending) {
    pending = desc.load().then(
      (support) => {
        parsers.set(desc, support.language.parser);
        for (const fn of listeners) fn();
      },
      () => void parsers.set(desc, null),
    );
    loads.set(desc, pending);
  }
  return pending;
}

function parserFor(desc: LanguageDescription): Parser | null {
  if (!parsers.has(desc)) void load(desc);
  return parsers.get(desc) ?? null;
}

/** Load every language these opening fences name (the PDF waits for them before it lays out). */
export async function loadLanguages(openLines: string[]): Promise<void> {
  const wanted = new Set(openLines.map(fenceLanguage).filter((d): d is LanguageDescription => !!d));
  await Promise.all([...wanted].map(load));
}

/** recent results, so moving the caret does not re-parse every block on screen */
const cache = new Map<string, Mark[][]>();
const CACHE_MAX = 64;

/** Colour marks for each line of a block's body (offsets within its line), or null when the
    block has no known language or its parser has not arrived yet. */
export function highlightBlock(openLine: string, body: string[]): Mark[][] | null {
  const desc = fenceLanguage(openLine);
  const parser = desc && parserFor(desc);
  if (!desc || !parser) return null;
  const code = body.join('\n');
  const key = desc.name + '\0' + code;
  const hit = cache.get(key);
  if (hit) return hit;

  const out: Mark[][] = body.map(() => []);
  let li = 0;
  let start = 0; // where line `li` starts in `code`
  highlightTree(parser.parse(code), classHighlighter, (from, to, cls) => {
    // spans come in document order; one may cover several lines (a block comment)
    while (li < body.length - 1 && from > start + body[li].length) start += body[li++].length + 1;
    let [l, s] = [li, start];
    while (from < to && l < body.length) {
      const end = Math.min(to, s + body[l].length);
      if (end > from) out[l].push({ from: from - s, to: end - s, cls });
      from = s + body[l].length + 1;
      s = from;
      l++;
    }
  });
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}
