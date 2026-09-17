/* The editor itself: a CodeMirror view configured to behave exactly like the blog
   editor's hand-written contenteditable — minus the hand-written parts.

   Everything that used to be a patch (custom caret, IME timing, undo stack, line
   copy/cut, arrow keys stepping into an image) is now either a CodeMirror primitive or
   a thin extension on top of one. That is the whole point of building on CodeMirror: the
   fragile, engine-dependent work happens in a core that is tested across engines, not here. */

import { EditorView, drawSelection, dropCursor, keymap, rectangularSelection } from '@codemirror/view';
import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel, closeSearchPanel } from '@codemirror/search';
import { sourceDecoration, setAssetResolver } from './decorations';
import type { AssetResolver } from './decorations';
import { imageNavKeymap } from './image-nav';
import { continueList } from './lists';

export type EditorHooks = {
  onChange: (doc: string) => void;
  /** called on every update (document or selection changed) — focus mode relies on it to bring
      the caret back into the band */
  onUpdate: (docChanged: boolean, selectionSet: boolean) => void;
  onSave: () => void;
  onImage: (file: File) => void;
  onToggleDrawer: () => void;
  onEscape: () => void;
  resolveAsset: AssetResolver;
};

const fontCompartment = new Compartment();

/** Wrap the selection in `mark` (⌘B / ⌘I), or drop empty markers at the caret. */
function wrapWith(mark: string) {
  return (view: EditorView): boolean => {
    const changes = view.state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: mark },
        { from: range.to, insert: mark },
      ],
      range: range.empty
        ? EditorSelection.cursor(range.from + mark.length)
        : EditorSelection.range(range.from + mark.length, range.to + mark.length),
    }));
    view.dispatch(changes, { scrollIntoView: true, userEvent: 'input' });
    return true;
  };
}

/* The caret: CodeMirror draws it, CSS breathes it. On every move we drop the animation
   for one frame so the bar is solid the instant it moves (the blog editor did the same
   by re-triggering its keyframes). */
const caretLife = ViewPluginCaret();
function ViewPluginCaret(): Extension {
  let timer: number | undefined;
  return EditorView.updateListener.of((u) => {
    if (!u.selectionSet && !u.docChanged) return;
    const el = u.view.dom;
    el.classList.add('caretmove');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('caretmove'), 90) as unknown as number;
  });
}

/* CodeMirror's own UI strings, in the app's language. (The search panel is the only
   piece of CodeMirror chrome this editor shows.) */
const zh: Extension = EditorState.phrases.of({
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全选',
  'match case': '区分大小写',
  regexp: '正则',
  'by word': '全词匹配',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'current match': '当前匹配',
  'replaced $ matches': '已替换 $ 处',
  'replaced match on line $': '已替换第 $ 行的匹配',
  'on line': '行',
});

/* IME: while composing, the native caret must exist for the input method to anchor its
   candidate window to. CodeMirror keeps the composition itself intact; we only swap
   which caret is visible. */
const imeClass: Extension = EditorView.domEventHandlers({
  compositionstart(_e, view) {
    view.dom.classList.add('ime');
  },
  compositionend(_e, view) {
    // one frame later: the IME is still finishing its cycle on this tick
    requestAnimationFrame(() => view.dom.classList.remove('ime'));
  },
});

export function createEditor(parent: HTMLElement, doc: string, hooks: EditorHooks): EditorView {
  setAssetResolver(hooks.resolveAsset);

  const imagePaste: Extension = EditorView.domEventHandlers({
    paste(e) {
      const img = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (!img) return false;
      e.preventDefault();
      const f = img.getAsFile();
      if (f) hooks.onImage(f);
      return true;
    },
    drop(e) {
      const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
      if (!f) return false;
      e.preventDefault();
      hooks.onImage(f);
      return true;
    },
    dragover(e) {
      if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault();
      return false;
    },
    // macOS remaps Shift+wheel to a horizontal delta; this editor has no horizontal
    // scroll, so send it back to the vertical axis (lets you wheel while shift-selecting)
    wheel(e, view) {
      if (!e.shiftKey) return false;
      const d = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return false;
      e.preventDefault();
      view.scrollDOM.scrollTop += d;
      return true;
    },
  });

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        EditorView.lineWrapping,
        history({ minDepth: 200, newGroupDelay: 350 }),
        // cursorBlinkRate: 0 — turns off CodeMirror's built-in hard on/off blink (steps(1) 1.2s).
        // That and our soft 1.15s breathing are two separate animations with slightly different
        // periods; layered, they drift further out of phase until, after a few blinks, it becomes a
        // "double blink". The caret's fade is left entirely to CSS (style.css: caretfade).
        drawSelection({ cursorBlinkRate: 0 }),
        dropCursor(),
        rectangularSelection(),
        search({ top: false }),
        zh,
        sourceDecoration,
        imeClass,
        imagePaste,
        caretLife,
        fontCompartment.of([]),
        keymap.of([
          ...imageNavKeymap,
          { key: 'Mod-s', preventDefault: true, run: () => (hooks.onSave(), true) },
          { key: 'Mod-\\', preventDefault: true, run: () => (hooks.onToggleDrawer(), true) },
          { key: 'Mod-b', preventDefault: true, run: wrapWith('**') },
          { key: 'Mod-i', preventDefault: true, run: wrapWith('*') },
          { key: 'Mod-f', preventDefault: true, run: openSearchPanel },
          { key: 'Enter', run: continueList },
          // historyKeymap only treats Ctrl-Y as redo on Windows; add ⌘⇧Z / Ctrl-Shift-Z so all three
          // platforms share one shortcut
          { key: 'Mod-Shift-z', preventDefault: true, run: redo },
          {
            key: 'Escape',
            run: (v) => {
              closeSearchPanel(v);
              hooks.onEscape();
              return true;
            },
          },
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) hooks.onChange(u.state.doc.toString());
          if (u.docChanged || u.selectionSet) hooks.onUpdate(u.docChanged, u.selectionSet);
        }),
        EditorState.allowMultipleSelections.of(false),
      ],
    }),
  });
  return view;
}

/** Swap the writing font without touching the document (settings). */
export function applyFont(view: EditorView, family: string) {
  document.body.style.setProperty('--font-body', family);
  view.dispatch({ effects: fontCompartment.reconfigure(EditorView.theme({ '.cm-content': { fontFamily: family } })) });
}
