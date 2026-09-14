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

The selected build is upstream `main`, locked at the start of the recut to
[`167653ddfa338d4d664de11524735c52b48dc139`](https://github.com/openclaw/openclaw/commit/167653ddfa338d4d664de11524735c52b48dc139).
Its package version is `2026.9.4`; this is a main snapshot, not the GA tag.
[Runtime source `c94ec031913aa04c34ed690de2294d9836ce0b15`](https://github.com/ceckert/openclaw/commit/c94ec031913aa04c34ed690de2294d9836ce0b15)
on `ceckert/openclaw:codex/octogee-main-20260913` carries the remaining overlay:

| Fix | Behavior pinned by its regressions | Upstream disposition |
| --- | --- | --- |
| Native channel membership | Materialize canonical channel sessions through an admin-only sync RPC; permit native features for explicit members, revoke only service-authored grants, and preserve explicit human grants in either grant order. | Still needed; contributing to the existing [upstream policy discussion #135631](https://github.com/openclaw/openclaw/issues/135631#issuecomment-5657833033), not silently redefining upstream's `none` policy. |
| Preferences and workspace icons | Resolve preferences without a session target, authorize icons through current native profile roles and session visibility, and bound repeated credential failures while allowing recovery. | Still needed; the generic preferences fix is [upstream PR #147930](https://github.com/openclaw/openclaw/pull/147930). |
| Channel session scope | Keep room messages in one channel session while retaining each message's Mattermost reply root. DMs retain native behavior. | Still needed; existing [upstream proposal #132759](https://github.com/openclaw/openclaw/issues/132759) awaits the shared-room policy/configuration decision. |

The config revision freshness patch [#142169](https://github.com/openclaw/openclaw/pull/142169)
and account-scoped SecretRef reload inspection patch
[#142193](https://github.com/openclaw/openclaw/pull/142193) are dropped from the
overlay. Both exact upstream merge commits are ancestors of the locked main snapshot;
their upstream regression coverage remains intact.

The membership RPC reconciles grants owned by its calling principal. Octogee
always calls it as the durable `svc:gateway-edge` profile; browser and device
changes do not change that principal. Human sharing operations use human
profiles, so explicit human grants remain separate. Reusing the synchronization
principal for manual grants, or changing it between syncs, is outside this
integration contract and would require explicit grant-origin representation.

The port uses upstream's schema-derived Mattermost config types and current
gateway session-store owner. Generated protocol bindings, plugin asset hashes,
and config metadata are refreshed. The media fixture workaround is dropped:
upstream #146508 now tests dispatch admission directly. Upstream's newer
`openRootFile` boundary remains intact. Added regressions prove channel membership
revocation removes prepared-icon access, mention eligibility, and delayed mention
delivery. Native activity-summary authorization uses the same sharing policy;
no custom Activity journal or transcript recovery is restored.

The root artifact is `openclaw-fork-c94ec031.tgz`
(SHA-256 `c0c652fa9a13dd332b82aa5b0e02b64c5991d062c5aa34554a8da8a534f57e46`).
Mattermost is `openclaw-mattermost-bcf4fa36.tgz`
(SHA-256 `bcf4fa3655ea94b2538209e6e7433e2f7863d8deff156e1b63bad98b57b3bf32`).

The exact overlay commit passed the full build. Focused gateway/runtime suites
cover membership, sharing, preferences, read visibility, mentions, media, and
icons; Mattermost routing/participation suites passed 152 tests and the UI icon
suite passed 11. Changed-source type, lint, format, protocol, config metadata,
and repository guards passed. The aggregate changed-check run hit a test-file
line limit; after tightening redundant assertions, its affected lint/tests and
remaining guards passed separately. Native mobile app builds were not run.
The packed root installed in a clean npm prefix, reported the exact overlay commit,
and imported the matching Mattermost runtime in the Dockerfile's bundled layout.
Octogee's base-reuse, native Mattermost, image fingerprint, CUA installer, and
gateway-edge membership/identity contracts are checked separately. Automated
checks do not constitute a live TEST rollout for this recut.

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

`Dockerfile.base` builds the CUA SDK from the 0.23.2 backport commit
[`2721eda5f2801d9d0695759c39c0ed9c812c82c9`](https://github.com/ceckert/cua/commit/2721eda5f2801d9d0695759c39c0ed9c812c82c9)
and installs its Linux library into OpenClaw's native driver package. The
backport carries [CUA PR #3659](https://github.com/trycua/cua/pull/3659):
standalone modifier aliases need native keysym and evdev translations.
No Omarchy keybindings or OpenClaw tool semantics change.

The build runs the focused Wayland tests, requires native package version
0.23.2, and records the source commit in `octogee-patch.json` beside the
library. The Dockerfile is already part of the immutable base fingerprint;
changing the source pin produces a new base identity. The original npm Node
runtime and generated bindings remain from the same 0.23.2 release.

The September 13 audit verified that published 0.23.2 and current CUA main
still lack these mappings; PR #3659 remains a draft awaiting native platform
proof. The exact 40-line backport applies unchanged. Source-extracted Rust
mapping regressions fail without the fix and pass with it, and four installer
regressions pass. These checks do not replace the image's Linux crate tests
or a real Wayland modifier/launcher smoke.

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
