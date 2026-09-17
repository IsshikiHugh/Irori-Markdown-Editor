#!/usr/bin/env bash
# Development mode: open the Tauri window with frontend hot reload.
#   ./scripts/dev.sh            desktop app
#   ./scripts/dev.sh --web      browser only (in-memory file system, never touches the real disk)
set -euo pipefail
cd "$(dirname "$0")/.."

# Rust: prefer the rustup toolchain (Tauri 2 needs rustc >= 1.88; many system package managers lag behind)
if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

if [[ "${1:-}" == "--web" ]]; then
  exec npx vite
fi
exec npx tauri dev
