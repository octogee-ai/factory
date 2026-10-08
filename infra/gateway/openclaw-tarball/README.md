# OpenClaw current build

Octogee uses a released OpenClaw tag or an explicitly selected main snapshot,
plus the smallest overlay required by its consumers. `current.json` selects
two write-once GCS artifacts. Build main resolves their generations and produces
an immutable, digest-addressed image family. Building never deploys TEST or PROD.

## Refresh a tag or selected main snapshot

1. Fetch upstream in a clean OpenClaw checkout (`origin`: `openclaw/openclaw`,
   `ceckert`: the fork). For a tag, record the annotated tag object and peeled
   commit. For main, inspect the jobs of the most recent successful **full** CI
   run, not just a green fast/security-only push run. Record its exact head SHA,
   run URL and skipped jobs. A newer tip is not automatically a better candidate.
   An operator may instead select a newer main for independent qualification;
   record that exception and its CI limitations explicitly.
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
[`5fa9edbad09902107a2ac64d7d7d7ae08b58a416`](https://github.com/openclaw/openclaw/commit/5fa9edbad09902107a2ac64d7d7d7ae08b58a416),
locked for the October 7 recut. Its
[push CI](https://github.com/openclaw/openclaw/actions/runs/37703965004)
has one security-fast success and 39 skips, not full-CI green. The operator
selected this newer native implementation for independent qualification.
Exact overlay: `687bfec2f0a25adb9620e17fc715d60fd8eb42eb`, at
`ceckert/openclaw:codex/openclaw-current-oct07`.
Package version `2026.9.8` identifies a main snapshot, not the released tag.

Runtime artifacts and every hosted UI provenance record use that same clean,
built source. Schema 21, agent schema 24 and protocol 4 remain unchanged.
The schema repair preserves both shipped schema-20 layouts and refuses
downgrades; it does not reset or repair live state. Preserve native backups
and settle old-version in-flight cron handoffs before a separately authorized
rollout. No merge, deployment or live-state mutation is part of this recut.

### Patch assessment

The selected main owns approval completion and compare-and-swap, atomic
session-member reads, phased startup, shared profiles, plugin registry reuse,
deleted-agent cleanup, current conversation-turn contracts and OpenRouter
catalog v2. Duplicate owners and obsolete fixture APIs are removed. Main's
worker computer takeover transport remains unchanged.

Explicit grants now reuse native atomic membership reads and storage provenance:
channel synchronization cannot revoke an owner's explicit grant. Session facts
resolve the exact session key, agent and store before entering the native
worker; empty native membership is authoritative, not a fallback trigger.

Ian F's contribution in
[#163685](https://github.com/openclaw/openclaw/pull/163685)
is included and adapted to the current native plugin lifetime owner. Public
channel dispatch retains the original instance through provider finalization,
then releases custody. Native scoped bindings preserve class/private callback
receivers; noncallable data such as AbortSignal keeps its original identity.
No plugin-ID replacement lookup or global fallback is added.

| Retained contract | Consumer / condition for removal |
| --- | --- |
| Startup/reload settlement, typed supersession retry and queued SQLite authority | Builder agent admission; remove when native owners supply equivalent FIFO, live revocation and single-open behavior. |
| Committed reload debt across superseding catalog/config work | Customer mounts and config writes; preserve successor-owned service work without repeating fulfilled replacement. |
| Tenant-bound requester/reviewer and execution-time authority | Native computer/connector approvals; native roles alone do not bind an action to a live VM/run. |
| Explicit/channel-derived sharing and exact channel-sync dispatch | gateway-edge membership sync and hosted sharing; retain distinct grants and native storage fences. |
| Durable per-agent cron handoff | Shared/Builder migration; preserve exact identity, partial transfer, scratch, abort and host-bound grants. |
| Session-bound Talk consults and live voice grants | Octogee's native Talk integration; retain authenticated session identity and cancellation. |
| Final-reply observation and late observer lookup | Final-reply notifications; terminal provider settlement, not progress or run-completion authority. |
| Per-owner Browser observations and external VNC credential refresh | Visible desktop; another agent cannot unlock stale input. |
| Channel-scoped Mattermost context, transcript labels and member-authorized UI | Threaded multi-human rooms and hosted native panels. |
| Tenant-filtered read-only Automations projection | Hosted Workspace Automations without transcript or mutation authority. |
| Predecessor catalog closure lifetime and request-free account startup | Distinct gaps tracked by #158986 and #159396; native catalog publication and Slack reviewer routing do not remove them. |

Merged #159013 is adopted; its old cleanup family is gone. Closed #159002
stays closed and its broader registry cache remains removed. CUA's modifier
fix is published upstream, but this selected OpenClaw still pins 0.28.2;
keep the matching native backport until a matched SDK/package upgrade passes.
The overlay is not an overall line reduction. Required boundary tests remain;
large repeated fixture scaffolding is extracted into existing support owners,
not replaced by weaker assertions or raised line caps.

### Qualification

Exact clean-source build passed in 3m 59.5s. The matched packers, native archive
integrity, strict Voice/Activity SDK checks, isolated install and real Linux
arm64 full-plugin-installer passed. Installed build-info and all companions
identify the same source; a network-disabled node-user check passed.
Installer proof image:
`sha256:51c36a36494ca05310384e67cadfea7197c45b5c59ab49e4d1dac167e8a3fac1`.
Codex has 174 matching runtime files, Parallel nine, bundled trust passes,
and all three native-hook modules import.

Root `openclaw-fork-ac9fe889.tgz`, generation `1791431347971708`, SHA-256
`ac9fe8894d7b1e3de2f2b62f3cc11ba1483b9f47c1aefd8bcf74afa9aced37a2`.
Mattermost is byte-identical and reuses `openclaw-mattermost-56f2899f.tgz`,
generation `1791376533057025`, SHA-256
`56f2899f8c6dd4577c44a0e23bc955a6f5bd102e7a749a1079b0e5757c2353d7`.
Publication used a generation-zero precondition; exact-generation readbacks
match both complete hashes. No moving object or overwrite is used.

All seven affected backend families pass: 1,591 distinct cases across 77 files.
Sixteen public channel-custody cases exercise real native instances and
generations, private/prototype callbacks, retirement, cancellation, concurrent
same-ID isolation and cleanup. The callback receiver defect has real-entry
RED/GREEN proof. Fresh, explicitly approved isolated Astra review of the
corrected overlay is scoped-clean; no private TEST data was sent.

Native synthetic UI proof covers a genuine prior-source Browser baseline
(nine tests), current Browser/model-picker/Automations/header E2E (40 tests),
and component/consumer contracts (86 tests). Desktop/mobile before-and-after
captures are inspected. This is not authenticated TEST or desktop-driver proof.
The final island generator's upstream input audit is read, native entry points
remain wired, and all generated provenance and adapter digests are refreshed.

Production core/UI/extensions types, all 27 core-test type graphs, scoped typed
lint, formatting and the native line-cap ratchet pass. Five overlay-only static
cycles were removed by narrowing imports into existing native owners; both
static and value-cycle checks pass. All three unused-export scans are empty.
The final correction replay passes 120 cases across ten files, and its fresh
isolated Astra review has no actionable findings. The full changed-source
driver was stopped after its type chain passed; separately completed gates
are evidence, not aggregate command success.

The build reports a nonfatal Control UI startup-size warning: 373561 gzip bytes
against the native 373454-byte budget. No budget, guard or line cap was raised.
Octogee's 111 artifact/pin/base-image cases, 57 native island/tool/Browser/
Automations consumers, 34 final-reply Activity cases, and app and edge
typechecks pass after regeneration. Final hosted CI is recorded in the recut PR.

After merge, Build main produces an immutable image family; it never deploys.
Full authenticated Builder activation, Browser/Terminal/Dashboard, return,
reactivation and history continuity remain rollout acceptance work. This recut
does not claim to fix separate Octogee project-agent restore or Builder
acceptance investigations.

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
builder uses pinned Rust 1.99.0. OpenClaw retains its own pnpm 12.5.1,
Codex plugin dependency 0.160.0 and matched CUA package 0.28.2.

Node 26.11.1 is published, but the official Docker Registry returned
`MANIFEST_UNKNOWN` for `library/node:26.11.1-bookworm-slim` during this refresh.
The base retains the existing immutable Node 26.10.0 image, which satisfies
the selected OpenClaw engine requirement. A release announcement without the
official image's immutable multiarchitecture digest is not an image input.

The actual October 7 Linux arm64 `gateway-system` image
`sha256:c4ff7a4157a3d81393fb014e44f0fc4739219db665764f7ea0137dffb7cc1569`
passes network-disabled CLI smoke as the `node` user, including both updated
CLIs and npm. The supported amd64 Builder npm/native and base-system stages
also pass actual image builds and pinned tool checks. Network-disabled smoke
confirms the Builder CLIs; gcloud configuration writes pass under the gateway
chart's node-owned HOME mount contract.
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
