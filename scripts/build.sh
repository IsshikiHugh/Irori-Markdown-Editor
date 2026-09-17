#!/usr/bin/env bash
# 打包安装包。产物落在 src-tauri/target/release/bundle/。
#   ./scripts/build.sh          当前平台
#   ./scripts/build.sh --web    只构建前端（dist/）
set -euo pipefail
cd "$(dirname "$0")/.."

# Rust：优先用 rustup 装的工具链（Tauri 2 需要 rustc >= 1.88，很多系统包管理器还停在旧版本）
if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

npm run typecheck
if [[ "${1:-}" == "--web" ]]; then
  npx vite build
  echo "› dist/ 已构建"
  exit 0
fi
npx tauri build ${@+"$@"}  # 空参数时 macOS 自带 bash 3.2 + set -u 会报 unbound
echo "› 产物：src-tauri/target/release/bundle/"
