/* The VS Code–style thumbnail on the right edge.

   The blog editor could clone the whole page because the whole page existed in the DOM.
   Here the document is virtualised, so the clone is rebuilt from the text — but ONLY for
   the slice of the document the minimap can actually show, and each cloned row is parked
   at the y CodeMirror's own height map reports. That keeps a 100k-word document at the
   same cost as a short one while staying pixel-aligned with the real text. */

import type { EditorView } from '@codemirror/view';
import { decorateLine, imageLine, lineHTML, quoteScan } from '../editor/tokens';
import type { Glide } from './glide';

const PAD = 10;
/** hard ceiling on cloned rows, so a pathological viewport can never explode the DOM */
const MAX_ROWS = 1200;

export type Minimap = {
  layout: () => void;
  /** the document changed: the clone must be repainted even if the same lines show */
  invalidate: () => void;
  destroy: () => void;
};

export function createMinimap(
  view: EditorView,
  mini: HTMLElement,
  content: HTMLElement,
  vp: HTMLElement,
  resolveAsset: (src: string) => string | null,
  glide: Glide,
  /** 选框要标出的「真正看得见的那一段」：普通模式是整个视口，专注模式是聚焦带。
      返回相对滚动容器顶端的偏移与高度。 */
  visibleRange: () => { offset: number; height: number } = () => ({ offset: 0, height: view.scrollDOM.clientHeight }),
): Minimap {
  let scale = 0.16;
  let shift = 0;
  /** 顶端留白：默认和其它三边一样是 PAD；macOS 透明标题栏下最上面那条是窗口拖拽区，
      选框要让到它下面去（CSS 变量 --mini-top，见 style.css 的 body.overlay-titlebar） */
  let topInset = PAD;
  let mode: 'pin' | 'slide' = 'pin';
  let dragging = false;
  let grabOffset = 0;
  /** what the clone currently shows — re-rendering it on every scroll frame would be
      the one place where a long document actually costs something */
  let painted = { from: -1, to: -1, width: 0, scale: 0 };

  const scroller = () => view.scrollDOM;
  const padTop = () => view.documentPadding.top;

  function metrics() {
    const s = scroller();
    // 文字列的宽度（clientWidth 含左右内边距，而缩略图要按文字列等比缩放）
    const cs = getComputedStyle(view.contentDOM);
    const width =
      (view.contentDOM.clientWidth || 700) - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    scale = Math.max(0.01, (mini.clientWidth - 2 * PAD) / width);
    topInset = parseFloat(getComputedStyle(mini).getPropertyValue('--mini-top')) || PAD;
    const miniH = mini.clientHeight;
    const docH = s.scrollHeight;
    const seen = visibleRange();
    const vpH = seen.height * scale;
    const boxNat = topInset + (s.scrollTop + seen.offset) * scale;
    shift = 0;
    mode = 'pin';
    if (docH * scale > miniH - topInset - PAD) {
      mode = 'slide';
      const track = Math.max(1, miniH - vpH - topInset);
      const docScroll = Math.max(1, docH - s.clientHeight);
      const desired = topInset + Math.min(1, Math.max(0, s.scrollTop / docScroll)) * track;
      shift = boxNat - desired;
    }
    return { width, miniH, docH, vpH, boxNat };
  }

  function render(width: number, miniH: number) {
    const top = topInset - shift;
    content.style.width = width + 'px';
    content.style.transform = `scale(${scale})`;
    content.style.top = top + 'px';

    // which scroll-space band is visible in the minimap right now
    const yFrom = Math.max(0, (0 - top) / scale);
    const yTo = (miniH - top) / scale;
    const docFrom = Math.max(0, yFrom - padTop());
    const docTo = Math.max(0, yTo - padTop());
    const first = view.lineBlockAtHeight(docFrom);
    const last = view.lineBlockAtHeight(docTo);
    const doc = view.state.doc;
    const fromLine = doc.lineAt(first.from).number;
    const toLine = Math.min(doc.lines, doc.lineAt(last.to).number);
    // nothing new is visible and the document has not changed (invalidate() clears this)
    // → the clone is still valid, and moving it is just the `top` we already set above
    if (painted.from === fromLine && painted.to === toLine && painted.width === width && painted.scale === scale) return;
    painted = { from: fromLine, to: toLine, width, scale };

    // rail membership needs the lines above; replay from the nearest blank line
    let scanFrom = fromLine;
    while (scanFrom > 1 && doc.line(scanFrom - 1).text.trim() !== '') scanFrom--;
    const texts: string[] = [];
    for (let n = scanFrom; n <= toLine; n++) texts.push(doc.line(n).text);
    const rails = quoteScan(texts);

    const parts: string[] = [];
    let rows = 0;
    for (let n = fromLine; n <= toLine && rows < MAX_ROWS; n++, rows++) {
      const line = doc.line(n);
      const text = line.text;
      const rail = rails[n - scanFrom];
      const deco = decorateLine(text);
      const cls = ['ln'];
      if (deco.lineClass) cls.push(deco.lineClass);
      if (rail?.member) cls.push('quote');
      if (rail?.lazy) cls.push('qlazy');
      const y = view.lineBlockAt(line.from).top + padTop();
      const img = imageLine(text);
      let inner: string;
      if (img) {
        const url = img.src ? resolveAsset(img.src) : null;
        inner = url
          ? `<span class="imgwrap"><img src="${escapeAttr(url)}" alt=""></span>`
          : `<span class="imgwrap"><span class="imgmiss"></span></span>`;
        cls.push('imgrow');
      } else {
        inner = lineHTML(text, deco);
      }
      parts.push(`<div class="${cls.join(' ')}" style="top:${y.toFixed(2)}px">${inner}</div>`);
    }
    content.innerHTML = parts.join('');
  }

  function layout() {
    const s = scroller();
    // 一屏放得下时根本没有可滚的范围 —— 选框不该显示成可以抓着拖的样子
    mini.classList.toggle('noscroll', s.scrollHeight <= s.clientHeight + 1);
    const { width, miniH, vpH, boxNat } = metrics();
    render(width, miniH);
    vp.style.top = boxNat - shift + 'px';
    vp.style.height = vpH + 'px';
  }

  function boxTopToScroll(boxTop: number) {
    const s = scroller();
    const off = visibleRange().offset;
    if (mode === 'pin') return (boxTop - topInset) / scale - off;
    const track = Math.max(1, mini.clientHeight - visibleRange().height * scale - topInset);
    const docScroll = Math.max(1, s.scrollHeight - s.clientHeight);
    return Math.min(1, Math.max(0, (boxTop - topInset) / track)) * docScroll;
  }

  const onDown = (e: MouseEvent) => {
    // 按在缩略图上就不该在正文里拉出一片选区 —— 这里的拖拽只管滚动
    e.preventDefault();
    if (mini.classList.contains('noscroll')) return; // 没得滚：点也不跳、拖也不动
    const s = scroller();
    if (e.target !== vp) {
      const y = e.clientY - mini.getBoundingClientRect().top;
      const scrollSpaceY = (y - (topInset - shift)) / scale;
      // 点击是「跳转」→ 滑过去；下面的拖拽仍然 1:1 跟手
      glide.to(Math.max(0, scrollSpaceY - s.clientHeight / 2));
    }
    dragging = true;
    grabOffset = e.clientY - vp.offsetTop;
    document.body.style.userSelect = 'none';
  };
  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    glide.cancel(); // 开始拖了就别再跟动画抢
    scroller().scrollTop = Math.max(0, boxTopToScroll(e.clientY - grabOffset));
  };
  const onUp = () => {
    dragging = false;
    document.body.style.userSelect = '';
  };

  mini.addEventListener('mousedown', onDown);
  addEventListener('mousemove', onMove);
  addEventListener('mouseup', onUp);

  return {
    layout,
    invalidate() {
      painted.from = -1;
      layout();
    },
    destroy() {
      mini.removeEventListener('mousedown', onDown);
      removeEventListener('mousemove', onMove);
      removeEventListener('mouseup', onUp);
    },
  };
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
