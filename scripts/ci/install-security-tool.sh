#!/usr/bin/env bash
set -euo pipefail

case "${1:?tool name required}" in
  trivy)
    repo=aquasecurity/trivy
    version=v0.76.2
    asset=trivy_0.76.2_Linux-64bit.tar.gz
    checksum=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf
    ;;
  osv-scanner)
    repo=google/osv-scanner
    version=v2.7.1
    asset=osv-scanner_linux_amd64
    checksum=fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8
    ;;
  zizmor)
    repo=zizmorcore/zizmor
    version=v1.32.0
    asset=zizmor-x86_64-unknown-linux-gnu.tar.gz
    checksum=bb110cc765eca9cd7efb2e284a956be5974c60027b0970f16397d86208a9957b
    ;;
  *) echo "Unknown security tool: $1" >&2; exit 2 ;;
esac

destination="${2:?destination directory required}"
mkdir -p "$destination"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
curl -fsSL --retry 4 --retry-all-errors "https://github.com/$repo/releases/download/$version/$asset" -o "$scratch/$asset"
printf '%s  %s\n' "$checksum" "$scratch/$asset" | sha256sum -c -
case "$asset" in
  *.tar.gz)
    tar -xzf "$scratch/$asset" -C "$scratch"
    binary="$(find "$scratch" -type f -name "$1" -print)"
    [[ -f "$binary" ]] || { echo "Expected one $1 binary in $asset" >&2; exit 1; }
    ;;
  *) binary="$scratch/$asset" ;;
esac
install -m 0755 "$binary" "$destination/$1"
