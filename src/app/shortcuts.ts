/* 窗口级快捷键。v1 没有菜单栏，这些键必须在焦点**不在**正文里时也生效 ——
   在抽屉的字体框里打字，⌘S 和 Esc 不能因此失灵。编辑器自己的 keymap already 处理过的
   按键到这里时带着 defaultPrevented，所以不会触发两次。 */
import type { Platform } from '../platform/types';
import type { DocumentSession } from './document';

export type ShortcutDeps = {
  platform: Platform;
  doc: DocumentSession;
  toast: (msg: string) => void;
  /** 打开新文件之后把内容放进缓冲区 */
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
