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
git rev-parse v2026.9.1^{}
git switch -c octogee/gateway-scaling-patches-v2026.9.1 v2026.9.1
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
ARTIFACT_DIR=$(mktemp -d -t openclaw-v2026.9.1-artifacts-XXXXXX)
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

The current build is [OpenClaw `v2026.9.1`](https://github.com/openclaw/openclaw/releases/tag/v2026.9.1),
peeled to `ad6fe23aecb9b833d68139b0ddc9f239b894d2f1`, with overlay head
`2e2f6f595f57ce37ca7dc92b20b5a208c8817a3b`. Its root artifact is
`openclaw-fork-2e2f6f59.tgz` at generation `1788475273529187`; its separately
packed Mattermost runtime is `openclaw-mattermost-9b303940.tgz` at generation
`1788475248911711`. The overlay was re-audited against upstream main through
`8c6653a78dec`; none of the retained areas had been adopted.

| Patch area | v2026.9.1 assessment | Why Octogee carries it / removal gate |
| --- | --- | --- |
| Sandbox-backed file discovery | The tag has no native shell-free discovery surface. [OpenClaw PR #122899](https://github.com/openclaw/openclaw/pull/122899) remains parked at `c0ed0b9a32c9` pending the maintainers' security contract decision. | Keeps native `ls`, `find`, and `grep` without granting `exec` or `process`. Remove when upstream supplies an equivalent sandbox bridge and file-tool registration seam. |
| Secret handling | The tag has neither unchanged resolved-SecretRef reuse nor the authenticated `secrets.apply` RPC. | Avoids unnecessary secret-provider work and supports Octogee configuration writes. Remove when upstream provides both stable reuse and the authenticated write RPC. |
| No-archive session deletion | The tag has an internal purge primitive, but public `sessions.delete` cannot request it. [OpenClaw PR #137428](https://github.com/openclaw/openclaw/pull/137428) carries the public flag at `452e3776ef93ecc3063847bb6fe38557700170bc`. | Lets Ops Agent purge transient one-shot sessions without archive compression or event-loop starvation. Remove when the public no-archive contract lands upstream. |
| Recreated agent databases | The tag does not revalidate a recreated agent database before reuse. [OpenClaw PR #137424](https://github.com/openclaw/openclaw/pull/137424) carries the identity check at `e021c59be005ca879ce9e48509f19fbe965b170e`. | Prevents stale per-agent state after replacement. Remove when upstream reopens on file identity or generation change, or mandates a process restart after replacement. |
| Fresh-chat terminal ownership | The tag rejects `terminal.open` when a selected chat has not yet materialized its durable session row. | Materializes and revalidates the exact agent-owned session before opening its terminal. Remove when upstream supports exact-owner materialization for a fresh selected chat. |
| Durable Mattermost channel sessions | The tag keeps live state in SQLite and does not project authorized Mattermost channels through Control UI session/history/send or rebuild bounded conversational context from them. | Keeps SQLite as live execution state while making the Mattermost thread the durable transcript and recovery source. Remove when upstream exposes a pluggable durable conversation projection or equivalent channel adapter with the same authorization and run-correlation guarantees. |

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
