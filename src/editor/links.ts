/* ⌘-click on a link (Ctrl-click on Windows and Linux) opens it in the browser — in running
   text, whether it shows collapsed or as source, and in a rendered table. A plain click still
   just places the caret, as it does everywhere else. While the key is held, links under the
   pointer look clickable. */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { linkAt } from './tokens';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
const withKey = (e: MouseEvent | KeyboardEvent) => (IS_MAC ? e.metaKey : e.ctrlKey);

/** Is this the click that opens a link? */
export const isOpenClick = (e: MouseEvent) => e.button === 0 && withKey(e);

let opener: (url: string) => void = () => {};
export function setLinkOpener(fn: (url: string) => void) {
  opener = fn;
}
export const openLink = (url: string) => opener(url);

export const linkClicks: Extension = [
  EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!isOpenClick(e) || !(e.target as HTMLElement).closest?.('.lnk')) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos);
      const url = linkAt(line.text, pos - line.from);
      if (!url) return false;
      e.preventDefault();
      opener(url);
      return true;
    },
    mousemove(e, view) {
      view.dom.classList.toggle('linkkey', withKey(e));
      return false;
    },
    keydown(e, view) {
      if (e.key === 'Meta' || e.key === 'Control') view.dom.classList.toggle('linkkey', withKey(e));
      return false;
    },
    keyup(e, view) {
      if (e.key === 'Meta' || e.key === 'Control') view.dom.classList.remove('linkkey');
      return false;
    },
    blur(_e, view) {
      view.dom.classList.remove('linkkey');
      return false;
    },
  }),
];
