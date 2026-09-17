/* 键盘焦点与「正文以外也能滚」这两件事，都是为了对抗宿主的默认行为，跟写作本身无关，
   所以从装配文件里拿出来单独放。两条都踩过坑，注释里写了是哪一条。 */
import type { EditorView } from '@codemirror/view';
import type { Glide } from '../features/glide';

/** 装上守卫，返回「把焦点交还给正文」的那个函数 —— 目录点击和冒烟探针都要用它。 */
export function installFocusGuard(view: EditorView, glide: Glide): { focusEditor: () => void } {
/* 滚轮：正文以外的地方（左边的目录栏空白、右边的缩略图、顶部状态栏）也要能滚动正文。
   抽屉、目录列表、查找面板这些自己会滚的区域放行。 */
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

/* 键盘焦点：窗口一回到前台就把焦点交还给正文，否则快捷键要等用户先点一下才生效
   （原生窗口刚起来时 webview 可能还不是第一响应者）。 */
/** 把焦点交还给正文，但**不许动滚动位置**。
    WebKit 在重新聚焦 contenteditable 时会把光标滚进视野 —— 于是「在抽屉里点一下」
    就会把正文猛地拽回光标所在处。Chromium 不这么干，所以这条只能靠代码守住。 */
const focusEditor = () => {
  const top = view.scrollDOM.scrollTop;
  view.focus();
  if (view.scrollDOM.scrollTop !== top) view.scrollDOM.scrollTop = top;
  requestAnimationFrame(() => {
    if (!glide.running() && Math.abs(view.scrollDOM.scrollTop - top) > 1) view.scrollDOM.scrollTop = top;
  });
};

const refocus = () => {
  // 抽屉开着时不抢焦点：那会儿人在操作界面，不是在写字
  if (document.body.classList.contains('menuopen')) return;
  const el = document.activeElement as HTMLElement | null;
  // 有人正在别的控件里打字（设置项、查找框、冲突对话框）就别抢焦点
  if (el?.closest?.('input,textarea,select,button,.drawer,.cm-panels,.conflict')) return;
  // 焦点在 body/html，或落在编辑器的外壳（滚动容器）上 → 交还给正文
  if (!el || el === document.body || el === document.documentElement) return focusEditor();
  if (view.dom.contains(el) && !view.contentDOM.contains(el)) focusEditor();
};
addEventListener('focus', refocus);
// 焦点离开正文却没有落到别的控件上（点了空白、原生窗口把焦点收走）→ 交还给正文
addEventListener('focusout', (e) => {
  if ((e as FocusEvent).relatedTarget) return;
  setTimeout(refocus, 0);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refocus();
});
addEventListener('mousedown', (e) => {
  const t = e.target as HTMLElement | null;
  // 在正文里按下 → 让路；在缩略图上按下不算，那里刚发起的就是一次滑动
  if (t?.closest?.('.cm-scroller')) glide.cancel();
  if (t?.closest?.('input,textarea,.drawer,.cm-panels,.mini,.conflict,.toc-inner')) return;
  setTimeout(refocus, 0);
});

  return { focusEditor };
}
