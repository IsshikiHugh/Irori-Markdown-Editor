/* Smoke probe. scripts/smoke.sh launches the packaged app and passes in an output path; this
   writes the state of the whole "shell → file read → editor → decoration" chain there as JSON,
   then quits.

   Why it ships in the production bundle: both of this project's test suites run the **production
   build** — e2e drives dist/, smoke drives the packaged .app (see the top of
   tests/e2e/harness.mjs and scripts/smoke.sh). "Test exactly what ships" is a deliberate trade-off,
   so this cannot be stripped out under DEV.
   It moved here from main.ts only to keep the assembly file readable — over ninety lines there
   used to be this. */
import type { EditorView } from '@codemirror/view';
import type { Platform } from '../platform/types';
import type { DocumentSession } from '../app/document';
import type { SettingsStore } from '../app/settings';

export type SmokeCtx = {
  view: EditorView;
  platform: Platform;
  doc: DocumentSession;
  settings: SettingsStore;
  /** hand focus back to the text without touching the scroll position — WebKit scrolls behind
      our back, and that is exactly what the probe checks */
  focusEditor: () => void;
  /** the text the word count currently displays */
  wordCount: () => string;
};

/** Returns right away, doing nothing, when no smoke output path is set. */
export async function runSmoke(ctx: SmokeCtx): Promise<void> {
// smoke check (scripts/smoke.sh): prove in one file that the whole chain works inside
// the real system WebView — shell → file read → editor → decoration
const smoke = await ctx.platform.smokeOut();
let focusKeepsScroll: boolean | null = null;
if (smoke) {
  // Verify on the real host something Chromium can't reproduce: WebKit scrolls the caret into
  // view when it refocuses a contenteditable (seen as "one click in the drawer yanks the text back
  // to the caret"). This measures whether that is actually guarded against.
  const el = ctx.view.scrollDOM;
  const probe = Math.min(600, Math.max(0, el.scrollHeight - el.clientHeight));
  if (probe > 50) {
    el.scrollTop = probe;
    // Put the caret somewhere visible at the probe position: otherwise, with focus mode on,
    // "bring the caret back into the focus band" would itself change the scroll position, and the
    // probe could no longer measure what it is really meant to
    const at = ctx.view.posAtCoords({ x: ctx.view.contentDOM.getBoundingClientRect().left + 20, y: el.getBoundingClientRect().top + el.clientHeight / 2 }, false);
    ctx.view.dispatch({ selection: { anchor: at ?? 0 } });
    ctx.view.contentDOM.blur();
    await new Promise((r) => setTimeout(r, 80));
    ctx.focusEditor();
    await new Promise((r) => setTimeout(r, 150));
    focusKeepsScroll = Math.abs(el.scrollTop - probe) <= 2;
    el.scrollTop = 0;
    // After scrolling back to the top, wait for CodeMirror to re-render the opening lines; otherwise
    // the first line isn't in the DOM yet when decorations are measured below
    // (the --close run tripped on exactly this race: heading / quote / bold all falsely reported ✗)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 120));
  }
}
if (smoke?.dialog) {
  // Open a save panel without answering it, then ask the Rust main thread for the window rect.
  // If the dialog has deadlocked the main thread (the ⌘S freeze bug), this invoke never returns.
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  void ctx.platform.saveDialog('smoke.md');
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
      // right edge of the dot of "9." minus that of "10." — 0 when numbers right-align in WebKit too
      listDots: (() => {
        const dots = [...document.querySelectorAll('.cm-content .lnum')].map((el) => {
          const node = el.firstChild;
          const text = node?.textContent ?? '';
          if (!node || text.indexOf('.') < 0) return null;
          const r = document.createRange();
          r.setStart(node, text.indexOf('.'));
          r.setEnd(node, text.indexOf('.') + 1);
          return r.getBoundingClientRect().right;
        });
        return dots.length >= 2 && dots[0] != null && dots[1] != null ? dots[0] - dots[1] : null;
      })(),
      // source text and class names of the first three lines: proves "what's rendered is those
      // lines of the file", checkable without a screenshot
      firstLines: [...document.querySelectorAll('.cm-content .cm-line')].slice(0, 3).map((l) => ({
        text: l.textContent,
        cls: l.className.replace('cm-line ', ''),
      })),
      toc: document.querySelectorAll('#toc .toc-link').length,
      minimapRows: document.getElementById('miniContent')?.children.length ?? 0,
      wordCount: ctx.wordCount(),
      // which of the configured families this machine actually has (evidence for M-07)
      rect: await ctx.platform.windowRect(),
      // under a transparent title bar the text must make room for the traffic lights: this
      // proves that style really took effect
      overlayTitlebar: document.body.classList.contains('overlay-titlebar'),
      // whether keyboard focus is really inside the web page: the one to check for the root cause
      // of dead shortcuts
      hasFocus: document.hasFocus(),
      focusKeepsScroll,
      activeElement: document.activeElement?.className || document.activeElement?.tagName || null,
      toplineHeight: (document.querySelector('.topline') as HTMLElement).getBoundingClientRect().height,
      // caret: there should be exactly one, without CodeMirror's black left border
      caret: (() => {
        const c = document.querySelector('.cm-cursor');
        if (!c) return null;
        const cs = getComputedStyle(c);
        return { count: document.querySelectorAll('.cm-cursor').length, border: cs.borderLeftWidth, w: cs.width, bg: cs.backgroundColor };
      })(),
      // the fade layer must live inside the editor, below the cursor layer
      fadeParent: document.getElementById('fade')?.parentElement?.className.split(' ')[0],
      editorIsolated: getComputedStyle(ctx.view.dom).isolation === 'isolate',
      font: ctx.settings.value.fontFamily
        .split(',')
        .map((f) => f.trim().replace(/^["']|["']$/g, ''))
        .find((f) => document.fonts.check(`19px "${f}"`)),
    }),
  );
  if (smoke.close) {
    // take exactly the same path as ⌘W: closeWindow → close_requested → our close check → destroy
    // the window
    setTimeout(() => void ctx.platform.closeWindow(), 200);
  } else if (!smoke.hold) setTimeout(() => window.close(), 200);
}
}
