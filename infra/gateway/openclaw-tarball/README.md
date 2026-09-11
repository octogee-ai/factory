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

The selected release is `v2026.9.4`, peeled to
[upstream commit `3a9d69db306cd7f081e06254cb89c4bcc14a7107`](https://github.com/openclaw/openclaw/commit/3a9d69db306cd7f081e06254cb89c4bcc14a7107).
[Runtime source `d266aa7e0270f74a486c103d5e8484c916bf771a`](https://github.com/ceckert/openclaw/commit/d266aa7e0270f74a486c103d5e8484c916bf771a)
on `ceckert/openclaw:codex/octogee-v2026.9.4` carries the remaining overlay:

| Fix | Behavior pinned by its regressions | Upstream disposition |
| --- | --- | --- |
| Native channel membership | Materialize canonical channel sessions through an admin-only sync RPC; permit native features for explicit members, revoke only service-authored grants, and preserve explicit human grants in either grant order. | Still needed; [fork PR #4](https://github.com/ceckert/openclaw/pull/4) |
| Preferences and workspace icons | Resolve preferences without a session target, authorize icons through current native profile roles and session visibility, and bound repeated credential failures while allowing recovery. | Still needed; [fork PR #4](https://github.com/ceckert/openclaw/pull/4) |
| Channel session scope | Keep room messages in one channel session while retaining each message's Mattermost reply root. DMs retain native behavior. | Still needed; upstream consideration pending |

The config revision freshness patch [#142169](https://github.com/openclaw/openclaw/pull/142169)
and account-scoped SecretRef reload inspection patch
[#142193](https://github.com/openclaw/openclaw/pull/142193) are dropped from the
overlay. Both exact upstream merge commits are ancestors of the selected GA tag;
their upstream regression coverage remains intact.

The membership RPC reconciles grants owned by its calling principal. Octogee
always calls it as the durable `svc:gateway-edge` profile; browser and device
changes do not change that principal. Human sharing operations use human
profiles, so explicit human grants remain separate. Reusing the synchronization
principal for manual grants, or changing it between syncs, is outside this
integration contract and would require explicit grant-origin representation.

The port uses GA's schema-derived Mattermost config types and current gateway
session-store owner. Generated protocol bindings and config metadata are refreshed.
A test-only upstream media fixture repair creates the attached worker environment
before dispatch and surfaces setup failures, so denial assertions exercise the
intended ownership transition instead of passing after setup throws.

The root artifact is `openclaw-fork-d266aa7e.tgz`
(SHA-256 `bd946618107a56a24b299f0fbe5ab1a3603743092eb996e47b33f839af577909`).
Mattermost is `openclaw-mattermost-81ca0eed.tgz`
(SHA-256 `81ca0eedc687f9a6858550be5427a759a6419362c6daa5a24c718ab70f42f84a`).

The exact overlay commit passed the full build, 730 core/config regressions,
79 Mattermost regressions, and 11 UI regressions. Changed-source type, lint,
format, protocol, config metadata, and repository guards passed; the consolidated
sharing suite and its lint check were rerun after correcting two test-local names.
The packed root installed in a clean npm prefix, reported the exact overlay commit,
and imported the matching Mattermost runtime in the Dockerfile's bundled layout.
The Octogee base-reuse and native Mattermost contract suites passed all 16 tests.

### Mattermost session and delivery policy

Templates and pre-boot set `threadSessionScope: "channel"` for Mattermost accounts.
Existing reply and streaming preferences remain intact. This restores shared
context across a room's threads without restoring answer-commit observation,
Activity publication, or transcript reconstruction. Sessions and tool history
remain in native OpenClaw SQLite state. Existing thread sessions are not deleted
or merged by this change.

Octogee sets the native `messages.queue.byChannel.mattermost` policy to `followup`.
This keeps an overlapping second message queued with its own reply destination;
the native default `steer` can instead redirect the running answer into its first
thread. Other channel queue settings are preserved.

Human posts retain Octogee's submission ID in namespaced Mattermost properties,
bound to the posting user. Mattermost clears `pending_post_id` in later REST reads;
the durable ID lets native history reconcile the optimistic user bubble.

For v2026.9.3, a disposable runtime connected to the real TEST Mattermost service proved that
two humans, separate roots, and an existing thread share one channel session;
another channel remains isolated. An overlapping two-human test used distinct
answers and verified each appeared under its own root with `followup`. The test
also verified durable submission properties survive REST retrieval and native
history contains the turns. These were API/runtime checks, not a browser rollout.
All four fixture tokens were revoked, users deactivated, and private rooms and the
team archived afterward. Adapter and pre-boot behavior have separate regressions.

Startup-default preservation is also dropped downstream: Octogee already provisions
explicit account policies and plugin enablement. A separate generic auto-enable
reproduction still loses an effective schema default; that is upstream follow-up,
not a reason to preserve Octogee's patch. No replacement control RPC is needed.

Native `ls` continues to replace the former discovery patch. Resolved-secret caching,
custom `secrets.apply`, no-archive deletion, database-recreation polling, and custom
fresh-chat terminal ownership remain removed. The Dockerfile's WebSocket import
rewrite is removed because the released Mattermost package resolves it natively.

## Temporary native CUA driver patch

`Dockerfile.base` builds the CUA SDK from the 0.22.2 backport commit
[`6309cc93dea771c7980a23d586608b465293a4de`](https://github.com/ceckert/cua/commit/6309cc93dea771c7980a23d586608b465293a4de)
and installs its Linux library into OpenClaw's native driver package. The
backport carries [CUA PR #3659](https://github.com/trycua/cua/pull/3659):
standalone modifier aliases need native keysym and evdev translations.
No Omarchy keybindings or OpenClaw tool semantics change.

The build runs the focused Wayland tests, requires native package version
0.22.2, and records the source commit in `octogee-patch.json` beside the
library. The Dockerfile is already part of the immutable base fingerprint;
changing the source pin produces a new base identity. The original npm Node
runtime and generated bindings remain from the same 0.22.2 release.

Remove the native builder stage and installer overlay when the selected
OpenClaw package uses a published CUA version containing the fix and passes
the modifier/launcher checks. An upstream merge alone does not update an
installed npm package. Until then, a driver version change deliberately fails
the image build and requires reassessing this backport.

## What the packers do

`pack-fork-tarball.sh` produces an installable root package. It vendors root
`workspace:*` dependencies and unpublished Codex/Parallel companions when
needed, so a tag does not depend on a companion publish race.

`pack-mattermost-tarball.sh` runs OpenClaw's plugin packer and verifies compiled
runtime output. Mattermost stays separate so its exact native channel runtime
is content-addressed independently from the root package.

Use `pnpm build`, not `pnpm run build:docker`: the full build creates every
compiled file needed by `npm pack`.
