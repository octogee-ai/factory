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

Upstream: operator-selected main
[`d1ea49abc634222cbf207b3a7964385539d61e3e`](https://github.com/openclaw/openclaw/commit/d1ea49abc634222cbf207b3a7964385539d61e3e),
locked for the October 5 recut. This is not a full-CI-green base.
[Push CI 37369141356](https://github.com/openclaw/openclaw/actions/runs/37369141356)
has one security-fast success and 39 skips; all 40 jobs were inspected.
The operator chose this newer native implementation for independent qualification,
not to describe its green push badge as full validation. This recut does not
merge or deploy; a separate task owns the existing TEST recovery.
Exact overlay:
[`b9b2026d829ebcc841783757b4e83c80339b4841`](https://github.com/ceckert/openclaw/commit/b9b2026d829ebcc841783757b4e83c80339b4841),
pushed and read back at `ceckert/openclaw:codex/openclaw-main-oct05-refresh`.
Package version is `2026.9.8`; this is a main snapshot, not a GA tag.

The recut includes the complete `99541ca8` repair. Explicit secrets reload joins the native startup
admission owner's tracked preparation before opening its publication transaction.
This removes repeated startup/reload supersession while preserving reload
coalescing and forced-cold successor transactions. Shutdown cancels waiting
reloads while custody drains; terminal agent preparation failures stay refused.
Typed config/secrets supersession during startup still retries with native FIFO
custody, the original database witness and one database open. No Doctor, state
reset, timeout extension or schema change is added. Browser/Terminal admission
and Dashboard membership sync depend on the affected agent; live TEST acceptance
is still required after deployment. Queued SQLite worker opens now capture the
startup admission context when enqueued, retaining it when the worker replies.
The captured guard still checks live revocation and tenant ownership; it cannot
borrow another agent's startup authority.

Selected main separates native agent opening, migration and readiness
publication. The overlay uses those phases instead of restoring the old combined
startup callback: successful opening/migration occurs once, while only typed
config/secrets supersession retries publication under fresh native admission
scope. Model-publication rejection rechecks the same live guard; genuine model
failures, revoked ownership and shutdown stay terminal.

Committed model-refresh supersession retains unfinished service work in the
existing hot-reload owner. Neutral and identical successors consult that owner,
then use the normal managed publication path when debt remains. Successful
plugin replacement clears work it already fulfilled; stopped owners do not
clear it. Debt-free writes, explicit writer `none`, and reload `off` stay fast.

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
| `openclaw-fork-b1ee7667.tgz` | `b1ee7667afd8da89d689a59c1694c5abd7ed6cd4f7fa704b3ba5283fd39d5fe3` | `1791237182581118` |
| `openclaw-mattermost-2046d3c9.tgz` | `2046d3c91da87cb671e0eb86da41dd2d77a43525627911f8569f23d72cbc8164` | `1791237185743175` |

Generation-bound downloads match both complete hashes above.

Shared-state schema advances to 21; agent schema stays 24. The native migration
owner reconciles both shipped schema-20 layouts while retaining receipts,
handoff journals, fences, jobs and scratch. Synthetic populated-state tests
prove upgrade and downgrade refusal; they are not live continuity proof.
Preserve native backups and roll forward, not an image-only downgrade or reset.

### Qualification

The exact source's full `pnpm build` passes in 11m22s. Its build-info records
the exact overlay above. Native archive integrity and isolated matched
installation pass: 14,019 core files and 874 Mattermost files are byte-identical
to their archives. The native lifecycle consumes its one pending-install marker;
that marker is checked separately, not counted as an installed runtime file.
Both native Voice and Activity source/compiler contract gates pass during packing.

The actual Linux arm64 `openclaw-full-plugin-installer` target passes native
registry refresh, bundled trust, nine Parallel files, 173 Codex files and all
three native-hook imports. Network-disabled inspection confirms the exact
source above. Local installer proof image:
`sha256:013cf1611154e0fcb3b04d21b6cf68d3760f5319a938e2d85c2ecc69057a5aaf`.
This is installer proof, not a final Build main manifest or live TEST acceptance.

The retained startup/reload proof reproduces concurrent reloads repeatedly
superseding native preparation, then verifies eventual admission and later reload
success after the repair. The queued-worker regression uses the real worker and
broker: releasing the worker under a sibling context cannot replace the opening
agent's authority, and revoking the original admission still refuses the open.
Final startup/lifecycle/state qualification passes 59 native cases across six
files; the managed reload composition passes another 70 cases across four files.
Approval, session, cron, browser, Talk, Mattermost and header boundary suites
pass. All verified isolated Astra findings were corrected with failing controls;
the last scoped review finds no runtime issue. The final documentation correction
uses contextual inference for reviewer types rather than a private SDK import.
Production and affected test types, scoped typed lint, formatting and source guards pass.
Aggregate `pnpm check` success is not claimed. The inherited schema guard still
reports Swift schema 20 versus TypeScript 21; neither schema changes here. The
full build reports startup JS gzip 372985 B against the unchanged 373454 B
enforcement limit. Startup CSS is above its advisory target but below its hard
ceiling; no UI budget was increased.

All seven hosted UI provenance records were regenerated from the exact source.
The input audit adopts native sustained browser-input feedback, the model-picker
spinner correction, desktop fullscreen ownership and current UI simplifications.
The native entry points remain wired; removed question helper code is not restored.
The unchanged Octogee adapters produce five entries sharing 360 generated chunks.
Hosted island consumers pass 15 tests; native browser E2E passes five scenarios
in 19.42s. The genuine previous-source desktop/mobile takeover control passes
two scenarios in 13.57s; synthetic before/after captures were inspected.
The strict computer-approval consumer typecheck resolves only the actual
installed public SDK, with no missing-module suppression. Computer hook behavior
passes 23 cases. Final artifact/pin qualification passes 135 cases; base/toolchain
qualification passes 66 cases, with the final selected four suites replayed (53).

After the immutable Build main and authorized TEST rollout, verify eventual
startup convergence and an authenticated Builder activate → Browser/Terminal/
Dashboard → return → reactivate cycle, with history continuity against the
preserved baseline. Keep PROD on its accepted build; do not repeat accepted
recovery requests or clear live custody fences.

### Patch assessment

Rechecked against `d1ea49ab`: merged native deleted-agent cleanup replaces the
entire old cleanup family. Native Skill Workshop lifetime and published model
advancement replace their duplicate overlay owners. Native member readers and
the existing reservation worker are reused. The unused request-authority shim
is deleted; account startup uses the existing context-resolver owner without
inheriting the initiating RPC authority. Closed #159002 stays closed, and its
registry workaround remains removed. Tenant, execution-authority, explicit
versus channel-derived grants, live voice binding and cron-transfer contracts
remain distinct consumer requirements.

Native scoped Slack reviewers (#159525) cover approval routing and eligibility,
not Octogee's live VM/run authority through execution. Native unknown-author
attribution (#160257) fixes messages; the retained header patch resolves exact
participant labels from the matching transcript. Worker computer takeover is
already adopted: its transport has no diff from the selected upstream base.

This recut removes obsolete implementations and duplicated test scaffolding;
it does not drop real SQLite, worker, tenant or execution-authority controls.
Narrow retained regressions cover same-owner cron grants, delivered terminal
consult replies, successor-owned service refresh, member publication and stale
observations. Native removed exports are not restored for old mocks. Removed
API mocks borrow actual native exports, and fixture types follow native leases.

| Behavior | Current consumer | Removal condition |
| --- | --- | --- |
| Settle native startup before secrets reload; retry typed startup supersession | Builder Coach/project startup, Browser/Terminal admission and Dashboard channel sync | Native reload joins tracked startup work before publishing. Startup retries only known generation changes without losing FIFO custody or database/authority guards; remove this overlay when the selected upstream supplies equivalent convergence behavior. |
| Keep queued SQLite opens in their admission context | Startup preparation after the worker becomes available | Native queued-open callbacks retain their original async authority and continue checking revocation and tenant ownership. |
| Preserve committed hot reload during cron retries and superseding refreshes | Gateway config writes and customer mounts | Native reload preserves committed state, successor scope and genuine failures. |
| Keep predecessor catalog inventory out of retained auth-reader closures | Long-lived Gateway/account reloads | Native catalog seeding detaches the previous generation without changing inventory or credential retention; #158986 covers this distinct gap. |
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
| Start channel accounts without initiating RPC client authority | Mattermost Coach turns after config reload | [#159396](https://github.com/openclaw/openclaw/pull/159396) or equivalent retains the Gateway binding without the closed client's authority. |

Native deletion owns reader closure, its worker journal and revival fences.
The overlay does not duplicate that lifecycle or its test harness.

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
- Adopted native phased startup and deferred maintenance owners. Fresh native
  member readers remain authoritative, including empty membership results.
- Merged the distinct workspace-icon refusal/retry controls into main's existing
  header suite instead of restoring its deleted standalone test. Consolidated
  repeated startup fixture setup without dropping behavior assertions.
- Kept bundled Mattermost consult helpers on the existing private channel-route
  facade. External approval hooks infer reviewer types from the public plugin
  API; no private reviewer type import or public SDK-budget increase remains.
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
completion, authorization or a durable notification queue.

Upstream contributions carry separate local and hosted evidence. The selected
base adopts #159013, including worker-owned journal authority and deletion
leases; its old overlay implementation is gone. #159002 stays closed. Catalog
publication, metadata during drain and reload/model-call admission are native;
they do not eliminate the distinct predecessor-closure fix in #158986.
Channel startup retains the native `runChannelAccountStartup` owner plus the
request-authority correction tracked by #159396. Neither open contribution is
described as hosted-green without its own current-head evidence.

Native session-member readers, awaited transcript persistence and session-header
return-link contracts are adopted. Mattermost can extend the return-link plugin
contract instead of adding a second core UI implementation. Explicit grants
must still remain distinct from synchronized channel membership.

Schema 21 preserves both schema-20 layouts and marks old receipt state
`unknown`, not delivered. Native Doctor remains the owner of general legacy
cron repair. The retained handoff adapter materializes only the exact selected
same-owner jobs and eligible grants through the native worker.

### Base-image inputs

The October 5 recut updates Claude Code to 2.1.289, Codex CLI to
0.160.1 and Builder pnpm to 12.9.1, with matching locks and install-script
approvals. The base uses gcloud 587.0.0, GitHub CLI 2.102.0 and yq 4.54.1; Builder Firebase CLI
is 15.32.1 and npm is 12.2.0. Builder Terraform advances to 1.16.5;
Node 26.10.0 and inherited fd 10.5.0 stay unchanged. The native CUA driver
builder uses pinned Rust 1.99.0. OpenClaw builds use its own pnpm 12.5.1, not
the Builder's tool version. The actual Linux arm64 system stage and CLI smoke
pass; the October 5 system image is
`sha256:93421d0fd35dc70bc5d07ac3c337de3541b6c5e5b222333ab17bd16df8061264`.
Network-disabled smoke confirms both updated CLIs and npm. Builder's
duplicate `fd-find` and the redundant npm dependency override
remain removed.

The October 5 lock audit reports three high-severity entries from one Firebase
CLI dependency chain: `firebase-tools` → `chokidar` → `braces`,
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
Published Firebase 15.32.1 and braces 3.0.3 have no newer fixed version at the
time of inspection. npm's proposed Firebase 6.8.0 downgrade is not adopted.
This is an unresolved inherited tool dependency, not a zero-vulnerability audit.
Published metadata confirms Node, gcloud, the four Python pins and GitHub CLI/Helm/yq pins
remain current; the earlier Debian audit is prior evidence, not a fresh claim.

Native package verification uses a fresh disposable `OPENCLAW_STATE_DIR` in
the same image-build instruction. Reopening an inherited Docker-layer SQLite
database changes its birth time during copy-up and trips native admission.
The recipe correction and this selected pair passed actual Linux arm64 image
proof. Native guards and live state remain unchanged.

CUA remains the matched 0.28.2 package plus the native modifier backport below.
Published 0.30.3 and later releases contain the upstream fix, but the selected OpenClaw
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
