#!/usr/bin/env bash
# Smoke test on the real app: open a document with the bundled .app and confirm the whole chain
# "shell → read file → editor → decorations" really works inside the system WebView
# (WebKit on macOS, not Chrome).
#
#   ./scripts/smoke.sh               use the debug build
#   ./scripts/smoke.sh --release     use the release build
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -x "$HOME/.cargo/bin/cargo" ]]; then export PATH="$HOME/.cargo/bin:$PATH"; fi

profile=debug
shot=0
for a in "$@"; do
  [[ "$a" == "--release" ]] && profile=release
  [[ "$a" == "--shot" ]] && shot=1
  [[ "$a" == "--dialog" ]] && dialog=1
  [[ "$a" == "--close" ]] && closeprobe=1
  [[ "$a" == "--pdf" ]] && pdfprobe=1
done
dialog=${dialog:-0}
closeprobe=${closeprobe:-0}
pdfprobe=${pdfprobe:-0}
bin="src-tauri/target/$profile/irori"
[[ -x "$bin" ]] || { echo "✗ $bin not found — run ./scripts/build.sh first"; exit 2; }

tmp="$(mktemp -d)"
doc="$tmp/冒烟.md"
out="$tmp/report.json"
cat > "$doc" <<'MD'
# 冒烟测试

这是一段中文正文，含 **粗体**、`代码` 与 [链接](https://example.com)。

> 引用一行

9. 九
10. 十

| 名称 | 数量 |
| --- | --: |
| 苹果 | 3 |

```ts
const n: number = 2;
```

$$ \frac{a}{b} $$
MD
# a 4x3 red PNG next to the document (the export carries it; see the end of the text below)
echo "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC" | base64 -d > "$tmp/pic.png"
# Append a long run of text so there is something to scroll (needed by the "refocus keeps the
# scroll position" check). Blank line first, so these lines stay out of the list above.
echo "" >> "$doc"
for i in $(seq 1 200); do echo "第 $i 行的正文内容，写点中文让行高接近真实情况。" >> "$doc"; done
# a picture for the PDF export to carry — at the very end, so its late load cannot move the lines
# the scroll probe above measures
printf '\n![](pic.png)\n' >> "$doc"

hold=""
[[ "$shot" == "1" ]] && hold="1"
dlg=""
[[ "$dialog" == "1" ]] && dlg="1"
cls=""
[[ "$closeprobe" == "1" ]] && cls="1"
pdf=""
[[ "$pdfprobe" == "1" ]] && pdf="1"
IRORI_SMOKE_OUT="$out" IRORI_SMOKE_HOLD="$hold" IRORI_SMOKE_DIALOG="$dlg" IRORI_SMOKE_CLOSE="$cls" IRORI_SMOKE_PDF="$pdf" "$bin" "$doc" >/dev/null 2>&1 &
pid=$!
for _ in $(seq 1 60); do [[ -f "$out" ]] && break; sleep 0.25; done

if [[ "$closeprobe" == "1" ]]; then
  # The ⌘W close path: after writing the report the window requests close; the process should exit within seconds
  gone=0
  for _ in $(seq 1 30); do if ! kill -0 "$pid" 2>/dev/null; then gone=1; break; fi; sleep 0.2; done
  if [[ "$gone" == "1" ]]; then
    echo "   ✓ the ⌘W close flow really closed the window"
  else
    echo "   ✗ the window did not close after the close request — this is the \"confirmed close, window stays\" bug"
    { kill "$pid" && wait "$pid"; } 2>/dev/null || true
    exit 1
  fi
fi

if [[ "$dialog" == "1" ]]; then
  # Main-thread liveness probe: open a save panel, leave it unanswered, then ask Rust for the window position
  for _ in $(seq 1 40); do [[ -f "$out.mainthread" ]] && break; sleep 0.25; done
  if [[ -f "$out.mainthread" ]] && grep -q '"alive":true' "$out.mainthread"; then
    echo "   ✓ the main thread stays alive while a dialog is open (⌘S cannot freeze)"
  else
    echo "   ✗ the dialog deadlocked the main thread — this is the save freeze"
    { kill "$pid" && wait "$pid"; } 2>/dev/null || true
    exit 1
  fi
fi

if [[ "$pdfprobe" == "1" ]]; then
  # PDF export through WKWebView's own print operation, written straight to a file
  if ! node -e '
    const fs = require("fs");
    const [info, pdf] = process.argv.slice(1);
    const r = JSON.parse(fs.readFileSync(info, "utf8"));
    const bytes = fs.existsSync(pdf) ? fs.readFileSync(pdf) : null;
    const raw = bytes ? bytes.toString("latin1") : "";
    const pages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
    // the head ornament and the picture in the document
    const images = (raw.match(/\/Subtype\s*\/Image/g) || []).length;
    const ok = !r.error && r.pages >= 2 && pages === r.pages && images >= 2;
    console.log(`   ${ok ? "✓" : "✗"} PDF export: ${pages} page(s) written, ${r.pages} laid out, ${images} picture(s)${r.error ? " — " + r.error : ""}`);
    process.exit(ok ? 0 : 1);
  ' "$out.pdfinfo" "$out.pdf"; then
    { kill "$pid" && wait "$pid"; } 2>/dev/null || true
    exit 1
  fi
  [[ -n "${IRORI_SMOKE_PDF_KEEP:-}" ]] && cp "$out.pdf" "$IRORI_SMOKE_PDF_KEEP" && echo "   › kept: $IRORI_SMOKE_PDF_KEEP"
fi

# --shot: capture only this window (at the position and size it reports), nothing else on screen
if [[ "$shot" == "1" && -f "$out" ]]; then
  png="${IRORI_SMOKE_SHOT:-/tmp/irori-window.png}"
  rect=$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rect;
    if (r) console.log(`${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`);
  ' "$out")
  if [[ -n "$rect" ]]; then
    sleep 1
    screencapture -x -o -R "$rect" "$png" && echo "› window screenshot: $png"
  else
    echo "! could not get the window position, skipping the screenshot"
  fi
fi
{ kill "$pid" && wait "$pid"; } 2>/dev/null || true

if [[ ! -f "$out" ]]; then
  echo "✗ the app wrote no smoke report: the window may be blank, or the frontend never started"
  exit 1
fi
echo "› smoke report: $(cat "$out")"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const need = [["host is Tauri", r.host === "tauri"], ["engine is the system WebView", r.engine === "WebKit"],
  ["settings are saved and read back", r.settingsPersist === true],
  ["file was read", (r.chars || 0) > 20], ["lines were rendered", (r.renderedLines || 0) >= 5],
  ["heading decoration", r.decorated.h1], ["quote decoration", r.decorated.quote], ["bold decoration", r.decorated.bold],
  ["list numbers line up on the dot", r.listDots != null && Math.abs(r.listDots) <= 0.6],
  ["table rendered", r.decorated.table === true],
  ["code block coloured (its language loaded as a separate chunk)", r.decorated.code === true],
  ["math block typeset (KaTeX loaded as a separate chunk)", r.decorated.math === true],
  ["table of contents", (r.toc || 0) >= 1], ["minimap", (r.minimapRows || 0) >= 1],
  ["text clears the transparent title bar", process.platform !== "darwin" || (r.overlayTitlebar && r.toplineHeight >= 24)],
  ["refocusing the editor keeps the scroll position", r.focusKeepsScroll !== false],
  ["exactly one caret, no black border", !r.caret || (r.caret.count === 1 && r.caret.border === "0px")],
  ["fade layer lives inside the editor (cannot cover the caret or top bar)", r.fadeParent === "cm-editor"],
  ["editor is its own stacking context (fade cannot cover the drawer)", r.editorIsolated === true]];
let bad = 0;
for (const [n, ok] of need) { console.log(`   ${ok ? "✓" : "✗"} ${n}`); if (!ok) bad++; }
// These two are informational, not assertions: the font depends on what is installed, the menu on the host
console.log(`   ${r.font ? "✓" : "!"} font: ${r.font || "none of the configured families is installed; falls back to the system default"}`);
console.log(`   ${r.menu ? "✓" : "!"} system menu ${r.menu ? "present (⌘C/⌘V have something to hang off)" : "missing — clipboard shortcuts need a manual check"}`);
process.exit(bad ? 1 : 0);
' "$out"
echo "› smoke test passed"
