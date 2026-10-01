/* ⌘A in two steps: inside a code block (or a math block), the first ⌘A selects what is between
   its fences — the code itself, ready to copy — and once exactly that is selected, ⌘A selects
   the whole document as usual. Anywhere else, or when the carets are spread over more than one
   block, it selects everything at once. */

import { EditorSelection } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { codeBlocks, inMath } from './decorations';

type Span = { from: number; to: number };

/** What is between the fences of the block line `n` (1-based) is in; null outside one, or when it is empty. */
function blockBody(state: EditorState, n: number): Span | null {
  const doc = state.doc;
  const code = codeBlocks(state).find((b) => n >= b.from && n <= b.to);
  if (code) {
    const last = code.closed ? code.to - 1 : code.to;
    if (last <= code.from) return null;
    return { from: doc.line(code.from + 1).from, to: doc.line(last).to };
  }
  const math = inMath(state, n);
  if (!math) return null;
  if (math.from === math.to) {
    // one line, $$tex$$: the TeX between the delimiters
    const line = doc.line(math.from);
    const a = line.text.indexOf('$$') + 2;
    const z = line.text.lastIndexOf('$$');
    return z > a ? { from: line.from + a, to: line.from + z } : null;
  }
  if (math.to - math.from < 2) return null;
  return { from: doc.line(math.from + 1).from, to: doc.line(math.to - 1).to };
}

export function selectBlockThenAll(view: EditorView): boolean {
  const state = view.state;
  const doc = state.doc;
  const ranges = state.selection.ranges;
  const body = blockBody(state, doc.lineAt(ranges[0].from).number);
  if (!body) return false;
  // every range must lie in this one block (fences included) for the first step to apply
  const owner = (pos: number) => blockBody(state, doc.lineAt(pos).number);
  const inside = ranges.every((r) => {
    const a = owner(r.from);
    const z = owner(r.to);
    return a && z && a.from === body.from && z.from === body.from;
  });
  if (!inside) return false;
  const main = state.selection.main;
  if (ranges.length === 1 && main.from === body.from && main.to === body.to) return false; // second ⌘A: everything
  view.dispatch({ selection: EditorSelection.single(body.from, body.to), userEvent: 'select' });
  return true;
}
