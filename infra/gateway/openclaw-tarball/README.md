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
[`7c2aa571ea03f08d8cee9bf1b5fe34b6547e9372`](https://github.com/openclaw/openclaw/commit/7c2aa571ea03f08d8cee9bf1b5fe34b6547e9372),
frozen for the October 11 recut. The operator approved independent local
qualification rather than waiting for full upstream CI to recover. OpenClaw
validation stays local; no full-upstream, fork-CI or iOS-green claim is made.
Exact overlay source is `c0be6a3b65361941447d0edcbf7479cba302dd7f` on
`ceckert/openclaw:codex/doctor-deleted-artifact-discovery`.
Package version `2026.9.9` identifies a main snapshot, not a released tag.

Shared-state schema 21, agent schema 25 and protocol 4 follow the selected
native contracts. Native schema admission and backups remain authoritative;
packaging neither repairs nor resets live stores. The compiled gateway objects
and committed native UI provenance must use this same clean, built source.
Deployment requires the successful immutable Build main family, TEST first
and actual fleet/service validation before the same build reaches PROD.

### Patch assessment

The overlay is ported onto the current native startup phases, prepared-model
runtime, channel lifetime, approval completion, session-member reader and Talk
relay owners. Native owners replace obsolete interfaces and duplicated
authority shims; adopted upstream fixes and retired Workshop code stay removed.
The main snapshot's worker-computer takeover transport remains unchanged.

| Retained contract | Consumer / condition for removal |
| --- | --- |
| Startup/reload settlement, typed supersession retry and queued SQLite authority | Builder admission; retain FIFO, live revocation and single-open behavior until native owners provide equivalent contracts. |
| Committed reload debt across superseding catalog/config work | Customer mounts/config writes; preserve successor-owned service work without repeating completed replacement. |
| Tenant-bound requester/reviewer and execution-time authority | Computer/connector approvals; native roles alone do not bind an action to a live VM/run. |
| Explicit and channel-derived sharing with exact native channel dispatch | Membership synchronization; channel sync cannot revoke explicit owner grants, and empty native membership is authoritative. |
| Durable per-agent cron handoff | Shared/Builder migration; preserve exact identity, partial transfer, scratch, abort and host-bound grants. |
| Session-bound Talk consults and live voice grants | Authenticated session identity and cancellation through native run/relay owners. |
| Final-reply observation and late observer lookup | Terminal provider settlement, not progress or run-completion authority. |
| Per-owner Browser observations and VNC credential refresh | Visible desktop; another agent cannot unlock stale input. |
| Channel-scoped Mattermost context, transcript labels and authorized hosted UI | Threaded multi-human rooms and member-authorized native panels. |
| Predecessor catalog closure lifetime and request-free account startup | Distinct gaps tracked by #158986 and #159396; catalog publication alone does not remove them. |
| Named-account removal custody and canonical identity | #167431 plus coordinated repairs; stop only the removed account, join pending startup, retain cleanup ownership on timeout, and fail closed on ambiguous dotted paths. |
| Queued node-token/metadata authority | Pairing/presence publication; replacement and revocation must invalidate authority before dispatch. |
| Deleted-agent maintenance discovery | Doctor must hold every journaled deleted identity, including restored files and unfinished deletion, while preserving runtime admission and cleanup selection. |

Public channel dispatch from
[#163685](https://github.com/openclaw/openclaw/pull/163685)
retains the original plugin instance through provider finalization, then
releases custody. Scoped bindings preserve class/private callback receivers;
noncallable data such as AbortSignal keeps its original identity. No plugin-ID
replacement lookup or global fallback is added. Open PRs are local adoptions,
not upstream merge claims; their current-main qualification is separate from
this frozen recut.

Octogee keeps the landed React model picker/tool icons (#4366) and read-only,
tenant-filtered React Automations (#4368). The unused native picker and
Automations islands are removed. Browser, Computer, workbench layout, themes
and tool display retain their native adapters and consumer contracts. Remaining
Lit islands still share one module graph; hosting is not redesigned. Solid
pages are not revived as retired Lit controllers.

### Local qualification and limits

Behavioral evidence, exact commands and final artifacts belong in the recut PR.
Required boundary assertions and budgets remain intact. In particular, the
HTTP cancellation fixture awaits actual agent-command entry after attaching its
abort listener, observes real HTTP/SSE and cleanup custody, releases held work
in `finally`, and joins root settlement. The MCP fixture observes actual
process cleanup rather than forcing an old process-exit assumption. The update
campaign fixture awaits the native handoff and joins unfinished requests.

The Hobby admission follow-up fixes the reproduced TEST failure where a healthy
SQLite session store was rejected after its worker waited five seconds for the
parent commit decision. The worker and parent now share a finite ten-second
monotonic deadline; expired, cancelled and stale authority still rolls back,
and an accepted commit keeps write custody until native settlement. Existing
absolute deadlines remain binding. This changes admission coordination, not
SQLite durability or snapshot policy. The four-file overlay passes 16 focused
and neighboring tests on its original overlay. Its mechanical port retains the
current database-admission and caller-cancellation owners. A real six-second
parent delay fails on the preceding frozen candidate and passes after the port;
all 14 owning commit/lifetime cases pass and the isolated source review is clean
through P2. Original-overlay build and image results are not qualification for
this combined candidate. Native/Hobby live acceptance remains separately owned
by the final acceptance effort.

The SQLite dialect guard intentionally reports design dependencies **19 → 20**.
Chris approved retaining this scoped dependency without weakening the guard or
changing storage schema. Its owner is
`src/cron/store/migration.kernel.ts: retiredMigrations`, called by
`executeCronMigrationInWorker` within one synchronous state-write transaction.
SQLite insertion order restores the most recent prior retirement fence after
resume/abort; opaque operation IDs are not chronological keys. A future backend
must represent creation order explicitly and preserve chronological custody
replay, retained host-bound jobs/scratch/grants, retired fences across repeated
resume/abort, and rejection of stale unfencing. Removing ordering or sorting by
operation ID is not equivalent.

The final unused-export scans report 37 production and 21 full-tree findings
across 20 files, all byte-identical to the frozen upstream base; the script scan
has zero findings. No native guard, baseline or lint rule is relaxed to conceal
these inherited findings. There is no aggregate `pnpm check` success claim.

Native Control UI build-size warnings remain advisory and their budgets are
unchanged. Local synthetic UI captures/tests are not authenticated TEST proof.
Full Doctor is not claimed to be a semantic no-op: healthy boots skip it while
bounded native recovery remains for failed boots and older/manual Builders.
The exact installed build accepts isolated Shared and VM-Builder configs from
the maintained policy, roster, account, pre-boot and per-agent catalog writers
before Doctor, with no schema warnings. Account deletion fragments are applied
through native merge-patch semantics, not persisted as null configuration.
The offline Doctor comparison still canonicalizes a retired model reference,
repairs the unmatched Shared default's unavailable provider, and records
metadata, skills and optional account/plugin choices; no default schema-key
translation is required to make either materialized config valid. This is
synthetic config/schema evidence, not provider or desktop acceptance.
Prior startup samples did not show faster startup and are not fresh evidence
for this source. Installed-image qualification and live rollout acceptance must
use the new exact artifacts, not October 8 proof images or an empty gateway.

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
Codex plugin dependency 0.160.0 and matched CUA package 0.32.0.

The base retains the existing immutable Node 26.10.0 image, which satisfies
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

CUA uses the matched 0.32.0 JavaScript/native package and the narrow Linux
desktop-discovery source patch below. The published modifier fix is adopted;
the old modifier-only fork is no longer an input.
No desktop OS image change is included. Environment rollout is separately gated
by the exact immutable Build main family and TEST/PROD validation.

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

## Native CUA desktop-discovery preservation

`Dockerfile.base` builds the Linux SDK from the official
[CUA 0.32.0 tag](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.32.0),
exact source `58aba84b5b83d77e7e2b0f006547699eb594e50d`, with
`cua-desktop-discovery.patch`. The published modifier fix is already present,
so the older modifier-only fork is not used. Rust and the other CLI/tool pins
remain unchanged.

The sparse checkout also includes `libs/cua/Cargo.toml` and
`libs/cua/crates/cua-telemetry`, the 0.32.0 driver's existing path dependency.
The source revision, Cargo lockfile, dependency features and test gates remain
unchanged; the recipe does not fetch the rest of the CUA workspace.

The 0.32.0 `GetAccessibilityTreeTool` still discovers only X11 windows. The
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

The installer requires matching 0.32.0 installed JavaScript bindings, native
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
0.32.0 skill pack
([`58aba84b`](https://github.com/trycua/cua/tree/58aba84b5b83d77e7e2b0f006547699eb594e50d/libs/cua-driver/rust/Skills/cua-driver))
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
