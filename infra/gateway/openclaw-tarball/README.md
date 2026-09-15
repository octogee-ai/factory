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

The selected build is upstream `main`, explicitly re-locked for this recut to
[`8b8ffca0188f15743c97518fae1ca82916185dcc`](https://github.com/openclaw/openclaw/commit/8b8ffca0188f15743c97518fae1ca82916185dcc),
whose [upstream CI passed](https://github.com/openclaw/openclaw/actions/runs/34995253977).
Its package version is `2026.9.4`; this is a main snapshot, not the GA tag.
[Runtime source `61955ecb9a9ebb56c86677395ae7818739c8f895`](https://github.com/ceckert/openclaw/commit/61955ecb9a9ebb56c86677395ae7818739c8f895)
on `ceckert/openclaw:codex/octogee-main-20260915` carries the remaining overlay:

| Fix | Behavior pinned by its regressions | Upstream disposition |
| --- | --- | --- |
| Native channel membership | Materialize canonical channel sessions through an admin-only sync RPC; permit native features for explicit members, revoke only service-authored grants, and preserve explicit human grants in either grant order. | Still needed; contributing to the existing [upstream policy discussion #135631](https://github.com/openclaw/openclaw/issues/135631#issuecomment-5657833033), not silently redefining upstream's `none` policy. |
| Preferences and workspace icons | Resolve preferences without a session target, authorize icons through current native profile roles and session visibility, and bound repeated credential failures. The overlay responds to upstream browser sign-in recovery by invalidating rejected icon requests even when the bearer token stays the same, without evicting successful or missing-image caches. | Still needed; [upstream PR #147930](https://github.com/openclaw/openclaw/pull/147930) is closed unmerged. A future submission needs the actual multi-agent Gateway reproduction, not only resolver tests. |
| Channel session scope | Keep room messages in one channel session while retaining each message's Mattermost reply root. DMs retain native behavior. | Still needed; existing [upstream proposal #132759](https://github.com/openclaw/openclaw/issues/132759) awaits the shared-room policy/configuration decision. |
| Deferred cron monitor convergence | A committed hot reload whose system cron monitor reconcile answers retry-scheduled stays live and logs the deferral instead of forcing a gateway restart; the cron service's own retry finishes the monitors. Pinned by the reload model-state and partial-monitor-write regressions. | Needed by Octogee's multi-customer surge imports; [upstream PR #148592](https://github.com/openclaw/openclaw/pull/148592) independently proposes this fix, with [our corroborating proof](https://github.com/openclaw/openclaw/pull/148592#issuecomment-5684713367). Remove after it lands in the selected base; do not duplicate the PR or carry its unrelated restart-audit changes. |
| External desktop reconnect | Reread rotated VNC credentials on each external attach-mode observation; preserve managed ephemeral credentials, cancellation, and desktop lifetime. | Needed by Octogee external desktops; no matching upstream PR found. A focused submission still needs real VNC rotation/reconnect proof. |
| Published plugin runtime reuse | Detached Skill Workshop reviews reuse the current published generation while retaining their exact model and admission owner. | Reproduced downstream; no matching upstream PR found. Do not claim a performance gain without before/after preparation measurements. |
| Native session and dialog recovery | Preserve readable Mattermost titles, resolve participant names within exact transcript identity namespaces, and keep plugin-dialog Cancel/X usable offline. | Reproduced downstream; no upstream PR filed. |
| Computer approval authority | Allow a plugin to constrain native approval reviewers using live server facts; preserve requester identity and revalidate authority, cancellation, and admission through execution. | Required by Octogee's gateway-owner policy; two type-only SDK exports, no new RPC or approval store. |

The config revision freshness patch [#142169](https://github.com/openclaw/openclaw/pull/142169)
and account-scoped SecretRef reload inspection patch
[#142193](https://github.com/openclaw/openclaw/pull/142193) are dropped from the
overlay. Both exact upstream merge commits are ancestors of the locked main snapshot;
their upstream regression coverage remains intact.

The September 15 recut also removes the manifest-provenance workaround and its
duplicate regression: upstream [#148632](https://github.com/openclaw/openclaw/pull/148632)
fixes canonical provenance at the installed-plugin index owner. The session-list
guidance patch is removed in favor of upstream's expanded inventory, pagination,
and relationship semantics. The extra computer privilege warning is removed;
Octogee's existing tier instructions already describe its noninteractive host.
The approval/requester port preserves upstream's newer screen-target authority
and adds a combined cross-browser/cross-human regression.

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

The root artifact is `openclaw-fork-61955ecb.tgz`
(SHA-256 `9a04c6d40f9b30cd9a96f64cac16f7e76b66d7c7969dff4ee140c1583fd77081`,
GCS generation `1789496313717926`).
Mattermost is `openclaw-mattermost-97eb0b89.tgz`
(SHA-256 `97eb0b899a1c88703656b3a97f91bee604e00daecaa0c467021a2ca5c904014a`,
GCS generation `1789496316868067`). Both write-once uploads were verified against
the local artifacts using GCS MD5 and CRC32C hashes.

The September 15 overlay passed the full build and `pnpm check` from the exact source commit;
`dist/build-info.json` reports `61955ecb9a9ebb56c86677395ae7818739c8f895`.
Before the approved six-commit re-lock, focused suites passed 1,452 tests:
416 cron/reload, 58 desktop, 26 plugin-loading,
79 Skill Workshop (including six real-runtime/mock-provider end-to-end cases),
15 storage/lifecycle, 439 approval/identity, and 419 channel/session/Control UI.
The overlay diff is byte-identical after rebase. The final base passed 416
cron/reload tests and 540 authentication/model/requester/approval tests.
The new native model-attribution test failed twice during concurrent build work,
with malformed cancellation cleanup masking the initial failure; the original
test passed unchanged in an idle run. No deadlines, assertions, or runtime code
were altered to obtain that pass. Five Bun-only desktop cases were skipped on Node.
Browser fixtures covered both
service-worker modes for sign-in recovery and all three offline/active-install
dialog cases. The earlier session-title and dialog screenshots remain in
[Octogee PR #3849](https://github.com/octogee-ai/octogee/pull/3849); this recut's
PR also carries the new same-bearer icon-recovery screenshots.
Full core and extension test typechecks and SDK surface/wiring checks passed.
The final re-locked source also passed all aggregate production/script/test-root
typechecks, type-aware lint, formatting, and policy guards.
The exact native SDK consumer check found no Octogee contract mismatch; three
existing import suppressions become unused when the real SDK is available.
Octogee's artifact/image contracts, pack lifecycle, and access-tools plugin passed 77 tests.
Independent source reviews found no actionable issues. Native mobile builds
were not run.

The packed root passed upstream's tarball-integrity checker, installed in a clean
prefix with the image's npm 12.0.2, reported the exact overlay commit, and imported
the matching Mattermost runtime in the Dockerfile's bundled layout. npm blocked
install scripts by default; the native launcher completed the pending package
lifecycle successfully. No install-script approval workaround was needed.
Octogee's RPC quarantine, Dashboard recovery, desktop process supervision,
toolchain, identity, and approval integration regressions are checked separately.
These fixes address reproduced defects; the recorded PROD CPU stalls and memory
provider retries still require rollout observation to establish full recovery.
Automated checks do not constitute a live TEST or PROD rollout.

This main candidate follows the [v2026.9.5 testing priorities](https://pagedrop.ai/g/jalehman/917106e69312c5b603d2e0ef3f48cf21):
storage integrity first, then plugin/reload lifecycle, shared messaging, and the
Control UI. Local storage regressions cover WAL/DELETE preservation, foreign-owner
rejection, bounded startup inspection, and session-history worker reuse/close.
Before wider adoption, a separately authorized TEST rollout must prove existing
conversation continuity across restart, overlapping two-human Mattermost turns,
membership revocation, approval identity, and browser reconnect. Live provider
account/billing behavior and real external VNC password rotation remain unqualified
by this local recut; mobile and voice are not deployment claims.

### Mattermost session and delivery policy

Templates and pre-boot set `threadSessionScope: "channel"` for Mattermost accounts.
Templates default room replies to threads with native `replyToMode: "all"`;
pre-boot fills this default only when unset. Explicit channel/account reply modes,
per-chat-type overrides, and streaming preferences remain intact. Native direct
messages stay unthreaded unless explicitly configured otherwise. This restores shared
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

`pack-fork-tarball.sh` produces an installable root package. It runs upstream's
prepared-artifact lifecycle before vendoring, including install inventories,
the pending-install marker, and manifest sanitation. It restores temporary
manifest, changelog, and docs-map changes after packing, including pack failures.
It vendors root
`workspace:*` dependencies and unpublished Codex/Parallel companions when
needed, so a tag does not depend on a companion publish race.

`pack-mattermost-tarball.sh` runs OpenClaw's plugin packer and verifies compiled
runtime output. Mattermost stays separate so its exact native channel runtime
is content-addressed independently from the root package.

Use `pnpm build`, not `pnpm run build:docker`: the full build creates every
compiled file needed by `npm pack`.
