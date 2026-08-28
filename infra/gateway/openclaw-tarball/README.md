# OpenClaw Private Fork Tarball

This is the maintenance guide for updating Octogee's temporary OpenClaw fork.

`Dockerfile.base` installs OpenClaw from a local tarball at
`openclaw-fork.tgz` in this directory. The tarball is a private build of
OpenClaw with Octogee-specific patches that haven't landed upstream yet.
The `.tgz` file is gitignored. Cloud Build stages it from GCS before the
Docker build runs; local docker builds need it copied manually.

> **Quick links**
> - [Update flow](#update-flow) — when you're rolling forward
> - [Common gotchas](#common-gotchas) — paper cuts that have bitten us
> - [Diagnostic-patch policy](#diagnostic-patch-policy) — when to drop diags
> - [Current patches](#current-patches) — what's in the stack today

---

## When to do this

Two triggers:

1. **Upstream OpenClaw cuts a release we want to adopt.** Watch
   `git log origin/main` in the fork checkout; the user-facing tags are
   `vYYYY.M.N` (sometimes with `-N` suffix for hotfixes).
2. **We're adding/changing/removing a fork patch** without an upstream version
   bump.

Either way, the flow is the same — produce a new tarball, upload it
to GCS, bump the pin in two cloudbuild files, build the base image, then
let CI build the gateway bundle (`octogee-gateway` + `gateway-edge`, plus the
`octogee-gateway-operator` image). The new images remain inert in Artifact
Registry until the operator cuts a release.

---

## Architectural rule for this flow

> **Main builds immutable, SHA-addressed artifacts. The operator cuts desired
> state. Cowboy owns live convergence.**

This guide produces artifacts only. It does not define another release
authority or add live-world checks to CI.

---

## Pre-flight

Before you start, verify:

- **Local fork checkout** at `~/workspace/openclaw/openclaw` with two remotes:
  - `origin` → `openclaw/openclaw` (upstream, read-only — used for `git fetch --tags`)
  - `ceckert` → `ceckert/openclaw` (Chris's mirror — where the `octogee/*`
    integration branches are pushed for record-keeping)
- **Working tree clean** in `~/workspace/openclaw/openclaw` (`git status`
  shows nothing pending).
- **A clean worktree** for the octogee monorepo.
- **`gcloud` authed** with `octogee` project default (`gcloud config get project`
  → `octogee`).

---

## Update flow

Run sequentially.

### Step 1 — Fetch and freeze the upstream target

▸
```bash
cd ~/workspace/openclaw/openclaw
git fetch --tags origin main
UPSTREAM_SHA=$(git rev-parse origin/main)
git tag --sort=-v:refname | head -5
```

✓ `UPSTREAM_SHA` is the exact upstream-main commit for this cycle. Do not
refresh it mid-roll; a later upstream commit is a separate cycle.

### Step 2 — Pin the variables for this cycle

For an upstream-main snapshot:

▸
```bash
UPSTREAM_VERSION=$(git show "${UPSTREAM_SHA}:package.json" \
  | node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).version)')
BASE_REF=$UPSTREAM_SHA
OPENCLAW_COMPATIBILITY_HOST_VERSION=$UPSTREAM_VERSION
OPENCLAW_VERSION="${UPSTREAM_VERSION%%-*}-main.${UPSTREAM_SHA:0:8}"
BRANCH_SUFFIX="main-${UPSTREAM_SHA:0:8}"
PREV_REF="<previous-frozen-upstream-sha-or-tag>"
PREV_BRANCH="<previous-octogee-integration-branch>"
```

For a tagged release instead:

```bash
BASE_REF=v2026.8.1
OPENCLAW_VERSION=${BASE_REF#v}
OPENCLAW_COMPATIBILITY_HOST_VERSION=$OPENCLAW_VERSION
BRANCH_SUFFIX=$BASE_REF
PREV_REF=v2026.7.4
PREV_BRANCH=octogee/gateway-scaling-patches-v2026.7.4
```

`OPENCLAW_VERSION` names the upstream baseline: a main snapshot uses the frozen
**upstream** SHA suffix. The patched checkout's full `SOURCE_SHA` is captured
after the overlay is final (Step 8) and must not be substituted into that
version. This deliberately makes `2026.8.1-main.<upstream8>` and
`_OPENCLAW_SOURCE_SHA=<overlay40>` different when Octogee carries patches.

The Docker-safe main-snapshot label is deployment provenance, not SemVer plugin
API precedence. Base builds set `OPENCLAW_COMPATIBILITY_HOST_VERSION` to the
packed release floor (`2026.8.1` in this example); child images inherit it while keeping
`OPENCLAW_VERSION=2026.8.1-main.<upstream8>` for image and fleet provenance.

✓ `BASE_REF`, `OPENCLAW_COMPATIBILITY_HOST_VERSION`, `OPENCLAW_VERSION`,
`BRANCH_SUFFIX`, `PREV_REF`, and `PREV_BRANCH` are set and `BASE_REF` still
resolves to the frozen target.

### Step 3 — Cut the integration branch

Tagged branches keep the `v` prefix. Main snapshots use the frozen upstream
short SHA, so the branch itself records which moving-main instant was ported.

▸
```bash
INTEGRATION_BRANCH="octogee/gateway-scaling-patches-${BRANCH_SUFFIX}"
git checkout -b "$INTEGRATION_BRANCH" "$BASE_REF"
```

✓ You're on the new integration branch, working tree clean, head exactly at
`BASE_REF`.

### Step 4 — Cherry-pick the prior fork stack

Oldest-first preserves history order in `git log`.

▸
```bash
git cherry-pick $(git rev-list --reverse "${PREV_REF}..${PREV_BRANCH}")
```

✓ Each patch lands cleanly. Auto-merges in already-modified files are fine
— git will say `Auto-merging <file>` and continue. Manual conflict means
upstream changed something underneath the patch; resolve, `git add`,
`git cherry-pick --continue`.

> ⚠ **When upstream splits a file, this step is a PORT, not a replay.**
> If upstream moved a function out of the file our patch modifies, the
> cherry-pick will happily reintroduce the pre-split original on top of the
> split tree — and the *feature* commits often do it without ever conflicting,
> because the conflict surfaces only in a later adapt commit. The result builds
> and looks green while the fork's wiring sits in a file nothing calls.
>
> Two signals, both cheap:
>
> ```bash
> # 1. Did a file our stack patches shrink dramatically upstream?
> git show "${BASE_REF}:path/to/file" | wc -l   # vs the same file at ${PREV_REF}
>
> # 2. After the pick, does the fork's net delta still touch the same files?
> git diff --name-only ${PREV_REF} ${PREV_BRANCH} | sort > /tmp/old-files
> git diff --name-only ${BASE_REF} HEAD | sort > /tmp/new-files
> comm -23 /tmp/old-files /tmp/new-files   # in OLD not NEW = moved or LOST
> ```
>
> Anything in that last list is a patch you must re-place by hand. Resolve the
> conflict to **HEAD** (never reintroduce upstream-deleted code), finish the
> pick, then author one `fix(recut): port …` commit that puts the fork's hunks
> in their new homes. Prefer a **fork-owned module** for the relocated logic and
> leave upstream files with the smallest possible hook — that is what keeps
> the next roll cheap.

### Step 5 — Audit upstream relevance

You need to know two things per patch: did upstream touch the same file,
and if so, did upstream make our patch redundant.

▸ List **only the files our cherry-picked patches touch** (NOT all upstream
files in the range — that would be ~500 commits' worth):

```bash
# Files our patches touch — compare against the upstream baseline:
git log ${BASE_REF}..HEAD --name-only --pretty=format: | sort -u | grep -v '^$'
```

▸ For each of those files, diff between the previous and new upstream tags:

```bash
git diff --stat ${PREV_REF}..${BASE_REF} -- path/to/file
```

▸ For files where upstream did change something, look at what:

```bash
git log ${PREV_REF}..${BASE_REF} --oneline -- path/to/file
```

▸ Keyword sweep the upstream commit log for behaviors our patches own — if
upstream landed any of these, the corresponding patch is redundant:

```bash
for kw in "isControlUiVisible" "broadcast.*agent" "surgical" \
          "per-account.*reload" "config.*patch.*hash" \
          "ws.*upgrade.*timing" "config.patch.*timing"; do
  hits=$(git log ${PREV_REF}..${BASE_REF} --oneline --grep="$kw" 2>/dev/null | wc -l | tr -d ' ')
  echo "  $kw: $hits hits"
done
```

✓ For each patch, decide one of:
- **Keep** — no upstream diff in the file, or the upstream diff is unrelated
  to what the patch does (auto-merge that landed cleanly is usually this case).
- **Drop** — upstream landed equivalent behavior, the patch is redundant.
- **Drop diagnostic** — see [Diagnostic-patch policy](#diagnostic-patch-policy).

If equivalence is clear, drop the patch and redo Step 4 without it. If the
reason for a patch is unclear, ask the operator. Do not create a per-release
audit table, feature-hoist sweep, or decision ledger.

### Step 6 — Build OpenClaw

Use the newest released Node version on the target tree's supported production
line. Check `package.json#engines.node`, upstream's Docker/CI target, and the
installed dependency engine ranges together. Do not default to the minimum
accepted version or jump to an odd-numbered current release merely because the
root range admits it. When the newest Node major is outside the declared range,
use the newest patch on the current supported LTS/ship-target major.

▸
```bash
pnpm install --frozen-lockfile
pnpm build                       # ⚠ NOT build:docker — see "Why pnpm build" below
```

✓ Build completes with no errors. `dist/` is populated.

### Step 6b — Run upstream checks against the patched tree

`pnpm build` does not type-check tests or run them. Run upstream's static
checks and the tests owned by files the fork changes:

▸
```bash
pnpm check
# Focused vitest: every test file the stack touches + same-name sibling
# tests of touched sources. src/** files run via root vitest; extension
# files run via their own project lane.
FILES=$( (git log ${BASE_REF}..HEAD --name-only --pretty=format: | sort -u \
    | grep '\.test\.ts$'; \
  git log ${BASE_REF}..HEAD --name-only --pretty=format: | sort -u \
    | grep '\.ts$' | grep -v '\.test\.ts$' | sed 's|\.ts$|.test.ts|') \
  | sort -u | while read f; do [ -f "$f" ] && echo "$f"; done)
npx vitest run $(echo "$FILES" | grep '^src/')
for ext in $(echo "$FILES" | grep '^extensions/' | cut -d/ -f2 | sort -u); do
  pnpm test:extension "$ext"
done
```

Do not run the whole upstream suite as a second copy of this signal. If
`pnpm check` fails only because the fork owns additional environment names,
verify the exact fork count with
`node scripts/check-env-var-count.mjs --base HEAD`; treat any other failure as
part of the patch.

### Step 7 — Pack the tarball

Run the pack script — it produces a SELF-CONTAINED tarball regardless of
npm publication state:

▸
```bash
ARTIFACT_DIR=$(mktemp -d -t openclaw-release-XXXXXX)
ROOT_TGZ=$(bash ~/workspace/octogee-ai/octogee/infra/gateway/openclaw-tarball/pack-fork-tarball.sh . "$ARTIFACT_DIR")
test -s "$ROOT_TGZ"
# Confirm the workspace spec was resolved (file:vendor/... or a concrete version):
tar -xzOf "$ROOT_TGZ" package/package.json | grep '"@openclaw/ai"'
```

What it does (and why — the two publication gaps that used to stop rolls):

- **Binds source to bytes** — packing fails unless the fork checkout is clean,
  rebuilds every ignored runtime byte from that source, then requires
  `dist/build-info.json.commit` to equal `git HEAD` and the bundled Control UI
  to carry that commit. The script reads the build info back out of the
  finished tarball; Cloud Build checks the same packed commit against the full
  `sourceSha` pin before using the artifact.
- **`workspace:*` root deps** (since 7.1: `@openclaw/ai`) — `npm pack` ships
  the specifier verbatim (upstream's own release rewrites it via
  `prepare-openclaw-npm-shrinkwrap.ts` at publish time) and the base image's
  `npm install -g` dies on it ~2 min in with an opaque npm error. The script
  vendors each one into `vendor/<name>/` inside the tarball and rewrites the
  spec to `file:vendor/<name>`. NOT `bundleDependencies` — on a pnpm
  workspace that drags the whole transitive closure out of the symlink farm
  and ships an empty `@modelcontextprotocol/sdk` (installs green,
  crash-loops the codex-plugin install).
- **Unpublished companions** (`@openclaw/codex`, `@openclaw/parallel-plugin`)
  — tagged releases publish them in lockstep (sometimes lagging by a day —
  the beta.3 saga); a dev-slot snapshot of upstream main never publishes.
  When the exact version is missing from npm the script compiles each via
  upstream's `plugin-npm-publish.sh --pack` into `vendor/<pkg>.tgz`;
  `Dockerfile.base` prefers the vendored tarball and falls back to npm.
  Published versions vendor nothing — the same tarball ceremony covers every
  slot with no per-cycle Dockerfile edits.

`@openclaw/mattermost` is NOT vendored — the fork always patches it, so it
ships as its own content-addressed artifact (Step 7b) on every slot.

✓ A single `openclaw-<version>.tgz` file, ~20-65 MB, ~7-12k files, with the
`@openclaw/ai` spec resolved inside; working tree left clean (the script
restores `package.json` and removes `vendor/` on exit).

### Step 7b — Pack the Mattermost artifact (6.11+, externalized MM)

The base image installs our patched `@openclaw/mattermost` from the fork
bucket. A raw `npm pack` of `extensions/mattermost` ships TypeScript source
with **no `dist/`** — the plugin installer fails closed at image build
("requires compiled runtime output"). Pack through the fork's own plugin
pipeline, which builds the runtime and rewrites the manifest:

▸
```bash
MM_TGZ=$(bash ~/workspace/octogee-ai/octogee/infra/gateway/openclaw-tarball/pack-mattermost-tarball.sh \
  . "$ARTIFACT_DIR")
tar -tzf "$MM_TGZ" | grep -q 'dist/index.js'
```

✓ Tarball contains `package/dist/index.js` (~900KB compiled, not ~200KB
source-only).

> ⚠ **Verify BOTH artifacts before upload with the Dockerfile's real install
> branches.** A root-only scratch install is insufficient for main snapshots:
> Codex must be repacked to the synthetic host version, Parallel comes from
> its vendored archive, and the patched Mattermost config must validate.
>
> ```bash
> set -euo pipefail
> test -s "$ROOT_TGZ" && test -s "$MM_TGZ"
> SCRATCH=$(mktemp -d)
> ROOT_PREFIX="$SCRATCH/root"
> VERIFY_HOME="$SCRATCH/home"
> mkdir -p "$VERIFY_HOME"
> npm install -g --prefix "$ROOT_PREFIX" "$ROOT_TGZ"
> OPENCLAW="$ROOT_PREFIX/bin/openclaw"
> OPENCLAW_ROOT="$ROOT_PREFIX/lib/node_modules/openclaw"
> "$OPENCLAW" --version
>
> CODEX_TGZ="$OPENCLAW_ROOT/vendor/openclaw-codex.tgz"
> if test -s "$CODEX_TGZ"; then
>   CODEX_REPACK="$SCRATCH/codex-repack"
>   mkdir -p "$CODEX_REPACK"
>   tar -xzf "$CODEX_TGZ" -C "$CODEX_REPACK"
>   node -e 'const fs=require("node:fs"); const [f,v]=process.argv.slice(1); const p=JSON.parse(fs.readFileSync(f,"utf8")); if(p.name!=="@openclaw/codex") throw new Error(p.name); p.version=v; fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' \
>     "$CODEX_REPACK/package/package.json" "$OPENCLAW_VERSION"
>   (cd "$CODEX_REPACK/package" && npm pack --ignore-scripts --pack-destination "$CODEX_REPACK")
>   CODEX_INSTALL=$(find "$CODEX_REPACK" -maxdepth 1 -name '*.tgz' -print -quit)
>   HOME="$VERIFY_HOME" "$OPENCLAW" plugins install "npm-pack:$CODEX_INSTALL" --force --accept-capabilities
> else
>   HOME="$VERIFY_HOME" "$OPENCLAW" plugins install "@openclaw/codex@$OPENCLAW_VERSION" --accept-capabilities
> fi
>
> PARALLEL_TGZ="$OPENCLAW_ROOT/vendor/openclaw-parallel-plugin.tgz"
> if test -s "$PARALLEL_TGZ"; then
>   HOME="$VERIFY_HOME" "$OPENCLAW" plugins install "npm-pack:$PARALLEL_TGZ" --force --accept-capabilities
> else
>   HOME="$VERIFY_HOME" "$OPENCLAW" plugins install "@openclaw/parallel-plugin@$OPENCLAW_VERSION" --accept-capabilities
> fi
> HOME="$VERIFY_HOME" "$OPENCLAW" plugins install "npm-pack:$MM_TGZ" --force --accept-capabilities
> printf '%s\n' '{"channels":{"mattermost":{"replyToMode":"all","replyToModeByChatType":{"direct":"all"},"threadSessionScope":"channel"}}}' \
>   | HOME="$VERIFY_HOME" "$OPENCLAW" config patch --stdin
> HOME="$VERIFY_HOME" "$OPENCLAW" config validate
> HOME="$VERIFY_HOME" "$OPENCLAW" plugins list --json > "$SCRATCH/plugins.json"
>
> CODEX_PACKAGE=$(find "$VERIFY_HOME/.openclaw/npm" -path '*/node_modules/@openclaw/codex/package.json' -print -quit)
> test "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$CODEX_PACKAGE")" = "$OPENCLAW_VERSION"
> test -n "$(find "$VERIFY_HOME/.openclaw/npm" -type d -path '*/node_modules/@openclaw/parallel-plugin' -print -quit)"
> test -n "$(find "$VERIFY_HOME/.openclaw/npm" -type d -path '*/node_modules/@openclaw/mattermost' -print -quit)"
> node -e 'const i=require(process.argv[1]); for (const id of ["codex","parallel","mattermost"]) { const n=(i.plugins??[]).filter(p=>p?.id===id).length; if(n!==1) throw new Error(`${id}: expected one runtime plugin, got ${n}`) }' \
>   "$SCRATCH/plugins.json"
> ```
>
> For `*-main.*`, both companion archives must take the vendored branches;
> their synthetic versions do not exist on npm. The Mattermost pin is the
> first 8 characters of the tgz SHA-256.

### Step 8 — Capture immutable identities

▸
```bash
SOURCE_SHA=$(git rev-parse HEAD)
FORK_SHA=${SOURCE_SHA:0:8}
ROOT_SHA256=$(shasum -a 256 "$ROOT_TGZ" | awk '{print $1}')
MATTERMOST_SHA256=$(shasum -a 256 "$MM_TGZ" | awk '{print $1}')
MATTERMOST_FORK_SHA=${MATTERMOST_SHA256:0:8}
PACKED_SOURCE_SHA=$(tar -xzOf "$ROOT_TGZ" package/dist/build-info.json \
  | node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).commit)')
test "$PACKED_SOURCE_SHA" = "$SOURCE_SHA"
PACKED_MATTERMOST_SOURCE_SHA=$(tar -xzOf "$MM_TGZ" package/package.json \
  | node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).octogeeSourceCommit)')
test "$PACKED_MATTERMOST_SOURCE_SHA" = "$SOURCE_SHA"
```

✓ `SOURCE_SHA` is the full patched-tree commit packed into the root artifact;
`FORK_SHA` is its 8-character object/build pin. Both artifacts carry and are
verified against that full source commit. The two SHA-256 values bind the
artifact bytes, and the Mattermost digest prefix names its object.

### Step 9 — Upload both artifacts immutably

▸
```bash
upload_immutable() {
  local local_file=$1 object=$2 expected=$3
  if ! gcloud storage objects describe "$object" --project=octogee >/dev/null 2>&1; then
    gcloud storage cp "$local_file" "$object" --project=octogee \
      --if-generation-match=0 \
      || gcloud storage objects describe "$object" --project=octogee >/dev/null
  fi
  actual=$(gcloud storage cat "$object" --project=octogee \
    | shasum -a 256 | awk '{print $1}')
  test "$actual" = "$expected" \
    || { echo "FATAL: immutable artifact digest mismatch: $object" >&2; return 1; }
}

upload_immutable "$ROOT_TGZ" \
  "gs://octogee-openclaw-fork/openclaw-fork-${FORK_SHA}.tgz" "$ROOT_SHA256"
upload_immutable "$MM_TGZ" \
  "gs://octogee-openclaw-fork/openclaw-mattermost-${MATTERMOST_FORK_SHA}.tgz" \
  "$MATTERMOST_SHA256"
```

✓ A first run creates each object only if generation is zero. A retry or racing
uploader succeeds only when streaming the stored bytes reproduces the expected
digest; an existing different object is never overwritten.

### Step 10 — Mirror the integration branch

▸
```bash
git push ceckert "$INTEGRATION_BRANCH"
```

✓ Branch pushed to `ceckert/openclaw` for record-keeping. Future audits
(`git log v...`) work without the local checkout.

### Step 11 — Bump `cloudbuild-base.yaml` (the BASE config)

In the octogee monorepo, edit `cloudbuild-base.yaml`:

- `_OPENCLAW_VERSION` → `$OPENCLAW_VERSION`
- `_OPENCLAW_COMPATIBILITY_HOST_VERSION` → `$OPENCLAW_COMPATIBILITY_HOST_VERSION`
- `_OPENCLAW_UPSTREAM_SHA` → `$UPSTREAM_SHA` for a main snapshot; clear it for
  a tagged release
- `_OPENCLAW_SOURCE_SHA` → `$SOURCE_SHA`
- `_OPENCLAW_ROOT_SHA256` → `$ROOT_SHA256`
- `_OPENCLAW_MATTERMOST_FORK_SHA` → `$MATTERMOST_FORK_SHA`
- `_OPENCLAW_MATTERMOST_SHA256` → `$MATTERMOST_SHA256`
- `_OPENCLAW_FORK_SHA` → `$FORK_SHA`

Then **sync the `bases:` block** in `infra/gateway/oc-build-matrix.yaml`
— update the `label: current` entry's `version`, `forkSha`, `sourceSha`,
`rootSha256`, `mattermostForkSha`, and `mattermostSha256` to the same values.
Also set `compatibilityHostVersion`; for a main snapshot, set `upstreamSha` to
the frozen full upstream commit. Remove `upstreamSha` for a tagged release.
⚠ This is a hard obligation: `bases:` is the single source of
truth for `scripts/rebuild-matrix-bases.sh` and the
`gateway-base-rebuild.yml` workflow. The `current` `bases:` entry MUST
equal `cloudbuild.yaml`'s `_OPENCLAW_VERSION`/`_OPENCLAW_FORK_SHA` or the
base that the gateway image FROMs won't get rebuilt. (`bases:` is a
separate top-level key from `versions:`; `gateway-build-operator-base.yml` only reads
`versions:`.)

✓ Diff shows all artifact, compatibility, and provenance substitutions and
the `current` `bases:` entry updated to match.

### Step 12 — Bump `cloudbuild.yaml` (the GATEWAY config)

▸ **Don't forget this file.** ⚠ This is the second most-common paper cut.

Edit `cloudbuild.yaml`:

- `_OPENCLAW_VERSION` → `$OPENCLAW_VERSION` (same value as Step 11)
- `_OPENCLAW_FORK_SHA` → `$FORK_SHA` (same value as Step 11)

The gateway image's `FROM` resolves the base by `_OPENCLAW_VERSION` tag —
if you only bump one file, the gateway image silently builds against the
wrong base and the boot banner reports the old version. **Always bump
both.**

✓ `git diff cloudbuild-base.yaml cloudbuild.yaml` shows version and fork SHA
in both files, with compatibility owned by the base config. Don't commit yet.

### Step 12b — `oc-build-matrix.yaml`: current base + optional preview base

The matrix carries the `label: current` base row, which must exactly match
`cloudbuild.yaml`'s `_OPENCLAW_VERSION` and `_OPENCLAW_FORK_SHA`, plus an
optional operator-selected `label: preview` base row. `versions:` stays empty.
A preview base row needs `compatibilityHostVersion`, `forkSha`, `sourceSha`
(the FULL 40-hex fork commit), `rootSha256` (the root tarball's sha256),
`mattermostForkSha`, `mattermostSha256` (the MM artifact's sha256), and
`config: cloudbuild-base-beta.yaml`. A main snapshot also needs `upstreamSha`
(the FULL frozen upstream commit); a tagged row must omit it. The beta config's
verified candidate rebuild checks all of them before publishing. The preview BASE builds
via `rebuild-matrix-bases.sh`; a preview GATEWAY image is built on demand
with `scripts/build-pinned-gateway.sh` against that base when the
operator wants to roll it. When the fork changes, update the current row
with the two cloudbuild files.
Artifact Registry tags remain immutable.

For a main snapshot, `mattermostForkSha` is mandatory: the synthetic
`$OPENCLAW_VERSION` is not published on npm, so the base cannot fall through to
`@openclaw/mattermost@$OPENCLAW_VERSION`. The older
`cloudbuild-gateway-candidate.yaml` path is not a substitute: it rejects
`*-main.<sha8>` versions and its `Dockerfile.base-candidate` layer is only a
Mattermost swap atop an already-buildable root, not a general fork-overlay
builder. Use the preview matrix row with `cloudbuild-base-beta.yaml`, then the
normal pinned-gateway script.

GitHub's GCP WIF condition accepts only `refs/heads/main`; a feature-branch
workflow cannot authenticate to submit these preview builds. Before the pin
change lands, use an operator-authenticated local shell:

```bash
scripts/rebuild-matrix-bases.sh  # dry run; copy the preview row's 12-hex baseInput
PREVIEW_BASE_INPUT_HASH="<preview-base-input-hash>"
source scripts/lib/deployment-target.sh
octogee_load_deployment_target --environment=prod
export CLOUDSDK_BUILDS_REGION="$TARGET_REGION"
OPENCLAW_UPSTREAM_SUBSTITUTION=""
if [[ "$OPENCLAW_VERSION" == *-main.* ]]; then
  OPENCLAW_UPSTREAM_SUBSTITUTION=",_OPENCLAW_UPSTREAM_SHA=$UPSTREAM_SHA"
fi
gcloud builds submit --config cloudbuild-base-beta.yaml \
  --substitutions="_REGION=$TARGET_AR_LOCATION,_OPENCLAW_VERSION=$OPENCLAW_VERSION,_OPENCLAW_COMPATIBILITY_HOST_VERSION=$OPENCLAW_COMPATIBILITY_HOST_VERSION${OPENCLAW_UPSTREAM_SUBSTITUTION},_OPENCLAW_FORK_SHA=$FORK_SHA,_OPENCLAW_SOURCE_SHA=$SOURCE_SHA,_OPENCLAW_ROOT_SHA256=$ROOT_SHA256,_OPENCLAW_MATTERMOST_FORK_SHA=$MATTERMOST_FORK_SHA,_OPENCLAW_MATTERMOST_SHA256=$MATTERMOST_SHA256,_BASE_INPUT_HASH=$PREVIEW_BASE_INPUT_HASH" \
  --project="$TARGET_AR_PROJECT"

# Then use the immutable base sentinel built above:
OCTOGEE_SHA="<exact-octogee-commit>"
CANDIDATE_TAG="agent-conversation-w9a-${OCTOGEE_SHA:0:8}"
SIDECAR_CONTEXT=$(mktemp -d -t octogee-sidecar-XXXXXX)
git archive "$OCTOGEE_SHA" | tar -x -C "$SIDECAR_CONTEXT"
gcloud builds submit "$SIDECAR_CONTEXT" \
  --config "$SIDECAR_CONTEXT/gateway-edge/cloudbuild-candidate.yaml" \
  --substitutions="_REGION=$TARGET_AR_LOCATION,_IMAGE_TAG=$CANDIDATE_TAG,_CACHE_TAG=$CANDIDATE_TAG-cache" \
  --project="$TARGET_AR_PROJECT"
scripts/build-pinned-gateway.sh "$OCTOGEE_SHA" "$OPENCLAW_VERSION" \
  "$OPENCLAW_VERSION-fork-$FORK_SHA-base-$PREVIEW_BASE_INPUT_HASH" \
  "$CANDIDATE_TAG"
```

The candidate config accepts only its isolated tag family and never writes
`gateway-edge:latest`. The pinned builder requires that candidate tag's suffix
to equal the selected Octogee commit's first eight characters before aliasing
it into the bundle. Do not wait for feature-branch Actions to gain cloud
authority.

✓ `git diff infra/gateway/oc-build-matrix.yaml` shows the current row matching
the cloudbuild pins and any preview row carrying all six immutable inputs.

### Step 13 — Let `main` build the base

Landing the pin change triggers the base build from the matrix and then the
gateway image build. Do not submit a duplicate pre-build. Use
`scripts/rebuild-matrix-bases.sh --apply` only as an explicit recovery tool
when the normal base build did not produce the required immutable artifact.

### Step 14 — Land the new pins

Update `cloudbuild-base.yaml`, `cloudbuild.yaml`, and
`infra/gateway/oc-build-matrix.yaml` in one normal repository change. Run the
focused build-contract tests and let `main` build the immutable SHA-addressed
images.

This guide ends at artifact production. Releasing those bytes is an operator
action, documented in [Handbook 21](../../../docs/handbook/21-deploy-and-cicd.md).
Do not add a tag ceremony, live smoke gate, receipt, or CI convergence watch to
this fork-maintenance flow.

---

## Common gotchas

Stickies, in order of how often they bite us.

### Forgetting `cloudbuild.yaml` after editing `cloudbuild-base.yaml`

**Symptom:** The gateway image resolves the previous OpenClaw base even though
the new base image exists.

**Cause:** `_OPENCLAW_VERSION` is the tag the gateway Dockerfile uses to
`FROM` the base. If only `cloudbuild-base.yaml` was bumped, the gateway
build pulls the old base.

**Fix:** Always bump both files in lockstep with the same values and run the
focused build-contract test.

### `pnpm pack` hangs at 100% CPU

**Symptom:** `pnpm pack` runs for 5+ minutes, no output, single core
pegged. Stack samples identical.

**Cause:** OpenClaw's `package.json` `exports` map has 309 entries and
`dist/` holds ~108k files. pnpm pack's file-inclusion check is roughly
`O(files × exports × glob_negations)` and hits catastrophic regex
backtracking.

**Fix:** Always use `npm pack --ignore-scripts` (Step 7). It uses
`npm-packlist` (different algorithm), finishes in ~5 seconds, produces a
file-content-identical tarball. The `--ignore-scripts` flag also skips
the `prepack` lifecycle hook (`scripts/openclaw-prepack.ts`) which has
the same regex-walk problem.

### `pnpm run build:docker` produces an incomplete dist tree

**Symptom:** `npm pack` aborts with
`ENOENT: lstat 'dist/extensions/<name>/index.js'`.

**Cause:** `build:docker` is a partial build (`tsdown` + a few helpers)
that doesn't build every extension. The pack walks `dist/` looking for
files referenced by the `exports` map and finds gaps.

**Fix:** Always use `pnpm build` (the full build-all script, Step 6),
not `pnpm run build:docker`. Slower but it's the only build that
produces a packable dist tree.

### Mismatched `_OPENCLAW_FORK_SHA` between cloudbuild files

**Symptom:** Base build is fine, gateway build is fine, but the boot
banner reports a `fork=` SHA that doesn't match what's in
`cloudbuild-base.yaml`.

**Cause:** The gateway Dockerfile takes `OPENCLAW_FORK_SHA` as a
`--build-arg` from `cloudbuild.yaml`, separate from the base build. If
`cloudbuild.yaml`'s value is stale, the boot banner is wrong even
though the actual binary is correct (the fork SHA in the banner is for
operator confirmation, not for build correctness).

**Fix:** Step 12 — keep `_OPENCLAW_FORK_SHA` identical in both files.

### Base build fails at `openclaw plugins install @openclaw/<x>`

**Symptom:** `octogee-gateway-base` build dies with
`FATAL: @openclaw/<plugin> install failed` →
`package install requires compiled runtime output for TypeScript entry
./index.ts`.

**Cause:** Several official OpenClaw plugins (`@openclaw/mattermost`,
historically) publish a **TypeScript-source-only** registry package with
no compiled `dist/`. OC 5.x's plugin loader rejects source-only installs
in non-dev paths. These plugins are *also shipped as bundled extensions*
in the OC dist tree (`dist/extensions/<x>/index.js`) — the registry
install was redundant. It failed **silently for months** because the old
recipe was `openclaw plugins install … | tail` and `sh` has no
`pipefail`, so `tail`'s exit code greened the layer. #979's hardening
(`exit 1` on failure) correctly surfaced the long-dead failure.

**Fix:** If the plugin is bundled (`ls dist/extensions/<x>/index.js` in
the fork checkout), the registry install is dead weight — remove that
`RUN openclaw plugins install @openclaw/<x>` block from
`Dockerfile.base`. Do **not** re-mask it with `|| true`. Confirm bundled
status before removing; a genuinely-unbundled plugin still needs a
working (compiled) install. Upstream #82425 ("repair source-only
official plugin installs") is the broader fix landing in 5.16+.

### Base build fails at codex staging (`@openclaw/codex missing from staged /opt tree`)

**Symptom:** `octogee-gateway-base` build dies at the codex step with
`FATAL: @openclaw/codex missing from staged /opt tree` — but the line
just above shows `Installed plugin: codex` (the install itself
*succeeded*). Distinct from the source-only failure above: here the
install works, the *staging assertion* fails.

**Cause:** `openclaw plugins install`'s on-disk layout is an upstream
impl detail that **moves between releases**. ≤5.27 placed the package
flat at `~/.openclaw/npm/node_modules/@openclaw/codex`; the 5.28
plugin-subsystem refactor (84 files / +5302 LOC) moved it to a per-plugin
project dir `~/.openclaw/npm/projects/openclaw-codex-<hash>/node_modules/@openclaw/codex`
and added a generated `~/.openclaw/plugins/installs.json` registry. A
staging assertion (or entrypoint restore guard) hard-coded to the old
path breaks the moment upstream reshuffles. Caught on the 5.28-beta.2
preview (2026-05-29); alpha.1 had built fine days earlier on the same
Dockerfile — pure upstream drift.

**Fix (already in place — `Dockerfile.base` + `entrypoint.sh`):** both
the staging assertion and the runtime restore guard use a
**layout-agnostic** check — `find <staged-npm> -type d -path
'*/node_modules/@openclaw/codex' | grep -q .` — and stage/symlink the
**whole** `~/.openclaw/npm` tree, so whatever layout comes along is
carried. If this fails *again* it's a package rename/scope change, not a
path-depth change (the `find` already handles arbitrary nesting). The
base build's codex step is now self-validating: a green base build proves
the staging.

**Runtime fact — don't re-derive:** codex loads at runtime from
`openclaw.json` (`plugins.entries.codex.enabled: true`) resolving the
package from the npm managed-root — **NOT** from `plugins/installs.json`.
That registry is a lazy cache (regenerated on demand; absolute-path +
content-hash specific); it is **not staged, not restored, and not
required** for the harness to load. Only the `npm` tree needs to survive
the runtime emptyDir, which the existing whole-`npm` symlink already does.

On upstream-main builds Codex is version-bound to the host. The base image
re-packs a vendored Codex companion with `OPENCLAW_VERSION` before installation;
otherwise startup repair treats the package as stale and tries its unpublished
version from npm.

**Verify a staging change cheaply (no full gateway build needed):**
`kubectl run` a throwaway pod on the freshly-built base image in
`octogee-test`, run the entrypoint's `find` guard + the symlink into a
fake `$HOME/.openclaw` + a minimal `openclaw.json` that enables codex,
then `openclaw plugins doctor` / `openclaw plugins list | grep codex`
(expect "No plugin issues detected" + codex `enabled`, resolving from the
`projects/` path). Use `--restart=Never` + poll + `logs`, **not**
`-i --rm` — the attach times out during the large base-image pull and
kills the pod before it runs.

### Base build times out (~10m cliff)

**Symptom:** `octogee-gateway-base` (or the gateway image) build fails
with a Cloud Build timeout.

**Fix:** Inspect the build trace and remove unnecessary work or correct the
failing build step. Do not extend a release timeout merely to make a gate pass.

---

## Diagnostic-patch policy

Add a diagnostic patch only for an active investigation. Remove it when the
investigation ends; do not carry it forward for historical continuity.

---

## Current patches

The fork branch and its commits are authoritative. Use
`git log <frozen-upstream-commit>..<integration-branch>` to inspect the exact
current stack for either a tagged release or a main snapshot. Do not maintain
a second per-roll ledger in this repository.

The stack currently exists to provide these product behaviors:

- sidecar-visible agent events and a bounded, environment-gated diagnostic
  event feed;
- durable Mattermost admission, activity publication, live snapshots, and
  ingress control RPCs;
- channel-scoped Mattermost sessions with native thread delivery, correct
  native conversation identity, and SecretRef-safe route inspection;
- Mattermost warm-run terminal-outcome fallback that finalizes an existing
  preview when possible;
- native `ls`, `find`, and `grep` sandbox tools while upstream PR #122899 is
  still open;
- reuse of successfully resolved, unchanged exec-backed SecretRefs during
  automatic config writes and refreshes;
- an authenticated in-process `secrets.apply` gateway RPC;
- avoidance of config-apply self-wait during channel reload. Upstream
  [PR #131180](https://github.com/openclaw/openclaw/pull/131180) merged after
  this cycle's frozen `f9b08635` cutoff, so remove the overlay in the next
  frozen-main refresh.

The current fork diff and tests own the implementation detail. During a roll,
drop any patch already provided upstream and keep new hooks as small as
possible. Diagnostic-only patches are temporary and are removed when their
active investigation ends.

---

## GCS bucket

Tarballs live at `gs://octogee-openclaw-fork/openclaw-fork-<short-sha>.tgz`.
The pinned SHA is tracked via `_OPENCLAW_FORK_SHA` in `cloudbuild-base.yaml`
*and* `cloudbuild.yaml` (must match — see Step 12). Object names include
the short SHA so builds pin to a specific immutable artifact — bump the
substitution to roll forward.

---

## Why `npm pack`, not `pnpm pack`

Through v2026.4.20 the RUNBOOK said `pnpm pack`. From v2026.4.24 onward
the OpenClaw `package.json` `exports` map has 309 entries and `dist/`
holds ~108k files. pnpm pack's file-inclusion check is roughly
`O(files × exports × glob_negations)` and hits catastrophic regex
backtracking — the process pegs 100% CPU with frozen memory and
identical stack across samples, never completing.

`npm pack` uses `npm-packlist` (a different algorithm) and finishes in
~5 seconds with a structurally identical tarball. This is a one-package
pack (no workspace deps), so the artifacts are file-content identical —
the `package.json` `files` declaration is what both tools honor.

`--ignore-scripts` skips the `prepack` lifecycle hook
(`scripts/openclaw-prepack.ts`), which has the same regex-walk
problem in `writeDistInventory`. The full `pnpm build` above produces
all the dist artifacts prepack would have produced — the only thing
prepack adds is `dist/postinstall-inventory.json`, which the gateway
base image doesn't consume.

## Why `pnpm build`, not `pnpm run build:docker`

`build:docker` is a partial build (`tsdown` + a few helpers) that's
faster but doesn't build every extension. If the resulting `dist/`
tree is missing files referenced by `npm pack`'s file walk you'll get
`ENOENT: lstat 'dist/extensions/<name>/index.js'` and the pack
aborts. The full `pnpm build` runs the complete build-all script,
including every extension's tsdown step. It's slower but it's the
only build that produces a packable dist tree.

---

## Local docker build

If you need to build the base image locally (not via Cloud Build), fetch
the pinned tarball first:

```bash
gcloud storage cp \
  gs://octogee-openclaw-fork/openclaw-fork-<sha>.tgz \
  infra/gateway/openclaw-tarball/openclaw-fork.tgz --project=octogee
docker build -f infra/gateway/Dockerfile.base .
```

---

## Diagnostic base builds

The release pipeline builds only the current OpenClaw runtime. For a
diagnostic experiment, build a pinned image outside the release workflow and
keep it out of the deployment aliases; it is not a supported release slot.

---

## Reverting to upstream npm

When the patches all land upstream and we no longer need a fork:

1. Delete the `COPY …` + `RUN npm install -g /tmp/openclaw-fork.tgz` block
   in `Dockerfile.base` and restore `RUN npm install -g openclaw@${OPENCLAW_VERSION}`.
2. Delete the `fetch-fork-tarball` step and `_OPENCLAW_FORK_*`
   substitutions from `cloudbuild-base.yaml` *and* `cloudbuild.yaml`.
3. Drop the boot-banner `fork=` field in `infra/gateway/entrypoint.sh`.
4. Delete this directory + the GCS bucket.

---
