/* Enter inside a list item starts the next item — the one piece of list editing that
   every markdown editor has and whose absence is felt on the second line.

   - on an item with text: split at the caret and open the next item (same indent, same
     bullet, or the number after this one);
   - on an empty nested item: step out one level, becoming the next sibling of its parent;
   - on an empty top-level item: the marker goes and the list ends there.

   Only the marker is ever inserted or removed; the rest of the line stays as typed. */

import type { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { listItem } from './tokens';
import { inCode } from './decorations';
import type { ListItem } from './tokens';

const nextMarker = (li: ListItem) =>
  li.ordered ? String(parseInt(li.marker, 10) + 1) + li.marker.slice(-1) : li.marker;

/** With several carets: each one on a list item continues its list, the others get a plain newline. */
function continueLists(view: EditorView): boolean {
  const { state } = view;
  const items = state.selection.ranges.map((r) => {
    const line = state.doc.lineAt(r.head);
    if (!r.empty || inCode(state, line.number)) return null;
    const li = listItem(line.text);
    if (!li) return null;
    const lead = li.indent.length + li.marker.length + li.gap.length;
    return r.head >= line.from + lead && line.text.slice(lead).trim() !== '' ? li : null;
  });
  if (!items.some(Boolean)) return false;
  let i = 0;
  const tr = state.changeByRange((r) => {
    const li = items[i++];
    const insert = '\n' + (li ? li.indent + nextMarker(li) + li.gap : '');
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length) };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: 'input' });
  return true;
}

export function continueList(view: EditorView): boolean {
  const { state } = view;
  if (state.selection.ranges.length > 1) return continueLists(view);
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
  if (inCode(state, line.number)) return false; // `- ` in a code block is code
  const li = listItem(line.text);
  if (!li) return false;
  const lead = li.indent.length + li.marker.length + li.gap.length;
  if (range.head < line.from + lead) return false; // caret inside the marker itself: a plain newline

  if (line.text.slice(lead).trim() === '') {
    let parent: ListItem | null = null;
    if (li.indent) {
      for (let n = line.number - 1; n >= 1; n--) {
        const text = state.doc.line(n).text;
        const up = listItem(text);
        if (up && up.indent.length < li.indent.length) {
          parent = up;
          break;
        }
        if (!up && /^[^ \t]/.test(text)) break; // left the list
      }
    }
    const insert = parent ? parent.indent + nextMarker(parent) + parent.gap : '';
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
      scrollIntoView: true,
      userEvent: 'input',
    });
    return true;
  }

  const insert = '\n' + li.indent + nextMarker(li) + li.gap;
  view.dispatch({
    changes: { from: range.head, insert },
    selection: { anchor: range.head + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}
