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
import { countText, formatCounts } from './features/wordcount';
import { installFocusGuard } from './app/focus-guard';
import { installShortcuts } from './app/shortcuts';
import { runSmoke } from './dev/smoke';

/* getElementById 的返回类型写死在 HTMLElement 上，取 SVG 节点时每处都要双重强转。
   这里把强转收进来一次，调用方写 $<SVGPathElement>('curvepath') 即可。 */
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

  /* 图片 src → <img> 能加载的地址。正文和缩略图是两个渲染器，但解析规则必须是同一条：
     网络/内联地址原样放行，其余按当前文档的位置解析成绝对路径再交给宿主。 */
  const resolveAsset = (src: string): string | null => {
    if (/^(https?:|data:)/i.test(src)) return src;
    const abs = doc.path ? resolveAgainst(doc.path, src) : null;
    return abs ? platform.assetUrl(abs) : null;
  };

  /* 专注模式下光标要一直待在聚焦带里；每帧最多跟一次 */
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
  // 渐隐层放进编辑器里：这样它盖得住正文，却盖不住光标（CodeMirror 的光标层 z-index 150），
  // 也盖不住编辑器之外的顶部标题栏
  view.dom.appendChild($('fade'));
  // macOS 下标题栏是透明的（tauri.conf.json: titleBarStyle=Overlay），正文要给红绿灯让位
  if (platform.kind === 'tauri' && /Mac/.test(navigator.userAgent)) document.body.classList.add('overlay-titlebar');

  /* ---------- features ---------- */
  // 一个滑动器，三处共用（目录点击 / 缩略图点击 / 专注模式拉回光标），
  // 这样它们不会各滚各的
  const glide = createGlide(view);

  // 缩略图与专注模式互相要用到对方（选框要知道聚焦带、聚焦带变了要重排缩略图），
  // 用两个引用把这层循环解开，免得谁先谁后都踩到「还没初始化」。
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
      // 专注模式下真正看得见的只有聚焦带，选框就该标那一段（带外是渐隐的）
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
    // 内边距 / 聚焦带一变：CodeMirror 要等自己的测量周期才知道新的 documentPadding，
    // 缩略图必须在那之后再排，否则它还按旧的留白画、选框也还标着旧的那一段。
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

  // 焦点与滚轮的守卫（对抗宿主默认行为，见 src/app/focus-guard.ts）
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
  // 专注模式下光标要一直待在聚焦带里。用「每次更新跟一下」而不是「按键时取消动画」——
  // 后者会让「回车后接着打字」把正在进行的滑动打断，光标就被留在带外了。
  view.dom.addEventListener('mouseup', () => focus.keepCaretInBand());

  /* ---------- drawer + settings ---------- */
  // 抽屉里的控件不抢焦点：焦点一旦离开正文，CodeMirror 就会把光标藏起来 ——
  // 而「开关一下专注模式，光标就没了」正是这么来的。输入框除外，它们本来就要焦点。
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

  // 窗口级快捷键（v1 没有菜单栏，见 src/app/shortcuts.ts）
  installShortcuts({ platform, doc, toast, setBuffer });

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
    // a 白纸: in memory only until the first ⌘S, by design
    doc.setText('');
  }
  updateWordCount();
  toc.rebuild();
  minimap.layout();
  view.focus();

  // 冒烟探针（scripts/smoke.sh）：在真实系统 WebView 里证明整条链路通了。
  // 实现在 src/dev/smoke.ts —— 它是生产包的一部分，理由见那个文件的开头。
  await runSmoke({
    view,
    platform,
    doc,
    settings,
    focusEditor,
    wordCount: () => $('wcv').textContent ?? '',
  });

  // test/debug handle — the app is driven through this in the behaviour suite
  window.__irori = { ...(window.__irori || {}), view, doc, settings, platform, minimap, toc, focus, glide, toast, focusEditor };
}

void boot();
