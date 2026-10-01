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

Upstream: selected green main
[`3d3a11c401f9817c61531ad0781e7c14c08dd80c`](https://github.com/openclaw/openclaw/commit/3d3a11c401f9817c61531ad0781e7c14c08dd80c),
locked before the October 1 recut. [Full CI 36786150394](https://github.com/openclaw/openclaw/actions/runs/36786150394)
passed: all 160 jobs inspected, 153 successes and seven skips. Skips were
ios-screenshots, pr-fail-fast, checks-node-compat-node24, check-plan,
ios-release-e2e, ios-screenshot-evidence and Seal full-release child evidence.
Exact overlay:
[`46398c529fb23f4429542d0ef24dc6224ab6287e`](https://github.com/ceckert/openclaw/commit/46398c529fb23f4429542d0ef24dc6224ab6287e),
pushed and read back at `ceckert/openclaw:codex/octogee-main-oct01`.
Package version is `2026.9.7`; this is a main snapshot, not the published GA tag.

The overlay retains fork PRs #5/#6, live voice-session grants, native approval
authority, hosted Automations and final-reply observation. Runtime objects and
all seven hosted UI provenance records come from the same clean, built source.
The selected main supplies native registry reuse, shared candidate execution,
reservation receipt contexts and current Browser/UI owners. Removed APIs are
not restored to accommodate old fixtures. Talk remains a session-bound factory:
model-supplied targets cannot override its session or authenticated identity.
Native line caps and authorization assertions remain unchanged.

| Selected write-once object | SHA-256 | GCS generation |
| --- | --- | --- |
| `openclaw-fork-ba4fdcd9.tgz` | `ba4fdcd9abf2cd698cf55f68489f234ef275f1777623c7dc2388ff01cd9c50f6` | `1790880475393384` |
| `openclaw-mattermost-93fbedb5.tgz` | `93fbedb52e43f67d306a8cdc645f8a516da14d2c083b9ecd5532fdc585898483` | `1790880478811849` |

Shared-state schema remains 20 and agent schema remains 24, as in the prior
current build. Schema equality is not live migration or continuity proof.
Preserve native backups and roll forward, not an image-only downgrade or reset.

### Qualification

The exact-source `pnpm build` passed in 10m 14.5s and records build ID
`2026.9.7-46398c529fb2-2026-10-01T18-31-32.924Z`. Both maintained packers ran
sequentially. Exact-source voice and activity consumer SDK checks passed.
Native archive integrity and the isolated matched installation passed. The
actual Linux arm64 `openclaw-full-plugin-installer` passed with 154 byte-identical
Codex files, nine Parallel files, bundled trust and all three native-hook imports.
Local installer image:
`sha256:868b37dca36a3291b1d59542758a2d5f55b16e4b70413179e72980b854065977`.
This is package qualification, not the later Build main gateway image identity.
Both write-once objects were read back and their full hashes verified.

Focused native proof includes 143 channel/Codex tests, 736 Gateway tests,
real SQLite-worker catalog retention, per-agent cleanup, cron handoff,
sharing/approval boundaries, Talk and Mattermost consults. Final affected
cron/Browser/Mattermost reruns passed 59 tests in four files.
Five real desktop/mobile UI E2E tests passed; inspected captures are
byte-identical to the prior current build. These are separate suites, not an
assertion that the entire upstream test suite ran. Production core/UI/extensions
types, all 27 canonical core-test typegraphs, extensions/scripts/root types,
protocol/config/Kysely/session-schema generation and native line-cap
checks passed. Independent integration review found no actionable remaining
regression. Stable post-pack scoped typed lint passed.
Octogee passed 135 artifact/provenance tests, 63 base/toolchain/security tests,
32 native-island/model-picker/Automations tests, 14 gateway Browser resource
consumer tests, and PWA/gateway-edge typechecks. The UI audit
retains native, actively wired entry points; gateway protocol/client,
picker/composer, layout, redaction and style changes follow the selected main.
All bundles were regenerated together, not hand-edited. The upstream input audit
was read and each entry checked for active native wiring.

The unchanged upstream SDK size gate reports 4,597 exports against 4,594 and
2,699 callables against 2,698. Three unused type exports remain removed.
The retained surface has concrete approval, voice and packaged Mattermost
consumers; the budget was not raised or bypassed. Export consistency passes.
No aggregate `pnpm check` success is claimed.

### Patch assessment

Rechecked against green main `3d3a11c4`: native per-record registry reuse
([#161267](https://github.com/openclaw/openclaw/pull/161267)) replaces the prior
workspace-registry workaround. Its two production files and existing loader
test now match upstream exactly; closed #159002 is not carried or reopened.
Catalog retention, per-agent reader closure and channel startup authority remain
distinct gaps. The overlay incorporates the current cleanup/channel PR fixes,
including worker close acknowledgment, committed-create fences and removal of
operator-tool authority from account startup. Whole-Gateway shutdown does not
replace per-agent cleanup, and reload skipping does not detach caller authority.

Native scoped Slack reviewers (#159525) cover approval routing and eligibility,
not Octogee's live VM/run authority through execution. Native unknown-author
attribution (#160257) fixes messages; the retained header patch resolves exact
participant labels from the matching transcript. Worker computer takeover is
already adopted: its transport has no diff from the selected upstream base.

This is not an overall overlay reduction. The prior GA overlay was 281 files,
13,083 insertions and 1,182 deletions; the final main overlay is 284 files,
13,282 insertions and 1,215 deletions. It still grows slightly
despite dropping the registry workaround and 230 lines of duplicated Codex
request-lifetime tests. Four distinct revoked/live-policy cases remain in the
existing command-scope suite. Real SQLite, worker, tenant and execution-authority
proof remains necessary; test-only type adaptations use the new native owners.

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
- Adopted native per-record plugin registry reuse; removed the fork's broader
  registry cache and restored the native loader test unchanged.
- Removed duplicated Codex request-lifetime coverage and unused approval helper
  wrappers. Retained four distinct authorization controls in the existing suite.
- Kept native candidate execution, async reservation receipt contexts, Browser
  tab ownership and scoped test contracts when adapting main. Did not restore
  removed SDK exports, Tasks APIs or old helper paths for stale fixtures.
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

Upstream contributions carry separate local and hosted evidence. #158986 is
refreshed on the selected main with 63 focused tests and RED/GREEN retention
proof; its native retirement callback no longer captures the predecessor's
catalog inventory. #159013 and #159396 have no remaining actionable code-review
findings, but their hosted reds are not declared resolved. #159013 still needs
maintainer-only exact-head security approval. Main's shutdown fixture fix
#162133 explains one old channel CI failure; its first-signin failure remains
unclassified. #159002 is closed and replaced by the selected native owner.
Hosted PR checks are not this overlay's qualification.

### Base-image inputs

Claude Code moves to 2.1.286, Codex CLI to 0.159.3 and npm to 12.2.0, with
matching Builder locks and install-script approvals. The base also updates
gcloud to 587.0.0, GitHub CLI to 2.102.0 and yq to 4.54.1; Builder Firebase CLI
is 15.32.1 and pnpm is 12.8.1. Node 26.10.0, Rust 1.98.1 and inherited fd
10.5.0 stay unchanged. OpenClaw builds use its own pinned pnpm 12.5.1, not
the Builder's tool version. The actual Linux arm64 system stage and CLI smoke
pass. Builder's duplicate `fd-find` and the redundant npm dependency override
remain removed.

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
Published 0.30.3 and 0.31.0 contain the upstream fix, but the selected OpenClaw
still pins 0.28.2. The upstream adoption issue tracks a matched package upgrade.
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
PR #3659 merged on September 28 as `b1bd49ce1dcc`. Published driver 0.30.3
contains it, as does [0.31.0](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.31.0),
published September 30. The merge is not a claim that the local headless builds
performed canonical desktop validation.

[OpenClaw #160469](https://github.com/openclaw/openclaw/issues/160469) tracks
adoption of the first published matched SDK/native release containing the fix,
with release-source evidence and the focused modifier smoke needed to remove
this backport. Published 0.30.2 predates the merge; 0.30.3 is the first fixed
published pair.

OpenClaw owns the package-version pin in its root and `cua-computer` manifests;
Octogee owns this matching native backport and adapted skills. Fixed releases
are available, but the selected OpenClaw main still uses 0.28.2. A version
upgrade must align OpenClaw's dependency lock,
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
