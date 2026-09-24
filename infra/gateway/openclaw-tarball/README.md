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

The September 23 final recut selects annotated tag
[`v2026.9.6`](https://github.com/openclaw/openclaw/releases/tag/v2026.9.6),
locked to tag object `ce5bbdc244ee937246cc1700d1b224d020c3b599` and peeled
source `eb377ac59e6c9fd6c7705028034812becf00271b`. Its release branch differs
from the previous `b6b45244` main snapshot: 394 commits are main-only and 33
release-only. This is a release port, not a claim that the tag includes every
newer main change. Package version is `2026.9.6`.

The scheduled-job handoff overlay is
`ceckert/openclaw:codex/octogee-scheduler-handoff`, built from exact source
`69259a083e84712e90fb4328951109654bc70ba0` on top of the previous
`a2cd214a1e1fa6c13e5a82ef13b47e6b85397bbb` overlay.

This adds the native `cron.migration` operator RPC and per-agent durable
scheduler fences. Portable timers, job IDs, creator provenance, and scratch
revisions move without copying the shared scheduler database. Source retirement
precedes destination activation; rollback tombstones reject delayed requests.
Schema 19 prevents older runtimes from ignoring these ownership fences.

The archives below were built, locally install-verified, and published with
write-once generation preconditions. Published checksums and sizes match the
verified local archives. Neither TEST nor PROD has been deployed from this change.

| Write-once object | SHA-256 | GCS generation |
| --- | --- | --- |
| `openclaw-fork-adb75f19.tgz` | `adb75f19eef8ec2d147ae9ce473aaa3b6254b607c7a9be318fee39af6a04b9bc` | `1790215793943848` |
| `openclaw-mattermost-43163935.tgz` | `43163935aad1df28f3f78a4faf0e4f0b255856400854cc3e5310999751629f23` | `1790215776773694` |

Upstream adoption removes these downstream patches:

- Preferences authorization: [PR #147930](https://github.com/openclaw/openclaw/pull/147930),
  merged as `25c6dd5`.
- Overlapping config/secrets model publication: [PR #155073](https://github.com/openclaw/openclaw/pull/155073),
  merged as `58e27e0`; native publication completion now joins its successful
  successor rather than requesting a false recovery restart.
- Custom membership projection: native `cf32d5a` / `42263f8` provide the
  projection owner, replacing the previous overlay implementation.
- Offline plugin-dialog recovery: native wizard handling in `97043faf`
  replaces the old patch.

| Retained area | Required behavior and boundary |
| --- | --- |
| Channel administration and human grants | Admin-only channel sync uses native mutation authority; revocation removes only service-authored grants and preserves explicit human grants in either grant order. Native membership projection owns the facts. |
| Mattermost channel sessions and presentation | Room threads share channel context while each turn retains its reply root; DMs stay native. Preserve readable session titles and participant names within their exact transcript identity namespaces. |
| Workspace icon access and recovery | Use current native profile roles and session visibility; invalidate rejected requests even when a recovered bearer stays unchanged, without discarding successful or missing-image caches. |
| Computer requester and reviewer authority | Preserve live verified requester identity independently of command-owner/admin privilege. Recheck reviewer authority through native worker admission/commit and deferred Codex execution, including final file revalidation. Two type-only SDK exports; no new RPC or approval store. |
| External VNC reconnect | Read rotated credentials on each external attach observation while preserving managed credentials, cancellation, and native desktop lifetime. Live rotation/reconnect proof remains outstanding. |
| Detached Skill Workshop runtime reuse | Reuse the current published plugin generation while retaining the exact model and admission owner. No unmeasured performance benefit is claimed. |
| Cron retry deferral | Keep a committed reload live when monitor reconciliation schedules its native retry; partial-write retry convergence has regression coverage. This is narrower than the other contributor's [PR #148592](https://github.com/openclaw/openclaw/pull/148592), whose branch is not rewritten or duplicated. |
| Computer blank selectors | Treat blank `target`, `node`, and `environmentId` as unset so sole-paired-node discovery works. [PR #155072](https://github.com/openclaw/openclaw/pull/155072) remains carried until its fix is in the selected base. |

The port follows the release's worker and lifetime owners. Reviewer authority
is rechecked through native transaction admission and commit callbacks, including
post-error revalidation; it does not import main-only persistence machinery.
A red/green regression proves that revoking operator scopes while reviewer
preparation is pending prevents resolution. Native channel ensure
publishes actual committed creates so the existing projection observes them;
profile-catalog reads skip a redundant host-thread PRAGMA instead of creating a
second cache. Collected replies clear live sender authority when verified people
differ, and queued authority remains bound to the admitted requester. Native
cancellation, reviewer roles, and worker transaction fences remain intact.

Per-agent SQLite advances from schema 22 to 23 and shared state from 17 to 18.
The release retains the deletion-journal prerequisite, so PR #3999's private
native-state initialization remains required. A populated TEST online backup
with 76 transcript events passed isolated native Doctor bootstrap (14.296s),
schema 22→23 migration (19.697s), and exact schema-23 preflight with no issues.
All decoded transcript rows, IDs, ordering, timestamps, ownership metadata,
and auth-table hashes were unchanged. Private diagnostic reads created WAL
sidecars; native online backup consolidated the proof copy before preflight.
No live database was modified and no private records left TEST. Disposable
proof copies were removed afterward. The container startup path retains its
migration lease and verified pre-migration backups; the final rollout must still
check admission for every mounted agent and continuity of existing conversations.
This rollout is forward-only. An image-only downgrade after schema advancement
is unsafe.

Packaging keeps the exact core source and rebuilds Codex and Parallel from that
same checkout. The full image places Codex at `dist/extensions/codex` with its
declared production dependencies, using upstream's supported source-image route:
native discovery must report `origin: "bundled"` before granting keyed-store APIs.
No registry provenance is fabricated and no installed-plugin trust rule is relaxed.
The disposable stage omits development-only workspace metadata from npm input,
installs production/optional dependencies with lifecycle scripts disabled, and
restores original manifest bytes before native registry refresh and inspection.
Install or refresh failures abort; inspection failures retain stderr and JSON.

`infra/gateway/verify-codex-source-match.mjs` checks bundled location and trust,
identity/version, the exact manifest and all runtime bytes against the source
archive. The image recipe separately verifies paired native-hook imports and
absence of a duplicate managed-npm Codex.
A shared version string does not prove matching bytes. The lightweight core image
does not include Codex; Parallel uses no trust-gated API and remains a vendored
archive in the managed npm tree. The root packer preserves upstream's explicit
bundled dependencies and vendors private workspace packages. In particular,
substituting the same-version registry `chrome-devtools-mcp` would discard its
upstream browser snapshot-identity repair. Native tarball-integrity checks cover
the patched files and required license/runtime assets.

Release-port focused runs pass the nine-file channel/icon/computer/Mattermost
suite and thirteen-file requester/reviewer/runtime/session-sharing/UI suite.
Additional reviewer and native admission regressions pass 19 and 13 cases;
the manager suite passes 61. These suites overlap, not a unique-test total.
The release routes reactions through native channel context; four reaction
cases cover public/private channels without importing newer main thread lookup.
Independent code/security review found no actionable findings. The worker-race
fixture revokes before mutation; source review, not a separate dynamic race,
verifies the same composed authority guard at both admission and commit.
Upstream PR #155072 maintenance is outside this recut; its downstream fix remains.

Core production types, all 25 core-test type graphs, UI/extension production
types, extension-test and script types, SDK/config/plugin boundaries,
formatting, growth limits, and native unused-export checks pass. Final native
lint qualification is still pending; no aggregate `check:changed` success is
claimed until it finishes. No rule was weakened.

The final exact-commit build, native tarball-integrity check, and isolated pair
installation pass. The actual Linux arm64 `openclaw-full-plugin-installer`
target passes at local image digest
`sha256:f7eb8d4f9d42313df3d12c7c7e018a37e59bb4453ea4a4750e85b41f10669f56`:
144 Codex runtime files are byte-identical and all three native-hook imports pass.
Final-input Octogee checks pass 114 artifact tests and 19 base-image tests.
The earlier main recut's picker screenshots are not new release-port browser
proof. Native Android/macOS
application builds are outside this gateway qualification. No hosted Octogee
build or deployment result is claimed by these local proofs.

The standard native archive check passes. Its optional
`--require-bundled-workspace-deps` mode instead demands npm-bundled `@openclaw/ai`,
which is not Octogee's documented `file:vendor/` layout. The isolated pair install
and actual Linux image verify that vendored layout without changing bundling rules.

Qualification continues to follow the [v2026.9.5 testing priorities](https://pagedrop.ai/g/jalehman/917106e69312c5b603d2e0ef3f48cf21):
storage integrity, plugin/reload lifecycle, shared messaging, and Control UI
behavior. TEST must verify conversation continuity, overlapping two-human
Mattermost turns, membership revocation, approval identity, and browser reconnect.
Provider account/billing behavior, live VNC rotation, mobile, and voice remain
outside these local proofs. The existing Lit-to-React model-picker adapter and
CUA backport keep their established reuse boundaries; no composer or framework
migration is introduced.

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

Mattermost defaults to `streaming.mode: "block"` with
`streaming.preview.toolProgress: true`: completed text and tool-activity blocks
remain visible, and final text follows the tool activity. Both gateway templates
seed these preferences. The pre-boot fix-up fills only missing channel-level
fields after gateway overrides are merged, so existing gateways gain the defaults
on their next boot. Builders can set another mode (`off`, `partial`, or `progress`)
or disable preview tool progress; those explicit values survive subsequent boots.
Accounts without a `streaming` override inherit the channel preferences. An explicit
`channels.mattermost.accounts.<accountId>.streaming` object remains untouched and
replaces the channel's streaming object under native OpenClaw account resolution.

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
