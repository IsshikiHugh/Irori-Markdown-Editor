/* Two half-width spaces typed at the start of a paragraph → two full-width spaces (U+3000).

   Why: markdown eats leading ASCII spaces, so a Chinese paragraph's first-line indent
   never survives rendering; U+3000 does. Inside a fenced code block nothing is touched —
   code indentation must stay exactly as typed. Ported from the blog editor. */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';

const FENCE = /^\s{0,3}(```|~~~)/;

export function insideFence(state: EditorState, lineNo: number): boolean {
  let fences = 0;
  for (let n = 1; n < lineNo; n++) if (FENCE.test(state.doc.line(n).text)) fences++;
  return fences % 2 === 1;
}

export const IDEOGRAPHIC_SPACE = '　';

export const cjkIndent: Extension = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ' || from !== to) return false;
  const line = view.state.doc.lineAt(from);
  // only the very start of a line, and only as the SECOND space
  if (from !== line.from + 1 || line.text[0] !== ' ') return false;
  if (insideFence(view.state, line.number)) return false;
  view.dispatch({
    changes: { from: line.from, to: line.from + 1, insert: IDEOGRAPHIC_SPACE + IDEOGRAPHIC_SPACE },
    selection: { anchor: line.from + 2 },
    userEvent: 'input.type',
  });
  return true;
});
