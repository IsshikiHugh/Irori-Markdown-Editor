/* Several carets, the VS Code way.

   - ⌥-click adds a caret (⌥-drag adds a selection); ⌘-click stays "open the link" (links.ts).
   - A middle-button drag — or ⌥⇧-drag, for a trackpad — selects a column: dragged straight down
     it puts one caret on every line, dragged across it selects the same strip of every line.
   - Esc brings several carets back to one (index.ts).

   The column is measured in pixels, not characters: CodeMirror's own rectangular selection counts
   columns, which in proportional text (and next to CJK, twice as wide) lands each line's caret
   somewhere else than under the pointer. Here every line gets the positions straight below the
   two ends of the drag. Lines drawn as a picture, a table or a typeset formula are skipped — a
   caret there would turn them into source mid-drag and move every line below. */

import { EditorSelection, EditorState } from '@codemirror/state';
import type { Extension, SelectionRange } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { MouseSelectionStyle } from '@codemirror/view';
import { imageLine } from './tokens';
import { inCode, inMath, inTable } from './decorations';

const isColumnDrag = (e: MouseEvent) => e.button === 1 || (e.button === 0 && e.altKey && e.shiftKey);

/** a line shown as a picture, a table or a formula (while no caret is in it) */
function rendered(state: EditorState, n: number): boolean {
  return (!!imageLine(state.doc.line(n).text) && !inCode(state, n)) || !!inTable(state, n) || !!inMath(state, n);
}

function columnStyle(view: EditorView, start: MouseEvent): MouseSelectionStyle {
  const x0 = start.clientX;
  const y0 = start.clientY;
  const lineAtY = (x: number, y: number) => view.state.doc.lineAt(view.posAtCoords({ x, y }, false)).number;
  let first = lineAtY(x0, y0);
  return {
    update(u) {
      if (u.docChanged) first = u.state.doc.lineAt(u.changes.mapPos(u.startState.doc.line(first).from)).number;
    },
    get(cur) {
      const state = view.state;
      const doc = state.doc;
      const last = lineAtY(cur.clientX, cur.clientY);
      const ranges: SelectionRange[] = [];
      let main = 0;
      for (let n = Math.min(first, last); n <= Math.max(first, last); n++) {
        if (rendered(state, n) && n !== first && n !== last) continue;
        const line = doc.line(n);
        // the row to read the positions on: where the drag starts / ends, else the line's first row
        const blk = view.lineBlockAt(line.from);
        const y =
          n === first && n !== last
            ? y0
            : n === last
              ? cur.clientY
              : view.documentTop + blk.top + Math.min(blk.height, view.defaultLineHeight) / 2;
        const clamp = (p: number) => Math.max(line.from, Math.min(line.to, p));
        const a = clamp(view.posAtCoords({ x: x0, y }, false));
        const h = clamp(view.posAtCoords({ x: cur.clientX, y }, false));
        if (n === last) main = ranges.length;
        ranges.push(EditorSelection.range(a, h));
      }
      return ranges.length ? EditorSelection.create(ranges, main) : state.selection;
    },
  };
}

export const multiCursor: Extension = [
  EditorState.allowMultipleSelections.of(true),
  EditorView.clickAddsSelectionRange.of((e) => e.altKey && !e.shiftKey),
  EditorView.mouseSelectionStyle.of((view, e) => (isColumnDrag(e) ? columnStyle(view, e) : null)),
];
