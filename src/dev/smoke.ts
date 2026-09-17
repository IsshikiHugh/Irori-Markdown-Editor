/* 冒烟探针。scripts/smoke.sh 启动打包好的应用、传一个输出路径进来，这里把
   「外壳 → 读文件 → 编辑器 → 装饰」整条链路的状态写成一个 JSON 交回去，然后退出。

   为什么它在生产包里：这个项目的两个测试套件跑的都是**生产产物** —— e2e 驱动 dist/、
   冒烟驱动打包出的 .app（见 tests/e2e/harness.mjs 与 scripts/smoke.sh 开头）。
   「测的就是发出去的那一份」是刻意的取舍，所以这段不能按 DEV 剔掉。
   把它从 main.ts 搬到这里，只是为了让装配文件读得动 —— 那边曾经有九十多行是这个。 */
import type { EditorView } from '@codemirror/view';
import type { Platform } from '../platform/types';
import type { DocumentSession } from '../app/document';
import type { SettingsStore } from '../app/settings';

export type SmokeCtx = {
  view: EditorView;
  platform: Platform;
  doc: DocumentSession;
  settings: SettingsStore;
  /** 把焦点交还给正文，且不许动滚动位置 —— WebKit 会偷偷滚，探针要验的就是它 */
  focusEditor: () => void;
  /** 字数统计当前显示的文本 */
  wordCount: () => string;
};

/** 没设 smoke 输出路径时直接返回，什么都不做。 */
export async function runSmoke(ctx: SmokeCtx): Promise<void> {
// smoke check (scripts/smoke.sh): prove in one file that the whole chain works inside
// the real system WebView — shell → file read → editor → decoration
const smoke = await ctx.platform.smokeOut();
let focusKeepsScroll: boolean | null = null;
if (smoke) {
  // 真机里验一条 Chromium 复现不出来的事：WebKit 重新聚焦 contenteditable 时会把光标
  // 滚进视野（表现为「在抽屉里点一下，正文被拽回光标处」）。这里实测它有没有被守住。
  const el = ctx.view.scrollDOM;
  const probe = Math.min(600, Math.max(0, el.scrollHeight - el.clientHeight));
  if (probe > 50) {
    el.scrollTop = probe;
    // 光标放在探测位置能看见的地方：否则专注模式开着时，「把光标带回聚焦带」
    // 本身就会改滚动位置，这条探针就测不出真正要测的东西了
    const at = ctx.view.posAtCoords({ x: ctx.view.contentDOM.getBoundingClientRect().left + 20, y: el.getBoundingClientRect().top + el.clientHeight / 2 }, false);
    ctx.view.dispatch({ selection: { anchor: at ?? 0 } });
    ctx.view.contentDOM.blur();
    await new Promise((r) => setTimeout(r, 80));
    ctx.focusEditor();
    await new Promise((r) => setTimeout(r, 150));
    focusKeepsScroll = Math.abs(el.scrollTop - probe) <= 2;
    el.scrollTop = 0;
    // 滚回顶部后等 CodeMirror 把开头那几行重新渲染出来，否则下面量装饰时第一行还不在 DOM 里
    // （--close 那次正是栽在这个竞态上：标题 / 引用 / 粗体三项都误报 ✗）
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 120));
  }
}
if (smoke?.dialog) {
  // 打开一个保存面板但不回答它，然后问 Rust 主线程要窗口矩形。
  // 如果对话框把主线程锁死了（⌘S 卡死的那个 bug），这个 invoke 永远不会回来。
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  void ctx.platform.saveDialog('冒烟.md');
  await wait(1200);
  const alive = await Promise.race([ctx.platform.windowRect().then(() => true), wait(3000).then(() => false)]);
  await ctx.platform.writeText(smoke.out + '.mainthread', JSON.stringify({ alive }));
}
if (smoke) {
  await ctx.platform.writeText(
    smoke.out,
    JSON.stringify({
      host: ctx.platform.kind,
      // ⌘C/⌘V live on the system Edit menu; this says whether the host provides one
      menu: smoke.menu,
      engine: navigator.userAgent.includes('AppleWebKit') && !navigator.userAgent.includes('Chrome') ? 'WebKit' : 'other',
      path: ctx.doc.path,
      chars: ctx.view.state.doc.length,
      renderedLines: document.querySelectorAll('.cm-content .cm-line').length,
      decorated: {
        h1: !!document.querySelector('.cm-line.h1'),
        quote: !!document.querySelector('.cm-line.quote'),
        bold: !!document.querySelector('.cm-content .b'),
        image: !!document.querySelector('.cm-content .imgrow'),
      },
      // 前三行的原文与类名：证明「渲染出来的就是文件里的那几行」，不用截屏也能核对
      firstLines: [...document.querySelectorAll('.cm-content .cm-line')].slice(0, 3).map((l) => ({
        text: l.textContent,
        cls: l.className.replace('cm-line ', ''),
      })),
      toc: document.querySelectorAll('#toc .toc-link').length,
      minimapRows: document.getElementById('miniContent')?.children.length ?? 0,
      wordCount: ctx.wordCount(),
      // which of the configured families this machine actually has (M-07 的证据)
      rect: await ctx.platform.windowRect(),
      // 透明标题栏下正文要给红绿灯让位：这条证明那段样式真的生效了
      overlayTitlebar: document.body.classList.contains('overlay-titlebar'),
      // 键盘焦点是否真的在网页里：快捷键失灵的根因就看这一条
      hasFocus: document.hasFocus(),
      focusKeepsScroll,
      activeElement: document.activeElement?.className || document.activeElement?.tagName || null,
      toplineHeight: (document.querySelector('.topline') as HTMLElement).getBoundingClientRect().height,
      // 光标：只该有一条，且没有 CodeMirror 那条黑色左边框
      caret: (() => {
        const c = document.querySelector('.cm-cursor');
        if (!c) return null;
        const cs = getComputedStyle(c);
        return { count: document.querySelectorAll('.cm-cursor').length, border: cs.borderLeftWidth, w: cs.width, bg: cs.backgroundColor };
      })(),
      // 渐隐层必须挂在编辑器里、且在光标层之下
      fadeParent: document.getElementById('fade')?.parentElement?.className.split(' ')[0],
      editorIsolated: getComputedStyle(ctx.view.dom).isolation === 'isolate',
      font: ctx.settings.value.fontFamily
        .split(',')
        .map((f) => f.trim().replace(/^["']|["']$/g, ''))
        .find((f) => document.fonts.check(`19px "${f}"`)),
    }),
  );
  if (smoke.close) {
    // 走和 ⌘W 完全一样的路：closeWindow → close_requested → 我们的关闭检查 → 销毁窗口
    setTimeout(() => void ctx.platform.closeWindow(), 200);
  } else if (!smoke.hold) setTimeout(() => window.close(), 200);
}
}
