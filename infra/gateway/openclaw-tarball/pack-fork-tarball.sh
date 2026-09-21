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
#    Do not add workspace deps to `bundleDependencies`: that makes npm bundle
#    the dep's ENTIRE transitive closure out of the pnpm node_modules
#    symlink farm, producing an inconsistent tree (an empty
#    @modelcontextprotocol/sdk → the CLI can't load its MCP runtime; installs
#    "green", crash-loops at the codex-plugin install step). The `file:` vendor
#    touches only the one unpublished package. Preserve upstream's explicit
#    bundles, which may contain patched runtime bytes unavailable on npm.
#
# 2. Compile Codex and Parallel from the same checkout as core and include
#    them as vendor/<pkg>.tgz, including when that version exists on npm.
#
# @openclaw/mattermost is deliberately NOT vendored here. It ships as its own
# content-addressed GCS artifact so the exact channel runtime is independently
# pinned and verified on every slot, including dev.
#
# Usage: pack-fork-tarball.sh [FORK_DIR] [OUT_DIR]
#   FORK_DIR  fork checkout    (default: ~/workspace/openclaw/openclaw)
#   OUT_DIR   tarball dest dir (default: /tmp/openclaw-fork)
# Set OPENCLAW_SKIP_BUILD=1 when the source was built in the same cycle.
# Prints the tarball path on success. ALWAYS run the Step 7 install-verify after.
set -euo pipefail

FORK_DIR="${1:-$HOME/workspace/openclaw/openclaw}"
OUT_DIR="${2:-/tmp/openclaw-fork}"
cd "$FORK_DIR"

if [ -e vendor ] || [ -L vendor ]; then
  echo "FATAL: fork source has a pre-existing ignored vendor path — move it before packing" >&2
  exit 1
fi

if [ "${OPENCLAW_SKIP_BUILD:-0}" != "1" ]; then
  echo "  building fork source" >&2
  pnpm build >&2
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/openclaw-[0-9]*.tgz

OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG=1 \
  node --import ./scripts/tsx.mjs --input-type=module -e '
    const { preparePrepackArtifacts } = await import("./scripts/openclaw-prepack.ts");
    await preparePrepackArtifacts();
  ' >&2

PKG_BACKUP="$(mktemp)" || { node scripts/openclaw-postpack.mjs >&2; exit 1; }
if ! cp package.json "$PKG_BACKUP"; then
  node scripts/openclaw-postpack.mjs >&2
  rm -f "$PKG_BACKUP"
  exit 1
fi
restore() {
  cp "$PKG_BACKUP" package.json || return 1
  rm -rf vendor || return 1
  node scripts/openclaw-postpack.mjs >&2 || return 1
  rm -f "$PKG_BACKUP"
}
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
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  "
  echo "  vendored workspace dep: $name@$ver -> file:$vend" >&2
done

for ext in codex parallel; do
  name="$(node -e "console.log(require('./extensions/$ext/package.json').name)")"
  ver="$(node -e "console.log(require('./extensions/$ext/package.json').version)")"
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
  echo "  vendored source-matched companion: $name@$ver -> $vendtgz" >&2
done

npm pack --ignore-scripts --pack-destination "$OUT_DIR" >&2
TARBALL="$OUT_DIR/$(ls -t "$OUT_DIR"/openclaw-[0-9]*.tgz | head -1 | xargs basename)"
trap - EXIT
restore
echo "$TARBALL"
