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

Rebase the prior overlay's patch series onto the locked commit one patch at a
time (`git rebase --onto <new-ref> <old-base> <overlay-head>`), keeping one
single-purpose commit per patch, and type-check every boundary
(`git rebase -x "pnpm tsgo:core" <new-ref>`). Then audit every patch against the
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

**Base:** upstream `openclaw/openclaw` `main` at
[`dfb6474c538f493a70a4d2c399703966899a9ed0`](https://github.com/openclaw/openclaw/commit/dfb6474c538f493a70a4d2c399703966899a9ed0)
(2026-09-25 08:48 -0700, merge of PR #158184). This is a branch snapshot, not a
release; the package version string remains `2026.9.6`. Upstream's push-to-main CI
skips real jobs, so "green" here means the merged PR head's `openclaw/ci-gate`
succeeded for #158184. Caveat: #154208 (`f80fef130a9`, three commits below the base)
was merged over a failed gate (a flaky Codex computer-use timing test), outside the
overlay's areas.

**Overlay branch:** `ceckert/openclaw:codex/octogee-main-dfb6474c538-recut`, head
`e4c728b9178b4a961b54637c709958bff7960080` (`dist/build-info.json` commit matches).
30 commits on the base: 28 single-purpose overlay patches, their test fixup, and one
`build(workboard)` Control UI bundle-hash commit.

**Policy:** the goal is zero patches, pursued deliberately through discussions
with the OpenClaw maintainers — not a stream of ad-hoc upstream PRs. The only
upstream PR in flight is [#155072](https://github.com/openclaw/openclaw/pull/155072).
Keep every patch small, generic, and upstream-quality so it is ready for those
discussions; record each patch's readiness in the table below.

| # | Commit | Patch | Octogee consumer | Upstream readiness |
| --- | --- | --- | --- | --- |
| 1 | `128f29c99c2` | Computer: blank `target`/`node`/`environmentId` = unset | Agent computer tool | Open PR #155072 |
| 2 | `3b549cf7b19` | Gateway: keep a committed hot reload live when system cron monitors will retry | `config.patch` path (pre-boot config) | Ready (narrower than #148592) |
| 3 | `a2767359702` | Skills: Skill Workshop reviews on the published plugin generation | Gateway-internal | Ready |
| 4 | `4dd0f0425f7` | State: prepare profile identity without a host-thread state read | Hot path of #13 | Ready |
| 5 | `d0e6fae74c8` | Desktop: re-read rotated external VNC credentials per observe | gateway-edge `desktop.observe` proxy | Ready |
| 6 | `7bed157e9b9` | Mattermost: `threadSessionScope` channel-scoped thread sessions | pre-boot sets `threadSessionScope=channel` | Ready |
| 7 | `db21b911d33` | Mattermost: title channel sessions by display name | Builder session titles | Ready |
| 8 | `091f8bd10f3` | UI: label channel participants from transcript senders | Control UI | Ready |
| 9 | `2db4a137a53` | Sessions: explicit member grants replace service-authored ones | gateway-edge channel-membership sync | Ready |
| 10 | `e4a94a21411` | Sessions: ensure initial session entries through the sharing worker | Prerequisite of #12 | Ready (with #12) |
| 11 | `31d173ab84a` | Gateway: grant channel-created sessions to synchronized members | Proxy identity `sessions.others` | Ready |
| 12 | `0cbe0c17518` | Gateway: `sessions.channel.sync` membership mirroring | gateway-edge `channel-membership-sync.ts` | Ready |
| 13 | `64f3ece248a` | Gateway: workspace icons for session members | gateway-edge icon proxy | Ready |
| 14 | `65483cb6489` | UI: refetch rejected workspace icons after auth recovery | Control UI | Ready |
| 15 | `737a3295127` | Plugins: live authenticated requester for `before_tool_call` | `octogee-access-tools/computer-approval.ts` | Ready |
| 16 | `05f8e586128` | Plugins: `before_tool_call` reviewer guard | same | Ready (after #15) |
| 17 | `18e4ba01481` | Harness: recheck reviewer authority before native execution | Builder gateways (Codex) | Ready (after #16) |
| 18 | `518b1bcf6df` | Cron: `cron.migration` scheduled-agent handoff with durable fences (includes default-agent ownership resolution) | Shared-gateway customer migration | Needs work: `cron.migration` snapshot shape validation |
| 19 | `063bff41746` | Cron: keep timer reservations within the admitted due set (regression from #18) | — | Fold into #18 |
| 20 | `ac661ac4d70` | Cron: partial handoff retains non-portable jobs dormant on the source | Builder VM return (Octogee PR #4034) | Fold into #18 |
| 21 | `671b773e10e` | Models: stop catalog generations chaining across reloads (heap growth under agent churn) | Every shared/Builder gateway hot reload | Ready; PR not filed |
| 22 | `832ed7a227f` | Gateway: hand a superseded hot reload's runtime refresh to its successor | Builder mount/migration (`agents.create` then `config.patch`) | Ready; PR not filed |
| 23 | `29641fdd60b` | Agents: release pooled auth readers for deleted and unrostered agents | Builder eviction (`agents.delete`, then the agent dir removal held-file check) | Ready; PR not filed |
| 24 | `6c5735314cb` | Plugins: reuse gateway activation across resolved secret rotation | `secrets.reload` on every mount/import | Ready; PR not filed |
| 25 | `075c4406f0c` | Gateway: advance the retained registry's activation stamp on plugin-neutral commits | Every `config.patch`/`agents.create` on shared gateways | Ready; PR not filed |
| 26 | `d2577c228d6` | Agents: borrow the Gateway registry for every workspace of a config-wide generation | Shared gateways with per-customer workspaces | Ready; PR not filed |
| — | `63963eb441c` | build(workboard): Control UI bundle hash for the recut head (covers #14) | Control UI | — |
| 27 | `54fabd0320c` | Secrets: config-write refreshes stop retaining removed agents' auth stores | Builder eviction/unmount (`agents.delete`, then the held-file check) | Ready; upstream main has the same bug, PR not filed |
| 28 | `2091f315e28` | Agents: retire a deleted agent's model runtime before releasing its database (test run under a canonical state dir in `e4c728b9178`) | Builder eviction/unmount after an import's `secrets.reload` | Ready; PR not filed |

Recut adaptations against the new base (all other patches applied cleanly):

- #5 merges with upstream desktop audio (#157723); audio preauth uses the freshly
  resolved VNC password.
- #6: upstream #155812 routes threaded reactions to the thread session. Upstream's
  cases stay alongside the channel-scoped cases; channel config and docs are
  regenerated.
- #8's header merges with #157482.
- #11: `createdVia` moves to upstream's split sqlite entry-cache files; the former
  `isMember` rewrite is dropped because upstream `projection.readMembership` does it.
- #12 uses `defineValidatedGatewayHandler` (#156521).
- #16 runs the reviewer check inside upstream's `OperatorApprovalStoreGuard` binding
  (#150237); a reviewer error resolves as not-found (fails closed). #17's tests
  moved to `native-hook-relay.reviewer-authority.test.ts` for the line cap.
- #18 sits on upstream's run-admission worker (#157634). Its shared state schema
  step is renumbered v19→v20 because upstream took v19 (#157709). The untested
  `lifecycleGeneration` refusal at the reservation commit boundary is dropped;
  upstream's `commitGuard` owns it. The `cron.migration` kernel, RPC handler,
  snapshot format, and types are byte-identical to the previous pin `c1424da`.
- #19 is mostly upstream-covered: upstream's `observeCronJobWrites` helper replaces
  the post-commit spy.
- #22 sits on upstream's revisioned config source (#157372), split into
  `config-reload-supersession.ts` and `config-reload-restart.ts` for the line-cap
  ratchet.

Upstream changes since v2026.9.6 that affect Octogee:

- Shared state schema is now 20 and forward-only: older gateway builds refuse the
  database. Builder VMs with persistent disks cannot be image-downgraded after
  running this build.
- Config writes publish immediately through one revisioned source (#157372);
  reloads are admitted while retained work drains (#157796); a `restart-required`
  verdict follows a bundled code digest change (#156827).
- Cron activation, release, and finish run on the state worker (#157634).
- `sessions.messages.subscribe` requires `key` (#156071).
- `agents.delete` waits for database resources (#157631).
- Mattermost threaded reactions route to thread sessions by default (#155812);
  Octogee's `threadSessionScope=channel` overrides it.
- Role-based model limits (`gateway.roles`, #156346).

Known follow-ups for the next recut: `cron.migration` snapshot validation, and
letting stage replace a target's re-projected system monitors
(`heartbeat:` / `skill-collection-review:` declarations) instead of refusing
them as a target conflict.

The archives below were built from the head above, install-verified together in
an isolated npm prefix (`OpenClaw 2026.9.6 (e4c728b)`), and published with
write-once generation preconditions; the published root archive's SHA-256 was
re-verified after upload. The Mattermost archive is byte-identical to the previous
publication and is reused.

| Write-once object | SHA-256 | GCS generation |
| --- | --- | --- |
| `openclaw-fork-d9c7e1f6.tgz` | `d9c7e1f66fabf78b0a12fbd842e190c632d4d8782aca89e455e9bcb8e5d8ab89` | `1790397689660129` |
| `openclaw-mattermost-4ee09605.tgz` | `4ee0960599474fed423e28b77ad56a0e794f3a4c1fcc5adb73c7864bad04ec09` | `1790361284337036` |

Qualification of this head: `git rebase -x "pnpm tsgo"` passes at all 26 patch
boundaries; `pnpm check`, `pnpm tsgo:prod`, `pnpm check:test-types`, and
`pnpm config:channels:check` pass; the focused suites (62 files, 1163 tests) pass;
`pnpm build` passes with `dist/build-info.json` equal to the head and a clean tree.
#21–#26 are each red on the pristine base (base plus the patch's test file only) and
green on the head: #21 retention (`expected [] to deeply equal [0..4]`), #22 7/8
failing without the handoff → 8/8, #23 `expected true to be false`, #24 registry not
reused, #25 assertion failures, #26 four registries → one. Patches #1–#27 (`54fabd0`)
run on TEST and PROD since 2026-09-26.

#27 is qualified on `54fabd0`: its refresh test is red without the fix and green with
it; `pnpm tsgo:core`, the secrets, secrets-startup, runtime-authority and
gateway-auth-refresh suites (12 files, 247 tests), and `pnpm build` (build-info equal
to the head, clean tree) pass. A Gateway `lsof` reproduction held 7 descriptors on
the deleted agent's `openclaw-agent.sqlite` after `agents.delete` on `63963eb` and 0
on this head.

#28 is qualified on `e4c728b`: its Gateway proof (`agents.create` → `sessions.create` →
`secrets.reload` → `agents.delete`, then no open connection to the agent database) is
red without the fix and green with it, three solo runs and in the batch; `pnpm
tsgo:core`, the agent-mutation, prepared-model-runtime and secrets suites (46 files,
642 tests), and `pnpm build` (build-info equal to the head, clean tree) pass.

### Patch #27: deleted agents' auth stores stayed open

`prepareActiveSecretsRuntimeRefresh` merged the config-derived agent directories into
the snapshot's `explicitAgentDirs`, so every later config write re-read the auth
store of every agent ever configured — including the write inside `agents.delete`
that removes the agent. The reopened pooled reader (30-minute idle timer, reset by
each retry's `config.patch`) kept `openclaw-agent.sqlite` and its WAL/SHM open, and
Octogee's held-file check refused every source unmount after a migration until the
gateway restarted. Refreshes now carry only caller-supplied explicit directories and
recompute agent directories from each written config.

### Patch #28: a deleted agent's model runtime reopened its database

With #27 in place, removing an agent changes the auth-profile snapshot set, which
fires a global auth mutation. That marked every prepared model-runtime owner stale —
including the deleted agent's own owner, still registered until the config reload
retired it — and the auth publication drain rebuilt it against the old roster,
reopening `openclaw-agent.sqlite` through the pooled auth reader after
`agents.delete` had closed it. It only happens once the agent has a published
runtime owner, which an import's `secrets.reload` creates, so agents imported onto a
shared gateway and moved off again still held their databases on `54fabd0`.
`agents.delete` now retires the agent's prepared model-runtime owners (and waits for
an in-flight build) before closing the pooled readers for its databases.

Packaging keeps the exact core source and rebuilds Codex and Parallel from that
same checkout. The full image places Codex at `dist/extensions/codex` with its
declared production dependencies, using upstream's supported source-image route:
native discovery must report `origin: "bundled"` before granting keyed-store APIs.
`infra/gateway/verify-codex-source-match.mjs` checks bundled location and trust,
identity/version, the exact manifest, and all runtime bytes against the source
archive; a shared version string does not prove matching bytes.

### Patches #24–#26: plugin reload freeze

Every `secrets.reload` and every post-commit prepared model-runtime convergence
cold-loaded every plugin through `capturePluginGenerationArtifact`, freezing the
event loop for 35–85 s under gVisor (measured on TEST, 2026-09-25). #24 reuses the
gateway activation when only resolved secrets rotate. #25 advances the retained
registry's activation stamp on plugin-neutral commits, so they no longer force a
recapture. #26 fixes the workspace-dir mismatch behind per-workspace cold loads: the
config-wide startup generation has no `workspaceDir`, while the active registry is
stamped with `agents.defaults.workspace`, so every customer workspace loaded its own
registry. A three-customer test gateway went from four registries (five captures) to
one.

### Patch #23: pooled auth readers outlived deleted agents

Upstream #150524 keeps read-only auth-profile handles on each agent's
`openclaw-agent.sqlite` for 30 minutes of idle time, and the OAuth peer scan reads every
agent directory on disk, rostered or not. `agents.delete` closed the agent's own
database handles but not the pooled reader, so a departed Builder's database stayed
open and Octogee's held-file check refused to remove it. That blocked eviction on
shared gateways, and with it scaler convergence. The patch closes the deleted agent's pooled
readers in `prepareAgentDeleteDatabases` and stops pooling peer-scan readers for
agents outside the roster. The interim Octogee exemption for read-only connections
during final removal (#4025) can be removed once this archive is live everywhere.

### Patch #21: catalog generations chained across reloads

Every hot reload (`agents.create`, `agents.delete`, `config.patch`) left the previous
prepared model-catalog generation reachable: `createFullModelCatalogAccess` captured
`previousInventory` in the closure context that the catalog-auth usage reader keeps
alive, so generations formed an unbounded chain, each pinning a retired ~10 MB
operation plugin cache. This was the shared-gateway heap growth that ended in
`Ineffective mark-compacts near heap limit` under agent churn. Seeding moves to
`prepared-model-runtime.catalog-seed.ts`, keeping the superseded inventory local.

A local gateway reproducer (default config, Codex off; `agents.create`/`agents.delete`
cycles plus `config.patch`; heap read after forced GC over the inspector) grew linearly
without the patch (377 → 670 MB over 6 cycles with 10 idle agents) and stayed flat
with it (262 → 280 MB). Under a 512 MiB heap with 20 idle agents, the unpatched build
died in the first cycle with the production OOM signature; the patched build ran 20
cycles (80 creates, 80 deletes, 20 patches) at 276 → 296 MB.

### Patch #22: superseded hot reloads finished a stale runtime refresh

A Builder mount writes twice: `agents.create` rosters the Coach, then `config.patch`
adds its accounts and bindings. The first write's hot reload committed within 3 s,
then spent ~47 s in its post-commit prepared-model-runtime refresh for a config the
patch had already replaced; only afterwards did the transaction notice supersession,
so the patch's own reload (another ~40 s) waited behind it. TEST pod
`octogee-gateway-shared-09a360c91291`, import `pr3568bfb7983eo`, 2026-09-24:
`17:55:50` reload #1 committed, `17:56:37` applied then superseded, `17:57:18`
reload #2 applied, `config.patch` answered after 90 s.

The reload transaction now exposes a `supersededSignal` that fires on a newer
in-process write or stop (watcher-only edits still validate at checkpoints). The
hot-reload tail stops awaiting its model-runtime and context-window refreshes once
superseded; the refresh keeps running detached, readers keep waiting on its
replacement gate, and the successor's refresh supersedes it with a scope widened by
the unfinished agent scope. A detached refresh that fails before any successor takes
its scope still schedules hot-reload recovery. A reproducer with two writes and a slow
first refresh hangs without the patch and hands off in ~10 ms with it. The saving on
a real mount (~45 s expected) is not yet measured on a gateway.

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

The current base (`dfb6474`) requires 0.28.2. The same 40-line patch applies
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
