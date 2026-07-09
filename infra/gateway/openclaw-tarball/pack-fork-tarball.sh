#!/usr/bin/env bash
# Pack the OpenClaw fork into a SELF-CONTAINED tarball for the gateway base image.
#
# Why this exists (learned on the 2026.7.1-beta.3 roll):
#   We pack with `npm pack` instead of `pnpm pack` (pnpm pack hits catastrophic
#   regex backtracking on OC's exports map — see the ceremony README). But unlike
#   pnpm, `npm pack` does NOT rewrite `workspace:*` dependency specifiers. Starting
#   with 2026.7.1-beta.3, the root package.json declares `@openclaw/ai: workspace:*`
#   — an in-monorepo package that is NOT published to npm (only a 0.0.0 squat
#   exists). A plain `npm pack` tarball therefore dies in Dockerfile.base at
#   `npm install -g /tmp/openclaw-fork.tgz` (can't resolve @openclaw/ai@workspace:*).
#
#   Fix: vendor each `workspace:*` root dep into `vendor/<name>/` INSIDE the tarball
#   and rewrite its spec to `file:vendor/<name>`. On install npm copies it from the
#   vendored path and resolves EVERYTHING ELSE (incl. its transitive deps and the
#   shipped npm-shrinkwrap.json's pinned tree) normally from the registry.
#
#   NOTE — do NOT use `bundleDependencies` for this: on a pnpm workspace it makes
#   npm bundle the dep's ENTIRE transitive closure out of the pnpm node_modules
#   symlink farm, producing an inconsistent tree (e.g. an empty
#   @modelcontextprotocol/sdk → the CLI can't load its MCP runtime). The `file:`
#   vendor is surgical: it touches only the one unpublished package. (This bit us
#   once on beta.3 — the bundleDependencies tarball installed but crash-looped the
#   codex-plugin install step. The `file:` tarball installs clean.)
#
#   With no workspace deps (6.11 and earlier) this degrades to a plain `npm pack`.
#
# Usage: pack-fork-tarball.sh [FORK_DIR] [OUT_DIR]
#   FORK_DIR  fork checkout    (default: ~/workspace/openclaw/openclaw)
#   OUT_DIR   tarball dest dir (default: /tmp/openclaw-fork)
# Precondition: `pnpm build` has already run (dist/ + packages/*/dist populated).
# Prints the tarball path on success. ALWAYS run the Step 7 install-verify after.
set -euo pipefail

FORK_DIR="${1:-$HOME/workspace/openclaw/openclaw}"
OUT_DIR="${2:-/tmp/openclaw-fork}"
cd "$FORK_DIR"
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/openclaw-*.tgz

PKG_BACKUP="$(mktemp)"
cp package.json "$PKG_BACKUP"
restore() { cp "$PKG_BACKUP" package.json; rm -rf vendor; rm -f "$PKG_BACKUP"; }
trap restore EXIT

# Root deps whose specifier uses the `workspace:` protocol.
WS_DEPS="$(node -e '
  const p = require("./package.json");
  const all = { ...p.dependencies, ...p.optionalDependencies };
  console.log(Object.entries(all)
    .filter(([, v]) => String(v).startsWith("workspace:"))
    .map(([k]) => k).join("\n"));
')"

for name in $WS_DEPS; do
  [ -z "$name" ] && continue
  abspkg="$(cd "node_modules/$name" && pwd -P)"   # the pnpm workspace pkg dir
  ver="$(node -e "console.log(require('$abspkg/package.json').version)")"
  vend="vendor/$(echo "$name" | sed 's|^@||; s|/|-|g')"   # @openclaw/ai -> vendor/openclaw-ai

  # Vendor the workspace pkg's PUBLISHABLE content (honors its `files`; NO node_modules).
  tmpp="$(mktemp -d)"
  ( cd "$abspkg" && npm pack --ignore-scripts --pack-destination "$tmpp" >/dev/null )
  mkdir -p "$vend"
  tar -xzf "$tmpp"/*.tgz -C "$vend" --strip-components=1
  rm -rf "$tmpp"

  # Rewrite spec -> file: and ensure vendor/ ships in the tarball.
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

# Externalized channel plugin the base image installs by name@version at build
# time (Dockerfile.base): @openclaw/mattermost. Upstream sometimes cuts an OC
# preview tag BEFORE publishing its scoped companion packages to npm (this bit
# the 6.11→7.1-beta.3 roll). When the exact version is missing from npm, build it
# here via upstream's own plugin release tool and ship it as a vendored tarball;
# Dockerfile.base prefers vendor/openclaw-mattermost.tgz and falls back to npm.
# Once the version publishes, this block no-ops and the base uses npm again.
MM_VER="$(node -e "console.log(require('./extensions/mattermost/package.json').version)" 2>/dev/null || true)"
if [ -n "$MM_VER" ] && ! npm view "@openclaw/mattermost@$MM_VER" version >/dev/null 2>&1; then
  mkdir -p vendor
  mmout="$(mktemp -d)"
  OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR="$mmout" bash scripts/plugin-npm-publish.sh --pack extensions/mattermost >&2
  cp "$mmout"/openclaw-mattermost-*.tgz vendor/openclaw-mattermost.tgz
  rm -rf "$mmout"
  node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(!p.files.includes('vendor/'))p.files.push('vendor/');fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');"
  echo "  vendored unpublished plugin: @openclaw/mattermost@$MM_VER -> vendor/openclaw-mattermost.tgz" >&2
fi

npm pack --ignore-scripts --pack-destination "$OUT_DIR" >&2
TARBALL="$OUT_DIR/$(ls -t "$OUT_DIR"/openclaw-*.tgz | head -1 | xargs basename)"
echo "$TARBALL"
