#!/usr/bin/env bash
# Build installers. Output goes to src-tauri/target/release/bundle/.
#   ./scripts/build.sh          current platform
#   ./scripts/build.sh --web    frontend only (dist/)
set -euo pipefail
cd "$(dirname "$0")/.."

# Rust: prefer the rustup toolchain (Tauri 2 needs rustc >= 1.88; many system package managers lag behind)
if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

npm run typecheck
if [[ "${1:-}" == "--web" ]]; then
  npx vite build
  echo "› dist/ built"
  exit 0
fi
npx tauri build ${@+"$@"}  # with no args, macOS's bundled bash 3.2 + set -u reports "$@" as unbound
echo "› output: src-tauri/target/release/bundle/"
