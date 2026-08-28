#!/usr/bin/env bash
# Pack the OpenClaw fork into a SELF-CONTAINED tarball for the gateway base image.
#
# Two publication gaps make a plain `npm pack` insufficient:
#
# 1. workspace:* root deps (since 7.1: @openclaw/ai). `npm pack` ships the
#    specifier verbatim (upstream's own release rewrites it via
#    prepare-openclaw-npm-shrinkwrap.ts at publish time) and the base image's
#    `npm install -g` dies on it. Fix: vendor each workspace:* root dep into
#    `vendor/<name>/` INSIDE the tarball and rewrite its spec to
#    `file:vendor/<name>`. npm copies it from the vendored path and resolves
#    everything else (incl. its transitive deps and the shipped
#    npm-shrinkwrap.json's pinned tree) normally from the registry.
#
#    Do NOT use `bundleDependencies` for this: on a pnpm workspace it makes npm
#    bundle the dep's ENTIRE transitive closure out of the pnpm node_modules
#    symlink farm, producing an inconsistent tree (an empty
#    @modelcontextprotocol/sdk → the CLI can't load its MCP runtime; installs
#    "green", crash-loops at the codex-plugin install step). The `file:` vendor
#    touches only the one unpublished package.
#
# 2. Companion plugins the base image installs from npm (@openclaw/codex,
#    @openclaw/parallel-plugin). A tagged release publishes them in lockstep
#    (eventually); a dev-slot snapshot of upstream main has NO published
#    version. When the exact version is missing from npm, compile each via
#    upstream's own plugin release tool and ship it as vendor/<pkg>.tgz;
#    Dockerfile.base prefers the vendored tarball and falls back to npm.
#    Published versions therefore vendor nothing — self-healing, no Dockerfile
#    change per cycle.
#
# @openclaw/mattermost is deliberately NOT vendored here: the fork always
# patches it, so it ships as its own content-addressed GCS artifact (ceremony
# Step 7b, _OPENCLAW_MATTERMOST_FORK_SHA) on every slot including dev.
#
# Usage: pack-fork-tarball.sh [FORK_DIR] [OUT_DIR]
#   FORK_DIR  fork checkout    (default: ~/workspace/openclaw/openclaw)
#   OUT_DIR   tarball dest dir (default: /tmp/openclaw-fork)
# Precondition: the checkout is clean. The script builds from HEAD before packing.
# Prints the tarball path on success. ALWAYS run the Step 7 install-verify after.
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
if [ -e vendor ] || [ -L vendor ]; then
  echo "FATAL: fork source has a pre-existing ignored vendor path — move it before packing" >&2
  exit 1
fi

echo "  building clean fork source at $SOURCE_HEAD" >&2
pnpm build >&2

if ! BUILT_HEAD="$(git rev-parse --verify HEAD 2>/dev/null)" \
  || [ "$BUILT_HEAD" != "$SOURCE_HEAD" ]; then
  echo "FATAL: fork source HEAD changed while building" >&2
  exit 1
fi
BUILT_STATUS="$(git status --porcelain --untracked-files=all)"
if [ -n "$BUILT_STATUS" ]; then
  echo "FATAL: fork build changed the source tree — generated output must remain ignored" >&2
  printf '%s\n' "$BUILT_STATUS" >&2
  exit 1
fi

if [ ! -f dist/build-info.json ]; then
  echo "FATAL: fork build did not produce dist/build-info.json" >&2
  exit 1
fi
RUNTIME_COMMIT="$(node -e '
  const info = require("./dist/build-info.json");
  if (typeof info.commit === "string") process.stdout.write(info.commit.trim());
')"
if ! [[ "$RUNTIME_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FATAL: built dist/build-info.json has no full lowercase commit" >&2
  exit 1
fi
if [ "$RUNTIME_COMMIT" != "$SOURCE_HEAD" ]; then
  echo "FATAL: built dist/build-info.json commit does not match git HEAD" >&2
  exit 1
fi
if ! node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const commit = process.argv[1];
  const assets = "dist/control-ui/assets";
  const matches = fs.readdirSync(assets)
    .filter((name) => name.endsWith(".js"))
    .some((name) => fs.readFileSync(path.join(assets, name), "utf8").includes(commit));
  process.exit(matches ? 0 : 1);
' "$RUNTIME_COMMIT"; then
  echo "FATAL: bundled Control UI build identity does not match runtime" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/openclaw-[0-9]*.tgz

PKG_BACKUP="$(mktemp)"
cp package.json "$PKG_BACKUP"
restore() { cp "$PKG_BACKUP" package.json; rm -rf vendor; rm -f "$PKG_BACKUP"; }
trap restore EXIT

WS_DEPS="$(node -e '
  const p = require("./package.json");
  const all = { ...p.dependencies, ...p.optionalDependencies };
  console.log(Object.entries(all)
    .filter(([, v]) => String(v).startsWith("workspace:"))
    .map(([k]) => k).join("\n"));
')"

for name in $WS_DEPS; do
  [ -z "$name" ] && continue
  abspkg="$(cd "node_modules/$name" && pwd -P)"
  ver="$(node -e "console.log(require('$abspkg/package.json').version)")"
  vend="vendor/$(echo "$name" | sed 's|^@||; s|/|-|g')"

  tmpp="$(mktemp -d)"
  ( cd "$abspkg" && npm pack --ignore-scripts --pack-destination "$tmpp" >/dev/null )
  mkdir -p "$vend"
  tar -xzf "$tmpp"/*.tgz -C "$vend" --strip-components=1
  rm -rf "$tmpp"
  nested_runtime_ws="$(node -e '
    const p = require("./" + process.argv[1]);
    const all = { ...p.dependencies, ...p.optionalDependencies };
    console.log(Object.entries(all)
      .filter(([, v]) => String(v).startsWith("workspace:"))
      .map(([k]) => k).join("\n"));
  ' "$vend/package.json")"
  if [ -n "$nested_runtime_ws" ]; then
    echo "FATAL: $name carries nested runtime workspace:* specs ($nested_runtime_ws) — extend vendoring" >&2
    exit 1
  fi

  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('package.json','utf8'));
    if (p.dependencies && p.dependencies['$name']) p.dependencies['$name'] = 'file:$vend';
    if (p.optionalDependencies && p.optionalDependencies['$name']) p.optionalDependencies['$name'] = 'file:$vend';
    if (!p.files.includes('vendor/')) p.files.push('vendor/');
    delete p.bundleDependencies;
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  "
  echo "  vendored workspace dep: $name@$ver -> file:$vend" >&2
done

for ext in codex parallel; do
  name="$(node -e "console.log(require('./extensions/$ext/package.json').name)" 2>/dev/null || true)"
  [ -z "$name" ] && continue
  ver="$(node -e "console.log(require('./extensions/$ext/package.json').version)")"
  if published="$(npm view "$name@$ver" version 2>&1)"; then
    echo "  companion published: $name@$ver — no vendoring" >&2
    continue
  elif ! grep -q "E404" <<<"$published"; then
    echo "FATAL: npm view $name@$ver inconclusive (registry unreachable?): $published" >&2
    exit 1
  fi
  mkdir -p vendor
  extout="$(mktemp -d)"
  OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR="$extout" \
    bash scripts/plugin-npm-publish.sh --pack "extensions/$ext" >&2
  vendtgz="vendor/$(echo "$name" | sed 's|^@||; s|/|-|g').tgz"
  cp "$extout"/*.tgz "$vendtgz"
  rm -rf "$extout"
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('package.json','utf8'));
    if (!p.files.includes('vendor/')) p.files.push('vendor/');
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  "
  echo "  vendored unpublished companion: $name@$ver -> $vendtgz" >&2
done

npm pack --ignore-scripts --pack-destination "$OUT_DIR" >&2
TARBALL="$OUT_DIR/$(ls -t "$OUT_DIR"/openclaw-[0-9]*.tgz | head -1 | xargs basename)"
if ! PACKED_BUILD_INFO="$(tar -xzOf "$TARBALL" package/dist/build-info.json 2>/dev/null)"; then
  echo "FATAL: packed artifact is missing package/dist/build-info.json" >&2
  exit 1
fi
PACKED_COMMIT="$(node -e '
  const info = JSON.parse(process.argv[1]);
  if (typeof info.commit === "string") process.stdout.write(info.commit.trim());
' "$PACKED_BUILD_INFO")"
if [ "$PACKED_COMMIT" != "$SOURCE_HEAD" ]; then
  echo "FATAL: packed artifact build-info commit does not match git HEAD" >&2
  exit 1
fi
echo "$TARBALL"
