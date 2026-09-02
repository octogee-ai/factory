# OpenClaw tagged build

Octogee builds its gateway from a released OpenClaw tag plus the small Octogee
overlay. `current.json` selects the two write-once GCS artifacts for the
current tag; the build resolves their exact generations and derives a new
immutable `octogee-gateway-base:inputs-…` tag. No step here deploys TEST or
PROD.

## Refresh a released tag

Start from a clean OpenClaw checkout with `origin` pointing at
`openclaw/openclaw` and `ceckert` at the Octogee fork. Fetch the tag, verify
its peeled commit, and cut the tag-specific overlay branch:

```bash
cd /path/to/openclaw
git fetch --tags origin
git rev-parse v2026.8.2^{}
git switch -c octogee/gateway-scaling-patches-v2026.8.2 v2026.8.2
```

Port the prior overlay oldest-first, then audit every patch against the
released tag. Drop behavior OpenClaw now provides. When upstream has split a
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
ARTIFACT_DIR=$(mktemp -d -t openclaw-v2026.8.2-artifacts-XXXXXX)
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
reuse the retired `*-main.tgz` objects. Set `upstreamTag`, `openclawObject`,
and `mattermostObject` in `current.json`, and mirror the two object names in
`cloudbuild-base.yaml`; the focused base-reuse test proves that mirror. Push
the overlay branch with `--force-with-lease`.

An artifact refresh must still create an Octogee main build input. Update this
current-overlay assessment in the same PR; its path is intentionally included
in Build main scope. Build main produces images only. The operator alone can
select TEST or PROD later.

## Current overlay

The current build is [OpenClaw `v2026.8.2`](https://github.com/openclaw/openclaw/releases/tag/v2026.8.2),
peeled to `0965053fe6b9341776df147a6934b7485c60b5ca`, with overlay head
`7552b8d7d62e78fc3ab7904f899988b6ce654642`. The Mattermost package is built
from the tag without an Octogee patch; native threading, streaming, steering,
and approvals supply the chat behavior.

| Patch area | v2026.8.2 assessment | Why Octogee carries it |
| --- | --- | --- |
| Sandbox-backed file discovery | The tag has no native shell-free discovery surface. [OpenClaw PR #122899](https://github.com/openclaw/openclaw/pull/122899) remains open; its refreshed current-main head is `6c3ea1812a0`. | Keeps native `ls`, `find`, and `grep` available without granting `exec` or `process`. |
| Secret handling | The tag has neither unchanged resolved-SecretRef reuse nor the authenticated `secrets.apply` RPC. | Avoids unnecessary secret-provider work and supports Octogee configuration writes. |
| No-archive session deletion | The tag has an internal purge primitive, but public `sessions.delete` cannot request it. | Lets Ops Agent purge transient one-shot sessions without archive compression and event-loop starvation. |
| Recreated agent databases | The tag does not revalidate a recreated agent database before reuse. | Prevents stale per-agent state after replacement. |
| Fresh-chat terminal ownership | The tag rejects `terminal.open` when a selected chat has not yet materialized its durable session row. | Materializes and revalidates the exact agent-owned session before opening its terminal. |

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
