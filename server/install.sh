#!/bin/sh
# Install the standalone irori-host binary (no Node needed) from the latest Irori release.
#
#   curl -fsSL https://raw.githubusercontent.com/IsshikiHugh/Irori-Markdown-Editor/main/server/install.sh | sh
#
# IRORI_HOST_BIN_DIR picks the install folder (default ~/.local/bin); IRORI_HOST_VERSION a release
# tag (default: the latest). Linux (glibc or musl) and macOS, x64 and arm64. Elsewhere:
# npx irori-host. The download is checked against the release's SHA256SUMS before it is installed.
set -eu

repo=IsshikiHugh/Irori-Markdown-Editor
dir=${IRORI_HOST_BIN_DIR:-$HOME/.local/bin}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "irori-host: no binary for $(uname -s); use 'npx irori-host' (Node >= 18)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "irori-host: no binary for $(uname -m); use 'npx irori-host' (Node >= 18)" >&2; exit 1 ;;
esac
libc=
# Alpine and other musl systems cannot run the glibc build
if [ "$os" = linux ] && { ls /lib/ld-musl-* > /dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then
  libc=-musl
fi
name="irori-host-$os-$arch$libc.gz"

if [ -n "${IRORI_HOST_BASE_URL:-}" ]; then # a mirror, or a local build (the release's files)
  base=$IRORI_HOST_BASE_URL
elif [ -n "${IRORI_HOST_VERSION:-}" ]; then
  base="https://github.com/$repo/releases/download/$IRORI_HOST_VERSION"
else
  base="https://github.com/$repo/releases/latest/download"
fi

if command -v sha256sum > /dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum > /dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  echo "irori-host: need sha256sum or shasum to check the download" >&2
  exit 1
fi

mkdir -p "$dir"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "downloading $base/$name"
curl -fL --progress-bar "$base/$name" -o "$tmp/$name"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
want=$(grep " \*\{0,1\}$name\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
got=$(sha "$tmp/$name")
if [ -z "$want" ] || [ "$want" != "$got" ]; then
  echo "irori-host: checksum mismatch for $name (expected ${want:-nothing}, got $got); not installed" >&2
  exit 1
fi
gunzip -c "$tmp/$name" > "$tmp/irori-host"
chmod +x "$tmp/irori-host"
mv "$tmp/irori-host" "$dir/irori-host"
echo "installed $dir/irori-host"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "note: $dir is not on PATH; add it, or run $dir/irori-host" ;;
esac
