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

The selected artifacts currently contain main
[`b458b9f1c6bc60389c7f88161262e5d39e23dcce`](https://github.com/openclaw/openclaw/commit/b458b9f1c6bc60389c7f88161262e5d39e23dcce)
plus overlay
[`8512ad6e924a80af029c3acf012e0713d0b31bc2`](https://github.com/ceckert/openclaw/commit/8512ad6e924a80af029c3acf012e0713d0b31bc2),
with package version `2026.9.6`. These are main-snapshot bytes, not the GA tag.
They include the native Talk and operator-takeover additions from
[fork PR #5](https://github.com/ceckert/openclaw/pull/5), selected by Octogee #4135.

| Selected write-once object | SHA-256 | GCS generation |
| --- | --- | --- |
| `openclaw-fork-09ad36fe.tgz` | `09ad36fe0e25fef24465c140330a3578be3373c0ecf863b621f07c1e4415e0bd` | `1790614009664709` |
| `openclaw-mattermost-fc42f59c.tgz` | `fc42f59c06799269e0bc6e123eef23d32b1dc5eabbd28064f81186b00c75f640` | `1790614018138418` |

Shared-state schema is 20; agent schema is 23. Preserve native backups and
roll forward, not an image-only downgrade or reset.

### Pending v2026.9.7 recut

The prepared overlay is on `ceckert/openclaw:codex/openclaw-main-sept28`,
[`543a4b4ab8480ff82900982b08c33677409d52a8`](https://github.com/ceckert/openclaw/commit/543a4b4ab8480ff82900982b08c33677409d52a8),
rebased onto full-green main
[`a58d7709797ae6a9816576f86987af68b0b1ef99`](https://github.com/openclaw/openclaw/commit/a58d7709797ae6a9816576f86987af68b0b1ef99).
[Full CI 36410528009](https://github.com/openclaw/openclaw/actions/runs/36410528009)
completed September 28 at 11:04 UTC: 152 successful jobs, seven skips, and a
successful `openclaw/ci-gate`. Skips were `pr-fail-fast`, `check-plan`,
`checks-node-compat-node24`, `ios-release-e2e`, `ios-screenshot-evidence`,
the iOS screenshot matrix placeholder, and `Seal full release child evidence`.

This branch is preparation, not a newly selected runtime. Production types and
238 focused tests across 19 files pass: 156 boundary tests plus 82 cron tests.
Cron's final 11-file run took 72.49 seconds after real SQLite RED controls proved
abort data loss, nonportable-grant handling and target collision/grant defects.
Core types, scoped typed lint, formatting and the native line-cap ratchet pass
for the correction. Native protocol generation caught and repaired the missing
Kotlin `cron.migration` enum entry; protocol, config metadata/baselines, Kysely
declarations and native schema parity checks pass.
The final exact-source build, matched-pair qualification, artifact publication,
and pointer switch remain pending the release tag. Prior trial archives and
builds are not evidence for this prepared head.

When the tag is published, record its tag object and peeled SHA, compare it
with this prepared base, rebase only the still-required overlay, rerun affected
checks and review, then follow the package procedure above. A release branch is
not a stable tag; do not substitute its moving tip or claim release qualification
from main CI. Keep the Octogee PR draft until those steps are complete.

### Patch assessment for the pending recut

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
- Dropped explicit computer `target: gateway` fallback. Octogee already selects
  native `target: node` with `node: octogee-desktop`.
- Removed the 336-line recurring real-Gateway descriptor harness and 32-line
  process helper after running resource proof. Narrow owner, worker, retry and
  recreation regressions remain; reload timing tests use deterministic controls.
- Removed unused reader-close exports. Kept native invalidation for
  resolved-secret and plugin-config changes.

Against the selected current overlay, the prepared diff touches 201 rather than
203 files. Non-test net additions fall from 3,321 to 3,312 lines; test/support
additions rise from 5,449 to 5,481 after fixing and proving the cron data-loss
and approval cases. Total net additions are 8,793 versus 8,770: this is not an
overall line-count reduction. Counts use `git diff --no-renames --numstat` and
native topology test/support classification; necessary resource and authority
coverage stays.

Upstream contributions carry separate local and hosted evidence. The catalog
and registry PRs have green hosted gates. Cleanup's final local proof includes
actual descriptor release, custom-store recreation and failed-close ordering;
hosted checks and maintainer sensitive-path approval remain separate gates.
The channel-authority PR's session-title fixture failure remains unresolved.
Check exact-head adoption and feedback before dropping any patch.

### Base-image inputs prepared with this recut

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
The recipe correction passed actual Linux arm64 image proof with the earlier
trial pair and its 19-test regression suite. Native guards and live state remain
unchanged; the release pair must repeat that image proof before publication.

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
