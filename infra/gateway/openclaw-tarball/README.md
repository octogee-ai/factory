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
- Verify `vendor/npm.tgz` in the root archive and the independent global npm
  installation contain the qualified runtime bytes. The packer stages stock npm
  12.2.1 and applies [its distribution patch](npm-12.2.1.patch) to that temporary
  copy before packing. The root keeps its exact npm 12.2.1 dependency and bundles
  that patched closure in a disposable package stage; a relative tarball
  dependency cannot be resolved before global install extracts the root. The
  normal npm package inventory supplies stage files and modes, with escaping
  paths refused. Installed source dependencies remain unchanged. Native's
  source uses stock npm 12.2.1. Octogee owns the nested Undici 6.29.1 and
  ip-address 10.7.4 fixes because pnpm 12.15 loses these bundled-file patches on
  a cached import. Reassess this patch against each selected npm release.
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

## Current overlay: October 24 session-list replacement readiness

This recut adds the six-file session-list repair to the qualified October 24
overlay below. Source `cf149eb8ba23177fbf1992a7ff4f3a7dc47b8b94` is published on
[`fix/session-catalog-reload-readiness-20261024`](https://github.com/ceckert/openclaw/tree/fix/session-catalog-reload-readiness-20261024).
The upstream contribution is [#182783](https://github.com/openclaw/openclaw/pull/182783).
It awaits the current provider catalog at the existing asynchronous session-list
selection boundary when runtime replacement invalidates the previous callbacks.
Cancellation, disposal and superseding replacement retain their owning lifecycle;
ordinary background catalog enrichment keeps its completed facts.

The source remains on frozen upstream `fe8d4597345c307f637fe0a2a5e6770226c7da9d`
with the existing security overlay. Dependency manifests, lockfiles and policy,
storage owners, PostgreSQL DDL and migrations are unchanged from `55d6c80e`.
Protocol remains 4, state schema 31 and agent schema 33. The maintained PostgreSQL
catalog qualifier reproduced identical routine, trigger and expression identities;
only its source provenance changes. Hosted UI inputs are unchanged and the
maintained generator regenerates their bundles and notices from the exact source.

The owning 21 tests, Native types, lint/format and scoped independent review pass.
Normal build, both maintained packers, the Native tarball checker and the strict
isolated pair install pass. Actual Linux AMD64 and ARM64 full-plugin installers
pass their bundled trust, registry, CUA, source-matched Codex/Parallel and three
native-hook checks. Each installed inventory has 762 physical package roots and
569 name/version pairs; pinned OSV 2.5.1 passes with unchanged policy and no new
exception. Both nested and independent global npm copies match all 15 previously
qualified upstream repair files.

The same installed Gateway fixture runs on AMD64/Node 26.12.1 against both pins.
Public `config.patch` holds synthetic-provider replacement; request logs confirm
`sessions.list` entered the server before observations. `55d6c80e` produces the
exact `PluginInstanceUnavailableError`. This source respects a 1000ms caller
deadline, keeps the next request pending until publication, then returns the
successor's high thinking policy and the same persisted session. Subsequent
config/model reads, cron hold/session read/resume, health and clean shutdown pass.
No model calls occur. Ordinary catalog enrichment was correctly nonblocking and
is not used as the failure control. The original Mattermost-stop-to-reload trigger
is not established; full live Octogee migration acceptance remains required.

Qualified root: `openclaw-fork-3b908e0f.tgz`, 132264656 bytes,
SHA256 `3b908e0f5ad977595a371e7a2ce446b82c1eba07084f6fd6d4647c7b0189f85d`.
Qualified Mattermost: `openclaw-mattermost-dc7c9709.tgz`, 1258426 bytes,
SHA256 `dc7c97096165b496741e6d215180f3dbb26db0eb6b006a563207ff22ce87c85e`.
The 873 Mattermost file hashes match the prior pair; the archive encoding differs.
Both objects were published create-only. Full generation-bound downloads verify
the exact hashes and byte counts: root generation `1792870075754965`, Mattermost
generation `1792870079047411`. This publishes packages, not an environment.

## Previous October 24 frozen main

The operator selected latest upstream main `fe8d4597345c307f637fe0a2a5e6770226c7da9d`
for independent qualification. It remains frozen. The overlay is
`55d6c80e504679ed4d0ffd2c26c1b43af05e5d0d`, published from
[`codex/openclaw-refresh-20261024`](https://github.com/ceckert/openclaw/tree/codex/openclaw-refresh-20261024),
version 2026.10.7. The isolated Octogee checkout starts from merged main
`e965e54c367e7132194c927d5bcbee8e1999701d`, including CI tiering #4759.
Other worktrees and running services are preserved; neither an older green
OpenClaw commit nor a moving newer tip was substituted.

The selected tip's [push CI](https://github.com/openclaw/openclaw/actions/runs/40104773927)
ran one successful security-fast job and skipped 42 jobs, including build, types
and tests. The inspected successful [full scheduled CI](https://github.com/openclaw/openclaw/actions/runs/37419202402)
qualifies `d8612ec864bb4c872616cfda5340c53803655f5f`, with 154 successes and
nine skips: Node 24 compatibility, PR fail-fast/check plan, Android/iOS
screenshots, alternate shared SDK, iOS release E2E and screenshot/seal evidence.
Those results do not qualify this selected tip.

### Native adoption and retained boundaries

Selected main includes [#181676](https://github.com/openclaw/openclaw/pull/181676)
(`317eaa07692ca8004df4c703b659bab2525cd21d`). Its narrow PostgreSQL recovery-hold
read and cron-owner worker now supply the earlier fork fix; duplicate owners
and assertions are dropped. Native's owning PostgreSQL/SQLite tests qualify
creation, recovery holds, cron inspection and unrelated SQL refusal.

Native [#181201](https://github.com/openclaw/openclaw/pull/181201) now owns missing
local client-credential recovery. The overlay drops its former explicit rebind
flag and duplicate credential implementation/tests. Octogee's bounded failed-boot
recovery invokes `doctor --fix --yes --non-interactive` only after detecting
missing local credentials and recovering the exact stale same-gateway owner.
Healthy credentials still skip Doctor; startup without consent, corrupt or
mismatched retained evidence, and a live owner remain refusal boundaries.
The superseded #180345 contribution is closed unmerged.

The generated validator registry, agent/state schema and worker inventory remain
native-owned. Protocol remains 4, state schema is 31 and agent schema is 33.
Native now supplies direct Undici 8.12.2. The overlay still pins fast-uri 4.2.3
and npm 12.2.1 because selected main has 4.2.2 and 12.2.0 respectively; the
existing strict dependency policy is unchanged. npm's distribution patch remains
staged only during packing, without modifying installed source dependencies.

The retained-boundary table below supplies individual gaps and removal
conditions. Reconciliation keeps requester/reviewer and execution-time authority,
independent explicit grants, authoritative empty channel-membership revocation,
strict-stop joining retained startup preparation, claimed reload-waiter root
ownership, and non-destructive detach with outbound-delivery custody. Native's
new mention alias cache carries current membership rather than stale cached
policy facts. Native AsyncContext owns reload root propagation. Existing-only
PostgreSQL restoration keeps store UUID/namespace, config, history, jobs and
recovery holds intact across a fresh executable Gateway restart; wrong paths,
missing stores and pending cleanup refuse restoration.

Memory shadow, checkpoint/snapshot custody, brokered voice and desktop requester
boundaries remain for their demonstrated product gaps, with removal conditions
in the table below. Detach #178755, auth #178970, checkpoint #178973, reload
#177823/#167431 and PostgreSQL restoration #181951 remain open; contribution
status alone does not justify retention. This refresh opens no new upstream PR.

### Qualification

The pinned pnpm 12.15.0 frozen install passes on Node 26.12.1. Native production
types pass for core, UI and extensions, changed-source formatting passes on 360
files, and focused type-aware lint passes. The boundary run passes 254 tests;
PostgreSQL credential/hold/outbound qualification passes 18 with one SQLite-only
case skipped in that lane. The actual CLI restoration and creation-conformance
run passes five cases, including the fresh executable Gateway restart.

Aggregate `pnpm check` is incomplete: the SQL worker guard did not finish after
ten minutes and was stopped. Earlier preflights, including line growth, dialect,
assertion safety and all 108 npm package-lock checks, passed; this is not an
aggregate check success. The full native build exits zero, but its report-only
UI budget check reports chat boot gzip 1,277,806 bytes against 1,275,713 bytes.
No threshold is increased and no security or live provider clearance is claimed.

CUA is rebuilt from official 0.36.0 at
`6d6c734c127025fb39ad5d585a10382808b39dc1`, required by this native source.
The existing bounded desktop-discovery patch still applies because upstream
keeps the X11-only discovery path. Both actual Linux AMD64 and ARM64 builder
targets pass 29 Wayland tests (one ignored) and four window tests, then build the
release SDK. This does not establish real desktop-session acceptance.

The catalog qualifier invokes the pinned native schema owner, including current
vector decoder and search versions. The generated trust catalog admits only
native routine/trigger/expression identities. The new memory bit projection
normalizes bounded dimensions 1–16000 only for its exact column; changed
conditions, functions, source columns and out-of-range dimensions still refuse.

Shared's unmatched-route agent has no broker identity. The class-policy disk
writer now supplies its public model metadata without API keys or auth profiles,
and keeps it inheriting the platform default instead of pinning its own model.
This gives native Doctor a configured consumer of that default and its provider
metadata, preventing replacement with a direct OpenAI model. The regression starts red and
passes with the full 48-case class-policy suite; canonical broker identities and
unknown-agent refusal remain unchanged.

### Published artifacts

Sequential packers consume the same clean full build. Native tarball integrity,
a fresh strict npm 12.2.1 installation on Node 26.12.1, all 873 Mattermost file
hashes and the 15 patched npm file hashes pass. The actual Linux AMD64 and ARM64
full-plugin installers pass Parallel's nine-file match, Codex's 188-file match,
all three native-hook imports, bundled trust and CUA artifact validation. Both
installed npm copies carry the same qualified patch bytes. Hosted islands are
regenerated from the same source; Solid rc.18 notices bind its exact published
commit, without changing the license bytes.

Create-only publication and full generation-specific readback verify these
objects in `gs://octogee-openclaw-fork/`:

| Package | Object and generation | Bytes | SHA256 |
| --- | --- | ---: | --- |
| root | `openclaw-fork-d1e29c09.tgz#1792857612859479` | 132059983 | `d1e29c0918e186752e3174b79b504bd260e758574c5a881ca652a9aac8e66b33` |
| mattermost | `openclaw-mattermost-9a88f9ed.tgz#1792857680497716` | 1251521 | `9a88f9ed84d12ad26dac50621c9c972a9d0c8091acf7771981c1d4d1f3e5b4ba` |

Focused Octogee qualification passes 120 artifact/island/CUA contracts, 85 app
consumer cases and 195 Gateway-edge cases; app and edge production types pass.
Core guard/recovery coverage passes 54 combined cases, including real PostgreSQL
projection checks; the credential-retirement administrative fixture uses the
disposable database administrator. No production database is used.

The refresh PR records complete-image qualification and the published image
digest. Final-head CI and installed-image qualification gate merge; Build main's
immutable image-family result is reported separately. Building does not deploy.

## Previous October 23 outbound delivery custody

The selected upstream remains frozen at
`6b3e0c6a94968cdaa03bb019bdcacc8b55aa9b63`. The qualified overlay is
`be883be916375649db9caacad9521b85118e1da7`, available from
[`fix/detach-outbound-custody-20261023`](https://github.com/ceckert/openclaw/tree/fix/detach-outbound-custody-20261023).
It adds only the outbound custody repair to the previously qualified
`5fa6d0924b834f5917adf4847ab615bb98d6fe8a` source described below; version
remains 2026.10.6.

An isolated public-RPC/Mattermost reproduction demonstrated that `agents.detach`
could retire an agent still needed by unfinished outbound delivery. The repair
checks completion, execution and mirror dependencies in the existing state
transaction before removing its roster entry. A pending delivery refuses detach
through the existing unavailable response; an unchanged configured source agent
can have its matching pre-removal detach fence rolled back so normal recovery
can finish delivery. New outbound custody is refused after detach retirement,
while existing-id retries and settlement retain their existing owners. No queue
is cleared or transferred by this fix. This belongs in Native because admission
and retirement must share its authoritative state transaction; an Octogee queue
probe cannot close that race. Remove the overlay once the selected upstream
supplies equivalent custody and the installed refusal/recovery controls pass.

### Artifacts and isolated qualification

The sequential maintained packers used clean, fully built source; installed
build-info names `be883be916375649db9caacad9521b85118e1da7`. The root was
published with a create-only generation condition. Unchanged Mattermost reuses
its existing generation. Complete generation-specific downloads match both
qualified archives' full SHA256, size and original bytes; previous objects
remain immutable.

| Package | Object in `gs://octogee-openclaw-fork/` | Bytes | SHA256 |
| --- | --- | ---: | --- |
| root | `openclaw-fork-888e10c4.tgz#1792806145087956` | 128838929 | `888e10c46ed6175b8354689c1ffd50e881df3b6efc2e51a4df78714b5222841f` |
| mattermost | `openclaw-mattermost-ef7e6074.tgz#1792766326593830` (unchanged bytes) | 1258422 | `ef7e60741f3b5978ee43435623b88964a23596d67b02b57923555147671497f9` |

Normal postcommit build, sequential packing, Native tarball integrity checks and
strict fresh npm installation with Native lifecycle scripts pass. Installed npm
12.2.1 carries the same 15 official fixed files in Native's bundled closure and
its independent global installation; source dependencies remain stock. The
actual Linux AMD64 full-plugin installer passes CUA lint, registry/bundled trust,
Parallel's nine-file match, Codex's 188-file match and all three native-hook
imports. All 873 Mattermost files match the paired archive. Node 26.12.1's
builtin Undici and direct Undici are 8.12.2; bundled npm uses Undici 6.29.1 and
ip-address 10.7.4. Pinned OSV 2.5.1 scans all 759 actual production package roots
with no reported vulnerabilities, no new ignore and the existing policy
unchanged. The inherited http-cache-semantics semantic residual described below
is unchanged.

The installed PostgreSQL control and cleanup replays use actual public Native
RPCs, the production Octogee adapter and a loopback Mattermost receiver. Pending
delivery refuses detach while preserving the exact config/agent/account,
canonical session/history, store UUID and namespace. The original scheduler and
channels resume; restoring the receiver lets canonical recovery produce one
physical effect without a manual resend, after which normal cleanup succeeds.
The independently reviewed source-owner regressions cover the queue transaction
and attribution boundaries, including seven real-PG cases; the explicit
SQLite-only CLI child fixture remains skipped in that PG run. Generic installed
operator delivery and source session-final regressions are separate proofs.

The maintained PostgreSQL catalog qualifier passes against fresh disposable
PostgreSQL 16.15/pgvector 0.8.7 as a non-superuser CREATEROLE database owner. All
five routine, five trigger and 289 expression fingerprints remain unchanged;
the generated catalog and its built interface change only their source SHA.
The existing catalog/routine and isolated PostgreSQL boundary suites pass
41 cases, independently of installed Native public-path acceptance. Hosted UI
provenance is regenerated from this same clean built source. All 50 shared
chunks and four entries remain byte-identical after exact chunk-filename
mapping; 49 chunk names change, while the six provenance/license pairs change
only their source SHA. Eight artifact/island suites pass 89 cases. The normal
local-file dependency owner also refreshes three stale core lock declarations
to their existing google-auth-library range, without changing resolved versions.

This qualifies the isolated published Native pair. The combined Octogee release
still requires normal CI/build/TEST deployment. Full controller/source-held
queued session-final migration proof and live TEST acceptance remain pending;
this repair does not define a new policy for wholly unattributed outbound rows.

## Previous October 23 retained PostgreSQL restoration and runtime security

The selected upstream remains frozen at
`6b3e0c6a94968cdaa03bb019bdcacc8b55aa9b63`; its CI limitations and the
preceding recut qualification remain recorded below. The clean overlay is now
`5fa6d0924b834f5917adf4847ab615bb98d6fe8a`, available from
[`fix/retained-agent-create-admission-20261023`](https://github.com/ceckert/openclaw/tree/fix/retained-agent-create-admission-20261023).
It adds the agent-creation fix and runtime dependency security repairs to
`3474860ac35ee5e3f4a2d4cbe7e3e631ecbb0333`;
no unrelated upstream changes are included. Version remains 2026.10.6.

The installed baseline's public `agents add` accepted an absent roster entry
whose existing PostgreSQL anchor referenced a missing namespace, recreating
empty storage under the carried store UUID. The fix admits existing PostgreSQL
anchors through Native's existing-only restoration owner before workspace or
config effects. It preserves the original metadata/identity refusal, while
fresh creation, unanchored/zero-byte retries, SQLite and journal/hold recovery
retain their existing owners. This belongs in Native because its storage owner
must distinguish restoration from fresh creation; an Octogee SQL probe cannot
replace that admission. Remove the overlay when the selected upstream supplies
equivalent admission and the installed restoration/refusal/retry controls pass.
The independent upstream-only adaptation is
[#181951](https://github.com/openclaw/openclaw/pull/181951); an open contribution
does not replace the qualified overlay in this frozen selected base.

The direct `fast-uri` dependency and existing override move from 4.2.2 to 4.2.3
for the maintainer’s [four URI security fixes](https://github.com/fastify/fast-uri/releases/tag/v4.2.3).
The approved exact-version cooldown exception is removable after
2026-10-26T22:51:36.634Z; the global seven-day strict dependency gate remains.
Frozen pnpm 12.15 regenerates the lock. The subsequent runtime repair moves
direct Undici to 8.12.2 and npm to 12.2.1 without a Node upgrade or new cooldown
exception. Native's authenticated bundled-dependency publisher policy admits
only npm 12.2.1's known stock minimatch/ip-address declarations, preserving its
parent integrity, name, version, path and `inBundle` checks. Octogee's temporary
distribution stage then replaces 15 files with verified official Undici 6.29.1
and ip-address 10.7.4 bytes. Both the bundled Native npm and independent global
npm use that same qualified closure. Installed source dependencies stay stock;
there is no postinstall rewrite or new Native contract.
The existing MCP schema suite passes six cases, and all four official security
vectors change from vulnerable to fixed in the source and installed artifacts.
Both isolated npm and actual Linux image readback find only fixed `fast-uri`
4.2.3 and nested AJV 3.1.9. Remove this dependency overlay once the selected
upstream supplies the fixed dependency and these controls pass.

Octogee's held Builder import uses that public creation path for carried project
agents absent from the fresh target roster. Current owner/project eligibility
and canonical project paths are checked during preflight and before and after
registration, including configured entries left by an interrupted attempt.
Changed authority keeps retries held until valid current authority returns.
Anchors are installed first;
the final source rsync follows Native registration so bootstrap cannot replace
authored persona files. Existing activation-manifest application then restores
the source config identity independently from `IDENTITY.md`; those values may
intentionally differ. There is no new identity writer or migration contract.
Codex snapshots install after that final copy creates their canonical home
directories, preserving valid databases created after pre-copy.

### Artifacts and qualification

Both write-once objects are in `gs://octogee-openclaw-fork/`. The replacement
root was published with a create-only generation condition; unchanged Mattermost
reuses its existing generation. Complete generation-specific downloads match
the qualified archives' full SHA256, size and original bytes. Previous objects
remain unchanged.

| Package | Object | Bytes | SHA256 |
| --- | --- | ---: | --- |
| root | `openclaw-fork-9266eedf.tgz#1792800630948190` | 128832764 | `9266eedf9dac28c78178484377596d682b306d196127fb6e5882776b78cf5fd5` |
| mattermost | `openclaw-mattermost-ef7e6074.tgz#1792766326593830` (unchanged bytes) | 1258422 | `ef7e60741f3b5978ee43435623b88964a23596d67b02b57923555147671497f9` |

Pinned pnpm 12.15.0 frozen installation and full `pnpm build` pass; build-info
matches source `5fa6d0924b834f5917adf4847ab615bb98d6fe8a` and source remains
clean after sequential maintained packers. Native tarball inventory/import-graph
checks and isolated strict npm 12.2.1 installation pass. Installed build-info
matches source. All 15 official fixed files survive installation in both Native's
nested npm and the independent global npm; their Undici/ip-address versions are
6.29.1/10.7.4, and direct Undici is 8.12.2. The actual Linux AMD64 full-plugin
installer passes CUA artifact lint, fresh registry/bundled trust, Parallel's
nine-file match, Codex's 188-file match and all three native-hook imports. All
873 Mattermost files match the paired archive. Image readback confirms source
5fa6d09 on Node 26.12.1 with builtin Undici 8.12.2. The unchanged repository
policy and pinned OSV 2.5.1 scan all 759 actual production package roots across
Native/plugins and independent global npm, with no reported vulnerabilities.
The maintained PostgreSQL catalog is regenerated from this source with unchanged
routine/trigger/expression fingerprints; real PostgreSQL and catalog tests pass
44 cases against a non-superuser CREATEROLE database owner. Eight installed
public-CLI cases requalify intact/missing/mismatched/fresh stores, global
PostgreSQL selection and SQLite/PostgreSQL zero-byte retries against this pair.

The 35 owning Native unit cases, two named held-store recovery integrations,
focused test types, changed-file lint/format and independent full-context review
pass. Installed public CLI controls preserve intact storage and refuse missing
namespaces or mismatched UUIDs without replacing history; fresh creation and
SQLite/PostgreSQL zero-byte retries pass. Intact/missing-store controls also
pass with PostgreSQL selected for global state. Local real-CLI/rsync composition
preserves persona/anchor bytes and PostgreSQL UUID/schema OID/transcript bytes;
real Gateway roster ensure and source-manifest replay preserve differing config
and file identities. After integration with main, the migration/reattach suites
pass 272 cases through the existing Linux rsync test adapter; the Codex snapshot
suite passes 12 cases, including the existing storage/trust guards. Lifecycle/activation
suites pass 183 cases, and scripts types and strict changed-file lint pass.
Hosted islands regenerate from
the same clean built source with no changed upstream island inputs or JS/CSS
bytes; only source provenance and license headers change from the prior pin.
Eight artifact/island suites pass 89 cases. TEST migration
acceptance and full aggregate Native `pnpm check` are not claimed by this local
qualification.

The inherited http-cache-semantics advisory remains separately assessed under
the existing scanner policy. Version 4.3 retains the disputed `max-stale` path:
an existing private cache can reuse a same-URL response after credentials change
when `Vary` is absent. No unauthenticated network leak was demonstrated. The
upstream [maintainer discussion](https://github.com/kornelski/http-cache-semantics/issues/56)
does not establish a semantic fix; this dependency refresh makes no such claim
and adds no scanner ignore.

## Previous October 23 overlay on main 6b3e0c6a

The operator selected and froze latest upstream main
`6b3e0c6a94968cdaa03bb019bdcacc8b55aa9b63` for independent qualification. The
clean overlay is `3474860ac35ee5e3f4a2d4cbe7e3e631ecbb0333`, published from
[`codex/octogee-pg-create-worker-20261023`](https://github.com/ceckert/openclaw/tree/codex/octogee-pg-create-worker-20261023).
Root, Mattermost and hosted islands share this source, version 2026.10.6.
The isolated Octogee follow-up starts from current main
`f914d23a7e530b0c2df9840efa81cf0458b1fa5b`. Other worktrees and services were
preserved. Neither an older green OpenClaw commit nor a newer tip was substituted.

The selected tip's scheduled [CI run 39962152091](https://github.com/openclaw/openclaw/actions/runs/39962152091)
finished with 143 successful, 11 failed and 10 skipped jobs. Inspected failures
include dependency dead exports, Windows fixture cleanup, updater recovery and
triage assertions, scheduled continuation and subagent progress, Bun startup
admission and no-output timeout, subprocess teardown and sessions-send recovery.
The aggregate gate failed. The inspected successful fast push run
[39960580969](https://github.com/openclaw/openclaw/actions/runs/39960580969)
on `edaaab95243eea488901e74d062a661656c6effe` ran only security-fast and skipped
42 jobs. The inspected successful full scheduled run
[37419202402](https://github.com/openclaw/openclaw/actions/runs/37419202402)
qualifies `d8612ec864bb4c872616cfda5340c53803655f5f`, with 154 successes and
nine skips: Node 24 compatibility, PR fail-fast/check plan, Android/iOS
screenshots, alternate shared SDK, iOS release E2E and screenshot/seal evidence.
Those runs do not qualify this selected tip.

### Native adoption and retained boundaries

The previous overlay was recut with 14 conflict resolutions. Native
[#181198](https://github.com/openclaw/openclaw/pull/181198) now supplies the
pending inherited-auth owner and startup-publication behavior. The duplicate
pending-admission implementation, worker plumbing and test suite are removed;
current native refusals for an agent's own pending admission remain intact.
The earlier #180632 contribution is closed unmerged and superseded by that native
owner. Backup/checkpoint parser assertions follow the replacement native CLI
registration owner instead of restoring the deleted test file. Current config,
channel, PostgreSQL catalogs and worker inventory are generated by native owners.
State and agent schemas are both 31; protocol remains 4.

The operator-requested [#181676](https://github.com/openclaw/openclaw/pull/181676)
is retained as a local patch through exact head
`129decb43a183f10663c46880b765cead2f1659c`. Its initial recovery-hold fix
is cherry-picked as `c4d3d7bf054`, the Gateway-thread regression as
`32b7ef1f980`, and the cron-owner worker fix as `3474860ac35`.
Only the synchronous deletion-recovery-hold read is admitted on the Gateway
thread; effects and unrelated SQL remain outside admission. Cron schema and
owner-row inspection instead use two narrow modes of the existing cron
read-only worker. SQLite reads and authoritative owner checks are unchanged.
Real PostgreSQL and SQLite controls cover recovery holds, cron owners,
unchanged config after caller refusal, and unrelated SQL rejection before and
after the reads. The follow-up passes all 133 affected native cases.

The original hold-only build reproduced a second public `agents.create` refusal
during cron-owner inspection. The updated installed native Gateway now creates
an agent with every family on PostgreSQL, lists it, and lists it after a clean
Gateway restart, without a main-thread SQL refusal. This public flow passes on
the installed native Node 24 build and the complete Linux Node 26 image.
Current Octogee Shared and Builder writers still select SQLite state and PostgreSQL agent stores.
[#4700](https://github.com/octogee-ai/octogee/pull/4700) separately changes fresh
Builder allocations to PostgreSQL state and retains its TEST activation and pod
replacement acceptance gate. This artifact update does not deploy that change.
Remove the local patch when the selected native base supplies both narrow read
contracts and the public creation flow passes.

Authorization and membership remain source-owned boundaries: requester/reviewer
and execution-time authority, independent explicit grants, authoritative empty
membership revocation and account-bound delivery. Strict stop still joins retained
startup preparation before claiming success. Reload expiry/supersession, plugin
capture retirement, memory-shadow custody, durable cron handoff, offline detach,
checkpoint and retained-agent recovery keep their native owners and refusal
controls. The retained-boundary table below supplies individual gaps and removal
conditions; native configuration and Octogee adapters remain preferred over core
extensions. Detach #178755, auth startup #178970, checkpoint #178973, reload
#177823 and #167431, and credential recovery #180345 remain open. Contribution
status alone is not a retention decision.

### Artifacts and qualification

Both write-once objects are in `gs://octogee-openclaw-fork/`. Generation-specific
readback matches full SHA256, size and original bytes.

| Package | Object and generation | Bytes | SHA256 |
| --- | --- | ---: | --- |
| root | `openclaw-fork-36bc77db.tgz#1792771184235002` | 122465183 | `36bc77dbcec128d332e5c8159551bd40456b76e68ba0316a2ddb552e8b094e44` |
| mattermost | `openclaw-mattermost-ef7e6074.tgz#1792766326593830` | 1258422 | `ef7e60741f3b5978ee43435623b88964a23596d67b02b57923555147671497f9` |

Pinned pnpm 12.15.0 with the frozen lockfile, production core/UI/extensions types,
applicable native test types, generated metadata/catalog checks, worker and dialect
ratchets, mock/export and line-cap guards, changed-file lint/format and native
import-cycle checks pass. The final full `pnpm build` passes with build-info
matching the clean source above. Aggregate `pnpm check` is **not claimed**: its
preflight and type lanes passed, but the broad lint run was interrupted after
813 seconds; final file-scoped lint completed separately. No ratchet or budget
was relaxed.

The initial recut's broad affected native run produced 1,989 passes, five fixture
failures and eight skips. Focused reruns repair all five failures: the desktop
fixture uses the native managed-desktop factory, queued-open authority tests signal their actual
queue barrier, and interactive browser recovery accounts for responsive remounts
while preserving exact credential assertions. Final desktop and creation consumer
runs pass 96 cases; queued-open passes both live/revoked cases; browser recovery
passes all four cases. PostgreSQL credential, retained-agent CLI, checkpoint and
native inherited-auth checks pass ten cases. Offline CLI PostgreSQL detach passes
its native timeout on rerun; the earlier timeout remains failed evidence. The
additional PostgreSQL hold/admission regression passes. The follow-up's 133
affected cases and real public creation/restart proof close the earlier
PostgreSQL-state cron-owner failure.

The unchanged Mattermost archive was repacked from this build and matches its
existing object in full; that write-once generation is reused. Sequential
root/Mattermost packers, native tarball inventory/import-graph checks
and an isolated strict npm 12.2.0 install pass. Installed build-info matches
source; all 873 Mattermost files match the archive. The actual Linux AMD64
full-plugin installer passes fresh registry/trust, Parallel's nine-file match,
Codex's 188-file match, all three native-hook imports and installed CUA artifact
validation. The unchanged locked CUA build/test stages reuse matching cache.
Hosted islands regenerate from this source; the Computer alias follows the
native Solid entry after upstream removed its one-line facade. The coexistence
fixture now exposes FontFaceSet's event interface. App production types and
185 native-island consumer cases pass, including the repaired coexistence case.
The follow-up regenerates identical runtime bytes with updated source provenance.

The complete Linux AMD64 Gateway image passes provisioner types, extension
imports, installed runtime dependencies and the full runtime-image gate. Both
Shared and Builder configurations are materialized through their real roster,
policy, invariant, broker-catalog and pre-boot writers from the current Octogee
main above. Fresh UID1000 containers use read-only roots, tmpfs state and an
internal-only PostgreSQL network. Native validation and Doctor exit zero;
strict comparisons preserve every authored setting and all three complete
per-agent broker catalogs. Only individually checked native defaults and
version/migration/timed Doctor bookkeeping change. Negative controls reject
policy, plugin, roster and model-catalog drift.

Configured plugins load, explicit opt-outs remain disabled, Codex retains bundled
trust and its three native-hook imports pass in both configurations. Installed
Linux Memory file listing/index reads and Skills instruction reads execute in
real subprocesses and exit cleanly. Unchanged app and Gateway-edge runtime
consumers retain the initial type and 185 island/63 edge case qualification.
The follow-up passes 97 artifact, license, runtime and pin contract cases. Doctor
retains offline model-context inspection diagnostics; provider/tool
or desktop execution, historical migration and live acceptance are not claimed.

The published qualification image is
`us-central1-docker.pkg.dev/octogee/octogee/gateway-refresh-qualification@sha256:26bb894203c661c9b52b5974f83ace96900806e70a1feda2cfdb81fea1dea424`.
Registry manifest/config hashes and a digest-addressed runtime readback verify
source `3474860ac35ee5e3f4a2d4cbe7e3e631ecbb0333` on Node 26.12.1. This is a
qualification image; the immutable main image family is built separately.

This qualification builds and publishes artifacts; it deploys no environment or
fleet. Final-head Octogee CI and the complete-image checks qualify merge. The
maintained Build main run produces its immutable image family separately.

## Previous October 21 refresh on frozen main 304cf4f6

The operator selected latest upstream main at the start of this refresh,
`304cf4f678c9cb09bc28d3c0652f363f8991ef9f`, for independent qualification.
It remains frozen. The final clean overlay is `b74ff0c433d355260925bda948f61ff4982ab657`, published
from `codex/octogee-refresh-304cf4f6` in the OpenClaw fork. Both package objects
and hosted islands come from that exact built source, version 2026.10.5.
The recut starts from current merged Octogee main `42264cac9f82b8a1c2e676adae45fd44eab054e2`
and its published overlay `127953fd7dacfbfb6438dce323dedad6b05a9f20`.
Primary checkouts and unrelated work were preserved.

The selected upstream [push CI run](https://github.com/openclaw/openclaw/actions/runs/39669784384)
completed successfully, but only `security-fast` ran; build and test jobs were
skipped. The inspected successful scheduled [full run](https://github.com/openclaw/openclaw/actions/runs/37419202402)
qualifies `d8612ec864bb4c872616cfda5340c53803655f5f`, not the selected source.
Its skips include Node 24 compatibility, PR fail-fast/check-plan,
Android/iOS screenshots, alternate shared SDK, iOS release E2E and evidence.
Neither an older green SHA nor a later moving tip was substituted.

### Native adoption and retained boundaries

Octogee adopts upstream's retirement of heartbeat configuration. Fresh coaches
receive the native 30-minute proactive `agentTurn` cron job through public
`cron.add`, with the native prompt, idle-only admission and empty-scratch
suppression. The declaration key makes incomplete provisioning retries converge;
completed customer reconciliation does not recreate a job the customer deleted.
The actual created Mattermost owner supplies the destination even when a reload
returns a stale snapshot. Explicit account plus `user:<id>` DM addressing keeps
delivery tenant-bound; the native global owner resolver cannot select a customer
on a shared gateway. This adapter requires no new OpenClaw seam or scheduler.

Both gateway templates, generated agents, safe defaults and the disabled Ops
config stop emitting retired heartbeat keys. Existing gateway schedules remain
under native Doctor/cron custody. Workspace import's temporary Doctor database
is not a schedule transfer: portable heartbeat evidence receives existing
`manual_review` disposition rather than being falsely reported applied or
written into runtime config. The importer now reads canonical keyed
`agents.entries` through its shared roster reader. Automations admits native
jobs through actual agent/session facts instead of heartbeat, skill-review or
memory-dreaming content fingerprints; foreign and ambiguous jobs remain hidden.

The overlay drops the duplicate cron-active helper and obsolete scratch-delete
assertion in favor of native owners. Native async-store composition, current
session-sharing authorization and target-record contracts, creator/recipient
preparation and broader cross-filesystem plugin-capture tests are adopted.
Hosted islands use the canonical connection-error owner, embed the native activity
atlas and preserve native Mermaid opaque-frame/classic-script isolation with
exact built external assets. Solid rc.16 license provenance follows its exact
published source commit; packaged MIT-License.txt notices remain mandatory.
Reset reply threading stays in the existing threading owner. The snapshot
sanitizer retains its native operation-scoped offline SQL classification after
extraction; no T1 allowance, ratchet budget or database schema is relaxed.
Canonical state schema **30**, agent schema **31** and protocol **4** are used.

The retained-boundary table in the previous assessment still supplies removal
conditions. This recut specifically rechecked:

- October 20 strict-stop: selected upstream still lacks the retained-startup
  preparation join condition. A retained cleanup owner with `starting` state
  must make strict stop refuse success until preparation actually settles.
- Channel-derived sharing versus independent explicit grants, authoritative
  empty-membership revocation and live requester/reviewer/Codex authorization.
- Identical/queued reload recovery, expired and superseded admission, held-root
  and plugin-capture cleanup, host recovery after worker retirement, and memory
  shadow creation-descriptor retirement.
- Non-destructive detach, durable cron migration custody, checkpoint restore,
  private snapshot sanitization and source/file custody. Native current-schema
  refusal tests preserve both surviving tables and exact source bytes.
- Scoped final-reply/plugin-instance observation, tenant-brokered voice, hosted
  identities and desktop requester boundaries. These remain product/security
  integrations; native Talk, Browser, Computer, storage and migration owners
  continue to own their behavior.

Contribution status is distinct from retention: detach #178755, auth startup
#178970, local checkpoint #178973, reload #177823 and #167431 remain open.
#177968 is closed unmerged; its broader native capture owner/tests are adopted
where equivalent. No merge outside this frozen base is claimed included.

### Artifacts and qualification

Both objects are in `gs://octogee-openclaw-fork/`. Generation-specific
downloads match the full SHA256, size and original bytes.

| Package | Object and generation | Bytes | SHA256 |
| --- | --- | ---: | --- |
| root | `openclaw-fork-04167f5c.tgz#1792618024417980` | 122092142 | `04167f5cd7be9f63c9ba440ef0fbe4520412cc6957aacc8120c04d47d1e81163` |
| mattermost | `openclaw-mattermost-48879970.tgz#1792618087297709` | 1251558 | `48879970eb9d8c941b5aba5763bf07fc00768b38951d33a5bb78aaf35494aaf3` |

The pinned pnpm 12.12.1 frozen install and full `pnpm build` passed. Installed
build metadata equals clean source HEAD. Production core/UI/extension types,
changed-scope lint/format, channel metadata, native line growth and worker
ratchets passed. Boundary tests cover the retained cases above; one Mac-only
cross-filesystem case skips because no distinct writable filesystem is present.
Aggregate `pnpm check` is not claimed: its max-lines suppression gate rejects
three UI files byte-identical to the selected upstream. No suppression or
budget was relaxed. Startup JS warns at 318.1 KiB against 318.0 KiB.

Sequential packers, Voice/Activity contracts, upstream tarball integrity and
isolated strict npm installation passed. Installed build-info matches the clean
source, all 873 Mattermost archive files match installed bytes, and the CLI runs.
The actual Linux AMD64 full-plugin installer passed CUA artifact validation,
native registry/bundled trust, Parallel's 9-file match, Codex's 186-file match and
three native-hook imports. The initial builder restart was a failed attempt;
only the completed resumed target is passing evidence.

The complete Gateway image identity, runtime gate and installed Shared/Builder
config/Doctor comparisons are recorded separately in the refresh PR. Local
AMD64 qualification runs under ARM64-host emulation. It does not identify an
immutable main release image; that family follows the maintained main build.

Octogee heartbeat provisioning/defaults, RPC response handling, import planning,
import service/UI, tenant automation access, base-image/preboot and refreshed
island consumers passed their focused tests and production typechecks.
The actual provisioner DTO passes this source's native cron schema, with
negative controls for retired/unknown fields. PR CI qualifies the committed
Octogee change separately. This is local build/package/config proof; provider
execution, live Gateway startup, historical migration and live acceptance are
not established. Merge produces an immutable main image family under the
maintained GitHub Actions build workflow. This refresh deploys no environment,
mutates no fleet and constructs no desktop image. Current main has retired
`cloudbuild-base.yaml`; current Dockerfiles, package pins and Actions inputs
are the maintained build path.

## Previous published PostgreSQL handoff and local recovery

The common source is `127953fd7dacfbfb6438dce323dedad6b05a9f20`.
Shared, Builder and native computer images consume this same pin. It retains
the native auth startup correction and local Gateway checkpoint command and
fixes the failures observed during rollout:

- Checkpoint restore no longer compares a prepared SQLite file's device number
  with its containing directory's. gVisor reports different values for them.
  Exact file/path custody checks remain; required atomic hard-link publication
  enforces the filesystem boundary, with no cross-volume copy fallback.
- The SQLite copy owner admits a byte copy when its clone-only attempt encounters
  fs-safe's typed no-replace capability refusal. It reuses fs-safe's guarded,
  non-overwriting copy path, preserving source identity, space admission and
  post-publication/cleanup refusals. No filesystem policy is disabled.
- Non-destructive `agents.detach` retains cron jobs and their scheduler hold.
  The existing cron migration owner exports/stages jobs and retires source jobs
  after cutover, or resumes them after source adoption on rollback. Detached
  agents cannot run those jobs. Ordinary agent deletion still prunes them.

These changes are contributed upstream in
[detach #178755](https://github.com/openclaw/openclaw/pull/178755),
[auth startup #178970](https://github.com/openclaw/openclaw/pull/178970), and
[local checkpoint draft #178973](https://github.com/openclaw/openclaw/pull/178973).
The checkpoint's storage/public CLI design awaits maintainer acceptance in
[proposal #178971](https://github.com/openclaw/openclaw/issues/178971). Remove each
overlay addition when the selected upstream supplies equivalent behavior and
its boundary regressions pass.

Local checkpoints use native capture/restore and matched-client receipt owners
to preserve Gateway-global SQLite, device identity/pairing credentials and
configured PostgreSQL anchors. PostgreSQL history stays in its store; provider
SecretRefs stay external. Restore requires offline custody, original configured
paths and fresh database targets. The native owner creates missing private
parents; its non-observing config reader preserves target freshness. The global
snapshot sanitizer excludes pending outbound delivery intent. Ordinary full
backup behavior is unchanged.

The overlay fixes passed fresh independent P0/P1 review. The copy fix passed
15 copy-owner, two prepared-volume and 19 restore-consumer cases, core types,
targeted lint and formatting. One process-visibility case required host access.
The earlier snapshot and detach fixes retain their qualified proofs below. The snapshot fix passed all
46 focused publication/restore/checkpoint consumer cases, core types and targeted
lint. The real installed CLI restored the actual failing five-image checkpoint
and original PostgreSQL anchor in isolated gVisor, offline as UID1000, while the
file/directory device numbers were 34/36. No PostgreSQL connection was made.
The detach regression passed three real Gateway cases, including held/unheld
jobs, source execution refusal before/after restart, adoption, transcript
continuity and ordinary deletion; core types, lint and formatting passed.

The final common source passed the full guarded native build, maintained
sequential packers, voice/activity SDK contracts and native package integrity.
Aggregate `pnpm check` remains unclaimed because of the inherited UI suppression
ratchet described below. The actual Linux full-plugin installer passed registry,
source-match and all three native Codex hook gates. Its installed public CLI,
offline as UID1000, passed capture, empty same-path root restore, recapture and
existing-target refusal. This pair proof initializes no PostgreSQL anchors;
the separate gVisor proof covers an existing anchor. Live handoff and new-pod
recovery remain rollout verification steps.

The root archive is 120511752 bytes, SHA256
`872fcc65f01225e9d8e2a3302307b65da1ad7c326e5268837065ea3dfb23def8`,
object `openclaw-fork-872fcc65.tgz`, generation `1792602991090858`.
Mattermost is 1258484 bytes, SHA256
`b48dcdf91685c9760fc566fc33076e9c2e909f6d3726f6b89140f12ad4178c34`,
object `openclaw-mattermost-b48dcdf9.tgz`, generation `1792603006360414`.
Complete hashes are checked by
generation-specific readback. Hosted islands and browser resources were
regenerated from the same clean, built source; native UI inputs are unchanged.
Octogee retains its assignment, drain and native admission checks without
requiring equal OpenClaw commit hashes between Gateways.

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
[CUA 0.36.0 tag](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.36.0),
exact source `6d6c734c127025fb39ad5d585a10382808b39dc1`, with
`cua-desktop-discovery.patch`. The published modifier fix is already present,
so the older modifier-only fork is not used. Rust and the other CLI/tool pins
remain unchanged.

The sparse checkout also includes `libs/cua/Cargo.toml` and
`libs/cua/crates/cua-telemetry`, the 0.36.0 driver's existing path dependency.
The selected revision's Cargo lockfile, dependency features and test gates remain
unchanged; the recipe does not fetch the rest of the CUA workspace.

The 0.36.0 `GetAccessibilityTreeTool` still discovers only X11 windows. The
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

The installer requires matching 0.36.0 installed JavaScript bindings, native
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

The upstream discovery contribution [CUA #5286](https://github.com/trycua/cua/pull/5286)
is closed unmerged. Selected 0.36.0 still lacks the required discovery behavior;
contribution status does not qualify or replace this pinned package/library pair.
Exact-pair architecture qualification is recorded in the current assessment above.
Real Wayland-session qualification remains separate from headless checks.

## Vendored computer-use skills

`infra/gateway/cua-skills/` holds the `cua-driver` skill adapted from CUA's
0.36.0 skill pack
([`6d6c734c`](https://github.com/trycua/cua/tree/6d6c734c127025fb39ad5d585a10382808b39dc1/libs/cua-driver/rust/Skills/cua-driver))
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
