# OpenClaw main build

Octogee builds its gateway from the current OpenClaw `main` branch plus the
small Octogee overlay. The normal cycle is intentionally short:

1. refresh OpenClaw `main`;
2. rebase the overlay and resolve only real source overlaps;
3. build once and run focused behavior tests;
4. package the root and Mattermost artifacts;
5. replace the two moving `main` objects; and
6. merge the Octogee PR so the normal build creates the gateway images.

There are no checked-in OpenClaw versions, source commits, artifact digests,
or matrix rows to update. A build uses whatever is current when the cycle is
run. This guide produces source artifacts and images; it does not roll TEST or
PROD.

## Build a current-main update

Start from the OpenClaw checkout that has `origin` pointing at
`openclaw/openclaw` and `ceckert` pointing at the Octogee fork.

```bash
cd /path/to/openclaw
git fetch origin
git switch octogee/gateway-scaling-patches-main
git rebase origin/main
```

Keep the overlay small. If upstream now supplies a behavior, drop the related
patch rather than adapting it. When a rebase conflicts, retain both changes
only when both behaviors are still needed, then run the affected tests.

Build and test the changed behavior:

```bash
pnpm install --frozen-lockfile
pnpm build

node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.gateway-server.config.ts \
  src/gateway/server.sessions.delete-lifecycle.test.ts

node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.extension-mattermost.config.ts \
  extensions/mattermost/src/mattermost/admission.test.ts \
  extensions/mattermost/src/mattermost/activity-gateway-runtime.test.ts \
  extensions/mattermost/src/mattermost/gateway-methods.test.ts
```

Run a narrower command when the overlay changes a different area. Do not add a
second release ceremony or source-identity test around this loop.

## Package and publish

From the Octogee checkout, package the built OpenClaw checkout into a fresh
temporary directory:

```bash
ARTIFACT_DIR=$(mktemp -d -t openclaw-main-artifacts-XXXXXX)
ROOT_TGZ=$(OPENCLAW_SKIP_BUILD=1 \
  bash infra/gateway/openclaw-tarball/pack-fork-tarball.sh \
  /path/to/openclaw "$ARTIFACT_DIR")
MATTERMOST_TGZ=$(bash infra/gateway/openclaw-tarball/pack-mattermost-tarball.sh \
  /path/to/openclaw "$ARTIFACT_DIR")

gcloud storage cp "$ROOT_TGZ" \
  gs://octogee-openclaw-fork/openclaw-fork-main.tgz
gcloud storage cp "$MATTERMOST_TGZ" \
  gs://octogee-openclaw-fork/openclaw-mattermost-main.tgz
```

Those object names are moving inputs by design. The build resolves each
object's generation and content digests, combines them with the base Dockerfile
and Cloud Build recipe hash, and uses that key as an immutable
`octogee-gateway-base:inputs-…` tag. An unchanged key reuses the existing image;
a new key builds from the exact resolved generations and then updates the
`octogee-gateway-base:main` compatibility alias. Gateway and Builder builds use
the immutable tag directly.

Publish the rebased overlay for review and traceability:

```bash
git push --force-with-lease ceckert HEAD:octogee/gateway-scaling-patches-main
```

Then open the Octogee PR containing the runtime integration. An artifact-only
refresh still needs a new Octogee main commit: update the current-overlay table
with the keep/drop assessment, without recording a source commit, version,
digest, or fingerprint. This README is a gateway build input specifically so
that small review update starts Build main for the new commit. Merge that PR
and use its Build main run; never retry an earlier main commit for a new
OpenClaw artifact pair. The separate
`build-current-openclaw-base` workflow is available for an explicit manual
base rebuild.

## What the packers do

`pack-fork-tarball.sh` produces an installable root package. It vendors root
`workspace:*` dependencies and unpublished Codex/Parallel companions when
needed, so a main snapshot does not depend on those packages having reached
npm.

`pack-mattermost-tarball.sh` runs OpenClaw's plugin packer and verifies that
the package contains compiled runtime output. Mattermost stays separate because
Octogee carries its channel integration there.

Use `pnpm build`, not `pnpm run build:docker`: the full build creates every
compiled file needed by `npm pack`. The packers use `npm pack` because it is
reliable on OpenClaw's large export map.

## Current overlay

The branch is authoritative. At the time of a refresh, re-check each patch
against upstream `main` and remove anything OpenClaw has adopted.

| Patch area | Latest assessment | Why Octogee carries it |
| --- | --- | --- |
| Sandbox-backed file discovery | `v2026.8.1` still has no native shell-free discovery surface. [OpenClaw PR #122899](https://github.com/openclaw/openclaw/pull/122899) remains open and rebases cleanly as proven Linux confined-host support plus sandbox/remote bridges. | Keeps native `ls`, `find`, and `grep` available without granting `exec` or `process`. |
| Secret handling | `v2026.8.1` still has neither unchanged resolved-SecretRef reuse nor the authenticated `secrets.apply` RPC. Its focused auxiliary-handler parity test now covers the generic registration assertion, so the overlay's duplicate test hunk is gone. | Avoids re-running secret providers for unrelated config writes and supports Octogee's configuration flow. |
| Mattermost admission and activity | `v2026.8.1` requester-receipt work still does not provide durable Mattermost ingress admission, live run control, delivery observation, or gateway activity snapshots. | Supplies the authoritative chat/run lifecycle used by the Octogee chat experience. |
| No-archive session deletion | `v2026.8.1` has the internal purge primitive for lifecycle-owned cleanup, but its public `sessions.delete` schema still cannot request it. | Lets Ops Agent purge transient one-shot sessions without archive compression and gateway event-loop starvation. |

The gateway base still verifies actual runtime contracts such as the expected
configuration behavior and tool-policy shape. Those are product checks, not
source or artifact identity gates.

## When the fork can disappear

Drop the fork when upstream covers every row above. At that point, remove the
two packaging steps from `cloudbuild-base.yaml`, install upstream OpenClaw in
`Dockerfile.base`, and delete this directory. Until then, prefer upstreaming or
deleting patches over growing the overlay.
