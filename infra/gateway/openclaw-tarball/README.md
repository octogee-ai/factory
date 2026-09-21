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

ROOT_SHA256=$(shasum -a 256 "$ROOT_TGZ" | awk '{print $1}')
ROOT_OBJECT="openclaw-fork-${ROOT_SHA256:0:8}.tgz"
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

The September 21 recut selects upstream `main` at
[`efefa508a8adbe461597b3ab968880d1e6af7af3`](https://github.com/openclaw/openclaw/commit/efefa508a8adbe461597b3ab968880d1e6af7af3),
locked from the newest completed successful push
[CI run](https://github.com/openclaw/openclaw/actions/runs/35601102699) at the
start of the recut. That run had 67 successful jobs and 18 conditional skips;
the CI gate and build artifacts passed. This is a main snapshot with package
version `2026.9.5`, not another GA release. The overlay branch is
`ceckert/openclaw:codex/octogee-main-20260921`, with exact runtime source
[`af5266fc70b45d9672b510d961ddb562c9fb8bb1`](https://github.com/ceckert/openclaw/commit/af5266fc70b45d9672b510d961ddb562c9fb8bb1).

The packer keeps that exact core source and rebuilds Codex and Parallel from
the same checkout. The full image includes Codex inside the running OpenClaw
package at `dist/extensions/codex`, with its declared production dependencies
installed locally to that plugin. This uses upstream's supported source-image
bundling route: native discovery reports `origin: "bundled"` and grants bundled
plugins the keyed-store APIs. No registry provenance is fabricated and no
installed-plugin trust rule is relaxed. Untrusted archives remain untrusted.
The disposable image stage omits development-only workspace metadata from npm's
input, installs production/optional dependencies with lifecycle scripts disabled,
then restores the original vendored manifest bytes before inspection and source
verification. An install failure aborts the stage.

The build verifies the physical bundled location, native bundled trust, package
identity/version, and byte equality of the manifest and all `dist` payloads
against the source-matched archive (`infra/gateway/verify-codex-source-match.mjs`).
It also exercises the paired native-hook runtime and rejects a duplicate Codex
in the image's managed npm tree. A main snapshot can share a version number
with a GA release, so version equality alone is not evidence of matching bytes.
The lightweight core image does not include Codex. Parallel uses no trust-gated
API and remains a vendored archive in the managed npm tree.

The root packer preserves upstream's explicit bundled dependencies while
vendoring private workspace packages. In this snapshot, `chrome-devtools-mcp`
carries upstream's browser snapshot-identity repair; replacing it with the
same-version registry package would lose that repair. Upstream's tarball check
verifies the exact patched files and required license/runtime assets.

| Fix | Behavior pinned by its regressions | Upstream disposition |
| --- | --- | --- |
| Native channel membership | Materialize canonical channel sessions through an admin-only sync RPC; permit native features for explicit members, revoke only service-authored grants, and preserve explicit human grants in either grant order. | Still needed; contributing to the existing [upstream policy discussion #135631](https://github.com/openclaw/openclaw/issues/135631#issuecomment-5657833033), not silently redefining upstream's `none` policy. |
| Preferences and workspace icons | Resolve preferences without a session target, authorize icons through current native profile roles and session visibility, and bound repeated credential failures. Rejected icon requests are invalidated even when a recovered bearer token stays the same; successful and missing-image caches are preserved. | Still needed. [PR #147930](https://github.com/openclaw/openclaw/pull/147930) is reopened on this base with a real paired Control UI WebSocket reproduction, non-admin scopes, native preferences storage, and own/foreign-session authorization controls. Maintainer review is ready; CI is separate from local proof. |
| Channel session scope | Keep room messages in one channel session while retaining each message's Mattermost reply root. DMs retain native behavior. | Still needed; existing [upstream proposal #132759](https://github.com/openclaw/openclaw/issues/132759) awaits the shared-room policy/configuration decision. |
| Deferred cron monitor convergence | A committed hot reload whose system cron monitor reconcile answers retry-scheduled stays live and logs the deferral instead of forcing a gateway restart; the cron service's own retry finishes the monitors. Pinned by the reload model-state and partial-monitor-write regressions. | Needed by Octogee's multi-customer surge imports. [PR #148592](https://github.com/openclaw/openclaw/pull/148592) belongs to another contributor and remains open, conflicting, and absent from this base. Supply corroborating proof; do not rewrite their branch, duplicate the PR, or carry its unrelated restart-audit changes. |
| External desktop reconnect | Reread rotated VNC credentials on each external attach-mode observation; preserve managed ephemeral credentials, cancellation, and desktop lifetime. | Needed by Octogee external desktops; no matching upstream PR found. A focused submission still needs real VNC rotation/reconnect proof. |
| Published plugin runtime reuse | Detached Skill Workshop reviews reuse the current published generation while retaining their exact model and admission owner. | Reproduced downstream; no matching upstream PR found. Do not claim a performance gain without before/after preparation measurements. |
| Native session and dialog recovery | Preserve readable Mattermost titles, resolve participant names within exact transcript identity namespaces, and keep plugin-dialog Cancel/X usable offline. | Reproduced downstream; no upstream PR filed. |
| Computer approval authority | Allow a plugin to constrain native approval reviewers using live server facts; preserve requester identity and revalidate authority, cancellation, and admission through execution. | Required by Octogee's gateway-owner policy; two type-only SDK exports, no new RPC or approval store. |

The audit covers 2,044 commits reachable from this main snapshot but not the
previous GA tag. All eight retained patch areas still have downstream callers
or behavior regressions; none has a complete upstream replacement in the selected
base. The port follows the new native owners instead of restoring old wiring.

Upstream now materializes archived sessions on demand
([#151574](https://github.com/openclaw/openclaw/pull/151574)) and prepares placement
facts asynchronously ([#150270](https://github.com/openclaw/openclaw/pull/150270)).
Membership must remain available without warming those archived rows. The port
keeps membership on the native projection row, reads it through the existing
session-transcript worker, and clears grants immediately on invalidation. Bounded
worker replies are admitted only while the same projection epoch, session
generation, and physical store remain current. Exact reads prepare membership
before entering the native synchronous consumer. No new membership cache, store,
or background owner is introduced. Cold, warm, demoted, revoked, and replaced
session regressions trap accidental Gateway-thread membership SQL and stale grants.

Channel sync uses upstream's mutation authority and rechecks it after waits.
Computer approval adopts the native requester/admission path from
[#151863](https://github.com/openclaw/openclaw/pull/151863); the live reviewer guard
also crosses the deferred Codex relay and runs after final file revalidation.
Native rejection and cancellation semantics are preserved. External desktop
observation rereads VNC credentials and revalidates owner/configuration/lifetime
before admitting a reconnect. Focused TCP RFB tests are not a substitute for
live browser authentication with a rotated password.

Useful upstream changes include restricted session search and member-picker
indexes, reuse of session-list candidates across viewers, unchanged-plugin
retention during reload, reduced model-catalog worker heap growth, and portable
browser upload staging. These are reasons to qualify the snapshot, not evidence
that Octogee's prior live OOM or CPU stalls are resolved. Mattermost recovery
remains bounded thread-context recovery, not reconstruction of an entire channel
or replacement of native SQLite state.

Per-agent SQLite advances from schema 21 to 22; shared state remains schema 17.
The native container-replacement startup path takes a migration lease and saves
verified pre-migration agent and shared-state snapshots before migration. The
FTS ownership migration preserves existing transcript/index bytes and marks a
lazy rebuild; injected commit failure rolls back both schema markers and changes.
TEST qualification must verify every mounted agent is admitted and conversations
survive restart. After advancement, rollback requires coherent pre-upgrade state
and its matching old image, not an image-only downgrade.

Generated protocol bindings, method inventory, channel metadata, docs baselines,
and the workboard asset hash are regenerated from the selected source. The SDK
surface is upstream's 4,530 exports plus the two reviewer types. The CUA backport
moves to the required 0.28.2 release, retaining the same 40-line modifier mapping
patch. The PWA picker is refreshed from the exact overlay source using the
existing Lit-to-React adapter, without adopting another framework or widening
the reuse boundary to the composer.

The root artifact is `openclaw-fork-a281f4f1.tgz`
(SHA-256 `a281f4f11ca5e4bbb0fc7031652fdedf9c9a3cbbc7f27bb991d11d12daf1e560`,
GCS generation `1790003449383758`).
Mattermost is `openclaw-mattermost-8de90600.tgz`
(SHA-256 `8de90600af307e69d8c7b50101985ed48c5a5f2e14f6336ad83aa9ff2c0cae9d`,
GCS generation `1790003452514310`).
Both uploads used the generation-zero precondition against previously absent
object names, and both remote objects were verified against the local artifacts
by size and GCS MD5. The packed root passed upstream's tarball-integrity checker,
installed into a clean npm prefix with install scripts disabled, reported
`OpenClaw 2026.9.5 (af5266f)`, carries the vendored `@openclaw/ai` workspace
dependency and the source-matched Codex and Parallel archives, and the Mattermost
artifact ships its compiled runtime. The prior `openclaw-fork-0038b3c7.tgz` and
`openclaw-mattermost-72f8286f.tgz` objects are untouched.

The isolated installed-package smoke verifies all 144 Codex runtime files and
three native-hook imports. The actual registered bundled harness can read its
binding store; an identical archive installed through the native CLI is denied
with `PLUGIN_TRUST_REFUSED`. Leaving that archive's native install record unchanged
while removing only its disposable managed copy still selects the genuine bundle
and permits the registered harness read. This is local package proof, not a live
provider turn or deployed Linux image.

The September 21 full build leaves a clean source checkout and embeds
`af5266fc70b45d9672b510d961ddb562c9fb8bb1` in `dist/build-info.json` and the CLI.
Focused runs include 486 Gateway tests, 414 authority/configuration/queue tests,
115 Mattermost tests, and final reruns of 31 projection/membership and 128 native
Codex approval/fingerprint tests. These runs overlap; they are not a unique-test
total. Desktop observation has 34 focused tests. The four native container-upgrade
and two exact 21-to-22 FTS migration tests pass. Three UI unit files pass 33 tests;
seven Chromium cases cover access renewal and offline plugin-dialog dismissal.
Generated channel/config checks and extension production/test type checks pass.
The aggregate check passed its preflights and production, script, and test-root
type checks. It caught one misplaced type import during core lint; the corrected
file passes the same type-aware runner. Extension/script lint, whole-tree format,
UI styles, and the remaining policy guards pass, with zero runtime import cycles.
The corrected exact-commit full build passes in 4m38s. The picker has 23 passing
React tests, app typecheck, scoped ESLint, and Chromium desktop/mobile checks.

Fresh independent review caught the Gateway-thread membership read and the
missing deferred approval recheck. Existing regressions then caught a readiness
wrapper hiding async consumers from the native synchronous-read guard. The port
fixes those owners; it does not weaken tests, budgets, or guards. The preferences
PR adds actual multi-agent paired-WebSocket proof. Its upstream review reports
ready for maintainer review, and the hosted proof passes in a successful
[151-test shard](https://github.com/openclaw/openclaw/actions/runs/35609687706/job/106366463808).
Five other shards fail: one in database-worker teardown after 177 passing
assertions, three in approval/event delivery, and one in session recovery.
The failing cases do not exercise the changed preferences guard, but without a
base reproduction they are not claimed pre-existing or flaky. That PR is not CI-green.
Native mobile builds and a full upstream test-suite run are not local deployment
claims. Automated checks do not constitute a live TEST or PROD rollout.

This recut follows the [v2026.9.5 testing priorities](https://pagedrop.ai/g/jalehman/917106e69312c5b603d2e0ef3f48cf21):
storage integrity first, then plugin/reload lifecycle, shared messaging, and the
Control UI. Before wider adoption, a separately authorized TEST rollout must prove
existing conversation continuity across restart, overlapping two-human Mattermost
turns, membership revocation, approval identity, and browser reconnect. Live
provider account/billing behavior and real external VNC password rotation remain
unqualified by this local recut; mobile and voice are not deployment claims.

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

`Dockerfile.base` builds the CUA SDK from the 0.28.2 backport commit
[`ebc42f2ce00401adf750bcbdb083cc69e973c83c`](https://github.com/ceckert/cua/commit/ebc42f2ce00401adf750bcbdb083cc69e973c83c)
on `ceckert/cua:octogee/cua-driver-0.28.2-modifier-keys` and installs its Linux
library into OpenClaw's native driver package. The backport carries
[CUA PR #3659](https://github.com/trycua/cua/pull/3659): standalone modifier
aliases need native keysym and evdev translations. No Omarchy keybindings or
OpenClaw tool semantics change.

The build runs the focused Wayland tests, requires native package version
0.28.2, and records the source commit in `octogee-patch.json` beside the
library. The Dockerfile is already part of the immutable base fingerprint;
changing the source pin produces a new base identity. The npm Node runtime and
generated bindings remain from the same 0.28.2 release.

The September 21 main snapshot requires 0.28.2. The same 40-line patch applies
unchanged to its native release commit
[`fc188250b4ca8549b8e61f937fdb1fb560770e86`](https://github.com/trycua/cua/commit/fc188250b4ca8549b8e61f937fdb1fb560770e86).
Local Docker builds of the exact builder stage pass on native arm64 and emulated
amd64. Each architecture passes 28 focused Wayland tests and 453 Linux tests;
one focused and six full-suite GUI tests remain ignored because these builders
have no live desktop. Release compilation, dynamic loading, and library
architecture checks pass on both. The six installer regressions pass. PR #3659
has the refreshed evidence; it remains draft pending its canonical desktop
validation, and the published driver still lacks the standalone mappings.

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
`workspace:*` dependencies and always compiles Codex/Parallel companions from
the same checkout, independently of npm publication status.

`pack-mattermost-tarball.sh` runs OpenClaw's plugin packer and verifies compiled
runtime output. Mattermost stays separate so its exact native channel runtime
is content-addressed independently from the root package.

Use `pnpm build`, not `pnpm run build:docker`: the full build creates every
compiled file needed by `npm pack`.
