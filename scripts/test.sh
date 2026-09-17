#!/usr/bin/env bash
# 全量验证：类型 → 单元 → 行为（headless Chromium）→ Rust 外壳。
#   ./scripts/test.sh           全部
#   ./scripts/test.sh --fast    跳过 Rust
#   ./scripts/test.sh B-2       只跑某一组行为用例
set -euo pipefail
cd "$(dirname "$0")/.."

# Rust：优先用 rustup 装的工具链（Tauri 2 需要 rustc >= 1.88，很多系统包管理器还停在旧版本）
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

echo "› 类型检查"
npm run typecheck

echo "› 单元测试"
npx vitest run

echo "› 构建"
npx vite build >/dev/null

echo "› 行为测试"
if [[ -n "$only" ]]; then
  node tests/e2e/run.mjs --only "$only"
else
  node tests/e2e/run.mjs --report
fi

if [[ -n "${IRORI_LEGACY_BLOG:-}" ]]; then
  echo "› 对照实验（新 vs 旧）"
  # 比哪几篇由 IRORI_COMPARE_SLUGS 给（空格分隔）—— 文章是各人博客里的，这里不写死
  [[ -n "${IRORI_COMPARE_SLUGS:-}" ]] || echo "  跳过：未设置 IRORI_COMPARE_SLUGS（空格分隔的文章 slug）"
  for slug in ${IRORI_COMPARE_SLUGS:-}; do
    node tests/compare/run.mjs --slug $slug
  done
fi

if [[ "$fast" == "0" ]]; then
  echo "› Rust 外壳"
  cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

  echo "› 打包 debug 产物（冒烟要用当前代码，不能拿旧产物当数）"
  npx tauri build --debug --bundles app >/dev/null
  echo "› 真机冒烟（系统 WebView）"
  ./scripts/smoke.sh --dialog
  ./scripts/smoke.sh --close
fi
echo "› 全部通过"
