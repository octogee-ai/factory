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

The selected build is the upstream GA tag
[`v2026.9.5`](https://github.com/openclaw/openclaw/releases/tag/v2026.9.5), an
annotated tag whose peeled commit is
[`ec9c1a13db8938e5a3eaa51fca2e981cde2395a9`](https://github.com/openclaw/openclaw/commit/ec9c1a13db8938e5a3eaa51fca2e981cde2395a9)
with package version `2026.9.5`. The tag branches from main at `309e85fe` and
adds four release commits: the release preparation, two changelog refreshes, and
[#151977](https://github.com/openclaw/openclaw/pull/151977), which stops older
updaters from rolling back while inspecting candidate dependencies.
[Runtime source `d144eb36efb8e2297058e52b45f5890b4a4d5f79`](https://github.com/ceckert/openclaw/commit/d144eb36efb8e2297058e52b45f5890b4a4d5f79)
on `ceckert/openclaw:codex/octogee-v2026.9.5` carries the overlay as one commit
rebased from the September 16 main snapshot.

The packer keeps that exact core source and rebuilds Codex and Parallel from
the same checkout. Upstream published `openclaw`, `@openclaw/codex`,
`@openclaw/mattermost`, and `@openclaw/ai` at `2026.9.5`; `@openclaw/parallel`
is not on npm at all. Source-matched companions remain the only accepted input,
but since 2026.9.5 OpenClaw grants keyed stores only to plugins whose install
record names the official npm or ClawHub package, and a `npm-pack:` archive can
never satisfy that (`resolvePluginTrust` reads `artifactKind: "npm-pack"` as
`provenance-invalid`). The image therefore installs `@openclaw/codex` from the
registry at the core version and proves at build time that its `dist` modules
are byte-identical to the source-matched archive
(`infra/gateway/verify-codex-source-match.mjs`), then asserts
`openclaw plugins inspect codex` reports `trusted-official`. A main snapshot has
no registry package at its version, so the image build fails loudly there;
Codex-trusting builds are GA tags. Parallel is not on npm and uses no
trust-gated API, so it stays a vendored archive.

| Fix | Behavior pinned by its regressions | Upstream disposition |
| --- | --- | --- |
| Native channel membership | Materialize canonical channel sessions through an admin-only sync RPC; permit native features for explicit members, revoke only service-authored grants, and preserve explicit human grants in either grant order. | Still needed; contributing to the existing [upstream policy discussion #135631](https://github.com/openclaw/openclaw/issues/135631#issuecomment-5657833033), not silently redefining upstream's `none` policy. |
| Preferences and workspace icons | Resolve preferences without a session target, authorize icons through current native profile roles and session visibility, and bound repeated credential failures. The overlay responds to upstream browser sign-in recovery by invalidating rejected icon requests even when the bearer token stays the same, without evicting successful or missing-image caches. | Still needed; [upstream PR #147930](https://github.com/openclaw/openclaw/pull/147930) is closed unmerged. A future submission needs the actual multi-agent Gateway reproduction, not only resolver tests. |
| Channel session scope | Keep room messages in one channel session while retaining each message's Mattermost reply root. DMs retain native behavior. | Still needed; existing [upstream proposal #132759](https://github.com/openclaw/openclaw/issues/132759) awaits the shared-room policy/configuration decision. |
| Deferred cron monitor convergence | A committed hot reload whose system cron monitor reconcile answers retry-scheduled stays live and logs the deferral instead of forcing a gateway restart; the cron service's own retry finishes the monitors. Pinned by the reload model-state and partial-monitor-write regressions. | Needed by Octogee's multi-customer surge imports; [upstream PR #148592](https://github.com/openclaw/openclaw/pull/148592) is still open and is not in the tag. Remove after it lands in the selected base; do not duplicate the PR or carry its unrelated restart-audit changes. |
| External desktop reconnect | Reread rotated VNC credentials on each external attach-mode observation; preserve managed ephemeral credentials, cancellation, and desktop lifetime. | Needed by Octogee external desktops; no matching upstream PR found. A focused submission still needs real VNC rotation/reconnect proof. |
| Published plugin runtime reuse | Detached Skill Workshop reviews reuse the current published generation while retaining their exact model and admission owner. | Reproduced downstream; no matching upstream PR found. Do not claim a performance gain without before/after preparation measurements. |
| Native session and dialog recovery | Preserve readable Mattermost titles, resolve participant names within exact transcript identity namespaces, and keep plugin-dialog Cancel/X usable offline. | Reproduced downstream; no upstream PR filed. |
| Computer approval authority | Allow a plugin to constrain native approval reviewers using live server facts; preserve requester identity and revalidate authority, cancellation, and admission through execution. | Required by Octogee's gateway-owner policy; two type-only SDK exports, no new RPC or approval store. |

The September 20 audit covers 680 upstream commits between the September 16
snapshot and the tag. No patch is dropped this cycle and no retained patch has an
upstream replacement in the tag. Only the channel-membership patch needed a
real re-derivation; the other seven auto-applied onto files upstream did not touch,
or touched only adjacently.

Upstream [#150196](https://github.com/openclaw/openclaw/pull/150196) now serves
session lists, descriptions, and live row events from a resident in-memory
projection that carries each row's `membership` set, and
[#151036](https://github.com/openclaw/openclaw/pull/151036) moves full member
reads into the session-transcript worker. The membership port adopts that shape:
the prepared sharing facts pass upstream's `isMember` lookup into the list entry
filter, live-event admission reuses the prepared target and role instead of a
second store read, and the projected `sessions.describe` read admits explicit
channel members through the same role resolution. Member writes emit upstream's
keyed session-change publication so the resident projection refreshes after a
sync. Unprepared readers still resolve membership from SQLite exactly as before,
and the sync RPC keeps upstream's synchronous compatibility facade. Upstream's
`authorizeSessionSharingTarget` now takes prepared caps and roles; the overlay
keeps hiding only `viewer` roles under the `none` policy so explicit members
remain visible.

Upstream [#150644](https://github.com/openclaw/openclaw/pull/150644) recovers
bounded Mattermost thread history after a restart or reset, keyed by the pending
history key of the message's session. Under Octogee's channel scope that key is
the channel session, so recovery seeds the shared room session from the thread
the message arrived in; flat DMs keep native behavior. No adapter change was
needed. Upstream [#150801](https://github.com/openclaw/openclaw/pull/150801)
appends desktop viewer-slot recovery beside the overlay's protocol additions;
the generated Kotlin and Swift bindings, the advertised method order, the plugin
SDK surface budget (upstream 4482 plus the overlay's two reviewer types), the
bundled channel config metadata, the workboard Control UI asset hash, and the
docs config baseline (channel surface 3740 to 3742 for `threadSessionScope`) are
regenerated from the tag.

The tag also lifts `@trycua/cua-driver` from 0.23.2 to 0.24.0; see the native
driver section below for the rebased backport. The app's vendored OpenClaw model
picker is regenerated from the same `d144eb36` checkout per
`app/openclaw-model-picker/README.md`; its Lit and Web Awesome dependency
versions are unchanged from the prior snapshot.

The main reasons to take this tag are upstream's safer upgrade path (Doctor
preserves session history and repeated-repair state, and finishes upgrades with
invalid retained histories), the resident session projection that keeps large
session lists off SQLite on the request path, worker-backed member and
conversation-list reads, live plugin install and reload without a Gateway
restart, Mattermost thread-context recovery after restart, structured Mattermost
option answers, and the [#151977](https://github.com/openclaw/openclaw/pull/151977)
updater fix. These are not evidence that Octogee's prior live OOM or CPU stalls
are resolved.

The root artifact is `openclaw-fork-0038b3c7.tgz`
(SHA-256 `0038b3c7616a5d2985c877c63b483dacfde28cb06e6c3fa53afe2fce9cda0800`,
GCS generation `1789928967091534`).
Mattermost is `openclaw-mattermost-72f8286f.tgz`
(SHA-256 `72f8286fd3d4da8148fa2980f41c995a6b156883db62f241b752ef7c540b1762`,
GCS generation `1789928970133436`).
Both uploads used the generation-zero precondition against previously absent
object names, and both remote objects were verified against the local artifacts
by size and GCS MD5. The packed root passed upstream's tarball-integrity checker,
installed into a clean npm prefix with install scripts disabled, reported
`OpenClaw 2026.9.5 (d144eb3)`, carries the vendored `@openclaw/ai` workspace
dependency and the source-matched Codex and Parallel archives, and the Mattermost
artifact ships its compiled runtime. The prior `openclaw-fork-1d44a605.tgz` and
`openclaw-mattermost-97eb0b89.tgz` objects are untouched.

The September 20 overlay passed a full exact-commit build whose `dist/build-info.json`
identifies `d144eb36efb8e2297058e52b45f5890b4a4d5f79`, all twenty-one `pnpm check`
steps, `pnpm tsgo:core`, `pnpm check:test-types`, and both generated-config
checks. The first `pnpm check` run caught one real port defect: the auto-merge
left an unused `listSessionMembers` import after upstream moved that read to the
worker; it is removed. The 43 focused core test files across every retained patch
area and the nearby upstream sharing-store, session-projection, prepared-read,
reload, and cron tests passed with 1,188 tests, run one file at a time because
the shard runner expands multi-file targets to whole shards. The three UI unit
files passed, and the seven Chromium cases for automatic and interactive access
renewal, offline dialog dismissal, and active-install ownership passed under the
UI e2e config. Native mobile builds were not run. No Codex or other independent
review was run on this recut; the rebased diff against the tag was inspected by
hand only. Automated checks do not constitute a live TEST or PROD rollout.

This tag follows the [v2026.9.5 testing priorities](https://pagedrop.ai/g/jalehman/917106e69312c5b603d2e0ef3f48cf21):
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

`Dockerfile.base` builds the CUA SDK from the 0.24.0 backport commit
[`5af343ee8886e10663ebc3a6040fe9b3eab80fa9`](https://github.com/ceckert/cua/commit/5af343ee8886e10663ebc3a6040fe9b3eab80fa9)
on `ceckert/cua:octogee/cua-driver-0.24.0-modifier-keys` and installs its Linux
library into OpenClaw's native driver package. The backport carries
[CUA PR #3659](https://github.com/trycua/cua/pull/3659): standalone modifier
aliases need native keysym and evdev translations. No Omarchy keybindings or
OpenClaw tool semantics change.

The build runs the focused Wayland tests, requires native package version
0.24.0, and records the source commit in `octogee-patch.json` beside the
library. The Dockerfile is already part of the immutable base fingerprint;
changing the source pin produces a new base identity. The npm Node runtime and
generated bindings remain from the same 0.24.0 release.

OpenClaw 2026.9.5 moves the driver dependency from 0.23.2 to 0.24.0, so the
September 20 recut rebases the same 40-line patch onto the upstream
`cua-driver-rs 0.24.0` release commit
[`4b3396d9fe4bd3cf723b0eb8db83c18a8764b520`](https://github.com/trycua/cua/commit/4b3396d9fe4bd3cf723b0eb8db83c18a8764b520).
The patch applies unchanged. PR #3659 remains open, and CUA main (driver 0.28.2)
still lacks the standalone mappings. A local Docker run of the builder stage on
the rebased source passed the focused Wayland tests (28 passed, the native
surface test ignored as before) and built `libcua_driver_sdk.so`; that run was
a native arm64 build, while Build main produces the amd64 library. The four
installer regressions pass with the 0.24.0 pins.

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
