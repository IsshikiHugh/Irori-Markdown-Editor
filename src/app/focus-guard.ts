/* Keyboard focus and "scrolling works outside the text too" both exist to fight the host's default
   behavior and have nothing to do with writing itself, so they live apart from the assembly file.
   Both have bitten us before; the comments say how. */
import type { EditorView } from '@codemirror/view';
import type { Glide } from '../features/glide';

/** Installs the guards and returns the "hand focus back to the text" function — TOC clicks and
    the smoke probe both need it. */
export function installFocusGuard(view: EditorView, glide: Glide): { focusEditor: () => void } {
/* Wheel: areas outside the text (the blank TOC rail on the left, the minimap on the right, the top
   status bar) must scroll the text too. Regions that scroll themselves — drawer, TOC list, search
   panel — are let through. */
addEventListener(
  'wheel',
  (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('.cm-scroller,.drawer,.toc-inner,.cm-panels,.conflict')) return;
    const d = e.shiftKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    glide.cancel();
    view.scrollDOM.scrollTop += d;
  },
  { passive: false },
);

/* Keyboard focus: as soon as the window comes back to the foreground, hand focus back to the text;
   otherwise shortcuts only work after the user clicks once (right after the native window comes
   up, the webview may not be first responder yet). */
/** Hand focus back to the text, but **never move the scroll position**.
    WebKit scrolls the caret into view when it refocuses a contenteditable — so "one click in the
    drawer" would yank the text back to wherever the caret is. Chromium doesn't do this, so only
    code can guard against it. */
const focusEditor = () => {
  const top = view.scrollDOM.scrollTop;
  view.focus();
  if (view.scrollDOM.scrollTop !== top) view.scrollDOM.scrollTop = top;
  requestAnimationFrame(() => {
    if (!glide.running() && Math.abs(view.scrollDOM.scrollTop - top) > 1) view.scrollDOM.scrollTop = top;
  });
};

const refocus = () => {
  // don't steal focus while the drawer is open: the person is working the UI then, not writing
  if (document.body.classList.contains('menuopen')) return;
  const el = document.activeElement as HTMLElement | null;
  // someone is typing in another control (a setting, the search box, the conflict dialog): don't
  // steal focus
  if (el?.closest?.('input,textarea,select,button,.drawer,.cm-panels,.conflict')) return;
  // focus is on body/html, or on the editor's outer shell (the scroll container) → hand it back to
  // the text
  if (!el || el === document.body || el === document.documentElement) return focusEditor();
  if (view.dom.contains(el) && !view.contentDOM.contains(el)) focusEditor();
};
addEventListener('focus', refocus);
// focus left the text without landing on another control (a click on blank space, the native
// window taking focus away) → hand it back to the text
addEventListener('focusout', (e) => {
  if ((e as FocusEvent).relatedTarget) return;
  setTimeout(refocus, 0);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refocus();
});
addEventListener('mousedown', (e) => {
  const t = e.target as HTMLElement | null;
  // pressed inside the text → give way; pressing on the minimap doesn't count, since that press
  // has just started a glide
  if (t?.closest?.('.cm-scroller')) glide.cancel();
  if (t?.closest?.('input,textarea,.drawer,.cm-panels,.mini,.conflict,.toc-inner')) return;
  setTimeout(refocus, 0);
});

  return { focusEditor };
}
