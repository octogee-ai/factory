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
[`6c42f8e6967722e1523cfa8541c65ca44a2e3459`](https://github.com/openclaw/openclaw/commit/6c42f8e6967722e1523cfa8541c65ca44a2e3459),
locked for the October 4 recut. This is not a full-CI-green base.
[Push CI 37210163214](https://github.com/openclaw/openclaw/actions/runs/37210163214)
has one security-fast success and 39 skips; all 40 jobs were inspected.
The operator chose to qualify this newer native implementation for TEST rather
than describe its green push badge as full validation.
Exact overlay:
[`150c92f398517242ca795ef7abcc9d7a6b35a2d2`](https://github.com/ceckert/openclaw/commit/150c92f398517242ca795ef7abcc9d7a6b35a2d2),
pushed and read back at `ceckert/openclaw:codex/octogee-main-oct04-candidate`.
Package version is `2026.9.8`; this is a main snapshot, not a GA tag.

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
| `openclaw-fork-1259f5f4.tgz` | `1259f5f40d82960249617b80112db72f782ec28364f2f5b66a54e2b64dc4a479` | `1791136020394119` |
| `openclaw-mattermost-e9a9e392.tgz` | `e9a9e392212c0e31c6b5fca2b9db8657812eb0b17187cdb9bca815d1f38e5580` | `1791135976505351` |

Generation-bound downloads match both complete hashes above.

Shared-state schema advances to 21; agent schema stays 24. The native migration
owner reconciles both shipped schema-20 layouts while retaining receipts,
handoff journals, fences, jobs and scratch. Synthetic populated-state tests
prove upgrade and downgrade refusal; they are not live continuity proof.
Preserve native backups and roll forward, not an image-only downgrade or reset.

### Qualification

The exact clean-source build passes in 11m12s. Native archive integrity and
isolated matched root/Mattermost installation pass. The actual Linux arm64
full-plugin-installer passes registry refresh, bundled trust, 167 byte-identical
Codex runtime files and all three native-hook imports. Its installed build-info
matches the source above; local proof image is
`sha256:28a40247ca872fd1957cb7376ef69d2305db24d09b6ba23268b037bc45dde83a`.

The rebase's affected cron, storage, tenant, model-reload, Mattermost, Talk and
sharing regressions pass, with failing controls for the new integration repairs.
Final cleanup passes 143 backend tests and 18 avatar-auth tests; full native
production, test, extension, script and UI type graphs pass, as does corrected-file
typed lint. All native unused-export scans are clean. Native UI E2E passes nine mock-Gateway tests for
browser width/takeover and authentication recovery. These are not live TEST
conversations. Both exact-source Octogee voice/Activity SDK checks pass during
packing; their focused suites pass 67 and 34 tests respectively.

All seven UI provenance records use the same clean built source. The complete
previous-pin input audit and the final source-only regeneration were reviewed;
the native entries remain wired upstream. The new source adopts model-picker
focus repair, compact session-list updates, calmer database warmup and current
Browser/Computer owners. Octogee PWA types, 15 island consumer tests, 135 final
pin/base/packer tests and 19 base-image recipe tests pass. Voice adopts the
unchanged streaming resampler from `realtime-voice-provider`, not its retired
facade export. No duplicate audio implementation is added.

Aggregate `pnpm check` success is not claimed. Native changed-source preflight
passes 22 initial gates, then rejects the retained approval-reviewer/consult SDK
contracts at the public-export budget (3649/3646 exports, 2112/2111 callables).
The full build reports startup JS gzip 373483 B versus 373454 B, 29 B over.
Full-tree lint reports inherited file-size violations; the modified sharing
owner also remains over its inherited cap but shrinks. Owned type/lint issues
were corrected, without raising caps or weakening assertions. Evidence is recorded in
[PR #4244](https://github.com/octogee-ai/octogee/pull/4244).

No deployment or live TEST acceptance is claimed. After merge and immutable
Build main, verify Shared and any active Builder separately: schema upgrade and
native backups, every mounted agent/account, Mattermost history, queued user
requests and approvals, authenticated UI, browser takeover and voice. Preserve
original continuity baselines and recheck concurrent lifecycle operations.

### Patch assessment

Rechecked against `6c42f8e6`: merged native deleted-agent cleanup replaces the
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

This recut keeps the October 2 tool inputs: Claude Code 2.1.287, Codex CLI
0.160.0 and npm 12.2.0, with matching Builder locks and install-script
approvals. The base uses gcloud 587.0.0, GitHub CLI 2.102.0 and yq 4.54.1; Builder Firebase CLI
is 15.32.1 and pnpm is 12.8.1. Node 26.10.0, Rust 1.98.1 and inherited fd
10.5.0 stay unchanged. OpenClaw builds use its own pinned pnpm 12.5.1, not
the Builder's tool version. The actual Linux arm64 system stage and CLI smoke
pass; the October 2 system image is
`sha256:7723f923f186a42f9c3a0d143119ed95d3bc3f3d6afd9a76b5fa8cb85c896417`.
Network-disabled smoke confirms both updated CLIs and the unchanged Node/npm/
GitHub CLI/fd versions. All 65 focused base/toolchain tests pass. Builder's
duplicate `fd-find` and the redundant npm dependency override
remain removed.

The October 2 audit covered all Builder npm roots, four Python pins and five
standalone tool pins. Its Debian index check found zero pending upgrades and
its Builder lock audit found zero vulnerabilities across 753 dependencies.
This is recorded prior toolchain proof, not an October 4 latest-version audit.

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
