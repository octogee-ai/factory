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
`upstreamRef`, `openclawObject` and `mattermostObject` in `current.json`, and
mirror the names in root `cloudbuild-base.yaml`. Push the exact overlay branch;
use `--force-with-lease` only when rewriting a previously published branch.

Update the Current overlay assessment below in the same Octogee PR. This README
is deliberately a gateway build input, including for artifact-only recuts.
Run focused artifact/base-image tests, evaluate feedback and wait for final-head
CI. After merge, Build main produces images, not a deployment. Environment
selection and rollout follow [Handbook 21](../../../docs/handbook/21-deploy-and-cicd.md).

## Current overlay

**Locked upstream:** main
[`b458b9f1c6bc60389c7f88161262e5d39e23dcce`](https://github.com/openclaw/openclaw/commit/b458b9f1c6bc60389c7f88161262e5d39e23dcce).
The September 26 selection uses the newest completed full-green main run found:
[36218202039](https://github.com/openclaw/openclaw/actions/runs/36218202039),
141 successful jobs, seven skipped, including successful `openclaw/ci-gate`.
Newer full runs were failed or pending; their fast-green push runs were not used.
This is a main snapshot with package version `2026.9.6`, not the GA tag's bytes.

**Exact overlay:** `ceckert/openclaw:codex/octogee-voice-adapter`,
[`8512ad6e924a80af029c3acf012e0713d0b31bc2`](https://github.com/ceckert/openclaw/commit/8512ad6e924a80af029c3acf012e0713d0b31bc2).
This extends the selected `bff2282` overlay with native hosted Talk/channel
consults, acknowledged narration, and Browser/Computer operator input custody.
[Native PR #5](https://github.com/ceckert/openclaw/pull/5) isolates those additions.
Generated hosted UI and resource validators use the same exact source.

### What remains and when it can go

| Behavior / commit | Octogee consumer | Removal condition |
| --- | --- | --- |
| Committed hot reload survives retryable cron-monitor activation (`304e64c`) | Gateway config writes | Native reload preserves committed runtime while monitors retry. |
| Skill Workshop uses published plugin generation (`d3fc118`) | Native skill review | Native reviews borrow the active generation with the same lifetime guarantees. |
| Rotated external VNC credentials read per observation (`7f122a6`) | Desktop proxy | Native reconnect/observe sees rotated credentials without stale password capture. |
| Mattermost channel-scoped threads and display-name titles (`3485bd9`, `098fe54`) | Threaded workspace rooms | Native channel scope preserves room context without mixing reply destinations. |
| Transcript sender labels (`23b5d97`) | Multi-human Control UI sessions | Native participants display the actual transcript sender. |
| Explicit grants, initial sharing-worker entries, channel-member grants and `sessions.channel.sync` (`011c128` through `a755482`) | gateway-edge membership sync | A native sync seam preserves personal grants, removals and tenant isolation. |
| Member-authorized icons and browser-auth retry (`5da10e7`, `4319b26`) | Shared-session Control UI | Native icons use session membership and recover after browser authentication. |
| Live tool requester, reviewer guard and native execution recheck (`3dcea82`, `e0c557f`, `45948ed`) | `octogee-access-tools` computer approval | Native hooks retain live requester/reviewer authority through approval and execution. |
| Durable scheduled-agent migration (`33a9735`), with agent-less jobs held only by in-flight fences (`bff2282`) | Cowboy Shared/Builder handoff; memory-core dreaming on former migration sources | Native cron transfer supports fenced ownership and scoped partial migration, and retired source fences do not hold agent-less jobs. |
| Superseded hot-reload tail handoff (`f0087d3`) | Back-to-back mount/config writes | Native successors inherit unfinished scope without waiting for stale work or losing failures. |
| Model-catalog generation release (`71540de`) | Long-lived gateways | [#158986](https://github.com/openclaw/openclaw/pull/158986) or equivalent is in the selected base. |
| Workspace-only Gateway registry reuse (`9907538`, narrowed by `a8a5ce9`) | Per-customer workspaces | [#159002](https://github.com/openclaw/openclaw/pull/159002) or equivalent is in the selected base; config/environment/metadata checks remain. |
| Deleted-agent model/auth/secrets/memory cleanup and per-isolate reader registry (`fb99ee1`, `0ed4358`, `1a84c2d`, `bcbfa47`, `7fbe0bb`) | Source unmount after migration | [#159013](https://github.com/openclaw/openclaw/pull/159013) or equivalent closes native owners, and every isolate's cached database readers, without disrupting surviving agents. |
| Channel accounts start detached from the calling RPC's plugin-runtime request scope and tool-caller identity (`88748c5`) | Mattermost Coach turns after `config.patch`/`config.apply` hot reload | [#159396](https://github.com/openclaw/openclaw/pull/159396) or equivalent is merged into the selected base: channel monitors restarted by a config RPC keep the Gateway binding but not the closed client's authority. |
| Explicit computer target `gateway` falls through to the sole paired node when the Gateway has no computer provider (`88748c5`) | Coach `computer` tool on the octogee-desktop node | An upstream PR (not yet filed) or equivalent is merged into the selected base: a provider-less Gateway resolves `gateway` to its one paired node. |

| Native channel consult adoption and acknowledged Talk narration (`6676e0f`) | Hosted Builder voice through the existing Mattermost channel and speech broker | Upstream exposes equivalent authenticated ingress, exact-run custody/cancellation, and speech-segment playback acknowledgements. |
| Connection-owned Browser lease and native Computer input fences (`6676e0f`) | Human takeover of shared gateway tools | Upstream provides equivalent lease ownership, input yield, and fresh-observation requirements across host/node/worker execution. |

The deletion fix uses the native memory-manager close API. Its proof establishes
a retained manager/provider lifetime; do not assume the current implementation
necessarily retains the older query-only/WAL reader.

One surviving WAL reader anywhere in the process defers SQLite's release of the
closed writer's descriptors. Every agent-database reader cache (auth-profile
pools, cached read-only scopes) therefore registers a closer with a per-isolate
registry; served task-pool workers, including the shared model-catalog and
session-transcript workers, apply reader requests between tasks, and the live
pool registry fans one request out to every worker. Deletion issues it last and
tombstones the deleted database paths so no isolate reopens them until the
roster admits the agent again (`agents.create` or roster hot reload).

Cron migration consolidates the prior three patches. It validates incoming
snapshot shape/size and replaces matching target-projected system monitors
while refusing unrelated user-job/tenant conflicts. Nonportable jobs remain
dormant on the source for partial handoffs. The former snapshot-validation and
monitor-reprojection follow-ups are covered by the new regressions.

### Removed or narrowed

- Adopted native blank computer selectors (#155072) and host-read-free profile
  identity preparation (#155800); neither patch remains.
- Removed registry reuse across resolved-secret changes and stamp advancement
  after plugin-neutral writes. Real callbacks demonstrated stale credential/model
  state. Native invalidation is restored; reuse only ignores workspace
  differences when the full activation identity matches.
- Consolidated deletion cleanup and cron handoff. Removed duplicate tests and
  stale fixture assumptions while retaining resource, scope and auth coverage.

Against the earlier audited `e4c728b`/`dfb6474` overlay, the diff drops from
194 to 184 files and 8,524 to 7,738 net added lines. Native test/support-path
classification drops from 67 to 61 files and 5,452 to 4,718 net added lines
(734 fewer). This compares source overlays, not deployed environments; the
intervening memory fix is included too.

The three grouped upstream PRs above have maintainer-readable reproductions.
#158986's hosted gate passed. #159002 and #159013 share a failing hosted deferred
SecretRef-reload timeout; local proof does not make their hosted CI green.
#159002 also has an exact installed-updater proof from published 2026.9.6.
Check actual upstream adoption at each recut rather than assuming submission
means the overlay can be dropped.

### Qualification and artifacts

The exact clean `8512ad6` source passes the canonical full `pnpm build`, production
and affected test typechecks, focused control/voice regressions, type-aware lint,
protocol generation, channel metadata, and SDK export/API checks. No aggregate
`pnpm check` success is claimed. The startup JS gzip warning remains visible:
371,784 bytes against a 371,332-byte budget, matching the previously documented
upstream-only contribution build. The budget was not changed.

Both maintained packers ran sequentially against that final build. Native root
archive integrity, isolated npm installation of the exact root/Mattermost pair,
and the hosted voice plugin's real installed-SDK load pass. The installed CLI
reports `OpenClaw 2026.9.6 (8512ad6)`. Packaging used unchanged committed Octogee
build inputs while unrelated app/layout edits were in progress.

The actual Linux arm64 `openclaw-full-plugin-installer` target passes registry
refresh, bundled trust, all 156 Codex source-match files, three native-hook
imports, and the patched CUA doctor. A network-disabled installed-image check
verifies the exact build SHA, Linux arm64 Node 26.10.0, functioning koffi 3.3.0
and esbuild 0.28.2, and the real channel-consult SDK export. Local image ID:
`sha256:f6b844dc7ee3b61acd86a78350bac30ce87764edd9b6fbe86ac5d48dbc6986a1`.
This is installed-image proof, not an environment rollout.

Published with generation-zero preconditions; both complete SHA-256 values were
verified by reading the objects back:

| Write-once object | SHA-256 | GCS generation |
| --- | --- | --- |
| `openclaw-fork-09ad36fe.tgz` | `09ad36fe0e25fef24465c140330a3578be3373c0ecf863b621f07c1e4415e0bd` | `1790614009664709` |
| `openclaw-mattermost-fc42f59c.tgz` | `fc42f59c06799269e0bc6e123eef23d32b1dc5eabbd28064f81186b00c75f640` | `1790614018138418` |

The selected source uses **shared-state schema 20 / agent schema 23**. Preserve
native migration backups and roll forward; older images may refuse migrated
databases. No image-only downgrade or session reset is part of this recut.

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
architecture checks pass on both. The six installer regressions pass. PR #3659
has the refreshed evidence; it remains draft pending its canonical desktop
validation, and the published driver still lacks the standalone mappings.

OpenClaw owns the package-version pin in its root and `cua-computer` manifests;
Octogee owns this matching native backport and adapted skills. CUA 0.29.1 is
available, but current OpenClaw main still selects 0.28.2 and 0.29.1 still lacks
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
