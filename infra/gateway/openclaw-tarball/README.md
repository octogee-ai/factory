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

## Current overlay: November 2 Shared worker retirement fix

This refresh freezes OpenClaw main at
`adabd2b4b1e9607047925e50b59959b4245415c2`, 495 commits after the previous
`ddd4d963854581a9890c00847e807ccff9e32f10` base. The operator selected today's
updated main for independent qualification. Subsequent upstream commits do not
change this build's input.

The clean built overlay is `3d3422eeddc04e1dd5e9cdba64a351b079871379` on
`ceckert/openclaw:codex/gateway-refresh-20261102-worker`. Gateway archives and
hosted islands come from that same source.

The selected tip's [push CI run](https://github.com/openclaw/openclaw/actions/runs/41491531110)
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

### Qualification and publication

Pinned pnpm 12.15.0 and the frozen lockfile built the clean source with full
`pnpm build package`; `dist/build-info.json.commit` matches the source SHA above.
Root and Mattermost were packed sequentially with the maintained packers from a
clean recipe snapshot. Both prepack/postpack lifecycles restored clean source.
Native root archive preflight, inventory and dist import-graph checks pass.

All production type lanes, scoped native lint, formatting, channel metadata,
worker inventory and config baseline checks pass. The selected native scope
passes 414 tests across worker leases, reload, sharing, authorization, voice,
Doctor/copy and outbound delivery, plus 47 UI controls. Removing only the new
ordinary-retirement guard reproduces the exact reported retiring-with-live-actor
error; all 19 worker controls pass with it restored.

The retained `server-reload-hot.superseded-tail.test.ts` has eight managed-reloader
timeouts followed by stalled cleanup. The first case also times out on exact old
`71ac89f`; it is an inherited validation gap. No assertions or timeouts were
weakened, and aggregate `pnpm check` success is not claimed. Native build budgets
also report advisory CSS (312.1 KiB against 302.1 KiB) and chat boot JavaScript
(1251.1 KiB against 1250 KiB) overages; budgets remain unchanged.

The actual Linux amd64 `openclaw-full-plugin-installer` target passes CUA driver
artifact lint, `config.changed` publication, source-matched Parallel and Codex
installation, registry refresh and all three native-hook imports. An isolated,
network-disabled installed Gateway accepts two concurrent `agents.create` calls
and then `secrets.reload` with zero warnings, without model/provider requests.
All twelve Octogee extension bundles load against this installed SDK. Both raw
Shared/Builder templates and generated configs from their final roster/pre-boot
writers pass native validation. Skill Workshop policy now uses its canonical
plugin config: Shared retains autonomous mode off and Builder retains its native
capability. The retired `skills.workshop` writer is removed.

The executable SQL catalog was regenerated against this exact source with
PostgreSQL 16/vector 0.8.7: all 11 routine, 15 trigger and 308 expression
fingerprints are unchanged; only its source SHA changes. All 48 PostgreSQL
import/recovery/handoff integration tests pass. Hosted islands and Browser
resources are regenerated from this build; 196 focused app checks and 39
runtime/license/pin checks pass.

The source branch is published to the fork. The root archive is a new write-once
object; the byte-identical Mattermost companion reuses its existing generation.
Full SHA256 readback of both exact published generations is verified.

| Package | Write-once object and generation | Bytes | SHA256 |
| --- | --- | ---: | --- |
| root | `openclaw-fork-b912698c.tgz#1793643777466672` | 116066361 | `b912698c24e85fcb0a3d0c8e0e99e56bbc0d77b9e7b067d1fa1f2943e96684d1` |
| mattermost | `openclaw-mattermost-6758b57d.tgz#1793554855718230` | 1266404 | `6758b57de1fbac9d7b29602537306266b024096874c945c5185fa0eab96a53ef` |

This qualification covers the installed base runtime and its consumers. Full
platform images and deployed TEST smoke remain separate Build main/Ship TEST
steps. No deployment, live restart or fleet desired-state mutation was performed.

### Upstream contributions

#189036 and #189418 had successful enforced checks at their reviewed heads and
remain open for maintainer review. #177823 is closed unmerged after native
adoption of its original bug fix; the remaining optional guard is retired from
the runtime. #167431's code checks passed but
maintainer approval is still required. #186891 (`1d18f8eb784`) and #186893 (`d4fd7a5c5de`) have been
refreshed and published with current-main conflicts resolved and native ratchets
passing; their prior live evidence is labeled separately from refreshed-head
checks. #178755 (`d576caa76fe`) is refreshed and ready for maintainer review for
the active non-destructive detach consumer; downstream-only held cron tests/docs
have been removed from its upstream proof. Hosted final-head checks remain
separate from local readiness. #178973 is closed unmerged
because its mixed-engine consumer was retired, not because native adopted its
API unchanged. Earlier superseded PostgreSQL PRs remain closed/merged as already
recorded in repository history. Contribution status never substitutes for runtime
necessity or image qualification.

## Native CUA desktop-discovery preservation

`Dockerfile.cua-driver` builds the Linux SDK from the official
[CUA 0.37.0 tag](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.37.0),
exact source `2d2f99228d4d2508dc6fcc84c176b296e146714a`, with
`cua-desktop-discovery.patch`, into the `octogee-cua-driver:inputs-<hash>`
image keyed by that Dockerfile and patch. `Dockerfile.base` consumes it as the
`cua-driver-builder` stage through the `CUA_DRIVER_IMAGE` build context, so a
base rebuild for any other reason reuses the compiled driver. The published modifier fix is already present,
so the older modifier-only fork is not used. Rust and the other CLI/tool pins
remain unchanged.

The sparse checkout also includes `libs/cua/Cargo.toml` and
`libs/cua/crates/cua-telemetry`, the 0.37.0 driver's only external path dependency.
The selected revision's Cargo lockfile, dependency features and test gates remain
unchanged; the recipe does not fetch the rest of the CUA workspace.

The 0.37.0 `GetAccessibilityTreeTool` still discovers only X11 windows: the two
files the patch changes are byte-identical between 0.36.0 and 0.37.0, whose Linux
changes are confined to input, pointer shape and X11. The patch applies unchanged. The
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
architectures, dynamic loading and the installed driver artifact check; 0.36.0
build results do not qualify this pair.

The installer requires matching 0.37.0 installed JavaScript bindings, native
package, plugin dependency and patch metadata, the exact official source/tag,
and a patch digest. It first validates the original SDK against OpenClaw's
native artifact manifest, then replaces only that architecture's SDK digest in
the plugin and its single compiled manifest. It finds that compiled module by the
same bundled-module labels native's own region reader accepts: the stable
`//#region` form and the qualified module-ID labels that the tsdown 0.23.2 /
Rolldown output adopted by native #188576 emits. Other binary/platform pins remain
unchanged. `octogee-patch.json` records the source, patch and installed library
digest. The CUA Dockerfile and patch remain immutable base-fingerprint inputs,
so a driver change still rebuilds the base.

OpenClaw owns the matched dependency/lock/artifact pins; Octogee owns this
discovery preservation and adapted skills. Remove the builder and installer
overlay only when the selected published package preserves the same
Wayland/visible/live/origin/canonical-record boundaries and passes matched
artifact and desktop qualification. A version bump or modifier fix alone does
not meet that removal condition.

The upstream discovery contribution [CUA #5286](https://github.com/trycua/cua/pull/5286)
is closed unmerged. Selected 0.37.0 still lacks the required discovery behavior;
contribution status does not qualify or replace this pinned package/library pair.
The actual Linux amd64 installer qualifies the unchanged exact driver/source
pair for this package set. Complete-image results belong in the runtime PR; a
new ARM64 or real Wayland-session run is not claimed by this refresh.

## Vendored computer-use skills

`infra/gateway/cua-skills/` holds the `cua-driver` skill adapted from CUA's
0.37.0 skill pack
([`2d2f9922`](https://github.com/trycua/cua/tree/2d2f99228d4d2508dc6fcc84c176b296e146714a/libs/cua-driver/rust/Skills/cua-driver))
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
management. CUA's browser guide is replaced by the `browser` tool. The 0.37.0
re-adaptation changes only the version: its new macOS install/permission
guidance, recovery-hint (`hint`/`next_call`) refusal row and `get_guide` MCP tool
have no counterpart in the managed `computer` tool, and its `LINUX.md` change is
qualification wording.

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
