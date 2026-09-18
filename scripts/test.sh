#!/usr/bin/env bash
# Full verification: types → unit → behaviour (headless Chromium) → Rust shell.
#   ./scripts/test.sh           everything
#   ./scripts/test.sh --fast    skip Rust
#   ./scripts/test.sh B-2       run one group of behaviour cases only
set -euo pipefail
cd "$(dirname "$0")/.."

# Rust: prefer the rustup toolchain (Tauri 2 needs rustc >= 1.88; many system package managers lag behind)
if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi


only=""
fast=0
for arg in "$@"; do
  case "$arg" in
    --fast) fast=1 ;;
    B-*) only="$arg" ;;
  esac
done

echo "› typecheck"
npm run typecheck

echo "› unit tests"
npx vitest run

echo "› build"
npx vite build >/dev/null

echo "› behaviour tests"
if [[ -n "$only" ]]; then
  node tests/e2e/run.mjs --only "$only"
else
  node tests/e2e/run.mjs --report
fi

if [[ -n "${IRORI_LEGACY_BLOG:-}" ]]; then
  echo "› comparison against the legacy editor"
  # Which posts to compare comes from IRORI_COMPARE_SLUGS (space-separated) — they live in each
  # person's own blog, so nothing is hard-coded here
  [[ -n "${IRORI_COMPARE_SLUGS:-}" ]] || echo "  skipped: IRORI_COMPARE_SLUGS is not set (space-separated post slugs)"
  for slug in ${IRORI_COMPARE_SLUGS:-}; do
    node tests/compare/run.mjs --slug $slug
  done
fi

if [[ "$fast" == "0" ]]; then
  echo "› Rust shell"
  cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

  echo "› build debug bundle (the smoke test must run the current code, not a stale build)"
  npx tauri build --debug --bundles app >/dev/null
  echo "› smoke test (system WebView)"
  ./scripts/smoke.sh --dialog
  ./scripts/smoke.sh --close
  ./scripts/smoke.sh --pdf
fi
echo "› all passed"
