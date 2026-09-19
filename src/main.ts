/* Wiring. Everything interesting lives in the modules; this file is the assembly. */

import { EditorView } from '@codemirror/view';
import { getPlatform } from './platform';
import { resolveAgainst } from './platform/paths';
import type { Platform } from './platform/types';
import { SettingsStore } from './app/settings';
import { DocumentSession } from './app/document';
import { storeImage, UnsavedDocumentError } from './app/images';
import { applyFont, createEditor } from './editor';
import { createTOC } from './features/toc';
import { createMinimap } from './features/minimap';
import type { Minimap } from './features/minimap';
import { createFocus } from './features/focus';
import { createGlide } from './features/glide';
import { clearPrint, exportPdf, preparePrint } from './features/export';
import { countText, formatCounts } from './features/wordcount';
import { installFocusGuard } from './app/focus-guard';
import { installShortcuts } from './app/shortcuts';
import { offerUpdate } from './app/update';
import { runSmoke } from './dev/smoke';

/* getElementById's return type is fixed to HTMLElement, so every SVG lookup would need a double
   cast. The cast is folded in here once; callers just write $<SVGPathElement>('curvepath'). */
const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

async function boot() {
  const platform: Platform = await getPlatform();
  const settings = new SettingsStore(platform);
  await settings.load();

  /* ---------- document session ---------- */
  let view!: EditorView;
  let suppressChange = false;

  /** Put `text` in the buffer.

      Opening a file starts at the top: CodeMirror maps the caret to the end of inserted
      text, and because the sheet keeps 85vh of bottom padding, the window would otherwise
      open scrolled past the first lines.

      A reload (the file changed under us) instead replaces only what actually differs —
      a common-prefix/suffix diff — so the caret, the scroll position and the undo history
      all survive an external edit that appended one line somewhere else. */
  const setBuffer = (text: string, keepCaret = false) => {
    const cur = view.state.doc.toString();
    if (cur === text) return;
    suppressChange = true;
    if (keepCaret) {
      let p = 0;
      while (p < cur.length && p < text.length && cur[p] === text[p]) p++;
      let suffix = 0;
      while (
        suffix < cur.length - p &&
        suffix < text.length - p &&
        cur[cur.length - 1 - suffix] === text[text.length - 1 - suffix]
      )
        suffix++;
      view.dispatch({
        changes: { from: p, to: cur.length - suffix, insert: text.slice(p, text.length - suffix) },
        scrollIntoView: false,
      });
    } else {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: text },
        selection: { anchor: 0 },
        scrollIntoView: false,
      });
      view.scrollDOM.scrollTop = 0;
    }
    suppressChange = false;
    afterDocChange();
  };

  const doc = new DocumentSession(
    platform,
    {
      onState(state) {
        const el = $('filechip');
        el.dataset.state = state;
        el.title = state === 'saving' ? 'saving…' : state === 'dirty' ? 'unsaved' : 'saved';
      },
      onPath(path, missing) {
        $('filename').textContent = (path ? doc.name : '未命名') + (missing ? '（已不存在）' : '');
        $('pathv').textContent = path ?? '未命名（尚未保存）';

        void platform.setTitle(path ? doc.name + ' — Irori' : 'Irori');
      },
      onReload(text) {
        setBuffer(text, true);
      },
      onConflict(disk, keepMine, useDisk) {
        const box = $('conflict');
        $('ctext').textContent = `${doc.path}\n磁盘上的版本与你正在编辑的不同（${disk.length} 字符 vs ${doc.text.length} 字符）。`;
        box.classList.add('open');
        $('ckeep').onclick = () => {
          box.classList.remove('open');
          keepMine();
        };
        $('cload').onclick = () => {
          box.classList.remove('open');
          useDisk();
        };
      },
      onToast: toast,
    },
    () => ({ autosave: settings.value.autosave, autosaveDelay: settings.value.autosaveDelay }),
  );

  /* Image src → a URL an <img> can load. The body and the minimap are two renderers, but the
     resolution rule must be one and the same: network/inline URLs pass through as-is; anything
     else is resolved to an absolute path against the current document, then handed to the host. */
  const resolveAsset = (src: string): string | null => {
    if (/^(https?:|data:)/i.test(src)) return src;
    const abs = doc.path ? resolveAgainst(doc.path, src) : null;
    return abs ? platform.assetUrl(abs) : null;
  };

  /* in focus mode the caret must stay inside the focus band; follow it at most once per frame */
  let bandFrame = 0;
  const followBand = () => {
    if (bandFrame) return;
    bandFrame = requestAnimationFrame(() => {
      bandFrame = 0;
      focus.keepCaretInBand();
    });
  };

  /* ---------- editor ---------- */
  view = createEditor($('body'), '', {
    onChange(text) {
      if (suppressChange) return;
      doc.setText(text);
      afterDocChange();
    },
    onUpdate() {
      followBand();
    },
    onSave() {
      void doc.save().then((ok) => ok && toast('已保存'));
    },
    onImage(file) {
      void (async () => {
        try {
          const ref = await storeImage(platform, doc.path, file);
          const at = view.state.selection.main;
          const line = view.state.doc.lineAt(at.head);
          const insert = (line.text.trim() ? '\n' : '') + `![](${ref})` + '\n';
          view.dispatch({ changes: { from: at.to, insert }, selection: { anchor: at.to + insert.length } });
          toast('图片已保存到 ' + doc.stemName + '/');
        } catch (err) {
          toast(err instanceof UnsavedDocumentError ? err.message : '图片保存失败：' + (err as Error).message);
        }
      })();
    },
    onToggleDrawer: () => document.body.classList.toggle('menuopen'),
    onEscape: () => document.body.classList.remove('menuopen'),
    resolveAsset,
  });
  applyFont(view, settings.value.fontFamily);
  // The fade layer goes inside the editor: that way it covers the text but not the caret
  // (CodeMirror's cursor layer is z-index 150), nor the top title bar outside the editor
  view.dom.appendChild($('fade'));
  // On macOS the title bar is transparent (tauri.conf.json: titleBarStyle=Overlay), so the text
  // has to make room for the traffic lights
  if (platform.kind === 'tauri' && /Mac/.test(navigator.userAgent)) document.body.classList.add('overlay-titlebar');

  /* ---------- features ---------- */
  // One glide, shared by three callers (TOC click / minimap click / focus mode pulling the caret
  // back), so they never scroll independently of each other
  const glide = createGlide(view);

  // The minimap and focus mode each need the other (the viewport box needs the focus band; a band
  // change must re-lay out the minimap). Two refs break the cycle, so whichever initializes first
  // never trips over "not initialized yet".
  let focusRef: ReturnType<typeof createFocus> | null = null;
  let minimapRef: Minimap | null = null;

  const minimap = createMinimap(
    view,
    $('mini'),
    $('miniContent'),
    $('vp'),
    resolveAsset,
    glide,
    () => {
      // in focus mode only the focus band is really visible, so that is the span the viewport box
      // should mark (everything outside the band is faded)
      const s = view.scrollDOM;
      if (!focusRef?.isOn()) return { offset: 0, height: s.clientHeight };
      const rect = s.getBoundingClientRect();
      const band = focusRef.bandPx();
      return { offset: band.top - rect.top, height: band.bottom - band.top };
    },
  );
  minimapRef = minimap;

  const focus = createFocus(
    view,
    {
      seg: $('fseg'),
      range: $('frange'),
      adjust: $('fadjust'),
      topR: $<HTMLInputElement>('ftopR'),
      botR: $<HTMLInputElement>('fbotR'),
      fill: $('fFill'),
      fade: $('fade'),
      svg: $<SVGSVGElement>('curve'),
      path: $<SVGPathElement>('curvepath'),
      poly: $<SVGPolylineElement>('cpoly'),
      handles: [$<SVGCircleElement>('ch1'), $<SVGCircleElement>('ch2'), $<SVGCircleElement>('ch3')],
      reset: $('curvereset'),
    },
    settings.value.focus,
    (p) => settings.patch({ focus: p }),
    glide,
    // Padding / focus band changed: CodeMirror only learns the new documentPadding in its own
    // measure cycle, so the minimap must lay out after that — otherwise it still draws with the
    // old margins and the viewport box still marks the old span.
    () => {
      const relayout = () => minimapRef?.invalidate();
      view.requestMeasure({ read: () => 0, write: relayout });
      requestAnimationFrame(() => requestAnimationFrame(relayout));
    },
  );
  focusRef = focus;

  const toc = createTOC(
    view,
    $('toc'),
    () => (focus.isOn() ? focus.bandPx().top : view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.clientHeight / 6),
    glide,
    () => focusEditor(),
  );

  /* ---------- refresh orchestration ---------- */
  let wcTimer: ReturnType<typeof setTimeout> | null = null;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  function updateWordCount() {
    $('wcv').textContent = formatCounts(countText(view.state.doc.toString()));
  }
  function afterDocChange() {
    focus.syncPads();
    if (wcTimer) clearTimeout(wcTimer);
    wcTimer = setTimeout(updateWordCount, 300);
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      toc.rebuild();
      minimap.invalidate();
    }, 120);
    minimap.invalidate();
  }

  // focus and wheel guards (fighting host default behavior; see src/app/focus-guard.ts)
  const { focusEditor } = installFocusGuard(view, glide);

  view.scrollDOM.addEventListener('scroll', () => {
    minimap.layout();
    toc.spy();
  });
  addEventListener('resize', () => {
    focus.apply();
    focus.syncPads();
    minimap.layout();
    toc.spy();
  });
  // In focus mode the caret must always stay inside the focus band. We follow it on every update
  // rather than cancelling the animation on keypress — the latter lets "Enter, then keep typing"
  // interrupt a glide in progress, leaving the caret stranded outside the band.
  view.dom.addEventListener('mouseup', () => focus.keepCaretInBand());

  /* ---------- drawer + settings ---------- */
  // Drawer controls don't take focus: once focus leaves the text, CodeMirror hides the caret —
  // which is exactly how "toggle focus mode and the caret is gone" happened. Inputs are exempt;
  // they need focus anyway.
  for (const el of [document.querySelector('.drawer') as HTMLElement, $('hair'), $('scrim')]) {
    el?.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return;
      e.preventDefault();
    });
  }

  $('hair').onclick = () => document.body.classList.add('menuopen');
  $('scrim').onclick = () => document.body.classList.remove('menuopen');
  $('dclose').onclick = () => document.body.classList.remove('menuopen');

  const aseg = $('aseg');
  const aint = $<HTMLInputElement>('aint');
  const fontin = $<HTMLInputElement>('fontin');
  function reflectSettings() {
    [...aseg.children].forEach((x) =>
      x.classList.toggle('on', ((x as HTMLElement).dataset.on === '1') === settings.value.autosave),
    );
    aint.value = String(settings.value.autosaveDelay);
    aint.disabled = !settings.value.autosave;
    fontin.value = settings.value.fontFamily;
  }
  aseg.onclick = () => {
    settings.patch({ autosave: !settings.value.autosave });
    reflectSettings();
  };
  aint.onchange = () => {
    const v = Math.min(60000, Math.max(100, Number(aint.value) || 800));
    settings.patch({ autosaveDelay: v });
    reflectSettings();
  };
  fontin.onchange = () => {
    settings.patch({ fontFamily: fontin.value.trim() || settings.value.fontFamily });
    applyFont(view, settings.value.fontFamily);
    minimap.layout();
  };
  reflectSettings();

  const exportAsPdf = () => {
    document.body.classList.remove('menuopen');
    void exportPdf(platform, doc.stemName, view.state.doc.toString(), resolveAsset, toast);
  };
  $('pdfbtn').onclick = exportAsPdf;

  // window-level shortcuts (v1 has no menu bar; see src/app/shortcuts.ts)
  installShortcuts({ platform, doc, toast, setBuffer, exportPdf: exportAsPdf });

  platform.onCloseRequested(() => doc.requestClose());
  // a file handed to this window while it was already open (macOS "open with")
  platform.onOpenFile((path) => {
    void (async () => {
      try {
        setBuffer(await doc.open(path));
        toast('已打开 ' + doc.name);
      } catch (err) {
        toast('打开失败：' + (err as Error).message);
      }
    })();
  });

  /* ---------- open the file this window was launched with ---------- */
  const startup = await platform.startupPath();
  if (startup) {
    try {
      const text = await doc.open(startup);
      setBuffer(text);
    } catch (err) {
      toast('打开失败：' + (err as Error).message);
    }
  } else {
    // a blank page: in memory only until the first ⌘S, by design
    doc.setText('');
  }
  updateWordCount();
  toc.rebuild();
  minimap.layout();
  view.focus();

  // smoke probe (scripts/smoke.sh): proves the whole chain works inside the real system WebView.
  // Implemented in src/dev/smoke.ts — it is part of the production bundle; see the top of that
  // file for why.
  await runSmoke({
    view,
    platform,
    doc,
    settings,
    focusEditor,
    wordCount: () => $('wcv').textContent ?? '',
    async printTo(path) {
      const pages = await preparePrint(view.state.doc.toString(), resolveAsset);
      try {
        await platform.printPdf(path);
      } finally {
        clearPrint();
      }
      return pages;
    },
  });

  // after everything else is up; a check that hangs or fails holds nothing up
  void offerUpdate(platform);

  // test/debug handle — the app is driven through this in the behaviour suite
  window.__irori = {
    ...(window.__irori || {}),
    view,
    doc,
    settings,
    platform,
    minimap,
    toc,
    focus,
    glide,
    toast,
    focusEditor,
    // the export's pages without the export (the tests print them with the browser's own PDF)
    preparePrint: () => preparePrint(view.state.doc.toString(), resolveAsset),
    clearPrint,
  };
}

void boot();
