#!/usr/bin/env bash
# 真机冒烟：用打包出来的 .app 打开一篇文章，确认「外壳 → 读文件 → 编辑器 → 装饰」整条链路
# 在系统自带的 WebView（macOS 上是 WebKit，不是 Chrome）里真的跑得起来。
#
#   ./scripts/smoke.sh               用 debug 产物
#   ./scripts/smoke.sh --release     用 release 产物
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
done
dialog=${dialog:-0}
closeprobe=${closeprobe:-0}
bin="src-tauri/target/$profile/irori"
[[ -x "$bin" ]] || { echo "✗ 没有 $bin —— 先跑 ./scripts/build.sh"; exit 2; }

tmp="$(mktemp -d)"
doc="$tmp/冒烟.md"
out="$tmp/report.json"
cat > "$doc" <<'MD'
# 冒烟测试

这是一段中文正文，含 **粗体**、`代码` 与 [链接](https://example.com)。

> 引用一行
MD
# 再补一段长文，才有得滚（用于「聚焦不改滚动位置」这条实测）。
# 先空一行，否则这些行会成为上面那条引用的懒延续，全被吸进引用块里。
echo "" >> "$doc"
for i in $(seq 1 200); do echo "第 $i 行的正文内容，写点中文让行高接近真实情况。" >> "$doc"; done

hold=""
[[ "$shot" == "1" ]] && hold="1"
dlg=""
[[ "$dialog" == "1" ]] && dlg="1"
cls=""
[[ "$closeprobe" == "1" ]] && cls="1"
IRORI_SMOKE_OUT="$out" IRORI_SMOKE_HOLD="$hold" IRORI_SMOKE_DIALOG="$dlg" IRORI_SMOKE_CLOSE="$cls" "$bin" "$doc" >/dev/null 2>&1 &
pid=$!
for _ in $(seq 1 60); do [[ -f "$out" ]] && break; sleep 0.25; done

if [[ "$closeprobe" == "1" ]]; then
  # ⌘W 的关闭路径：报告写完后窗口会自己请求关闭，进程应当在几秒内退出
  gone=0
  for _ in $(seq 1 30); do if ! kill -0 "$pid" 2>/dev/null; then gone=1; break; fi; sleep 0.2; done
  if [[ "$gone" == "1" ]]; then
    echo "   ✓ ⌘W 的关闭流程真的把窗口关掉了"
  else
    echo "   ✗ 请求关闭后窗口没有关 —— 这就是「弹窗点了关闭，窗口却还在」"
    { kill "$pid" && wait "$pid"; } 2>/dev/null || true
    exit 1
  fi
fi

if [[ "$dialog" == "1" ]]; then
  # 主线程存活探针：开一个保存面板不回答它，再问 Rust 要窗口位置
  for _ in $(seq 1 40); do [[ -f "$out.mainthread" ]] && break; sleep 0.25; done
  if [[ -f "$out.mainthread" ]] && grep -q '"alive":true' "$out.mainthread"; then
    echo "   ✓ 对话框打开时主线程仍然活着（⌘S 不会卡死）"
  else
    echo "   ✗ 对话框把主线程锁死了 —— 这就是保存卡死"
    { kill "$pid" && wait "$pid"; } 2>/dev/null || true
    exit 1
  fi
fi

# --shot：只截这一个窗口（按它自己报回来的位置和大小），不碰屏幕上的其它东西
if [[ "$shot" == "1" && -f "$out" ]]; then
  png="${IRORI_SMOKE_SHOT:-/tmp/irori-window.png}"
  rect=$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rect;
    if (r) console.log(`${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`);
  ' "$out")
  if [[ -n "$rect" ]]; then
    sleep 1
    screencapture -x -o -R "$rect" "$png" && echo "› 窗口截图：$png"
  else
    echo "! 拿不到窗口位置，跳过截图"
  fi
fi
{ kill "$pid" && wait "$pid"; } 2>/dev/null || true

if [[ ! -f "$out" ]]; then
  echo "✗ 应用没有写出冒烟报告：窗口可能白屏，或前端根本没启动"
  exit 1
fi
echo "› 冒烟报告：$(cat "$out")"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const need = [["宿主是 Tauri", r.host === "tauri"], ["引擎是系统 WebView", r.engine === "WebKit"],
  ["读到了文件", (r.chars || 0) > 20], ["渲染出了行", (r.renderedLines || 0) >= 5],
  ["标题装饰", r.decorated.h1], ["引用装饰", r.decorated.quote], ["粗体装饰", r.decorated.bold],
  ["目录", (r.toc || 0) >= 1], ["缩略图", (r.minimapRows || 0) >= 1],
  ["透明标题栏下正文已让位", process.platform !== "darwin" || (r.overlayTitlebar && r.toplineHeight >= 24)],
  ["重新聚焦正文不会改滚动位置", r.focusKeepsScroll !== false],
  ["光标只有一条、没有黑边", !r.caret || (r.caret.count === 1 && r.caret.border === "0px")],
  ["渐隐层挂在编辑器里（盖不住光标与顶栏）", r.fadeParent === "cm-editor"],
  ["编辑器自成层叠上下文（渐隐跑不到抽屉前面）", r.editorIsolated === true]];
let bad = 0;
for (const [n, ok] of need) { console.log(`   ${ok ? "✓" : "✗"} ${n}`); if (!ok) bad++; }
// 这两条是信息，不是断言：字体取决于本机装了什么，菜单取决于宿主
console.log(`   ${r.font ? "✓" : "!"} 字体：${r.font || "配置的字体族本机一个都没有，会落到系统默认"}`);
console.log(`   ${r.menu ? "✓" : "!"} 系统菜单${r.menu ? "存在（⌘C/⌘V 有依托）" : "不存在 —— 剪贴板快捷键需实测，见 deviations.md D-41"}`);
process.exit(bad ? 1 : 0);
' "$out"
echo "› 冒烟通过"
