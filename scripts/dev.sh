#!/usr/bin/env bash
# 开发模式：起 Tauri 窗口，前端热更新。
#   ./scripts/dev.sh            桌面应用
#   ./scripts/dev.sh --web      只在浏览器里跑（内存文件系统，不碰真实磁盘）
set -euo pipefail
cd "$(dirname "$0")/.."

# Rust：优先用 rustup 装的工具链（Tauri 2 需要 rustc >= 1.88，很多系统包管理器还停在旧版本）
if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

if [[ "${1:-}" == "--web" ]]; then
  exec npx vite
fi
exec npx tauri dev
