/* A click on a list item's task box ("- [ ] a") checks it: the blank between the brackets
   becomes an "x"; a click on a checked box ("[x]") clears it again. Only that one character
   changes, so the line stays plain markdown and undo takes it back. The caret stays put. */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { taskBox } from './tokens';

export const taskClicks: Extension = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || e.altKey || e.shiftKey || e.metaKey || e.ctrlKey) return false;
    const el = (e.target as HTMLElement).closest?.('.task');
    if (!el || view.state.readOnly) return false;
    const line = view.state.doc.lineAt(view.posAtDOM(el));
    const box = taskBox(line.text);
    if (!box) return false;
    e.preventDefault();
    const at = line.from + box.from + 1;
    view.dispatch({ changes: { from: at, to: at + 1, insert: box.done ? ' ' : 'x' }, userEvent: 'input.task' });
    return true;
  },
});
