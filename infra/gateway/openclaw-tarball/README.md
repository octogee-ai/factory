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
4. Commit the final source and run the full build. `pnpm build package` adds
   `clean:dist` before the same full-build steps, removing E2E/QA artifact residue. Verify
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
pnpm build package
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
- Verify `vendor/npm.tgz` in the root archive and the independent global npm
  installation contain the qualified runtime bytes. The packer stages stock npm
  12.2.1 and applies [its distribution patch](npm-12.2.1.patch) to that temporary
  copy before packing. The root keeps its exact npm 12.2.1 dependency and bundles
  that patched closure in a disposable package stage; a relative tarball
  dependency cannot be resolved before global install extracts the root. The
  normal npm package inventory supplies stage files and modes, with escaping
  paths refused. Installed source dependencies remain unchanged. Selected main pins npm 12.2.0; the overlay
  pins stock npm 12.2.1 before the disposable distribution patch. Octogee owns the nested Undici 6.29.1 and
  ip-address 10.7.4 fixes because pnpm 12.15 loses these bundled-file patches on
  a cached import. The glob 13.0.6 cancellation backport follows upstream commit
  `4682e8c9babee1b385202ede36389634e12076d7`; minimatch 10.2.5 preprocessing limits
  follow `77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8`. Versions remain unchanged
  for these backports, so version-only advisory scans still report them.
  Both glob public `index.min.js` bundles are regenerated from the patched closure
  with esbuild 0.27.3 using upstream `scripts/build.sh` options (`--minify
  --platform=node --bundle`, each format's `index.js`, matching `--format=cjs`
  or `--format=esm`), omitting source maps absent from npm's distribution.
  Run `node npm-distribution.test.mjs <npm-root>` against the staged and installed
  copies: all 24 raw/public CJS/ESM controls must pass. Reassess this patch against
  each selected npm release; retire each backport when the stock installed closure
  supplies the equivalent fix.
  Platform Dockerfiles stage npm 12.2.1 with this same distribution patch and
  run the same 24 controls before copying only the patched npm tree into runtimes;
  the patch and test bytes are platform/site release and per-image fingerprint inputs.
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
`current.json`. Push the
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

## Current overlay: November 2 weekly runtime refresh

This refresh freezes OpenClaw main at
`c1b0fc1415a09138c48e3f81055aca0f8e4f12aa`, 42 commits after the previous
`adabd2b4b1e9607047925e50b59959b4245415c2` base. The operator selected today's
updated main for independent qualification. Subsequent upstream commits do not
change this build's input.

The clean built overlay is `8b83bda7300f820ff8c22ea4ebf720fc125298a7` on
`ceckert/openclaw:codex/octogee-detach-latency-current`. Gateway archives and
hosted islands come from that same source.

This recut retains maintenance base `1f9f1e4687adbf30e3cf5e53ca15e2bc931ca89b`
and adds only the two reviewed commits from
[OpenClaw #191463](https://github.com/openclaw/openclaw/pull/191463). The base already
contains the canonical outbound receipt expectation, so no fixture correction is
carried in this overlay.

The selected tip's [push CI run](https://github.com/openclaw/openclaw/actions/runs/41518259691)
was cancelled before any jobs ran. The latest successful scheduled
[full CI run](https://github.com/openclaw/openclaw/actions/runs/41377849337)
is on `d1d45068a49bc85eb2a1eff077678b3a87a68621`: 150 jobs passed and 11 skipped
(check-plan, Node 24 compatibility, shared SDK declarations, Control UI i18n,
Android/iOS screenshot and release e2e jobs, iOS screenshot evidence, PR failure
report and release-child sealing). That run does not qualify this newer tip.
The checks below are this cut's independent qualification.

### Native adoption and retained product boundaries

The source is rebased onto that exact tip. Previously adopted session-list,
retained-PG creation, Talk initialization/consult and Doctor auth-alias fixes
remain native; their fork copies are not restored. Native schemas remain
canonical (GLOBAL39 and AGENT39). Native inbound-context composition, bot-loop
protection, worker ownership and backup source-artifact preservation remain.

Requested upstream fixes are included even while their PRs are open:
[#189036](https://github.com/openclaw/openclaw/pull/189036) at reviewed head
`bfc19c0c863f6f7b55bae25f0a7cc95f69294809` (worker-backed PG Talk steering) and
[#189418](https://github.com/openclaw/openclaw/pull/189418) at
`6b4438cd18818764968ebe4dd63619f093fd3ee1` (owner steering for native direct
attempts). The combined callback awaits authority preparation and rechecks the
current owner and backend at insertion.
Their prior exact-head green upstream checks are distinct from this runtime's
qualification. [#177823](https://github.com/openclaw/openclaw/pull/177823) is closed
unmerged and its optional superseded-retry guard and synthetic regression are
removed. Native #183964 already fixes the original SecretRef reload failure;
the exact frozen-native control passes. Remaining reload custody is assessed
separately below; its contract tests pass after this retirement.

Mattermost inbound parity (#186891) and message actions/multi-file sends
(#186893) remain approved channel behavior. Current action gates must retain
opt-in writes/downloads/pins/search/member information and final live-authority
checks; channel-scoped sessions retain reply roots. Their upstream contribution
readiness is tracked separately from installed artifact proof.

The scoped reload-account repair remains: only resolved new/removal-only account
targets skip unrelated global drain; affected existing accounts and widening
fallbacks retain it. Requester propagation, one approval reviewer, authoritative
membership revocation, strict stop joining physical startup/cleanup, worker
reclamation deadlines, retained-store detach/reattach and outbound delivery
custody remain under their existing owners.

Scheduled plugin tools receive a separate verified `scheduledRequester` only
for account-policy jobs delivered through their creator's channel account. It
never becomes ordinary invoking requester authority. Operator cron restore
retains closed `scheduledToolPolicy`/`toolsAllowProvenance` schemas, account/owner
matching and operator-only reads; native human-owner transfer changes a different
contract. Remove these extensions when native supplies the equivalent creator
fact or Octogee stops recreating jobs through operator `cron.add`.

The Octogee-only `doctor --skip-recovery-backups` option remains limited to
existing externally protected private-import/upgrade paths. It does not replace
the ordinary source Doctor required before a native SQLite-to-PG port. Native
maintenance admission, migrations, leases and commit authority remain intact.

### PostgreSQL-only Octogee policy and checkpoint retirement

Both Gateway classes now author `database.engine: postgres` for every configurable
portable family: state, agent, Workboard, Logbook and Team Reports. There is no
older-Builder or older-account SQLite runtime mode. Native-required local
credentials, PG anchors and safety/recovery journals remain native SQLite files;
they are not user data engine fallbacks.

The old periodic/preStop SQLite-state checkpoint and download/restore consumer
is removed. It already skipped PG GLOBAL anchors. Its fork-only `backup local`
CLI and paired mixed-engine snapshot owner are therefore removed too, restoring
native backup/restore and credential handling exactly. Native's all-PG
`backup create --local-companion` remains available; it is not claimed to be the
same API. Upstream #178973 was closed unmerged at the user's request because
Octogee no longer uses that proposal. PG GLOBAL recovery retains verified
recorded anchors and never falls back to an old SQLite checkpoint. Detach,
delivery-queue retirement and no-replace physical publication are preserved.

Retained SQLite data or explicit non-PG family selection refuses before the
writer changes config. GLOBAL absence alone cannot prove other stores are
fresh. With the Gateway and embedded writers stopped under their existing
service/hold authority, preserve source config/stores, run ordinary native
`doctor --fix --non-interactive`, and use native `database port --family <family>
--to postgres --dry-run` followed by the actual port for each SQLite family.
Native owns capture, verification, recovery manifests and config publication.
An empty-family port currently reports a verified no-op without rewriting its
selector: after inventory proves every populated store is PG and remaining
families are empty, use native's config writer to select PG for those empty
families. Never flip engine keys over retained SQLite files. Interrupted ports
must resume or roll back through the native manifest owner.

No deployed old-format/store inventory or live migration is claimed by this
isolated refresh. Build main publishes images; it does not deploy or migrate a
running Gateway. Any operational cutover still needs its stopped-source port and
post-port data/Memory/Skills verification.

### Migrating retained Builder stores

The Builder supervisor exposes an operator-only local-socket migration for all
five database families: state, agent, Workboard, Logbook, and Team Reports. On the
retained source allocation that has served traffic, with no active handoff, run:

```bash
/octogee/scripts/node_modules/.bin/tsx /octogee/scripts/ops/migrate-builder-stores.ts \
  --expected-pod-uid=<retained-source-pod-uid> --apply
```

The supervisor refuses standby boots, verifies the source pod UID and released
readiness marker, stops OpenClaw, and serializes migration against start/resume. It runs native
`openclaw doctor --fix --non-interactive` with recovery backups, inventories every
SQLite family, and invokes `openclaw database port --family <family> --to postgres`
for each populated family. Native ports own schema upgrades, data verification,
local credential companions, and recovery manifests. Only a native inventory
proving zero stores permits an expected-value config write for an absent family;
file size is never evidence of absence. Unsupported/custom store paths fail
before any port because Octogee cannot durably restore their anchors.

Before startup is unblocked, the command verifies each PostgreSQL store identity,
records and reads back state, agent, and auxiliary anchors through the fleet
broker, applies pre-boot config patches, and checkpoints system_config to Gitea.
The matching API must be deployed first: a broker that drops auxiliary anchors
fails read-back verification. A durable-record or config-checkpoint failure leaves
a local pending marker and the source held; rerunning retries the unfinished
work without re-porting completed PostgreSQL families. An active native recovery
manifest requires explicit native `database port --resume <manifest>` or
`--rollback <manifest>` while still held, followed by rerunning this command.
Success leaves the Builder held. Add `--resume` to explicitly permit startup only
after all steps succeed.

The provisioner also records newly created auxiliary anchors. Replacement pods
in the same Builder allocation restore those identities at native paths, verify
the PostgreSQL family/store ID, and refuse conflicting local stores or missing
namespaces. Records are bound to the Builder owner, gateway, and allocation
generation; Shared gateways cannot report or attach these global stores. This
does not move auxiliary stores between Builder and Shared placements. Logbook
frame images and other non-database files remain outside the anchor protocol.

Builder boot can preserve SQLite state/config and defer migration to the held
supervisor, but ordinary startup still requires PostgreSQL for every family.
No Doctor or port runs automatically at boot. Retain the source pod and its native
recovery artifacts until verification and durable checkpointing succeed; deleting
it mid-migration can lose the unpublished anchors and local recovery material.
An empty replacement pod cannot establish whether its predecessor had data. This
command requires an image containing the supervisor action and cannot retrofit
older running images. It does not change desired/live releases or reconcile a
failed rollout.

### Retained boundaries and removal conditions

Retention decisions distinguish reproduced bugs from approved optional product
behavior. An open contribution or an existing fork-only consumer is not itself
proof of necessity. A merged upstream PR removes an overlay only when equivalent
behavior is present in the selected base and the affected consumer controls pass.

| Family | Native gap or approved behavior; why the owner is here | Remove when |
| --- | --- | --- |
| Requester identity and single approval reviewer | Public requester facts must survive queued/follow-up execution; one reviewer and live client authority must remain valid through the final native/Codex continuation. Scheduled runs expose the verified job creator as a separate `scheduledRequester` only when delivery uses the creator's own channel account. An adapter cannot own core effect admission or reconstruct the job creator. | Native public propagation, single capture and revocation semantics pass delayed/held continuation controls, and native exposes an equivalent verified scheduled-creator fact. |
| Channel membership sync and disclosure | Native now owns invitation-only and linked-session membership filtering. Octogee retains its approved `none`-policy channel-member access, authoritative empty-set sync, explicit-grant precedence and publication invalidation; invitation-only visibility does not replace that mutation contract. Native prepared membership facts replace the overlay target lookup callbacks. | Native authoritative membership methods and read/projection owners provide equivalent revocation and incarnation checks. |
| Mattermost channel session scope | Approved `threadSessionScope: channel` keeps one session per channel while preserving reply roots in both directions. Current writers deliberately select this product behavior. | Native supports that option, or the product explicitly adopts thread sessions and adapts membership/consumers. |
| Channel startup and strict stop | Channel startup must not borrow invoking identity; strict stop joins startup and running work, retains physical cleanup ownership, and retires only removed accounts. | Native proves hung-startup joins, late-stop retry and active-sibling preservation. |
| Reload admission, supersession and settlement | Scoped reference-counted waiting roots, supersession wakeups and model/service debt prevent dropped work or a falsely settled baseline. New/removal-only account changes avoid unrelated global drain after successful resolution; affected existing accounts and widening fallbacks retain it. Native subscription exclusions, synchronous and post-wait checkpoints remain. The separate session-list provider-reload fix is entirely native. | Native owns equivalent scoped-account, held-root, late-join, superseded-tail and post-commit settlement behavior. |
| Shared worker retirement | A failed concurrent admission could retire a shared entry while another lease retained it, permanently blocking later opens and secret reload. Ordinary retirement now waits for the final active release while serving existing leases; canonical close invalidates retained leases before joining client closure. The exact retiring-with-live-actor error is reproduced by removing the guard. | Native preserves serving leases through failed concurrent admission and closes or aborts retirement without stranding them. |
| Lifecycle lease and reclamation deadline | One monotonic worker-visible budget prevents late commits. Native's five-second cap is preserved; the overlay carries one worker-visible monotonic deadline and refuses late authorization. | Native carries the same worker-visible absolute deadline and refuses cancelled, expired and late authorization, or the relevant lifecycle consumer is retired. |
| Detach, reattach and retained PostgreSQL | Approved configured-agent transfer retains original logical/physical identity under native creation/deletion custody; missing PG anchors must refuse rather than create. Native #188350 owns unconfigured retained-store creation admission; its duplicate overlay is removed. | Native public transfer preserves namespace/history and rollback/recovery custody, or a supported migration owner replaces it. |
| Outbound delivery custody | Retirement refuses unfinished authoritative delivery state and fences racing enqueue across all affected agent identities; empty caches are insufficient. | Native detach/deletion fences the same queue and retains idempotent receipts. |
| Cron migration custody | Held/exported/staged/activated ownership, retired fences, hash-bound chunks and drain are beyond ordinary native CRUD. Projection identity includes effective agent plus declaration. | Native migration provides equivalent activation, rollback, drain and two-engine round trip. |
| Retained legacy cron/state inputs | Fingerprints/order/schema checks admit only recognized retained formats and refuse unknown partial schemas; native canonical schemas remain authoritative. | The supported retained restore/move inputs are retired, or native adopts their exact migration. Historical fixtures alone do not prove a deployed inventory; no deployed old-format inventory was inspected in this recut. |
| PostgreSQL web-secret index reads | Cold GLOBAL state makes native's synchronous installed-index read fail during Builder `secrets.reload`; the existing async reader owns worker access and validation. | Native awaits the worker-backed reader here and the same cold-GLOBAL/provider conformance control passes without this overlay. |
| PostgreSQL cron enabled JSON | Native's SQLite JSON-value assumption fails PG bound enabled updates; the codec uses each engine's existing JSON expression. | Native equivalent passes both-engine false/true transitions without losing authored fields. |
| Memory shadow database retirement | Physical admission must retire before unlinking shadow files, preventing writes through live descriptors. | Native owns equivalent descriptor/late-owner retirement. |
| Voice relay and computer authority | Approved public broker transport retains native session/media ownership; desktop control release, observation/token lifetime and node execution remain bounded. | Native public contracts preserve transport validation, cancellation, fresh observation and late-dispatch refusal. |
| Final-reply notification | Activity tools require terminal final-content classification, not agent-completion inference. Only the public observer flag is retained; delivery custody is native. | Native supplies equivalent classification or the observer is removed. |
| Dashboard participant labels | Current same-session history supplies a human label missing from native observation projection. This optional presentation is used by the embedded full native Dashboard, with no access/identity mutation; the current browser/computer/workbench islands do not own its header. | Native projects equivalent labels or the embedded native chat consumer is removed. |
| Dependency and npm packaging | The exact npm 12.2.1 pin and disposable npm distribution patch need installed-byte verification; version equality does not qualify nested dependencies. Native already owns the fast-uri pin, with no fork-only version change. | Native installed closures contain the fixes and the dependency gate passes. |
| Generated schemas, inventories and test support | Describe retained APIs and canonical native owners, not independent features. | Regeneration after the owning feature's removal eliminates them. |


### Rollout handoff fixes in this cut

The November 1 rollout handoff identified Octogee migration/rollout issues, not
another native cron schema owner. The already-merged #4968 carries coach monitor
declarations with their original key and idempotent restore, while plugin-owned
declarations remain native. A failed source schedule snapshot (including an old
provisioner's 404), or failed durable snapshot publication, now stops the move
before cutover/removal; rollback attempts to restore known fenced jobs on the source before ingress
resumes; failed restoration remains a recovery limitation. Existing retained schedule snapshots remain available to recovery.
Builder recovery now classifies malformed retained local state as fatal, keeping
transient broker failures retryable; real CLI controls prove both classifications
without modifying retained bytes. The operational PostgreSQL runbook matches
this cut's five-family policy and checkpoint retirement.
Old builds that cannot export authenticated creator provenance still need an
explicit rescue/recreation through their rightful owner; this cut never invents
creator identity or runs the live rescue scripts.

A held computer VM can no longer give a release roll priority over its pending
source recovery. An already-running roll of that exact unadmitted VM target ends
its own claim after current recovery/claim checks, leaving cleanup with the
source recovery owner. Cluster/Helm rollback behavior stays with its existing
owner. Live workspace wire tests refresh canonical fixture placement before each
request while reusing the authenticated token. This removes suite-long stale
routing; it does not eliminate a move between a lookup and its HTTP request.
Native Proactive check jobs with empty scratch are preserved as requested.

### Detach and activation-abort integration

Read-only deletion authority checks avoid write transactions while preserving live
lease admission, journal/template ownership, the final host journal fence and all
mutation transactions. The current-source native scope passes 47 authority/cleanup
tests and 12 gateway detach, offline CLI and outbound-custody controls. The optional
standalone PostgreSQL case was skipped; the installed PostgreSQL offline CLI is
exercised by the abort replay below. Production core types, changed-file
lint, a full clean package build, archive integrity and the actual Linux full-plugin
installer target pass. Independent review with the complete lease/admission owners
reports no actionable P0–P2 findings.

At this pin, Skill Workshop is a bundled plugin. Native ignores unmarked
`plugins.entries.skill-workshop` policy as stale built-in-era configuration and
refuses offline-detach writes against it. Both templates and final config writers
now declare `meta.migrations.skillWorkshopPlugin: true`. Shared retains autonomous
mode off; Builder choices survive. The retired `skills.workshop` key remains absent.
The image gate rejects the ignored-policy warning even when Native reports
`valid: true`.

The native regression `tests/specs/openclaw-workshop-native.spec.ts` checks the
pinned CLI version, validates both classes through their actual writers, reproduces
the unmarked write refusal and verifies Workshop survives Doctor plus reconciliation.
It uses `OCTOGEE_TEST_OPENCLAW_BIN`, `OCTOGEE_TEST_OPENCLAW_NPM`,
`OCTOGEE_TEST_OPENCLAW_EXTENSIONS` and a disposable `OCTOGEE_TEST_POSTGRES_DSN`.
The installed-runtime comparison and active-chat abort replay use
`scripts/ops/prove-agent-detach.ts` and `scripts/ops/prove-activation-abort.ts`.
The committed [raw results and aggregates](../../../docs/operations/evidence/detach-fork-integration/summary.json)
record two alternating baseline/candidate pairs against Mattermost 12.0.1 and
PostgreSQL 17, with 5 ms database delay in each direction during detach only.
Ten warm calls per variant give median 4086.65 → 3454.11 ms (15.48% lower), and
median observed fixture SQL calls 433.5 → 330. Cold calls are reported separately.
All samples are retained. A 22607.56 ms candidate sample makes nearest-rank p95
worse than baseline's 4890.20 ms: the published tail acceptance criterion is not
met. Native maintenance overlaps the delay, but its cause remains unproven. This
cut does not claim to fix the production slow tail.

The comparison's timed calls precede its transfer phase. Following review, the
proof uses the production snapshot export, manifest validation, anchor landing and
installation owners rather than carrying an agent directory. A separate six-agent
[verified-import smoke](../../../docs/operations/evidence/detach-fork-integration/verified-anchor-smoke.json)
checks that revised path, original UUID/schema/session identity, exact canonical
transcript bytes, source write refusal and real Mattermost replies. Its zero-delay
observations are excluded from the performance comparison. New proof output also
persists labeled cold/warm median, nearest-rank p95 and spread beside raw samples.

The [active-user abort replay](../../../docs/operations/evidence/detach-fork-integration/activation-abort.json)
keeps the same coach agent active on Shared while its distinct pre-copy target
store is held. The actual signed abort handler, lifecycle adapter and installed
offline CLI reproduce HTTP 500 with unmarked policy, then return 200 after six
preserved-store detaches with corrected policy. Target history/anchors and the
source anchor survive; the source's held model response finishes afterward.
Process custody and watcher ownership are local fixtures, not a deployed fleet
trial. Both native config-writer/Doctor cases and 76 current-catalog PostgreSQL
permission, handoff and recovery controls pass.

### Maintenance-base qualification and publication

The following broader checks qualify the retained maintenance base. The targeted
detach recut checks are listed above; their scope does not imply a new aggregate
upstream test-suite pass.

Pinned pnpm 12.15.0 and the frozen lockfile built the clean source with full
`pnpm build package`; `dist/build-info.json.commit` matches the source SHA above.
Root and Mattermost were packed sequentially with the maintained packers from a
clean recipe snapshot. Both prepack/postpack lifecycles restored clean source.
The native root archive checker passes its preflight, inventory and dist import
graph. Its default mode matches this packer's self-contained `file:vendor`
workspace layout; the optional `--require-bundled-workspace-deps` mode requires
a different physical npm bundle layout. Actual installed private AI and patched
MCP imports resolve inside the installed OpenClaw tree and pass.

The runtime resolves official glob 14.0.3 and minimatch 11.0.4. The existing
systemd escaped-question-mark/wildcard control first failed against minimatch 11:
its canonical compiled parts are Matchers rather than RegExp instances. The
native consumer now excludes `GLOBSTAR` and calls the public matcher contract;
all 14 real-flow controls pass. The exact npm 12.2.1 bundled-glob 13.0.6 policy
entry is limited to that stock package's existing authenticated bundle owner.
The existing boundary matrix failed before the entry and all 100 package-lock
controls plus real prepack pass afterward. This does not exempt registry
packages or waive physical npm distribution verification.

Production core, UI and extension type lanes, script types, formatting, channel
metadata, worker inventory and config baseline checks pass. Focused native
controls pass across unit/relay (15), gateway custody/authorization/outbound
(66), infrastructure (69, with five platform skips), and the additional
requester/approval/workspace/file-transfer/secrets/CUA scope (67). Independent
worker/cron controls pass 31 tests, including 11 worker-lease controls. These
scopes overlap and are not an aggregate test count. The outbound receipt
assertion now requires the native delivered receipt; it was red before its
expectation was updated. No assertion or timeout was weakened.

Full native lint reports 17 max-lines failures; every failing file is
byte-identical to the selected upstream. Its limits remain unchanged. The prior
`server-reload-hot.superseded-tail.test.ts` qualification recorded eight
managed-reloader timeouts and stalled cleanup, including a first-case timeout
on the old native baseline. That unrelated owner is unchanged and this cut did
not rerun that suite. It remains an inherited qualification gap, not a current
exact-head result. Aggregate `pnpm check` success is not claimed. Full-build
advisory budgets report CSS 312.1 KiB against 302.1 KiB and chat boot JavaScript
1250.9 KiB against 1250 KiB; budgets remain unchanged.

The actual Linux amd64 `openclaw-full-plugin-installer` target passes CUA driver
artifact lint, `config.changed` publication, source-matched Parallel and Codex
installation, registry refresh and all three native-hook imports. All 24 npm
raw/public CJS/ESM security controls pass against the packaged distribution and
both installed npm copies; real workspace discovery also passes through both
installed npm public entrypoints. The actual CUA skills installer accepts the flattened
installed SDK/native/plugin 0.38.0 versions. All twelve Octogee extension bundles
load against this installed SDK. Both raw Shared/Builder templates and generated
configs from their real roster-ownership, policy and pre-boot writers pass native
validation. The 545-package physical installed root/companion/runtime inventory
matches none of the 16 source-workspace advisories: those remaining source paths
belong to unselected IMAP, Teams, Discord, Copilot and QA workspaces. Bundled npm
backport versions are retained honestly and verified by behavior and bytes.

An installed Gateway on the isolated PostgreSQL fixture accepts two concurrent
`agents.create` calls and `secrets.reload` with `warningCount: 0`. Startup
session-registry maintenance intersects a temporary agent resource close and
logs one fail-closed admission error. Its existing native scheduler completes
the next pass 60 seconds later, without a repeated failure. Both agents remain
listed and a second secret reload reports zero warnings; shutdown is clean.
The same diagnostic was observed in a SQLite fixture, so this is not described
as a SQLite-only issue or an unproven historical baseline failure. Resource
admission and the native maintenance retry owner remain unchanged.

The actual installed official CUA module dynamically loads all 202 exports,
including `CuaDriver`, on Node 26.13.0/glibc 2.36 with the same Debian X11/Xi/
xkbcommon libraries supplied by the final gateway-system stage. The disposable
image reports no pending apt upgrades. This ABI and artifact proof does not
replace real desktop acceptance after deployment.

The executable SQL catalog was regenerated against this exact source with
PostgreSQL 16.15/vector 0.8.7: all 11 routine, 15 trigger and 308 expression
fingerprints are unchanged; only its source SHA changes. All 48 PostgreSQL
import/recovery/handoff integration tests pass. Hosted islands and Browser
resources are regenerated from this build; 196 focused app checks and 39
runtime/license/pin checks pass. Focused Octogee packing, base-image, template
and CUA contracts pass 83 tests across eleven files.

The source branch is published to the public fork. Both archives are new
write-once objects. Full SHA256 and byte-equality readback of the exact published
generations, including the root's build-info source commit, is verified.

| Package | Write-once object and generation | Bytes | SHA256 |
| --- | --- | ---: | --- |
| root | `openclaw-fork-8af98932.tgz#1793668904035227` | 117068051 | `8af9893262abee6df15b3c2792f45b913a31e4f87876427c3e0b3bc0b4cc64c8` |
| mattermost | `openclaw-mattermost-bc6480eb.tgz#1793657168834514` | 1273634 | `bc6480ebfc8437515b67d288330651bb0f75f2b2825634fc6c4979a36b6c5e6c` |

This qualifies the installed base runtime and its consumers. Full platform
images, deployed TEST/PROD smoke and computer desktop acceptance remain separate
Build main and deployment steps. This recut does not mutate fleet desired state
or live Gateway/computer data.

### Upstream contributions

As checked on November 2, #189036 (`bfc19c0c863`), #189418 (`6b4438cd188`),
#186891 (`1d18f8eb784`), #186893 (`d4fd7a5c5de`), #167431 (`27193149bc2`)
and #178755 (`d576caa76fe`) remain open and unmerged. All six currently conflict
with live upstream main. Their earlier reviewed-head checks and published
contributions do not establish current-main merge readiness; this downstream
cut is clean on the separately frozen selected base. No upstream PR was changed
by this refresh. #177823 is closed unmerged after native adoption of its original
bug fix, and its optional guard remains retired. #178973 is closed unmerged
because its mixed-engine consumer was retired, not because native adopted its
API unchanged. Earlier superseded PostgreSQL contributions remain recorded in
repository history. Contribution status never substitutes for runtime necessity
or installed-image qualification.

## Native CUA desktop discovery

The official [CUA 0.38.0 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.38.0)
at `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19` includes
[the desktop-discovery contribution](https://github.com/trycua/cua/pull/5368).
Its native owner dispatches Wayland/X11 discovery, excludes off-screen windows
and known dead owners, remembers observed Wayland origins, and emits canonical
window records. Unknown-owner visible windows remain discoverable without
inventing process identity. The upstream regression covers these same boundaries.

Octogee therefore removes its Rust builder, discovery patch, SDK replacement,
and artifact-manifest rewriting. OpenClaw installs the official matched JavaScript
and native packages and owns their exact artifact hashes. The base image still
runs `openclaw doctor --lint --only cua-computer/driver-artifacts` before either
Gateway class is assembled. A version match alone does not qualify the library.
The JavaScript SDK and declarations are byte-identical to 0.37.0; its package
manifest advances the SDK and all six platform companions together.

Source adoption and installer fixtures do not prove a working desktop session.
This cut verifies dynamic loading from the actual installed 0.38.0 package on
the pinned Debian/Node runtime as recorded above. Real desktop acceptance remains
a deployment check; prior patched 0.37.0 results do not qualify the new library.

## Vendored computer-use skills

`infra/gateway/cua-skills/` holds the `cua-driver` skill adapted from CUA's
0.38.0 skill pack
([`85e2b131`](https://github.com/trycua/cua/tree/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/Skills/cua-driver))
and the `cua-omarchy` companion from Omarchy
[PR #11342](https://github.com/omacom/omarchy/pull/11342) at `94e97055`.
`provenance.json` records each repository, commit, and the SHA-256 of every
upstream file used for the adaptation. The runtime image installs them to
`/opt/octogee/skills/computer` with `install-cua-skills.mjs`, which requires
matching installed JavaScript, native-package and OpenClaw plugin versions,
the official release's source identity, pinned skill sources and listed files.
Native artifact verification remains with OpenClaw; there is no locally invented
patch receipt. No skill source is fetched at build or run time.

The adaptation keeps the loop, targeting, delivery, verification, and refusal
guidance and maps it onto the `computer` tool. It omits standalone CLI/MCP
transport, installation, self-update, permission profiles, approval-bypass flags,
cursor overlay, recording, embedding, macOS, Windows, and Omarchy package/plugin
management. CUA's browser guide is replaced by the `browser` tool. The 0.38.0
upstream skill differs from 0.37.0 only in its version; `LINUX.md` is unchanged.
The Hobby X11 skill carries the same driver version.

When the driver version changes, diff its official skills against the recorded
digests, carry forward the applicable guidance, and update the release/source
mapping and `provenance.json` together.

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
