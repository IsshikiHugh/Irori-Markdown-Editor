/* Rendering TeX for math blocks (and, in the PDF, inline math) with KaTeX.

   KaTeX and its stylesheet are loaded the first time something asks for a formula, as a
   chunk of their own, so a document without math never loads them. Until they have arrived
   renderMath() answers null — the renderers show the source meanwhile — and are told
   (onMathLoaded) to draw again. Opening a file with math waits for them first (mathReady),
   so its first paint is already typeset instead of flashing source and then reflowing.
   "Arrived" includes KaTeX's common fonts: typeset before they load, formulas would draw in
   fallback glyphs and change size a moment later. A formula KaTeX cannot parse renders as its source in red,
   never as an exception. */

type Katex = typeof import('katex').default;

let katex: Katex | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Called once KaTeX has arrived; returns the unsubscribe. */
export function onMathLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** the faces nearly every formula uses; the rarer ones (fraktur, script …) load on demand */
const FONTS = ['16px KaTeX_Main', 'italic 16px KaTeX_Math', '16px KaTeX_AMS', '16px KaTeX_Size1', '16px KaTeX_Size2', '16px KaTeX_Size3', '16px KaTeX_Size4'];

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Load KaTeX, its stylesheet and its common fonts (the PDF waits for it before it lays out). */
export function loadMath(): Promise<void> {
  loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
    async ([mod]) => {
      const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
      // a font that never arrives must not hold the formulas back for good
      if (fonts) await Promise.race([Promise.all(FONTS.map((f) => fonts.load(f).catch(() => []))), wait(1500)]);
      katex = mod.default;
      for (const fn of listeners) fn();
    },
    () => undefined,
  );
  return loading;
}

/** Before showing `text`: if it may hold math, have KaTeX ready (bounded, so a slow load only
    means a moment of source, never a window that does not open). */
export async function mathReady(text: string): Promise<void> {
  if (katex || !text.includes('$')) return;
  await Promise.race([loadMath(), wait(2000)]);
}

/** recent results, so moving the caret does not re-typeset every formula on screen */
const cache = new Map<string, string>();
const CACHE_MAX = 256;

/** A formula as HTML, or null while KaTeX is still loading. */
export function renderMath(tex: string, display: boolean): string | null {
  if (!katex) {
    void loadMath();
    return null;
  }
  const key = (display ? 'D' : 'I') + tex;
  const hit = cache.get(key);
  if (hit != null) return hit;
  const html = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
  return html;
}
