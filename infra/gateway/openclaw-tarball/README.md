# OpenClaw current build

Octogee uses a released OpenClaw tag or an explicitly selected main snapshot,
plus the smallest overlay required by its consumers. `current.json` selects
two write-once GCS artifacts. Build main resolves their generations and produces
an immutable, digest-addressed image family. Building never deploys TEST or PROD.

## Refresh a tag or green main snapshot

1. Fetch upstream in a clean OpenClaw checkout (`origin`: `openclaw/openclaw`,
   `ceckert`: the fork). For a tag, record the annotated tag object and peeled
   commit. For main, inspect the jobs of the most recent successful **full** CI
   run, not just a green fast/security-only push run. Record its exact head SHA,
   run URL and skipped jobs. A newer tip is not automatically a better candidate.
2. Lock that full SHA before starting. Rebase the prior overlay onto it, checking
   each changed boundary. Do not chase a moving tip during the build. Drop
   adopted behavior, unused capabilities and optimizations that change upstream
   correctness. Use native owners when files or APIs move.
3. Test affected behavior, with a failing control for new bugs; run applicable
   native type, lint, generated-output and package checks. Reuse upstream
   coverage instead of copying whole suites. Keep real resource/authorization
   boundary tests even when trimming fixtures.
4. Commit the final source and build with `pnpm build`. Verify
   `dist/build-info.json.commit` equals the clean checkout's HEAD. Use the
   repository-pinned package manager and frozen lockfile. `build:docker` is not
   a substitute: the full build creates the files required by `npm pack`.
5. Check open upstream contributions separately against current main. Remove
   an overlay fix once the selected base contains equivalent behavior and its
   consumer tests pass. An open PR, a merge outside the selected base, or a
   matching package version is not enough.

```bash
git fetch origin main
# Set this to the inspected full-CI run's 40-character head SHA, not FETCH_HEAD.
UPSTREAM_SHA=<verified-full-green-sha>
git rebase --onto "$UPSTREAM_SHA" <previous-upstream-base> <overlay-branch>
pnpm install --frozen-lockfile
pnpm tsgo:prod
pnpm check
pnpm config:channels:check
pnpm build
git status --short
cat dist/build-info.json
```

Record incomplete or inherited failing checks precisely; never describe a
partial run as aggregate `pnpm check` success. Keep single-purpose patches
and concise evidence in the PR, not historical benchmark diaries here.

## Package and publish

Run both maintained packers **sequentially** from a clean Octogee checkout into
a fresh directory. `OPENCLAW_SKIP_BUILD=1` is only for exact source already
built in this cycle. Both packers use the same OpenClaw artifact tree.

```bash
ARTIFACT_DIR=$(mktemp -d -t openclaw-current-artifacts-XXXXXX)
ROOT_TGZ=$(OPENCLAW_SKIP_BUILD=1 \
  bash infra/gateway/openclaw-tarball/pack-fork-tarball.sh \
  /path/to/openclaw "$ARTIFACT_DIR")
MATTERMOST_TGZ=$(bash infra/gateway/openclaw-tarball/pack-mattermost-tarball.sh \
  /path/to/openclaw "$ARTIFACT_DIR")
```

Before publication:

- Run upstream's `scripts/check-openclaw-package-tarball.mjs` on the root archive.
- Install the exact root and Mattermost pair in an isolated npm prefix and
  verify installed build-info. Core, Codex, Parallel and Mattermost must come
  from the same checkout, not merely share a version.
- Build the actual Linux `openclaw-full-plugin-installer` target in
  `infra/gateway/Dockerfile.base`. Its native registry refresh, bundled-trust
  check, source-match verification and three native-hook imports must pass.
  Recipe fixtures alone are not installed-image proof.
- Confirm the native prepack/postpack lifecycle leaves the source clean.

```bash
ROOT_SHA256=$(shasum -a 256 "$ROOT_TGZ" | awk '{print $1}')
ROOT_OBJECT="openclaw-fork-${ROOT_SHA256:0:8}.tgz"
MATTERMOST_SHA256=$(shasum -a 256 "$MATTERMOST_TGZ" | awk '{print $1}')
MATTERMOST_OBJECT="openclaw-mattermost-${MATTERMOST_SHA256:0:8}.tgz"

gcloud storage cp --if-generation-match=0 "$ROOT_TGZ" \
  "gs://octogee-openclaw-fork/${ROOT_OBJECT}"
gcloud storage cp --if-generation-match=0 "$MATTERMOST_TGZ" \
  "gs://octogee-openclaw-fork/${MATTERMOST_OBJECT}"
```

Never overwrite an object or use retired `*-main.tgz` names. If an object
already exists, verify its complete hash before reuse; an eight-character
name is not proof. Read back published generations and hashes. Set
`upstreamRef`, `sourceSha`, `openclawObject` and `mattermostObject` in
`current.json`, and mirror the names in root `cloudbuild-base.yaml`. Push the
exact overlay branch; use `--force-with-lease` only when rewriting a previously
published branch.

The hosted UI islands ship from the same source. Regenerate them from the same
clean, built checkout before publishing, so `sourceSha` pins the gateway objects
and the committed bundles together:

```bash
node app/openclaw-islands/build.mjs /path/to/openclaw "$(git -C /path/to/openclaw rev-parse HEAD)"
```

`tests/specs/openclaw-native-islands-pin.spec.ts` fails a PR whose committed
islands do not match `sourceSha`, and the build prints the upstream changes to
the islands' input files since the previous pin (see
[app/openclaw-islands/README.md](../../../app/openclaw-islands/README.md)).

Update the Current overlay assessment below in the same Octogee PR. This README
is deliberately a gateway build input, including for artifact-only recuts.
Run focused artifact/base-image tests, evaluate feedback and wait for final-head
CI. After merge, Build main produces images, not a deployment. Environment
selection and rollout follow [Handbook 21](../../../docs/handbook/21-deploy-and-cicd.md).

## Current overlay

Upstream: published [v2026.9.7](https://github.com/openclaw/openclaw/releases/tag/v2026.9.7),
peeled commit
[`c074824a27c96d3983043f9eeb33823cd1772d8c`](https://github.com/openclaw/openclaw/commit/c074824a27c96d3983043f9eeb33823cd1772d8c).
Annotated tag object: `a05c851cc522fb5e6bc347f1eb0ff10d8f378fcc`.
Exact overlay:
[`82117be26cc8cad45b1c93692083283992143208`](https://github.com/ceckert/openclaw/commit/82117be26cc8cad45b1c93692083283992143208),
pushed to `ceckert/openclaw:codex/octogee-v2026.9.7-sept30`.
Package version is `2026.9.7`. The release was published September 30 at
04:44:14 UTC and has [release validation 36644909314](https://github.com/openclaw/openclaw/actions/runs/36644909314).
Its release notes waive Telegram integration checks and omit the Android APK;
this is not a claim that every release check ran.

The overlay retains fork PRs #5/#6, live voice-session grants, native approval
authority, hosted Automations and final-reply observation. Runtime objects and
all seven hosted UI provenance records come from the same clean, built source.
The GA tag diverges from the prior `a15f3f72` main snapshot: 170 main-only
commits are outside the tag. Rebase onto the published commit, not a moving
release branch, and preserve its native APIs instead of copying main-only code.

Release-specific adaptations preserve native sharing preparation, deletion
cleanup bookkeeping and void execution admission. The Talk tool remains a
session-bound factory: model-supplied targets cannot override its native session
or authenticated runtime identity. Its existing regression harness now invokes
that factory. Relay expiry validation moved unchanged into its existing state
owner to satisfy the native line-cap ratchet; no coverage or guard was weakened.

| Selected write-once object | SHA-256 | GCS generation |
| --- | --- | --- |
| `openclaw-fork-06ac9f47.tgz` | `06ac9f47132cc28d98780c9b56e14609d0a1c22da8341f602525aa3157580576` | `1790774777466453` |
| `openclaw-mattermost-1401a28f.tgz` | `1401a28f47d7c6b202658e0a9b43594c23a25585cb84f02089604af85e2c61a6` | `1790774780673707` |

Shared-state schema remains 20 and agent schema remains 24, as in the prior
current build. Schema equality is not live migration or continuity proof.
Preserve native backups and roll forward, not an image-only downgrade or reset.

### Qualification

The exact-source `pnpm build` passed in 9m 7.5s and records build ID
`2026.9.7-82117be26cc8-2026-09-30T13-09-30.088Z`. Both maintained packers ran
sequentially. Exact-source voice and activity consumer SDK checks passed.
Native archive integrity and the isolated matched installation passed. The
actual Linux arm64 `openclaw-full-plugin-installer` passed with 156 byte-identical
Codex files, nine Parallel files, bundled trust and all three native-hook imports.
Local installer image:
`sha256:961ceb8229c5749932d2ce2f7edab94c86319e8bd2af8453b1cff53cf79f7691`.
This is package qualification, not the later Build main gateway image identity.
Both write-once objects were read back and their full hashes verified.

Focused native proof includes 138 resource/deletion/reload tests, 178
cron/sharing/approval boundary tests, 229 channel/voice/browser/UI tests and 534
owner/cleanup/relay tests. The final Talk extraction rerun passed 158 tests.
Five real desktop/mobile UI E2E tests passed; inspected captures are
byte-identical to the prior current build. These are separate suites, not an
assertion that the entire upstream test suite ran. Production core/UI/extensions
types, protocol/config/Kysely/session-schema generation and native line-cap
checks passed. Independent integration review found no actionable remaining
regression. Stable post-pack scoped typed lint passed.
Octogee passed 135 artifact/provenance tests, 19 base-image tests, 32 native-island,
model-picker and Automations consumer tests, and the PWA typecheck. The UI audit
retains native, actively wired entry points; gateway protocol/client,
picker/composer, layout, redaction and style changes follow the release's source.
All bundles were regenerated together, not hand-edited or wrapped for main-only APIs.

The unchanged upstream SDK size gate reports 4,594 exports against 4,591 and
2,696 callables against 2,695. Three unused type exports remain removed.
The retained surface has concrete approval, voice and packaged Mattermost
consumers; the budget was not raised or bypassed. Export consistency passes.
No aggregate `pnpm check` success is claimed.

### Patch assessment

Rechecked against the published `c074824a` base: all 45 prior overlay commits
were carried; no retained area is fully adopted, and every area still has a
current Octogee consumer. None of the four contributed
fixes is fully adopted. Native workspace registry reuse (#160658) does not cover
the undefined-workspace metadata fallback. Whole-Gateway writer shutdown
(#160201) does not close every isolate's readers during per-agent deletion.
Auth-neutral reload skipping (#160274) does not detach a restarted channel
monitor from its initiating RPC client's authority. Catalog retention is still
unchanged. Keep the narrow behavioral coverage for these distinct boundaries.

Native scoped Slack reviewers (#159525) cover approval routing and eligibility,
not Octogee's live VM/run authority through execution. Native unknown-author
attribution (#160257) fixes messages; the retained header patch resolves exact
participant labels from the matching transcript. Worker computer takeover is
already adopted: its transport has no diff from the selected upstream base.

This is not an overall overlay reduction: the selected-tag diff is 281 files,
13,083 insertions and 1,182 deletions. The small integration repair adapts existing
owners and tests; it does not add a replacement runtime or duplicate test suite.

| Behavior | Current consumer | Removal condition |
| --- | --- | --- |
| Preserve committed hot reload during cron retries and superseding refreshes | Gateway config writes and customer mounts | Native reload preserves committed state, successor scope and genuine failures. |
| Borrow the published plugin generation for Skill Workshop | Native Builder skill review; disabled by Shared policy | Native reviews borrow the active generation's lifetime. |
| Read rotated external VNC credentials per observation | Visible desktop proxy | Native reconnect/observe does not retain the old password. |
| Mattermost channel-scoped threads and display-name titles | Threaded workspace rooms | Native channel scope shares room context without mixing turn reply destinations. |
| Transcript sender labels | Multi-human Control UI sessions | Native participants display the actual transcript sender. |
| Initial sharing-worker entries, explicit/channel grants and `sessions.channel.sync` | gateway-edge membership sync and sharing UI | A native seam preserves explicit grants, revocations and tenant boundaries. |
| Member-authorized workspace icons and browser-auth retry | Shared-session Control UI | Native icons use session membership and recover after authentication. |
| Live requester/reviewer and execution-time authority | `octogee-access-tools` native computer/connector approvals | Native plugin hooks carry and recheck the same authority; approval roles alone do not replace this contract. |
| Durable per-agent cron handoff | Cowboy Shared/Builder migration | Native transfer preserves ownership, partial handoff, rollback, retained jobs and scratch state without blocking unrelated system jobs. |
| Native Talk consults and live voice-session binding | Octogee #4143 ticket-derived voice grants | Native channel consults expose the same authenticated live-session identity and cancellation boundary. |
| Browser observation ownership during operator takeover | Coach browser tool and shared native panels | Native lazy tools retain per-owner observation generations so another agent cannot authorize stale input. |
| Native final-reply classification in `message_sent` | Octogee #4153 final-reply notifications | Native opted-in channel settlement exposes terminal-final classification after provider finalization. |
| Resolve `message_sent` observer availability at delivery time | Final-reply notifications after tool progress crosses plugin generations | Native emitter checks the current generation without caching an earlier hookless scope or falling back across isolation boundaries. |
| Optional read-only explanation and per-job run-history capability in the native Automations view | Hosted Workspace Automations | Native view supports the same tenant-filtered read-only projection without transcript or mutation authority. |
| Release superseded model-catalog generations | Long-lived gateway reloads | [#158986](https://github.com/openclaw/openclaw/pull/158986) or equivalent is in the selected base. |
| Reuse unchanged Gateway plugin registries across workspaces | Per-customer workspaces | [#159002](https://github.com/openclaw/openclaw/pull/159002) or equivalent preserves config, environment and metadata invalidation. |
| Close deleted-agent owners and every isolate's database readers | Source unmount after migration | [#159013](https://github.com/openclaw/openclaw/pull/159013) or equivalent closes descriptors without disturbing survivors or reopening deleted paths. |
| Start channel accounts without initiating RPC client authority | Mattermost Coach turns after config reload | [#159396](https://github.com/openclaw/openclaw/pull/159396) or equivalent retains the Gateway binding without the closed client's authority. |

Deletion closes readers after session purging but before Trash; journal
completion remains last. A failed close is retryable and starts no filesystem
cleanup. Worker shutdown remains registered until cleanup joins, and revival
clears its local fence only after acknowledgment. Native transcript-worker
metadata release remains intact. Post-commit revival failures log that readers
remain closed rather than misreporting an already-committed creation as failed.

Explicit sharing grants retain storage-only provenance even when their actor
also synchronizes channel membership: sync revokes its own rows, not explicit
grants. Historical same-actor rows need an explicit regrant to distinguish them.

Cron handoff now uses upstream's native reservation worker and guarded
transaction. Only migration-held filtering and receipt fences remain there.
Native owner materialization protects legacy default-agent and retained jobs;
aborted incoming handoffs restore earlier retirement fences.
Target system monitors and scratch remain intact until activation, so abort
does not discard them. Activation rechecks exact job identity and host-bound
approval grants before replacement. Partial export leaves nonportable jobs,
their scratch and approval authority on the source, still fenced.
Settle in-flight cron handoffs before changing runtime versions: this correction
cannot reconstruct target data already discarded by the old staging behavior.

### Removed and adopted

- Adopted native approval scheduling, async row selection, plugin-scope access
  and cron reservation ownership. Removed the old reservation adapter and its
  test-helper/import churn.
- Did not restore removed Tasks/TaskFlow APIs or generated Workboard overrides.
- Kept main's native computer takeover transport unchanged; the overlay does
  not carry the obsolete fork implementation of that worker.
- Dropped explicit computer `target: gateway` fallback. Octogee already selects
  native `target: node` with `node: octogee-desktop`.
- Removed the 336-line recurring real-Gateway descriptor harness and 32-line
  process helper after running resource proof. Narrow owner, worker, retry and
  recreation regressions remain; reload timing tests use deterministic controls.
- Removed unused reader-close exports. Kept native invalidation for
  resolved-secret and plugin-config changes.

Final-reply observers require `success === true` and `isFinalReply === true`.
The existing native terminal-content predicate excludes progress, reasoning,
commentary, status notices and supplemental audio, even in the final dispatch
lane. One logical reply split across provider posts emits one observation with
its representative message ID; multiple logical finals per run remain possible.
Unclassified sends omit the flag. This is a best-effort observation, not run
completion, authorization or a durable notification queue. The small follow-up
changes 11 native files (141 insertions, nine deletions), mostly regression proof;
it does not claim an overall overlay line-count reduction.

Upstream contributions carry separate local and hosted evidence. #158986,
#159002, #159013 and #159396 were all still open at this recut's inspection.
Their hosted checks are not this overlay's qualification. Check exact-head
adoption and feedback before dropping any patch; similarly named upstream
cleanup is not evidence of equivalent behavior.

### Base-image inputs

Claude Code moves to 2.1.283 and Codex CLI to 0.157.1, with matching Builder
locks and install-script approvals. Node 26.10.0, npm 12.1.0 and Rust 1.98.1
were current at selection. The actual Linux arm64 system stage and CLI smoke
pass. Removing Builder's duplicate `fd-find` preserves inherited fd 10.5.0
instead of downgrading it to Debian's 8.6.0. npm 12.1.0 already contains fixed
`brace-expansion` 5.0.9, so its redundant override is removed.

All Builder npm roots, four Python pins and five standalone tool pins were
audited. A fresh Debian index check in the built system image found zero pending
upgrades; the Builder lock audit found zero vulnerabilities across 753
dependencies. This does not claim every transitive dependency is registry-latest.

Native package verification uses a fresh disposable `OPENCLAW_STATE_DIR` in
the same image-build instruction. Reopening an inherited Docker-layer SQLite
database changes its birth time during copy-up and trips native admission.
The recipe correction and this selected pair passed actual Linux arm64 image
proof. Native guards and live state remain unchanged.

CUA remains the matched 0.28.2 package plus the native modifier backport below.
Published 0.30.2 predates that fix; the upstream adoption issue tracks removal.
No desktop OS image change or environment deployment is part of this recut.

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
fields, so existing gateways gain the defaults on their next boot. Builders can
set another mode (`off`, `partial`, or `progress`) or disable preview tool
progress; those explicit values survive subsequent boots.
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

Native `ls`, ordinary archived deletion, native terminal ownership and explicit
Octogee account/plugin policies replace earlier patches. Custom `secrets.apply`,
resolved-secret caching, database-recreation polling and startup-default
preservation remain removed. No replacement admin RPC is needed.

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

The selected main snapshot requires 0.28.2. The same 40-line patch applies
unchanged to its native release commit
[`fc188250b4ca8549b8e61f937fdb1fb560770e86`](https://github.com/trycua/cua/commit/fc188250b4ca8549b8e61f937fdb1fb560770e86).
Local Docker builds of the exact builder stage pass on native arm64 and emulated
amd64. Each architecture passes 28 focused Wayland tests and 453 Linux tests;
one focused and six full-suite GUI tests remain ignored because these builders
have no live desktop. Release compilation, dynamic loading, and library
architecture checks pass on both. The six installer regressions pass.
PR #3659 merged on September 28 as `b1bd49ce1dcc`; the latest published driver
still lacks the standalone mappings. The merge is not a claim that the local
headless builds performed canonical desktop validation.

[OpenClaw #160469](https://github.com/openclaw/openclaw/issues/160469) tracks
adoption of the first published matched SDK/native release containing the fix,
with release-source evidence and the focused modifier smoke needed to remove
this backport. Published 0.30.2 predates the merge and is not that release.

OpenClaw owns the package-version pin in its root and `cua-computer` manifests;
Octogee owns this matching native backport and adapted skills. CUA 0.30.2 is
available, but the selected OpenClaw main still uses 0.28.2 and 0.30.2 still lacks
the modifier mappings. A version upgrade must align OpenClaw's dependency lock,
JS bindings, native artifact digests, backport and skill provenance together;
changing only `CUA_SOURCE_SHA` is not a safe version upgrade.

Remove the native builder stage and installer overlay when the selected
OpenClaw package uses a published CUA version containing the fix and passes
the modifier/launcher checks. An upstream merge alone does not update an
installed npm package. Until then, a driver version change deliberately fails
the image build and requires reassessing this backport.

## Vendored computer-use skills

`infra/gateway/cua-skills/` holds the `cua-driver` skill adapted from CUA's
0.28.2 skill pack
([`fc188250`](https://github.com/trycua/cua/tree/fc188250b4ca8549b8e61f937fdb1fb560770e86/libs/cua-driver/rust/Skills/cua-driver))
and the `cua-omarchy` companion from Omarchy
[PR #11342](https://github.com/omacom/omarchy/pull/11342) at `94e97055`.
`provenance.json` records each repository, commit, and the SHA-256 of every
upstream file the adaptation came from. The runtime image installs them to
`/opt/octogee/skills/computer` with `install-cua-skills.mjs`, which refuses a
driver version other than the installed native package and patch, an unpinned
source, a skill version drift, or any file not listed in provenance. Nothing is
fetched at build or run time; `cua-driver skills install` is never used.

The adaptation keeps the loop, targeting, delivery, verification, and refusal
guidance and maps it onto the `computer` tool. It drops the standalone CLI and
MCP transport, the install, self-update, and `skills install --from main`
instructions, permission profiles and approval-bypass flags, cursor overlay,
recording, embedding, macOS, Windows, and Omarchy package and plugin
management. CUA's browser guide is replaced by the `browser` tool.

When the driver version changes, the build fails until the skills are
re-adapted: diff the upstream files at the new release against the recorded
digests, carry forward what applies, and update `provenance.json`.

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
