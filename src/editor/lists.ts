/* Enter inside a list item starts the next item — the one piece of list editing that
   every markdown editor has and whose absence is felt on the second line.

   - on an item with text: split at the caret and open the next item (same indent, same
     bullet, or the number after this one);
   - on an empty nested item: step out one level, becoming the next sibling of its parent;
   - on an empty top-level item: the marker goes and the list ends there.

   Only the marker is ever inserted or removed; the rest of the line stays as typed. */

import type { EditorView } from '@codemirror/view';
import { listItem } from './tokens';
import type { ListItem } from './tokens';

const nextMarker = (li: ListItem) =>
  li.ordered ? String(parseInt(li.marker, 10) + 1) + li.marker.slice(-1) : li.marker;

export function continueList(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
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
