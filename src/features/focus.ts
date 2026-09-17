/* Focus mode: everything outside the band fades away along a curve you can drag.

   Ported from the blog editor, including the quartic Bézier with three draggable
   interior control points, the caret clamping, and the padding trick that lets the very
   first and very last line reach the band. The only change is what it measures: the
   CodeMirror scroller instead of the window. */

import type { EditorView } from '@codemirror/view';
import type { Glide } from './glide';
import { glideDuration } from './glide';

export type FocusPrefs = { on: boolean; top: number; bottom: number; curve: { x: number; y: number }[] };

export type FocusEls = {
  seg: HTMLElement;
  range: HTMLElement;
  adjust: HTMLElement;
  topR: HTMLInputElement;
  botR: HTMLInputElement;
  fill: HTMLElement;
  fade: HTMLElement;
  svg: SVGSVGElement;
  path: SVGPathElement;
  poly: SVGPolylineElement;
  handles: SVGCircleElement[];
  reset: HTMLElement;
};

export const CURVE_DEFAULT = [
  { x: 0.08, y: 0.62 },
  { x: 0.26, y: 0.9 },
  { x: 0.55, y: 0.99 },
];
const GAP = 8;

export function createFocus(
  view: EditorView,
  els: FocusEls,
  prefs: FocusPrefs,
  persist: (p: FocusPrefs) => void,
  glide: Glide,
  /** 聚焦带 / 内边距变了：外面要重排缩略图，否则它还按旧的 padding 画 */
  onBandChange: () => void = () => {},
) {
  let curve = prefs.curve?.length === 3 ? prefs.curve.map((p) => ({ ...p })) : CURVE_DEFAULT.map((p) => ({ ...p }));
  els.topR.value = String(prefs.top);
  els.botR.value = String(prefs.bottom);

  const isOn = () => document.body.classList.contains('focusmode');
  const save = () =>
    persist({ on: isOn(), top: +els.topR.value, bottom: +els.botR.value, curve: curve.map((p) => ({ ...p })) });

  /* ---- bezier ---- */
  const ctrlPts = () => [{ x: 0, y: 0 }, ...curve, { x: 1, y: 1 }];
  function bezXY(pts: { x: number; y: number }[], t: number) {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    for (let k = pts.length - 1; k > 0; k--)
      for (let i = 0; i < k; i++) {
        xs[i] += (xs[i + 1] - xs[i]) * t;
        ys[i] += (ys[i + 1] - ys[i]) * t;
      }
    return { x: xs[0], y: ys[0] };
  }
  function fadeY(x: number) {
    const pts = ctrlPts();
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      if (bezXY(pts, m).x < x) lo = m;
      else hi = m;
    }
    return Math.min(1, Math.max(0, bezXY(pts, (lo + hi) / 2).y));
  }
  function buildGrad() {
    const ft = +els.topR.value;
    const fb = +els.botR.value;
    const N = 12;
    const s: string[] = [];
    for (let i = 0; i <= N; i++) s.push(`rgba(247,243,236,${fadeY(1 - i / N).toFixed(3)}) ${((ft * i) / N).toFixed(2)}%`);
    s.push(`rgba(247,243,236,0) ${ft.toFixed(2)}%`, `rgba(247,243,236,0) ${fb.toFixed(2)}%`);
    for (let i = 0; i <= N; i++)
      s.push(`rgba(247,243,236,${fadeY(i / N).toFixed(3)}) ${(fb + ((100 - fb) * i) / N).toFixed(2)}%`);
    els.fade.style.backgroundImage = 'linear-gradient(to bottom,' + s.join(',') + ')';
  }

  /* ---- band ---- */
  /* 上下留白。旧编辑器底部固定留 85vh，让最后一行能滚到顶上 —— 但那条规则对短文档是错的：
     空文档也能滚 9px、三行能滚 93px、一屏放得下的十行能滚 359px，缩略图的选框也跟着能拖。
     所以现在只有「正文一屏放不下」时才留那段滚过末尾的空白；专注模式同理，正文整个放得进
     聚焦带就不需要滚。高度要等 CodeMirror 量完才准，所以放在它的测量周期里读写。 */
  let lastPads = '';
  function applyPads() {
    view.requestMeasure({
      key: 'irori-pads',
      read: () => ({
        h: view.scrollDOM.clientHeight,
        textH: Math.max(0, view.contentHeight - view.documentPadding.top - view.documentPadding.bottom),
      }),
      write: ({ h, textH }) => {
        const content = view.contentDOM;
        let top = '';
        let bottom = '';
        if (isOn()) {
          const ftop = parseFloat(els.topR.value);
          const fbot = parseFloat(els.botR.value);
          const padTop = (ftop * h) / 100;
          const band = ((fbot - ftop) * h) / 100;
          top = padTop + 'px';
          bottom = (textH <= band ? Math.max(0, h - padTop - textH) : ((100 - ftop) * h) / 100) + 'px';
        } else {
          const padTop = parseFloat(getComputedStyle(content).getPropertyValue('--pad-top')) || 44;
          // 一屏放得下 → 不留滚过末尾的空白（内容盒本身 min-height:100%，点空白处照样落光标）
          bottom = padTop + textH <= h ? '0px' : '';
        }
        const key = top + '|' + bottom;
        if (key === lastPads) return;
        lastPads = key;
        content.style.paddingTop = top;
        content.style.paddingBottom = bottom;
        if (top) content.style.setProperty('--pad-top', top);
        else content.style.removeProperty('--pad-top');
        onBandChange();
      },
    });
  }
  function bandPx() {
    const rect = view.scrollDOM.getBoundingClientRect();
    return {
      top: rect.top + (rect.height * parseFloat(els.topR.value)) / 100,
      bottom: rect.top + (rect.height * parseFloat(els.botR.value)) / 100,
    };
  }
  let pendingBand = 0;
  function keepCaretInBand() {
    if (!isOn()) return;
    // 正在滑就等它落地再看 —— 但**不能把这次请求丢掉**：
    // 「回车后接着打字」的时候，中途来的那些请求一旦被丢，光标就永远留在带外了。
    if (glide.running()) {
      if (!pendingBand) {
        const again = () => {
          if (glide.running()) {
            pendingBand = requestAnimationFrame(again);
            return;
          }
          pendingBand = 0;
          keepCaretInBand();
        };
        pendingBand = requestAnimationFrame(again);
      }
      return;
    }
    const head = view.state.selection.main.head;
    // 光标所在的行没渲染时 coordsAtPos 会返回 null（比如刚把光标移到很远的地方），
    // 那就退回用 CodeMirror 的高度表算，否则这种情况下永远不会把它带回带内
    const block = view.lineBlockAt(head);
    const fallback = { top: view.documentTop + block.top, bottom: view.documentTop + block.top + block.height };
    const c = view.coordsAtPos(head) ?? fallback;
    const { top, bottom } = bandPx();
    // 滑动的速率曲线与时长见 features/glide.ts（渐入渐出、按跨越行数递进）
    if (c.top < top) glide.by(c.top - top);
    else if (c.bottom > bottom) glide.by(c.bottom - bottom);
  }
  function apply() {
    const a = +els.topR.value;
    const b = +els.botR.value;
    document.body.style.setProperty('--ftop', a + '%');
    document.body.style.setProperty('--fbot', b + '%');
    els.fill.style.left = a + '%';
    els.fill.style.width = b - a + '%';
    applyPads();
    onBandChange();
    keepCaretInBand();
  }
  function setOn(on: boolean) {
    // anchor the caret's row so turning focus on does not move the text under the eye
    const head = view.state.selection.main.head;
    const before = view.coordsAtPos(head)?.top ?? null;
    document.body.classList.toggle('focusmode', on);
    if (on) els.range.classList.remove('open');
    [...els.seg.children].forEach((x) => x.classList.toggle('on', ((x as HTMLElement).dataset.on === '1') === on));
    applyPads();
    const after = view.coordsAtPos(head)?.top ?? null;
    if (before != null && after != null) {
      const dy = after - before;
      if (Math.abs(dy) > 0.5) view.scrollDOM.scrollTop += dy;
    }
    onBandChange();
    keepCaretInBand();
    save();
  }

  /* ---- curve editor ---- */
  const W = 240;
  const H = 96;
  const toX = (x: number) => x * W;
  const toY = (y: number) => H - y * H;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  function draw() {
    const pts = ctrlPts();
    let d = 'M0,' + H;
    for (let i = 1; i <= 48; i++) {
      const q = bezXY(pts, i / 48);
      d += ' L' + toX(q.x).toFixed(1) + ',' + toY(q.y).toFixed(1);
    }
    els.path.setAttribute('d', d);
    els.poly.setAttribute(
      'points',
      [[0, H], ...curve.map((c) => [toX(c.x), toY(c.y)]), [W, 0]].map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '),
    );
    els.handles.forEach((h, i) => {
      h.setAttribute('cx', String(toX(curve[i].x)));
      h.setAttribute('cy', String(toY(curve[i].y)));
    });
  }
  let drag = -1;
  const at = (e: MouseEvent) => {
    const r = els.svg.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp(1 - (e.clientY - r.top) / r.height) };
  };
  els.handles.forEach((h, i) =>
    h.addEventListener('mousedown', (e) => {
      e.preventDefault();
      drag = i;
    }),
  );
  document.addEventListener('mousemove', (e) => {
    if (drag < 0) return;
    curve[drag] = at(e);
    draw();
    buildGrad();
  });
  document.addEventListener('mouseup', () => {
    if (drag >= 0) {
      drag = -1;
      save();
    }
  });
  els.reset.onclick = () => {
    curve = CURVE_DEFAULT.map((p) => ({ ...p }));
    draw();
    buildGrad();
    save();
  };
  els.adjust.onclick = () => els.range.classList.toggle('open');
  els.seg.onclick = () => setOn(!isOn());
  els.topR.oninput = () => {
    if (+els.topR.value > +els.botR.value - GAP) els.topR.value = String(+els.botR.value - GAP);
    apply();
    buildGrad();
    save();
  };
  els.botR.oninput = () => {
    if (+els.botR.value < +els.topR.value + GAP) els.botR.value = String(+els.topR.value + GAP);
    apply();
    buildGrad();
    save();
  };

  draw();
  apply();
  buildGrad();
  if (prefs.on) setOn(true);

  return { apply, setOn, keepCaretInBand, isOn, bandPx, buildGrad, glideDuration, syncPads: applyPads };
}
