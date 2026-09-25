#!/usr/bin/env bash
# Compile server/irori-host.mjs into standalone binaries (no Node needed on the host) with Bun.
#
#   ./scripts/build-host.sh [out-dir]      # default: dist-host
#
# Writes irori-host-<os>-<arch>[-musl].gz for Linux / macOS (what server/install.sh downloads),
# irori-host-windows-x64.exe, and SHA256SUMS over all of them. Bun cross-compiles every target
# from one machine; on macOS the darwin binaries are signed ad hoc so Apple Silicon runs them.
# x64 builds use Bun's baseline targets: the default ones need AVX2, which some virtual machines
# and older CPUs lack ("Illegal instruction").
set -euo pipefail

cd "$(dirname "$0")/.."
out=${1:-dist-host}
bun=${BUN:-bun}
command -v "$bun" > /dev/null || bun="npx -y bun@1.4.2"

# published name → Bun target
targets=(
  linux-x64:linux-x64-baseline
  linux-arm64:linux-arm64
  linux-x64-musl:linux-x64-musl-baseline
  linux-arm64-musl:linux-arm64-musl
  darwin-x64:darwin-x64-baseline
  darwin-arm64:darwin-arm64
  windows-x64:windows-x64-baseline
)

rm -rf "$out"
mkdir -p "$out"
for pair in "${targets[@]}"; do
  name=${pair%%:*}
  target=${pair#*:}
  file="$out/irori-host-$name"
  [[ $name == windows-* ]] && file+=.exe
  $bun build --compile --minify --target="bun-$target" server/irori-host.mjs --outfile "$file"
  if [[ $name == darwin-* && $(uname -s) == Darwin ]]; then
    codesign --sign - --force "$file"
  fi
  [[ $name == windows-* ]] || gzip -9 "$file"
done
(
  cd "$out"
  if command -v sha256sum > /dev/null; then sha256sum irori-host-*; else shasum -a 256 irori-host-*; fi > SHA256SUMS
)
ls -l "$out"
