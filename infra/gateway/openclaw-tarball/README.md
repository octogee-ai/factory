# OpenClaw current build

Octogee uses a released OpenClaw tag or an explicitly selected main snapshot,
plus the smallest overlay justified by demonstrated product gaps. `current.json` selects
two write-once GCS artifacts. Build main resolves their generations and produces
an immutable, digest-addressed image family. Building never deploys TEST or PROD.

## Refresh a tag or selected main snapshot

Reassess the overlay on every recut. Use the selected upstream's unpatched
Control UI/Dashboard as the functional reference, comparing the same agent,
identity, permissions and provider configuration. Prefer native behavior,
configuration and public plugin APIs; adapt Octogee consumers before extending
OpenClaw core. An existing consumer's dependency on a fork-only API is not proof
that the patch is needed.

For each retained patch, the assessment below must answer: what concrete
failure or approved incremental behavior remains after trying the native path;
why it belongs here rather than in an Octogee adapter; and what removes it.
Distinguish reproduced upstream bugs from optional product features and obsolete
integration assumptions. Features we previously built are not automatically
retained. Record upstream contribution status separately from that decision.
Adopt OpenClaw's canonical schemas and migration owners rather than maintaining
an Octogee schema fork. Keep these decisions and consumer adaptations in the
canonical recut, not a parallel runtime update path.

1. Fetch upstream in a clean OpenClaw checkout (`origin`: `openclaw/openclaw`,
   `ceckert`: the fork). For a tag, record the annotated tag object and peeled
   commit. For main, inspect the jobs of the most recent successful **full** CI
   run, not just a green fast/security-only push run. Record its exact head SHA,
   run URL and skipped jobs. A newer tip is not automatically a better candidate.
   An operator may instead select a newer main for independent qualification;
   record that exception and its CI limitations explicitly.
2. Lock that full SHA before starting. Rebase only the justified overlay onto it,
   checking each changed boundary. Do not chase a moving tip during the build. Drop
   adopted behavior, unused capabilities and optimizations that change upstream
   correctness. Use native owners when files or APIs move.
3. Test affected behavior, with a failing control for new bugs; run applicable
   native type, lint, generated-output and package checks. Reuse upstream
   coverage instead of copying whole suites. Keep real resource/authorization
   boundary tests even when trimming fixtures.
   Materialize both gateway classes through their real policy/pre-boot writers,
   including generated agents, and validate them against the exact built gateway.
   An isolated Doctor comparison must not need to translate default config keys;
   correct their writers during this recut instead. Keep full Doctor off healthy
   boots, without removing bounded failed-boot recovery or driver-artifact checks.
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
# Set this to the selected and qualified 40-character SHA, not FETCH_HEAD.
UPSTREAM_SHA=<selected-and-qualified-sha>
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

Upstream is operator-selected main
[`0f13444e2a6b60348b146c95bdd8c7146f758aa3`](https://github.com/openclaw/openclaw/commit/0f13444e2a6b60348b146c95bdd8c7146f758aa3),
frozen for the October 13 native-first recut. Exact native source is
`860b241f3e39838c97d8556b284b4ceb3110f5b9`, branch
`codex/openclaw-controlled-main-oct13`. Package `2026.10.2` is a main
snapshot, not a released tag. OpenClaw validation stays local; no full upstream,
fork-CI or iOS-green claim is made.

`current.json` selects the write-once pair `openclaw-fork-94300a20.tgz` and
`openclaw-mattermost-5a3a7073.tgz`. Their exact published generations were
downloaded and compared byte-for-byte with the qualified local archives.
The native branch was pushed normally and its full head read back; no hosted
OpenClaw CI was triggered.

Shared-state schema **22**, agent schema **26** and protocol **4** are the
selected upstream contracts. Canonical DDL, versions, migration ownership and
database admission remain native. Do not preserve the old October 12 no-22
restriction or create an Octogee schema dialect.

### What was removed

Native Talk now owns consultation, interruption and cancellation. The fork's
channel-consult ingress, `talk_voice` verbatim playback-wait narration and
speech-only cancellation behavior are removed. Octogee's API archives received
finalized speech after a native call, without another model call or live
Mattermost ingress. Native playback lifecycle acknowledgments remain.

Mattermost uses native per-thread memory and native steering configuration.
The fork's room-wide `threadSessionScope` and routing implementation are gone.
Talk and Activity retain a selected existing root across replies and tool views;
they never infer the room or latest thread. Browser and Terminal keep verified
conversation custody; Computer and theme controls need no conversation-history
or audience grant.

The fork's Browser take-control/give-back, manual pause and stale-input protocol
are removed. Native browser controls and upstream worker-computer behavior stay
native. Obsolete run-completion claims, hook-isolation machinery and fork
database-admission/startup owners are also removed where upstream supplies the
contract. No new manager replaces them.

Using the same runtime-only filter against each selected upstream, the overlay
fell from 198 to 165 changed files and from 6,136 to 5,172 added lines. This
excludes tests, docs and generated output and compares the prior qualified
`121c7fd` line, not the entire Octogee adapter or compiled bundle.

### Remaining gaps and removal conditions

These are distinct bug fixes, integration boundaries and approved features, not
a blanket claim that native OpenClaw is missing voice, browser or thread support.

| Retained boundary | Concrete gap without it; condition for removal |
| --- | --- |
| Requester, reviewer and execution-time authority | A native approval role alone does not bind another member's action to the current tenant/requester/run. The exact upstream control accepted an unauthorized other-UID review; the retained boundary rejects it. Remove when native public contracts carry and enforce the same current authority across tool and Codex execution. |
| Explicit versus channel-derived session sharing | A channel membership refresh must not erase an explicit owner grant, and an empty authoritative membership must revoke derived access. Retain the narrow integration until native sharing exposes equivalent independent grant sources. |
| Durable cron handoff | A job list alone cannot represent held/exported/staged/retired custody, permanent retired fences, failed returns, scratch tombstones or host-bound jobs across a gateway move. New custody lives in native retained plugin KV. Remove when native lifecycle APIs cover that complete handoff contract. |
| Offline legacy cron import | Existing published fork databases contain two ordered journal/fence tables. Opaque operation IDs cannot identify the latest retirement. The approved reader fingerprints lossless SQLite identities at four named raw-SQL sites, imports relative order and snapshots into native KV, and creates no new schema. Retire it only when no retained source or supported restore can require that import. |
| Maintenance, reload and catalog lifetimes | Queued or superseded work must not borrow expired authority, lose committed reload debt, or close a catalog still owned by an earlier reader. Retain only the reproduced lifetime/settlement gaps while preserving native FIFO, cancellation and database owners; drop each when the selected upstream passes its boundary control. |
| Channel account removal and deleted-agent discovery | Removing one account must join its startup/cleanup without stopping siblings; Doctor must discover journaled deleted identities and restored files. Keep these scoped owner repairs until native removal and maintenance discovery preserve those cases. |
| Plugin instance through final delivery | Finalization must use the originating plugin instance and receiver, not a replacement ID lookup; AbortSignal and other data retain identity. Remove when native delivery custody covers that finalization boundary. |
| Final-reply observation | Octogee's delivery/archive consumers need the actual terminal provider reply, not progress text or an invented run-completion claim. Keep the narrow observer contract until an equivalent native public event is available. |
| Tenant-brokered native voice transport | Native OpenAI audio and consultation work, but direct provider connections would put credentials and billing outside the central API. The approved typed transport seam changes only the authenticated connection; native Talk owns media and cancellation. Remove the seam when a native public transport hook covers this broker without private imports. |
| Hosted identity and desktop boundaries | Tenant-authenticated avatars, participant attribution, VNC credential refresh and current computer requester authority must survive hosted access. These are scoped hosting/security integrations, not a second browser or computer controller; remove individual patches when native public owners cover their demonstrated boundary. |

Contribution status is separate from retention. Existing upstream proposals are
not claimed merged merely because their behavior is adopted locally. No new
upstream PR or external OpenClaw CI is part of this recut. Optional tenant
features are not relabeled as upstream bug fixes.

The old fork's shared-21 cron layout is recognized only as a complete known
layout. Normal native Doctor takes verified backups, derives canonical predicate
columns where needed, imports retained cron custody and performs upstream's
21→22 migration. Partial or ambiguous custody refuses conversion. Agent 26 stays
native; no agent-version bump is invented to force Doctor.

### Local qualification and limits

The full pinned-package-manager native build passed with exact source build-info
and all 155 public SDK gate subpaths. Maintained sequential packers, native root
archive integrity, the matched isolated npm install and actual arm64/amd64
full-plugin installer gates passed. The full arm64 Gateway recipe passed its
type, native-module, extension, runtime-dependency and runtime-image gates.
Dirty local images have `BUILD_SHA=unknown`; they are not immutable Build main
release digests or full amd64 Builder-runtime-image qualification.

Genuine synthetic stores were authored through the exact published
`cf903690` predecessor, not by downgrading candidate DDL. Actual installed
candidate Doctor and unmodified image boot owners upgraded both closed copies:
shared 21→22, agents 26, canonical rows/JSON/rowids, sessions, transcripts,
retained plugin data, jobs, scratch and fences preserved. Thirteen operations
and seven fences imported to native KV; the >1 MiB snapshot reconstructed
exactly. Native backup groups completed and passed. A second pre-spawn inspection
skipped Doctor and left database bytes unchanged. The failed-boot claim was
synthetic; no candidate Gateway or live/source-Doctor acknowledgment was made.
Original native-valid fixture workspaces are outside the Octogee portable
Builder root; that refusal is retained, not passed off as consumer config proof.
Cursor/ACP stores are empty in this predecessor, so populated migration coverage
is not claimed.

Fresh Shared and VM-Builder configs were materialized through the current
policy, roster, account, pre-boot and catalog writers on Linux tmpfs as node
UID 1000. All six native validate→Doctor→validate commands exited 0. Structural
defaults, per-agent models/tools/browser policy and native steer queues stayed
unchanged. Builder's literal Mattermost config comparison changed because
Doctor made the owner sender list explicit; 144 installed-native before/after
decisions preserve normal multi-human admission and control-command authority.
The original false literal comparison and later fixture-export failures are
retained. Fresh installed checks keep that literal change visible and verify
the actual ingress decisions separately, without claiming a full state export
or relabeling the original harness as green.

Full offline Doctor is not a semantic no-op. It changes metadata, plugin indexes,
model maps, skills and wizard defaults. Builder's implicit native global model
also causes genuine Codex plugin enablement; Shared's explicit Codex disable
remains respected. Configured coach/project models do not change. Shared's
global unavailable-model fallback and failed model-specific tool-schema
inspection do not establish provider readiness. Standalone Doctor skips agent
catalog discovery; its config-only registry cannot resolve the authored
`platform-openrouter` rows. Installed-native disk and captured-source registries
resolve all four Shared agents' selected models before and after Doctor, with
the exact broker transport. Native preparation preserves those authored
`models.json` rows in merge mode. This is metadata-resolution proof, not
credential, inference or live-readiness acceptance; no duplicate global provider
registration was added to silence the warning.

The earlier candidate's offline Doctor warning, `SQLite facts require their
retained admission`, exposed a retained-patch regression. An actual scheduler
and admission control failed its first checkpoint there and passed on the
selected unpatched upstream. Ordinary maintenance now keeps native bootstrap
root context instead of capturing a completed opening operation; the separately
needed noncreating worker-lifetime relay remains. The owning regression and
worker/WAL siblings pass, and fresh installed Shared/Builder Doctor runs no
longer emit that warning. Original failures are preserved. This does not prove
every long-running WAL outcome. Healthy boots retain bounded native inspection
and do not run full Doctor; actual runtime acceptance remains required.

All six generated native provenance/license records select this source.
Browser and Computer retain native HTMLElement bridges and React
mount/update/destroy contracts, with one shared graph for remaining Lit islands.
The landed React model picker/tool icons and read-only tenant-filtered
Automations remain. Focused consumers, app and sidecar production builds pass.
Inspected local Chrome before/after frames cover empty Browser/Computer panels
at desktop/narrow widths in light/dark themes, not connected capability, full
layout parity or authenticated TEST acceptance.

The original isolated review found one P2: a missing permanent-retirement fence
could escape import validation. It was independently reproduced and repaired;
actual Doctor and owning cron persistence controls pass. The original report
is not described as scoped-clean. Required guards, assertion/mock/timeout
budgets and inherited line-cap limits are not weakened. Advisory size/CSS,
TypeScript experimental and native dependency warnings remain visible.
There is no aggregate `pnpm check`, paid-response or faster-startup claim.

Only a successful immutable main build and coordinated TEST rollout can qualify
live service behavior. Recovery retains sole Fleet/acceptance ownership until
explicit handoff; local qualification is not a competing rollout.

### Base-image inputs

The October 7 tool refresh selects Claude Code 2.1.293, Codex CLI 0.161.0,
Builder pnpm 12.10.1 and gcloud 588.0.0, with matching npm locks and exact
install-script approvals. The Builder recipe retains its amd64 contract;
its versioned gcloud x86_64 archive hashes to
`e38ceac43022bb5a4d94d5a4a9c9c51f90f28c910b59a018ae07011e220c4412`
through both Google's download service and official release bucket. Google's
documented checksum for the unversioned download does not match this versioned object.
GitHub CLI 2.102.0, Helm 4.3.0, yq 4.54.1, Terraform 1.16.5, Builder Firebase
CLI 15.32.1, npm 12.2.0 and fd 10.5.0 stay unchanged. The native CUA driver
builder uses the pinned Rust 1.99.0 image and the source's toolchain selector.
The selected OpenClaw snapshot pins pnpm 12.9.0,
Codex plugin dependency 0.160.0 and matched CUA package 0.33.4.

The base retains the existing immutable Node 26.11.1 image, which satisfies
the selected OpenClaw engine requirement. This recut does not refresh unrelated
CLI or operating-system pins, and October 8 image results are not fresh runtime
qualification for the new OpenClaw/CUA pair.
Builder's duplicate `fd-find` and redundant npm dependency override remain removed.

The October 5 lock audit reports three high-severity entries from one Firebase
CLI dependency chain: `firebase-tools` → `chokidar` → `braces`,
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
Published Firebase 15.32.1 and braces 3.0.3 have no newer fixed version at the
time of inspection. npm's proposed Firebase 6.8.0 downgrade is not adopted.
This is an unresolved inherited tool dependency, not a zero-vulnerability audit.
October 7 published metadata confirms the remaining Builder npm dependencies,
the four Python pins, npm, fd, GitHub CLI, Helm, Terraform, yq and Rust remain
current. The earlier Debian and Firebase dependency audits are prior evidence,
not a fresh vulnerability-clearance claim for these updated inputs.

Native package verification uses a fresh disposable `OPENCLAW_STATE_DIR` in
the same image-build instruction. Reopening an inherited Docker-layer SQLite
database changes its birth time during copy-up and trips native admission.
Native guards and live state remain unchanged.

CUA uses the matched 0.33.4 JavaScript/native package and the narrow Linux
desktop-discovery source patch below. The published modifier fix is adopted;
the old modifier-only fork is no longer an input.
No desktop OS image change is included. Environment rollout is separately gated
by the exact immutable Build main family and TEST/PROD validation.

### Mattermost session and delivery policy

Live voice belongs to native Talk; Mattermost archival must not gate microphone
input, spoken replies or agent consultation. Archive a compact record of finalized
user and agent speech after the call, without another model call, preserving
participant attribution and the authorized target.
An archive is not a new human turn and must not replay work into the agent.
Do not retain real-time channel-consult handoff or verbatim playback-wait
narration solely for archival. Preserve native playback acknowledgments and
the distinction between ending media and explicitly cancelling agent work.

Mattermost uses native per-thread memory. Templates default room replies to threads
with native `replyToMode: "all"`; pre-boot fills this default only when unset and
removes the retired `threadSessionScope` key from channel and account configuration.
Explicit channel/account reply modes, per-chat-type overrides, and streaming
preferences remain intact. Native direct messages stay unthreaded unless explicitly
configured otherwise. Reply destination and session identity remain distinct native
contracts. Sessions and tool history remain in native OpenClaw SQLite state; existing
thread sessions are not deleted, merged or reconstructed by this change.

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

Octogee selects native `messages.queue.byChannel.mattermost: "steer"` in both
gateway templates and pre-boot configuration. Replies retain their selected
thread; native OpenClaw owns active-run steering, idle admission and refusal
behavior. Different threads keep separate session identities. Other channel
queue settings and native per-session override precedence remain unchanged.
This is native configuration, not a fork steering implementation.

Human posts retain Octogee's submission ID in namespaced Mattermost properties,
bound to the posting user. Mattermost clears `pending_post_id` in later REST reads;
the durable ID lets native history reconcile the optimistic user bubble.

Native `ls`, ordinary archived deletion, native terminal ownership and explicit
Octogee account/plugin policies replace earlier patches. Custom `secrets.apply`,
resolved-secret caching, database-recreation polling and startup-default
preservation remain removed. No replacement admin RPC is needed.

## Native CUA desktop-discovery preservation

`Dockerfile.base` builds the Linux SDK from the official
[CUA 0.33.4 tag](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.33.4),
exact source `ba0033a661101669c60ce05f1fe5753bf8bad748`, with
`cua-desktop-discovery.patch`. The published modifier fix is already present,
so the older modifier-only fork is not used. Rust and the other CLI/tool pins
remain unchanged.

The sparse checkout also includes `libs/cua/Cargo.toml` and
`libs/cua/crates/cua-telemetry`, the 0.33.4 driver's existing path dependency.
The source revision, Cargo lockfile, dependency features and test gates remain
unchanged; the recipe does not fetch the rest of the CUA workspace.

The 0.33.4 `GetAccessibilityTreeTool` still discovers only X11 windows. The
patch keeps discovery on the native Wayland/X11 dispatcher, excludes
off-screen windows and known dead owners, remembers observed Wayland origins,
and emits the existing canonical window record (including bounds, app name,
visibility and optional stacking order). Unknown-owner visible windows remain
discoverable without inventing process identity. This is discovery metadata,
not proof that a compositor permits capture or input.

The source patch includes a hermetic visible/live-owner boundary regression in
the existing Linux window-record test owner. The builder runs that owner and
the focused Wayland tests before the release SDK build with `portal-input`;
it does not enable `portal-capture` or experimental Hyprland input-v3. Those
headless tests are not canonical desktop E2E proof. Qualification of this exact
new source/library pair must include the Linux crate tests, both required image
architectures, dynamic loading and the installed driver artifact check; old
0.28.2 build results do not qualify this pair.

The installer requires matching 0.33.4 installed JavaScript bindings, native
package, plugin dependency and patch metadata, the exact official source/tag,
and a patch digest. It first validates the original SDK against OpenClaw's
native artifact manifest, then replaces only that architecture's SDK digest in
the plugin and its single compiled manifest. Other binary/platform pins remain
unchanged. `octogee-patch.json` records the source, patch and installed library
digest. The CUA source and patch remain immutable base-fingerprint inputs.

OpenClaw owns the matched dependency/lock/artifact pins; Octogee owns this
discovery preservation and adapted skills. Remove the builder and installer
overlay only when the selected published package preserves the same
Wayland/visible/live/origin/canonical-record boundaries and passes matched
artifact and desktop qualification. A version bump or modifier fix alone does
not meet that removal condition.

## Vendored computer-use skills

`infra/gateway/cua-skills/` holds the `cua-driver` skill adapted from CUA's
0.33.4 skill pack
([`ba0033a6`](https://github.com/trycua/cua/tree/ba0033a661101669c60ce05f1fe5753bf8bad748/libs/cua-driver/rust/Skills/cua-driver))
and the `cua-omarchy` companion from Omarchy
[PR #11342](https://github.com/omacom/omarchy/pull/11342) at `94e97055`.
`provenance.json` records each repository, commit, and the SHA-256 of every
upstream file the adaptation came from. The runtime image installs them to
`/opt/octogee/skills/computer` with `install-cua-skills.mjs`, which refuses a
driver version other than the installed JavaScript/native package and patch,
a driver-source mismatch, an unpinned skill source, a skill version drift, or
any file not listed in provenance. No skill source is
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

Image assembly installs Parallel into the host's bundled plugin tree and sets
its native `openclaw.build.bundledDist` declaration to `true`. Source-match
verification permits only that distribution-ownership metadata change; all
other package fields, runtime files and the plugin manifest must match the
packed companion. OpenClaw's Doctor then owns retiring an obsolete exact-package
npm install record and certifying any retained upgrade obligation. Discovery
as `origin=bundled` alone does not transfer that repair ownership.

`pack-mattermost-tarball.sh` runs OpenClaw's plugin packer and verifies compiled
runtime output. Mattermost stays separate so its exact native channel runtime
is content-addressed independently from the root package.

Use `pnpm build`, not `pnpm run build:docker`: the full build creates every
compiled file needed by `npm pack`.
