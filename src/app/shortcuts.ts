/* Window-level shortcuts. v1 has no menu bar, so these keys must work even when focus is **not**
   in the text — typing in the drawer's font field must not make ⌘S or Esc stop working. Keys the
   editor's own keymap already handled arrive here as defaultPrevented, so they never fire twice. */
import type { Platform } from '../platform/types';
import type { DocumentSession } from './document';

export type ShortcutDeps = {
  platform: Platform;
  doc: DocumentSession;
  toast: (msg: string) => void;
  /** puts the content into the buffer after a new file is opened */
  setBuffer: (text: string) => void;
};

export function installShortcuts({ platform, doc, toast, setBuffer }: ShortcutDeps): void {
/* ---------- window-level shortcuts (no menu bar in v1) ----------
   These also have to work when the focus is NOT in the editor — typing in the
   drawer's font field must not make ⌘S or Esc stop working. Anything the editor's
   own keymap already handled arrives here as defaultPrevented, so it never fires twice. */
addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  if (e.key === 'Escape') {
    document.body.classList.remove('menuopen');
    return;
  }
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 's' && !e.shiftKey) {
    e.preventDefault();
    void doc.save().then((ok) => ok && toast('已保存'));
    return;
  }
  if (k === 'w' && !e.shiftKey) {
    e.preventDefault();
    void platform.closeWindow();
    return;
  }
  if (k === '\\') {
    e.preventDefault();
    document.body.classList.toggle('menuopen');
    return;
  }
  if (k === 'n' && !e.shiftKey) {
    e.preventDefault();
    void platform.newWindow();
  } else if (k === 'o' && !e.shiftKey) {
    e.preventDefault();
    void (async () => {
      const p = await doc.openDialog();
      if (p) {
        setBuffer(doc.text);
        toast('已打开 ' + doc.name);
      }
    })();
  } else if (k === 's' && e.shiftKey) {
    e.preventDefault();
    void doc.saveAs().then((ok) => ok && toast('已另存为 ' + doc.name));
  }
});
}
