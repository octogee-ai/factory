#!/usr/bin/env bash
set -euo pipefail

FORK_DIR="${1:-$HOME/workspace/openclaw/openclaw}"
OUT_DIR="${2:-/tmp/openclaw-fork}"
cd "$FORK_DIR"

if ! SOURCE_HEAD="$(git rev-parse --verify HEAD 2>/dev/null)" \
  || ! [[ "$SOURCE_HEAD" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FATAL: fork source must be a Git checkout at a full commit" >&2
  exit 1
fi
SOURCE_STATUS="$(git status --porcelain --untracked-files=all)"
if [ -n "$SOURCE_STATUS" ]; then
  echo "FATAL: fork source tree is not clean — commit or remove every local change before packing" >&2
  printf '%s\n' "$SOURCE_STATUS" >&2
  exit 1
fi

RAW_DIR="$(mktemp -d -t openclaw-mattermost-raw-XXXXXX)"
STAGE_DIR="$(mktemp -d -t openclaw-mattermost-stage-XXXXXX)"
cleanup() { rm -rf "$RAW_DIR" "$STAGE_DIR"; }
trap cleanup EXIT

OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR="$RAW_DIR" \
  bash scripts/plugin-npm-publish.sh --pack extensions/mattermost >&2

if ! BUILT_HEAD="$(git rev-parse --verify HEAD 2>/dev/null)" \
  || [ "$BUILT_HEAD" != "$SOURCE_HEAD" ]; then
  echo "FATAL: fork source HEAD changed while packing Mattermost" >&2
  exit 1
fi
BUILT_STATUS="$(git status --porcelain --untracked-files=all)"
if [ -n "$BUILT_STATUS" ]; then
  echo "FATAL: Mattermost build changed the source tree" >&2
  printf '%s\n' "$BUILT_STATUS" >&2
  exit 1
fi

set -- "$RAW_DIR"/openclaw-mattermost-*.tgz
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "FATAL: Mattermost pack must emit exactly one tarball" >&2
  exit 1
fi
tar -xzf "$1" -C "$STAGE_DIR"
if [ ! -f "$STAGE_DIR/package/dist/index.js" ]; then
  echo "FATAL: Mattermost artifact is missing compiled runtime output" >&2
  exit 1
fi
node -e '
  const fs = require("node:fs");
  const [file, source] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.octogeeSourceCommit = source;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$STAGE_DIR/package/package.json" "$SOURCE_HEAD"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/openclaw-mattermost-[0-9]*.tgz
(
  cd "$STAGE_DIR/package"
  npm pack --ignore-scripts --pack-destination "$OUT_DIR" >&2
)
set -- "$OUT_DIR"/openclaw-mattermost-*.tgz
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "FATAL: Mattermost repack must emit exactly one tarball" >&2
  exit 1
fi
PACKED_SOURCE_HEAD="$(
  tar -xzOf "$1" package/package.json \
    | node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(typeof p.octogeeSourceCommit === "string" ? p.octogeeSourceCommit : "")'
)"
if [ "$PACKED_SOURCE_HEAD" != "$SOURCE_HEAD" ]; then
  echo "FATAL: packed Mattermost source identity does not match git HEAD" >&2
  exit 1
fi
echo "$1"
