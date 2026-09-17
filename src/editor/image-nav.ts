/* Arrow keys must step ONTO an image line, not over it.

   A picture is a block widget that replaces its line, and CodeMirror's default vertical
   motion treats such a block as one opaque thing to jump past. The blog editor made a
   point of the opposite behaviour — "arrow keys walk into image lines" — because stepping
   in is how you edit the `![](…)` source. So these four commands run before the default
   keymap and place the caret inside the neighbouring image line when there is one. */

import type { KeyBinding } from '@codemirror/view';
import { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { imageLine } from './tokens';

const isImage = (state: EditorState, lineNo: number) =>
  lineNo >= 1 && lineNo <= state.doc.lines && !!imageLine(state.doc.line(lineNo).text);

/** Is the caret on the last (or first) visual row of its wrapped line?
    Measured by comparing visual rows, not box edges: with line-height 2.05 the caret is
    a good deal shorter than its line box, so an edge comparison would never match. */
function atEdge(view: EditorView, down: boolean): boolean {
  const head = view.state.selection.main.head;
  const here = view.coordsAtPos(head);
  const line = view.state.doc.lineAt(head);
  const edge = view.coordsAtPos(down ? line.to : line.from);
  if (!here || !edge) return true;
  return Math.abs(here.top - edge.top) < 2;
}

function step(view: EditorView, dir: 1 | -1, requireEdge: boolean): boolean {
  const state = view.state;
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
  const targetNo = line.number + dir;
  if (!isImage(state, targetNo)) return false;
  if (requireEdge && !atEdge(view, dir === 1)) return false;
  if (!requireEdge) {
    // horizontal motion: only at the very edge of the current line
    if (dir === 1 && range.head !== line.to) return false;
    if (dir === -1 && range.head !== line.from) return false;
  }
  const target = state.doc.line(targetNo);
  view.dispatch({
    selection: { anchor: dir === 1 ? target.from : target.to },
    scrollIntoView: true,
    userEvent: 'select',
  });
  return true;
}

export const imageNavKeymap: KeyBinding[] = [
  { key: 'ArrowDown', run: (v) => step(v, 1, true) },
  { key: 'ArrowUp', run: (v) => step(v, -1, true) },
  { key: 'ArrowRight', run: (v) => step(v, 1, false) },
  { key: 'ArrowLeft', run: (v) => step(v, -1, false) },
];
