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
import { loadLanguages } from '../editor/highlight';
import { loadMath } from '../editor/math';
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
  /** lay the export pages out and print them into `path`; resolves with the page count */
  printTo: (path: string) => Promise<number>;
};

/** Returns right away, doing nothing, when no smoke output path is set. */
export async function runSmoke(ctx: SmokeCtx): Promise<void> {
// smoke check (scripts/smoke.sh): prove in one file that the whole chain works inside
// the real system WebView — shell → file read → editor → decoration
const smoke = await ctx.platform.smokeOut();
let focusKeepsScroll: boolean | null = null;
if (smoke) {
  // the code block's language and KaTeX are chunks of their own, loaded on first use: wait for
  // them, then for the editor to draw with them — a math block typeset mid-probe would change the
  // heights above the probe line
  await loadLanguages(['```ts']);
  await loadMath();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // Verify on the real host something Chromium can't reproduce: WebKit scrolls the caret into
  // view when it refocuses a contenteditable (seen as "one click in the drawer yanks the text back
  // to the caret"). This measures whether that is actually guarded against.
  const el = ctx.view.scrollDOM;
  const probe = Math.min(600, Math.max(0, el.scrollHeight - el.clientHeight));
  if (probe > 50) {
    el.scrollTop = probe;
    // Put the caret somewhere visible at the probe position: otherwise, with focus mode on,
    // "bring the caret back into the focus band" would itself change the scroll position, and the
    // probe could no longer measure what it is really meant to. And on a line of plain text: on a
    // picture, a table, a link or a formula the caret turns it back into source, which changes the
    // heights above — a moved scroll position the probe would blame on the refocus.
    const doc = ctx.view.state.doc;
    const mid = ctx.view.posAtCoords({ x: ctx.view.contentDOM.getBoundingClientRect().left + 20, y: el.getBoundingClientRect().top + el.clientHeight / 2 }, false);
    let n = doc.lineAt(mid ?? 0).number;
    while (n < doc.lines && /[[|$]/.test(doc.line(n).text)) n++;
    ctx.view.dispatch({ selection: { anchor: doc.line(n).from } });
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
if (smoke?.pdf) {
  // The export through WKWebView's real print operation: the script checks the file exists and
  // has as many pages as were laid out
  let pdf: { pages: number; error?: string };
  try {
    pdf = { pages: await ctx.printTo(smoke.out + '.pdf') };
  } catch (err) {
    pdf = { pages: 0, error: String(err) };
  }
  await ctx.platform.writeText(smoke.out + '.pdfinfo', JSON.stringify(pdf));
}
// settings really persist through the shell: write what is loaded (so nothing changes) and read
// it back. The page and the Rust command once disagreed on the argument's name and every save
// was silently rejected — no browser test can see that, only the real shell.
let settingsPersist: boolean | string = false;
if (smoke) {
  try {
    await ctx.platform.saveSettings(ctx.settings.value);
    const back = await ctx.platform.loadSettings();
    // the shell writes keys sorted, so compare regardless of order
    const canon = (v: unknown): string =>
      Array.isArray(v)
        ? '[' + v.map(canon).join(',') + ']'
        : v && typeof v === 'object'
          ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon((v as Record<string, unknown>)[k])).join(',') + '}'
          : JSON.stringify(v);
    settingsPersist = canon(back) === canon(ctx.settings.value);
  } catch (err) {
    settingsPersist = String(err);
  }
}
// remote servers are signed in to with an ECDSA key made by WebCrypto, which only a secure
// context has: make and use one here (not the real one — nothing is saved)
let remoteKeys: boolean | string = false;
if (smoke) {
  try {
    const alg = { name: 'ECDSA', namedCurve: 'P-256' };
    const pair = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const priv = await crypto.subtle.importKey('jwk', jwk, alg, false, ['sign']);
    const data = new TextEncoder().encode('irori-host sign-in\nsmoke');
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, data);
    remoteKeys = sig.byteLength === 64 && (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, data));
  } catch (err) {
    remoteKeys = String(err);
  }
}
if (smoke) {
  await ctx.platform.writeText(
    smoke.out,
    JSON.stringify({
      host: ctx.platform.kind,
      settingsPersist,
      remoteKeys,
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
        table: !!document.querySelector('.cm-content .mdtbl'),
        code: !!document.querySelector('.cm-content .cb .tok-keyword'),
        math: !!document.querySelector('.cm-content .mathrow .katex'),
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
