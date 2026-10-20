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

## PostgreSQL agent handoff

The current source is `05c8dcdebb93fcd1edc4b65f32c2618631cef72b`, the existing
`ac2ff7bf` overlay plus the non-destructive `agents.detach` owner. Upstream
[PR #178755](https://github.com/openclaw/openclaw/pull/178755) contributes this
capability independently. Remove this overlay addition once the selected upstream
base supplies equivalent durable detach and its regression tests pass. Existing
`agents.delete` semantics cannot implement a state-preserving Gateway move.

The exact native build, sequential maintained packers, SDK contracts, package
integrity and actual Linux full-plugin installer passed. Installed Parallel and
Codex sources and all three native hooks matched; offline UID 1000 smoke passed.
The root archive is 120341910 bytes, SHA256
`1ed67d45f7f9f6e32c9b5cf54a4cc31e4cc02f983776fe8fdf1e13bd9392d6dc`.
Its object is `openclaw-fork-1ed67d45.tgz`. Mattermost is byte-identical to the
existing `openclaw-mattermost-74cca5fd.tgz`, SHA256
`74cca5fdd7c77472e6794b83cb3816aa0f019175503d2de0bf19e93bcdb59654`.
Exact-generation downloads of root `1792529380141155` and Mattermost
`1792520298183836` match those complete hashes.
Hosted islands were regenerated from the same clean source; the only changed
native inputs are the detach schema and its three protocol registry exports.
The inherited startup-JavaScript warning remains 317.8 KiB against 317.5 KiB.

A synthetic PostgreSQL 16 proof on this installed runtime used Octogee's scoped
non-superuser credentials for Shared → Builder → Shared. Namespace ownership
transfer passed native catalog admission; store UUID, session ID, transcripts,
auth and indexed memory survived. Detached sources refused writes before and
after restart, and a neighboring Shared agent stayed usable. No live model
inference, environment deployment or active-active ownership was exercised.

## October 20 refresh on frozen main 04789278

The operator selected upstream main
`04789278f8b0cd4cac95386ef91a37ece34082c5` for independent qualification.
The clean native source is `ac2ff7bfc8b271149b67bc6dadae5c13816fa907`
(2026.10.5), published from `codex/openclaw-refresh-04789278` after qualification.
The selected upstream [CI run](https://github.com/openclaw/openclaw/actions/runs/39468753038)
was cancelled without jobs. None of the latest 50 successful main CI runs
included a successful build-artifacts job; a green security-fast run is not full CI.
The inspected successful scheduled [full run](https://github.com/openclaw/openclaw/actions/runs/37419202402)
qualified `d8612ec864bb4c872616cfda5340c53803655f5f`, not this snapshot.
Its skipped jobs include Node 24 compatibility, Android/iOS screenshot evidence,
iOS release e2e, the alternate shared-SDK job and release-child evidence sealing.
No newer upstream tip or older green source was substituted.

The remaining-gap table below continues to describe the retained overlay.
The selected upstream does not change the strict-stop preparation fix,
independent explicit/channel-derived grants, requester authorization,
keyed plugin-capture cleanup or queued reload recovery owners. Related upstream
PRs #177823, #177968 and #167431 remain open. No equivalent retained fix was
identified for removal. Native guest-mention scope changes, HTTP/avatar listener
owners and Terminal's removal of private test-injection properties are adopted;
Octogee does not use those removed properties. The sole overlay integration
conflict was the upstream reorganization of requester-authority tests; its real
boundary regression remains. An unchanged delivery receipt helper moved to the
existing delivery-result owner to satisfy the current line cap.
Native state schema 29, agent schema 31 and protocol 4 remain authoritative.

The pinned pnpm 12.12.1 frozen install, production core/UI/extension types,
focused lint/format, channel metadata, line-cap gate, full native build,
Voice/Activity contracts, sequential packers and package integrity passed.
All 243 focused native tests across 13 files passed, covering strict stop,
reload recovery, grant separation, requester/Codex authority, delivery,
mentions and native capture custody. The refreshed UI consumers passed
184 tests. Aggregate `pnpm check` is not claimed: its max-lines-suppression
preflight rejects three UI files already byte-identical in the selected
upstream, including their unchanged baseline. No suppression or budget was
relaxed. The build warns that startup JS is 317.8 KiB against 317.5 KiB.

The root archive is **120334525 bytes**, SHA256
`7353d64e0bff6a2080e5f82fbb91aa431723442296b7311979c98af2e01aa3e7`.
Mattermost is **1251635 bytes**, SHA256
`74cca5fdd7c77472e6794b83cb3816aa0f019175503d2de0bf19e93bcdb59654`.
Both were packed sequentially from the same clean built source. Their write-once
objects are `gs://octogee-openclaw-fork/openclaw-fork-7353d64e.tgz#1792520295253214`
and `gs://octogee-openclaw-fork/openclaw-mattermost-74cca5fd.tgz#1792520298183836`.
Exact-generation downloads match both complete hashes, sizes and original bytes.
The fork branch reads back at the exact native commit.

The actual Linux AMD64 full-plugin installer passed native registry/bundled
trust, Parallel's nine-file source match, Codex's 186-file match, three native
hook imports and CUA artifact checks. Offline read-only UID1000 qualification
also passed the exact installed pair and public Memory/Skills worker launchers.
Local AMD64 ran under ARM64-host emulation. Hosted island license/runtime/pin
contracts passed all 31 cases; app and gateway-edge production types passed.
The two focused base-image suites passed 19 cases. An inadvertently broad
scripts-suite invocation was interrupted after failures outside those selected
suites; no full scripts-suite success is claimed.

Shared materialization, installed schema validation and the strict writable
Doctor comparison passed. The initial Builder fixture failed because it still
supplied retired pod owner hints and omitted the current root claim. The fixture
now uses the canonical `writeBuilderClaim` owner without weakening its policy
assertions; current main's 14 computer/browser claim-policy cases pass. All 629
captured production inputs still match current main. Final class comparisons
and complete Gateway image results are recorded separately in the refresh PR.
Local file-handle exhaustion and Docker's subsequently unavailable guest engine
are host/tooling failures, not successful image evidence; remaining image work
uses the build-only Cloud Build identity and maintained Dockerfiles.
No TEST/PROD deployment, fleet mutation, desktop image construction or live
acceptance is part of this refresh. A main release family still follows merge.

## Previous October 20 strict-stop correction

That correction's clean native source is
`9d3a53f772b904d1436f3a962cd268336c492c14` (2026.10.5), on the same selected
upstream `2d03d5632a69d04181844f85b05d5509240dcc14`. It adds the confirmed
strict-stop correction to the previous October 20 overlay; it does not select
newer upstream source or change schemas, toolchains, CUA, desktop OS or fleet state.

A strict caller joining an existing non-strict account stop must still reject
while retained startup preparation owns work. The prior source incorrectly
returned success for this case. The manager now includes that existing
preparation slot in its join decision, preserving route-handoff retirement and
running-task ownership. The existing task regression also covers preparation;
its table lives with the existing recovery-test support to respect the file-size
ratchet. An equivalent nested account-enumeration condition was simplified, and
one obsolete test-only argument was removed. No runtime owner or public API was added.

The independent exact-previous-source control failed the intended preparation
assertion, and the corrected owner cases passed. Six focused lifecycle cases and
all 13 existing restart cases passed. Both affected Gateway type graphs, targeted
lint/formatting, the pinned-base line ratchet, full exact-head native build,
Voice/Activity SDK checks, sequential packers and package-integrity checker passed.
Fresh Astra source review found no actionable P0–P2 issue in its supplied scope;
it did not execute the code. The inherited startup-JavaScript warning remains
318.5 KiB against 317.5 KiB, without a raised budget.

The new packed root is **120295686 bytes**, SHA256
`8c08bc5559c3a55ab4213dd766e41573784610a25c3e16209617f9ca15b4ffd6`.
Mattermost is byte-identical to the previous pair: **1251616 bytes**, SHA256
`74ec55a2bd9e080775442940c42347e61797271e478aa100ae64085ee6ddf062`.
Its existing write-once generation `1792503776188007` is reused, not republished.
The new root was published write-once as
`gs://octogee-openclaw-fork/openclaw-fork-8c08bc55.tgz#1792509079123088`;
the exact-generation download matches its full hash, size and original bytes.
The retained Mattermost object is
`gs://octogee-openclaw-fork/openclaw-mattermost-74ec55a2.tgz#1792503776188007`.
Fork branch `ceckert/openclaw:codex/openclaw-strict-stop-oct20` reads back at
the exact native commit above. Publication does not merge or deploy anything.

The actual Linux AMD64 full-plugin installer passed against this exact pair:
native registry/bundled trust, Parallel's nine source-matched files, Codex's
186 runtime files, three native-hook imports and CUA artifact validation.
Offline read-only UID1000 verification confirmed the installed full native commit
and all 874 Mattermost archive files. AMD64 ran under ARM64-host emulation.
The unchanged system/CUA build inputs were cached; no full local Gateway image
or new ARM64 installer pass is claimed for this correction.

Hosted native UI and Browser resources regenerate from the exact new source.
The generator reports no changed native UI inputs since the previous source;
generated chunk names/references are not claimed byte-identical.
Three narrow consuming-island files passed all seven loading/contract cases.
Before the CI dependency repair, full-hash comparison matched all 623 captured
materializer inputs. The repair changes only the scripts manifest and lockfile's
development-only Hono floor/version; the other 621 inputs, all 557 runtime inputs,
29 native config inputs and three proof helpers still match. Hono and its MCP
parent are absent from the 237 captured materializer dependency inputs. The prior
four architecture/class config and isolated Doctor results are reused within
that boundary; this is not a fresh config matrix, ARM64 or live pass.

Immutable Octogee build `6c4f575b866c3cd66bb0768e8be032cab53299b7` retains
the previous native source and is not cleared for TEST by this correction.
Accepted build 517 is unchanged. No merge, deployment, live Gateway test or
fleet mutation is included. Historical failures remain failed evidence; the
resulting new immutable main family needs its own actual TEST acceptance.

## Previous October 20 overlay

The operator selected refreshed upstream main
`2d03d5632a69d04181844f85b05d5509240dcc14` for independent local
qualification, not as a full upstream CI clearance. The clean overlaid source is
`10f31e19e8a7b5d882c7078c1701bc8a7d3daa9b` (2026.10.5).
Upstream #163685 now owns queued channel delivery, so its duplicate delivery
owner is removed. The terminal-reply observer and the other justified Octogee
boundaries below remain. Fixes from still-open #177823 and #177968
retain superseded config-write recovery and cross-filesystem native capture.

Shared schema **29**, agent schema **31**, and protocol **4** are native.
The credential cutover and backup custody stay upstream-owned. Historical cron
fixtures now model the actual schema-28 predecessor rather than changing current
schema or weakening credential-pair admission.

Sequentially packed root archive: **120293931 bytes**, SHA256
`de55b39e3591b273ad19c816f20d3e1e0c3e7b985ba3cde55d0b5f2cea635ac8`.
Mattermost: **1251616 bytes**, SHA256
`74ec55a2bd9e080775442940c42347e61797271e478aa100ae64085ee6ddf062`.
The write-once objects are
`gs://octogee-openclaw-fork/openclaw-fork-de55b39e.tgz#1792503788356454` and
`gs://octogee-openclaw-fork/openclaw-mattermost-74ec55a2.tgz#1792503776188007`.
Exact-generation readbacks match both complete hashes, sizes and original bytes.
Fork branch `ceckert/openclaw:codex/openclaw-main-oct20` reads back at the exact
native commit above. Build main follows the normal Octogee merge path; publication
does not deploy. No deployment, desktop OS build or fleet change is included.

Production core/UI/extension types, native build, exact-source Voice/Activity
contracts and package integrity passed. The native build still reports startup
JavaScript at 318.5 KiB against its 317.5 KiB budget; no limit was raised.
An initial Matrix custody test failed during isolated state maintenance; its
upstream-only single-test control passed, which does not establish attribution
or erase the initial failure. The full affected six-file host rerun passed
63 tests, including all 18 delivery-custody cases. Affected Octogee UI consumers
passed 184 tests; artifact/base contracts passed 54 tests. App and gateway-edge
types passed. ARM64 and AMD64 installed companions/native hooks, ordinary
Memory/Skills workers, and all four architecture-by-gateway-class materialized
config plus isolated Doctor comparisons passed offline. AMD64 ran under ARM64
host emulation. All 623 captured config/runtime inputs remain byte-identical.
The local AMD64 Gateway image passed its runtime-image gate and disconnected
unprivileged installed-package/worker smoke. These checks do not establish live
provider, full Gateway boot or desktop acceptance.

Independent Astra review through the official app-bundled Codex client completed
all five frozen-source passes with zero actionable P0–P2 findings. The reviewer
assessed supplied patch chunks; unchanged implementations and runtime behavior
were not independently verified in its empty sandbox. This is scoped review,
not full upstream CI or live acceptance.

## Previous published overlay (October 19)

The October 19 recut selects upstream
`954a610f5d0fd1e5c542e7a7ed4206ad1484bb02` (2026.10.5). Its native dependency
requires CUA 0.34.1, so this local recipe pins official source
`0c69d9a2c8abbb5051a2df4a23f0fa166d5385dc` and matching driver and skills
provenance. The existing Linux discovery patch applies unchanged; native
0.34.1 still lacks that discovery behavior. The official skill changes only
its version; the Linux guide remains byte-identical.

The root npm install explicitly approves only registry packages `@google/genai`,
`esbuild` and `protobufjs`, plus the exact `file:/tmp/openclaw-fork.tgz` source,
matching the selected source's `allowBuilds` decisions. Strict approval rejects
unknown install hooks, and the image requires
the package lifecycle marker to be cleared before its first CLI check.

The exact native overlay is `7e1288187a50c0b2ae1c91a79fc22383c03988d0`,
fork branch `codex/openclaw-954a-oct19`. It merges the selected upstream with
the reviewed worker-cleanup overlay `97623938234d3c9b0050385c13dcb80233b2c75b`.
Octogee dependency updates already on main remain intact. Recovery's separate
SGID first-boot correction is not included or implicitly approved by this pin.

TEST reproduced keyed agent-database cleanup disposing unrelated plugin captures,
which broke later configuration and secret reloads. The preparation owner now
preserves those captures during keyed cleanup while retaining terminal disposal.
Upstream #177130 now owns packaged Memory and Skills workers under `dist/agents`.
The duplicate relocation and its guard were removed; canonical source locations,
the native runtime manifest and the portable-worker exclusion remain intact.
Actual installed public-SDK launchers were exercised on both architectures.
The keyed-cleanup and queued-config reload corrections remain.

Package `2026.10.5` is a main snapshot, not a
released tag. The operator selected independent local qualification; this is not
a claim that the selected snapshot passed the full upstream CI matrix. No
external OpenClaw/fork/iOS validation is dispatched.

`current.json` selects `openclaw-fork-29cc68fe.tgz` and
`openclaw-mattermost-07c9e2a1.tgz`, packed sequentially from this exact clean
build. Publication is write-once; complete hashes, not object-name prefixes,
identify the qualified pair.

Root: **114387257 bytes**, SHA256
`29cc68fe931d47a7e9f667e18717655ad8cfd012dc9a1c6b064820262ce753e1`.
Mattermost: **1252347 bytes**, SHA256
`07c9e2a119adb73e6ef8f47321f5dc798a14556f8497146508c15ccb4f56d410`.

Both objects were published write-once. Exact root generation
`1792438273576865` and Mattermost generation `1792438276629742` were read back
and verified against complete hashes and byte-identical local archives.
The public native branch reads back at the exact
commit; no hosted native workflow was dispatched or started by its push.

Shared-state schema **28**, agent schema **31** and protocol **4** are the
selected upstream contracts. Canonical DDL, versions, migration ownership and
database admission remain native. Do not preserve the old October 12 no-22
restriction or create an Octogee schema dialect.

### What was removed

This cut adopts upstream's packaged worker source/output split, host-owned native
capture custody, requester-origin admission, native queue/drain and Mattermost
reply owners. Tenant/requester execution authority and keyed database cleanup
remain scoped at those owners. Completed deleteFiles tombstones are not retained
store custody; canonical admission refusal and original deletion fences remain.
Native SQLite/cron APIs replace obsolete adapter test APIs without another
database owner. Doctor now persists the native collaborative-steering default
as false; it preserves explicit settings, and runtime already requires true to
enable cross-requester steering. This is not a grant of collaborative authority.

Earlier reductions adopted the native session-controller mutation owner, exact-store
session projections, `reloadSignal`, and `pluginDrainRetry`. It drops the old
completed-plugin deduplication branch, obsolete restart-target test API, unused
run-handle predicate and duplicate Talk test glue. Requester/reviewer guards,
channel sharing, cron custody and reload settlement remain covered at their
current owners. The channel config budget includes only the retained
`threadSessionScope` setting at channel and account scope. No retained production
boundary is declared upstream-covered merely because a file moved.

The prior cut dropped the startup model-publication handoff carry because its
base already included upstream #173366. Native owner-supersession coverage replaces the
obsolete hanging startup fixture. Native Solid participant/header presence,
HTTP-disconnect cleanup, maintenance and committed-token/revocation owners replace
duplicate fork adaptations and fixtures. The unused authority-owner extraction
and broad reload deferral are removed; genuine reload failures retain their
normal recovery path. Earlier reductions remain:

Upstream catalog retention/retirement (#158986), startup model publication retry
(#172632) and WAL ownership (#172414) own those contracts. Their duplicate fork
owners, prepared catalog seed, absolute commit-deadline customization and
redundant requester/receipt checks stay removed.

Native Talk now owns consultation, interruption and cancellation. The fork's
channel-consult ingress, `talk_voice` verbatim playback-wait narration and
speech-only cancellation behavior are removed. Octogee's API archives received
finalized speech after a native call, without another model call or live
Mattermost ingress. Native playback lifecycle acknowledgments remain.

Mattermost selects opt-in channel-wide memory through `threadSessionScope: "channel"`
and native steering configuration. The channel plugin uses native session-routing
contracts; it does not own a second history store or steering implementation.
Talk and Activity retain a selected existing root across replies and tool views;
the root controls delivery and archival, not session memory. They never infer the
latest thread. Browser and Terminal open directly on the authorized workspace
channel's native session without selecting or creating a reply thread. Channel
membership, workspace entitlement, native roles and resource ownership remain
required; Computer and theme controls need no conversation-history or audience grant.

Room live Activity is explicitly channel-wide, matching the shared native
session. Selecting a reply root does not filter that feed; native events lack
immutable per-turn root attribution. Chat replies and recorded run details retain
their original roots. Direct-message session behavior is unchanged.

Channel membership synchronization treats a base channel session's delivery root
as reply metadata, not a different memory or audience. Ordinary inbound replies
can change that root without blocking an idempotent grant or derived-member
revocation. Explicit thread-session requests still require matching root
provenance; canonical agent, channel, provider, kind and current authority checks
remain unchanged.

The fork's Browser take-control/give-back, manual pause and stale-input protocol
are removed. Native browser controls and upstream worker-computer behavior stay
native. Obsolete run-completion claims, hook-isolation machinery and fork
database-admission/startup owners are also removed where upstream supplies the
contract. No new manager replaces them.

This cut adopts the current native sharing preparation, canonical migration
owners and config-reload helper layout instead of retaining duplicate helpers.
The membership integration carries one worker-prepared roster through mention
and selected-session reads. Membership changes invalidate the existing read
scope, including capacity eviction and the consumer handoff; ordinary activity
still reuses selected facts. Reproduced authorization failures have regression
coverage without a second membership cache or database owner.

This pass also adopts native create-if-absent session entries and the new
storage-engine interfaces, removes obsolete admission-capture scaffolding and
redundant cron schema probes, and keeps cron reads inside the native worker
transaction. The approved offline legacy import is not a new runtime schema.

### Remaining gaps and removal conditions

These are distinct bug fixes, integration boundaries and approved features, not
a blanket claim that native OpenClaw is missing voice, browser or thread support.

| Retained boundary | Concrete gap without it; condition for removal |
| --- | --- |
| Non-destructive agent handoff | Native `agents.delete` purges sessions even with `deleteFiles: false`. Retain durable `agents.detach` until the selected upstream supplies its store-preserving drain/recovery contract; contribution: [#178755](https://github.com/openclaw/openclaw/pull/178755). |
| Channel-wide Mattermost memory | Native default thread sessions do not share agent memory across a room's threads. The operator-selected channel scope keeps one existing native session per channel while independently authorizing reply/archive roots. Keep it until native channel configuration covers this product behavior; do not merge or delete older thread histories. |
| Requester, reviewer and execution-time authority | A native approval role alone does not bind another member's action to the current tenant/requester/run. The exact upstream control accepted an unauthorized other-UID review; the retained boundary rejects it. Remove when native public contracts carry and enforce the same current authority across tool and Codex execution. |
| Explicit versus channel-derived session sharing | A channel membership refresh must not erase an explicit owner grant, and an empty authoritative membership must revoke derived access. Retain the narrow integration until native sharing exposes equivalent independent grant sources. |
| Durable cron handoff | A job list alone cannot represent held/exported/staged/retired custody, permanent retired fences, failed returns, scratch tombstones or host-bound jobs across a gateway move. New custody lives in native retained plugin KV. Remove when native lifecycle APIs cover that complete handoff contract. |
| Offline legacy cron import | Existing published fork databases contain two ordered journal/fence tables. Opaque operation IDs cannot identify the latest retirement. The approved reader fingerprints lossless SQLite identities at four named raw-SQL sites, imports relative order and snapshots into native KV, and creates no new schema. Retire it only when no retained source or supported restore can require that import. |
| Maintenance and reload lifetimes | Queued or superseded work must not borrow expired authority or lose committed reload debt. An identical `config.apply` retry blocked the channel reload it awaited during a real Builder import. Reloader-local claimed waiters are excluded only from that reload’s drain; unrelated work and global admission remain counted. Retain these reproduced lifetime/settlement repairs while preserving native FIFO, cancellation and database owners. Drop each hunk when the selected upstream passes its boundary control, including a late identical retry after startup drains. |
| Memory reindex shadow custody | A creation descriptor can outlive the joined shadow workers and prevent source cleanup after unlink. Retain retirement through the existing descriptor owner; remove when native shadow creation/retirement passes the actual file-descriptor regression. Canonical database and held-file guards remain unchanged. |
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
canonical migration through 28. Partial or ambiguous custody refuses conversion.
Known legacy cron custody tables select the full native repair/import owner rather
than the bounded fast path. Agent26→27 uses the unchanged upstream FIFO
outbox migration; native agent migrations through 31 remain unchanged. No
version bump is invented to force Doctor.

### Local qualification and limits

The exact clean native commit passed the pinned full build, targeted behavior
and production core/UI/extension types, changed-scope lint and formatting,
generated protocol/config/catalog checks and storage/line-growth ratchets. New
line-cap growth was resolved through the existing expiry and reload owners and
type-only UI deduplication, without disabling limits or removing coverage. This
is not aggregate `pnpm check` or full upstream CI success. Strict Voice/Activity SDK
gates, sequential packers and the native package-tarball checker passed. The
independent configured source review completed at P0/P1 scope with no actionable
findings. Approval/expiry, session/storage, requester authority, worker/package
and native UI controls passed. The source review used the operator-approved
independent reviewer because the CLI model route was unavailable; it is not an
automated CLI or hosted upstream clearance. Reviews are source assessments,
not live acceptance.

Both actual Linux arm64 and amd64 full-plugin installer targets passed native
registry refresh, Codex/Parallel source matching, bundled trust, driver-artifact
and native-hook imports. Real Octogee external plugins and bundled identity
were built by maintained owners and imported against the installed native SDK.

Shared and Builder configs were materialized through real template, roster,
account, pre-boot, class-policy and broker-catalog writers. All four architecture/
class combinations passed installed config validation, actual writable
post-plugin update Doctor, second validation and strict before/after comparison.
The image was read-only, UID1000 used fresh tmpfs, and networking was disconnected.
Policy, plugin choices and complete per-agent model catalogs stayed exact.
Doctor persisted the native absent-to-false collaborative-steering default;
negative controls reject an added true or any change to an authored setting.
Other changes were individually checked native version, migration and timed
Doctor bookkeeping fields. The initial comparison failure remains recorded.

Already-merged Octogee writer corrections remain intact: the retired Flash Lite
preview alias stays removed, owner group allowlists are emitted, fresh Builders
include Codex and missing configured voice enablement is defaulted. Explicit
Builder plugin opt-outs remain intact. These are writer corrections, not ignored
Doctor translations.

Hosted islands and Browser resource projections regenerate from the same native
commit. With current main dependencies, the refreshed companion passed 256
focused tests across 25 files plus app/gateway-edge production types. Final-head
CI and configured reviews still qualify the committed PR. Previous-family
results are not reused as new proof. The complete local amd64
gateway image passed its runtime gate and offline installed-package smoke check.
Live acceptance belongs to the resulting immutable main family.

Earlier failed controls remain failed evidence. Doctor emitted isolated-fixture
and upstream deprecation/ownership diagnostics; a successful command is not a
warning-free report or clean-close proof. This qualification does not establish
historical-data migration, full Gateway startup, provider/tool/desktop behavior
or live acceptance. TEST must qualify the resulting immutable main family;
PROD remains a separate operator decision.
The earlier closed-preparation-worker reload, activation timing and Codex tmp-link
transfer failures remain separate failed controls; this recut does not declare
them fixed without actual affected acceptance. Schema 28 state must not be
assumed safe for an older native image rollback.

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
builder uses main's pinned Rust 1.99.1 image and the source's toolchain selector.
The selected OpenClaw snapshot pins pnpm 12.12.1,
Codex plugin dependency 0.162.1 and matched CUA package 0.34.1.

The PR preserves main's immutable Node 26.12.0 image, which satisfies the
selected OpenClaw engine requirement. The earlier local image used Node 26.11.1
and Rust 1.99.0; the resulting main build qualifies the current combined recipe.
This recut does not independently refresh unrelated CLI or operating-system pins.
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

CUA uses the matched 0.34.1 JavaScript/native package and the narrow Linux
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

Mattermost uses channel-wide memory. Templates default room replies to threads
with native `replyToMode: "all"`; pre-boot fills this reply default only when unset
and selects `threadSessionScope: "channel"` for the channel and every generated account.
Explicit channel/account reply modes, per-chat-type overrides, and streaming
preferences remain intact. Native direct messages stay unthreaded unless explicitly
configured otherwise. Reply destination and session identity remain distinct native
contracts. Sessions and tool history remain in native OpenClaw SQLite state; existing
thread sessions are not deleted, merged or reconstructed by this change. A retained
base channel session resumes as-is; reset and compaction apply to that channel's
session, not one selected reply root. Different channels and account-bound agents
remain separate.

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
behavior. Threads in one channel share its session identity. Other channel
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
[CUA 0.34.1 tag](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.34.1),
exact source `0c69d9a2c8abbb5051a2df4a23f0fa166d5385dc`, with
`cua-desktop-discovery.patch`. The published modifier fix is already present,
so the older modifier-only fork is not used. Rust and the other CLI/tool pins
remain unchanged.

The sparse checkout also includes `libs/cua/Cargo.toml` and
`libs/cua/crates/cua-telemetry`, the 0.34.1 driver's existing path dependency.
The selected revision's Cargo lockfile, dependency features and test gates remain
unchanged; the recipe does not fetch the rest of the CUA workspace.

The 0.34.1 `GetAccessibilityTreeTool` still discovers only X11 windows. The
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

The installer requires matching 0.34.1 installed JavaScript bindings, native
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

The small upstream discovery correction is proposed in [CUA #5286](https://github.com/trycua/cua/pull/5286).
Its headless Linux tests passed; real Wayland qualification and the author's CLA
remain separate. Its newer upstream base does not qualify or replace this pinned
0.34.1 package/library pair. Both local architecture installers passed here.

## Vendored computer-use skills

`infra/gateway/cua-skills/` holds the `cua-driver` skill adapted from CUA's
0.34.1 skill pack
([`0c69d9a2`](https://github.com/trycua/cua/tree/0c69d9a2c8abbb5051a2df4a23f0fa166d5385dc/libs/cua-driver/rust/Skills/cua-driver))
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
