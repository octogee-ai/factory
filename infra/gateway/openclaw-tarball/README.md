# OpenClaw current build

Octogee builds its gateway from a released OpenClaw tag, or an explicitly
selected upstream branch snapshot, plus the Octogee overlay. `current.json`
selects the two write-once GCS artifacts; the build resolves their exact generations and derives a new
immutable `octogee-gateway-base:inputs-…` tag. No step here deploys TEST or
PROD.

## Refresh a tag or selected branch

Start from a clean OpenClaw checkout with `origin` pointing at
`openclaw/openclaw` and `ceckert` at the Octogee fork. Fetch the selected ref,
lock its full commit at the start, and cut the matching overlay branch. For a
tag, verify its peeled commit. For a branch, record the locked snapshot
honestly; a package version alone does not make it a GA release:

```bash
cd /path/to/openclaw
git fetch origin main
UPSTREAM_SHA=$(git rev-parse FETCH_HEAD)
git switch -c codex/openclaw-current-recut "$UPSTREAM_SHA"
```

Port the prior overlay oldest-first, then audit every patch against the
locked commit. Drop behavior OpenClaw now provides and capabilities Octogee no
longer needs. When upstream has split a
patched file, move only the required hook to its new owner; do not restore
deleted upstream wiring. Build and test the affected behavior before packing:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm config:channels:check
```

The focused tests must cover every changed patch area. The root build embeds
its source commit in `dist/build-info.json`; check it matches the final overlay
head before packaging. Refresh any still-open upstream PR that carries an
overlay patch, using `--force-with-lease` after its own build and focused tests.

## Package and publish

From a clean Octogee checkout, package the built overlay into a fresh
directory. Validate the root package and the local Mattermost package in an
isolated npm prefix before publication.

```bash
ARTIFACT_DIR=$(mktemp -d -t openclaw-current-artifacts-XXXXXX)
ROOT_TGZ=$(OPENCLAW_SKIP_BUILD=1 \
  bash infra/gateway/openclaw-tarball/pack-fork-tarball.sh \
  /path/to/openclaw "$ARTIFACT_DIR")
MATTERMOST_TGZ=$(bash infra/gateway/openclaw-tarball/pack-mattermost-tarball.sh \
  /path/to/openclaw "$ARTIFACT_DIR")

OVERLAY_SHA=$(git -C /path/to/openclaw rev-parse HEAD)
ROOT_OBJECT="openclaw-fork-${OVERLAY_SHA:0:8}.tgz"
MATTERMOST_SHA256=$(shasum -a 256 "$MATTERMOST_TGZ" | awk '{print $1}')
MATTERMOST_OBJECT="openclaw-mattermost-${MATTERMOST_SHA256:0:8}.tgz"

gcloud storage cp --if-generation-match=0 "$ROOT_TGZ" \
  "gs://octogee-openclaw-fork/${ROOT_OBJECT}"
gcloud storage cp --if-generation-match=0 "$MATTERMOST_TGZ" \
  "gs://octogee-openclaw-fork/${MATTERMOST_OBJECT}"
```

The write-once precondition is required. Never replace a release object or
reuse the retired `*-main.tgz` objects. Set `upstreamRef`, `openclawObject`,
and `mattermostObject` in `current.json`, and mirror the two object names in
`cloudbuild-base.yaml`; the focused base-reuse test proves that mirror. Push
the overlay branch with `--force-with-lease`.

An artifact refresh must still create an Octogee main build input. Update this
current-overlay assessment in the same PR; its path is intentionally included
in Build main scope. Build main produces images only. The operator alone can
select TEST or PROD later.

## Current overlay

The selected build is the operator-requested upstream `main` snapshot,
locked to [upstream commit `5702b8011812e26cf5ec3301116a9465683707b5`](https://github.com/openclaw/openclaw/commit/5702b8011812e26cf5ec3301116a9465683707b5),
with [overlay head `a3f78b8fcb40d8e2aff291c591cb04d753ef021c`](https://github.com/ceckert/openclaw/commit/a3f78b8fcb40d8e2aff291c591cb04d753ef021c)
on `ceckert/openclaw:octogee/gateway-scaling-patches-main`.
The package version is `2026.9.1`; this is a locked branch snapshot, not a
claim to have built a GA tag.

Its write-once artifacts are `openclaw-fork-a3f78b8f.tgz` at generation
`1788635329937525` (SHA-256 `4528b269d58bc40a661ff5ac41d8fe14c5487c094f04838bfa5d953db6be578e`)
and `openclaw-mattermost-aac59ca7.tgz` at generation `1788635332875879`
(SHA-256 `aac59ca7e013dfce7c125775d6382fe10e15c111b8b78cdc2c09f25514c4ce72`).
Both artifacts passed isolated npm installation and runtime entry checks;
the installed root reports the exact overlay commit above.

Only the Mattermost integration remains: 33 changed files, including tests and
generated metadata. The locked-main run passed 1,313 focused tests, the full
check, channel/config metadata and SDK surface checks, and independent P0–P2
review. A fresh full build from the committed overlay passed before packing.

This snapshot includes upstream's native sandbox directory listing from
[PR #136110](https://github.com/openclaw/openclaw/pull/136110). An isolated real
Docker invocation of the production tool factory exposed only `apply_patch`,
`edit`, `ls`, `read`, and `write` under a minimal filesystem-only policy. Native
`ls` passed nested listing, pagination, quoted filenames, and discovery after a
write; outside paths and symlink escapes were rejected. Neither `exec` nor
`process` was exposed. That satisfies Octogee's directory-discovery requirement;
recursive `find`/`grep` are not required. The entire discovery patch is dropped,
and [PR #122899 is closed with this proof](https://github.com/openclaw/openclaw/pull/122899#issuecomment-5554030414).
Octogee's project-agent policies no longer advertise the removed tools.

| Patch area | Locked main assessment | Why Octogee carries it / removal gate |
| --- | --- | --- |
| Sandbox-backed file discovery | Dropped in full. Use upstream's native `ls` and `readDirectory`, with no custom recursive search, directory producer, SDK subpath, or path/stat changes. | The verified native listing path meets Octogee's need without granting shell access. Do not retain optional `find`/`grep` as a new removal gate. |
| Resolved-secret reuse | Dropped. Cross-write caching was an optional performance optimization, not an Octogee correctness requirement. | Accept upstream's normal resolution cost and keep the resolver available. There is no custom stale-value lifecycle to maintain. |
| Custom `secrets.apply` RPC | Dropped. Upstream's existing batched `secrets apply` CLI uses the same apply engine; the old bootstrap-latency rationale did not hold in fresh measurements. | Octogee uses the asynchronous standard CLI and the existing reload path. No upstream RPC addition is required. |
| No-archive session deletion | Dropped. Standard upstream deletion archives transcripts using bounded worker-backed cleanup. [OpenClaw PR #137428](https://github.com/openclaw/openclaw/pull/137428) stays closed. | Ops Agent keeps per-request isolation and accepts archive retention. Durable scoped Ops conversations would be a separate product change, not a reason to retain this flag. |
| Recreated agent databases | Dropped. Upstream adopted lifecycle invalidation and schema revalidation through [OpenClaw PR #137424](https://github.com/openclaw/openclaw/pull/137424). | Upstream's recreation and gateway product tests cover the requirement without our filesystem-identity polling. |
| Fresh-chat terminal ownership | Dropped by operator choice. Keep upstream's native terminal and session lifecycle; no custom terminal materialization hook remains. | Mattermost-backed sessions may already supply an existing owner row. We do not claim all never-materialized native chats can open a terminal before their first message. This convenience is not a reason to carry another gateway patch. |
| Durable Mattermost channel sessions | Retained: channel-scoped sessions, queued delivery observation, sealed answer commits, and bounded recovery. Recovery uses delivered-answer timestamps, rejects noncausal references, distinguishes metadata-only rows from live SQLite state, and orders interleaved threads chronologically before retaining the newest entries. Each multipart answer remains one entry. | Octogee's channel-backed conversations consume this behavior. Channel scope requires threaded room replies; unthreaded configurations fail when the enabled account resolves. Keep Octogee's transcript metadata downstream; contribute generic delivery/adapter seams only when independently justified. Remove corresponding pieces as upstream adopts equivalent contracts. |

The gateway base still verifies runtime contracts such as expected config
behavior and tool-policy shape. Those are product checks, not a parallel
release authority.

## What the packers do

`pack-fork-tarball.sh` produces an installable root package. It vendors root
`workspace:*` dependencies and unpublished Codex/Parallel companions when
needed, so a tag does not depend on a companion publish race.

`pack-mattermost-tarball.sh` runs OpenClaw's plugin packer and verifies compiled
runtime output. Mattermost stays separate so its exact native channel runtime
is content-addressed independently from the root package.

Use `pnpm build`, not `pnpm run build:docker`: the full build creates every
compiled file needed by `npm pack`.
