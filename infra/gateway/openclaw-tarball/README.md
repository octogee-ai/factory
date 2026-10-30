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

## Current overlay: October 30 frozen main

This refresh freezes the selected OpenClaw main snapshot at
`4591070b2f4b1b043b57c306fcd6d235e56b04a2`. It independently qualifies that exact
tip without substituting an older green commit or following newer commits. The
clean overlay is [`471d2fdce16ab055ed2e766126a1c4757773f90f`](https://github.com/ceckert/openclaw/commit/471d2fdce16ab055ed2e766126a1c4757773f90f)
on `codex/gateway-refresh-20261030`: the reassessed overlay recut
`8dd1e43ff08c263ea2cf161a82eb97b7cc6368df`, including the PostgreSQL Talk fix
from upstream PR #188580, followed by the account-addition reload repair below.
The two Mattermost contributions, Octogee Doctor option and provider-qualified
runtime-policy fix remain only for the stated consumer contracts.

The selected tip's [push CI](https://github.com/openclaw/openclaw/actions/runs/41099206021)
was cancelled and supplies no runtime qualification. The
most recent successful [full scheduled CI](https://github.com/openclaw/openclaw/actions/runs/37419202402)
is older `d8612ec864bb4c872616cfda5340c53803655f5f`: 154 jobs pass and nine skip.
Those skips are Node24 compatibility, PR fail-fast, Android screenshots, check
plan, iOS device-family screenshots, the conditional additional-extension/shared
SDK declaration job, iOS release E2E, iOS screenshot evidence and full-release
child evidence sealing. Those results do not qualify the selected tip.

### Native adoption and overlay reassessment

Native [#186296](https://github.com/openclaw/openclaw/pull/186296), commit
`c8a753a0a4df2dbdba73a1a4b52187800c497950`, supersedes #182783 and owns session-list
provider replacement, current-catalog preparation, supersession and independent
reader cancellation. All seven corresponding production/test files now match the
selected native base exactly. The separate configuration-reload settlement and
waiting-root boundaries remain; they protect different work.

Native [#188350](https://github.com/openclaw/openclaw/pull/188350), landed as
`76ba4650f082a3f4d1189b45807f4a977fc03ca9` in the selected base, supersedes the
closed, unmerged [#181951](https://github.com/openclaw/openclaw/pull/181951).
Its retained-store admission and anchor-publication owners replace the duplicate
fork guard for unconfigured PostgreSQL agents. That guard is dropped. The
separate configured-agent detach/reattach handoff remains under its existing
custody contract; it is not restored as a competing creation or schema owner.

The recut preserves native inbound-context composition and the new channel-start
deferral owner. Requester identity follows native's extracted reply-authority
snapshot, which now retains the live authenticated resolver through queued
steering. Native #185730 retired restart recovery reconstruction; the obsolete
fork-only queued restart-flag test is removed rather than reviving that path.

Native inline bare-reset threading now owns the equivalent behavior, so the
redundant fork helper is removed. The requester identity extension follows
native's extracted `hook-tool-context.types.ts` owner; the standalone requester
type and duplicate export are removed. The live authenticated-identity resolver
remains because static sender metadata cannot express revocation. Native's new
hook trigger metadata, captured account-restart owner, subscription-root
semantics, Mattermost bot-loop protection and Template names are preserved.
GLOBAL36 and AGENT38 are native's canonical schemas; protocol remains 4.

The reclamation decision cap returns to native's five seconds. The previous
six-second control injected a delay; it did not measure a production cold path
and does not justify a ten-second allowance. Worker-visible monotonic deadline,
remaining-request budget, cancellation and late-authorization refusal remain.
The test now proves over-cap refusal. Test-only MCP cleanup differences and the
Dashboard panel-control type extraction are removed. Dashboard history-derived
participant labels remain an optional active presentation feature in the full
native iframe. Moving that header into the current unrelated island bundles
would not adapt its actual consumer.

Fresh independent source/consumer review covered the resolved recut and its
high-risk native integrations; the subsequent backup-helper extraction and
account-reload repair received their own scoped review. Those reviews found no
actionable P0–P2 findings in their reviewed snapshots. This is separate from
runtime qualification. It does not certify
that every retained line is unconditionally necessary: active product features
can be retired or adapted, and retained old cron/state formats depend on the
supported restore/move input contract. No deployed old-format inventory was
inspected; do not cite historical fixtures alone as evidence of such inventory.
Those readers remain bounded by exact recognized schemas and refusal of unknown
partial state while their recovery contract remains supported.

The hosted adapter now follows native Pele asset names and URL imports instead
of the retired Mermaid engine entry. Source-map custody, exact frame bytes and
opaque-iframe ownership remain checked; the generated native engine renders a
real diagram in the retained runtime regression. Native deletion-journal
coverage absorbs the duplicate fork test fixture while keeping distinct detach
phase, stale-owner and durable-completion assertions. The retained-custody
schema input now has its missing generated catalog: two table descriptors and
one fingerprint, with no canonical SQLite or PostgreSQL DDL change. Historical
fixtures use native Template/version restoration; all 36 retained recovery
controls pass.

### Carried Mattermost channel contributions

Two open upstream contributions are carried on the frozen base:
[#186891](https://github.com/openclaw/openclaw/pull/186891) (inbound
parity: acknowledgement reactions, channel system events, join introductions
and compact tool progress) and [#186893](https://github.com/openclaw/openclaw/pull/186893)
(message actions and multi-file sends). They are approved Builder channel
behavior that the current Mattermost pre-boot defaults already select, not a
reproduced native bug and not a fork-only API; Octogee consumers use only the
public Mattermost configuration they add. The recut adapts their behavior to
the selected native owners instead of replacing newer native code wholesale.
Its housekeeping includes the bundled channel
metadata and config-doc baseline regenerated for the new schema keys, and the
`SAFETY`/`mock-isolation` notes plus pruned assertion baseline that the
preflight ratchets require. Remove each
family when the selected base contains the merged behavior and the Mattermost
consumer controls pass; an open PR or a newer main containing it is not enough.

### PostgreSQL native voice startup

The selected unpatched main still opens the Talk session-entry database on the
Gateway thread. The real PostgreSQL regression fails with `PostgreSQL connections
must run in a worker`; SQLite passes. Upstream
[#188580](https://github.com/openclaw/openclaw/pull/188580), head
`8a727467c3e7670ec8a2e86a3c8ef5ad7b4523e1`, is open and its fix is carried here.
Talk now prepares through its existing worker and consumes the published
physical source; the public SDK's opaque-guard path retains native database
adoption. Configuration, schemas, session identity and authority checks stay
with their native owners. An Octogee voice transport override would not repair
this canonical session-entry defect.

Both PostgreSQL and SQLite creation/resumption regressions and 54 Talk siblings
pass. A separate full build at the upstream PR head also passed a real,
authenticated Gateway WebSocket flow against disposable PostgreSQL: two public
Talk create/audio/close calls, persisted public history, and exactly one
canonical session row after shutdown. The bundled OpenAI adapter used a loopback
provider protocol fixture with synthetic PCM and no external provider requests;
this proves transport and storage, not speech recognition or TTS quality.
The [posted proof](https://github.com/openclaw/openclaw/pull/188580#issuecomment-6529979391)
names that exact head. ClawSweeper's
[latest review](https://github.com/openclaw/openclaw/pull/188580#issuecomment-6529879820)
accepts that evidence and reports no actionable findings or before-merge work;
upstream maintainer review is still pending. Remove the overlay when the selected
base contains equivalent worker-owned initialization and these controls pass.

### New channel-account reload

Adding a project account could wait for unrelated admitted Gateway work even
though no existing account needed restarting. The managed-writer regression is
red on the preceding recut and green with the repair from coordinated source
`4d2d2f47d96a7814656709571050a503259cf5fc`, applied as final source
`471d2fdce16ab055ed2e766126a1c4757773f90f`. The reload owner captures the previous
runtime config before any publication. Only new/removal-only account targets
skip the global drain, after resolving every added account successfully.
Existing affected accounts and whole-channel restarts retain their drain;
resolution failures retain it because the later fallback can widen the restart.
The real managed write/channel-manager path proves the new account starts while
siblings and unrelated admitted work remain active; 269 current owner controls
pass, including the failing-resolution negative control. This belongs in the
native reload owner, not a caller-side retry. Remove it when the selected native
base provides the same scoped behavior and controls pass.

### Provider-qualified runtime policies

Octogee's writers also declare configured platform broker providers through
Native's existing `{ baseUrl, models: [] }` configuration. Pre-boot, class policy
and customer projection share the same environment-owned declarations; Dashboard
write validation receives those trusted endpoints for both gateway classes.
Provider API selection, complete model rows and credentials remain agent-local.
The declaration omits `api` because setting it globally changes an existing
agent's transport. Native inspection controls reduce 295 unknown-provider and
four selected-model-context findings to zero while preserving both providers'
full runtime model metadata. This adapts Octogee's configuration writer rather
than changing Native Doctor or duplicating the model catalog.

The TEST coach selected `platform-openrouter/openai/gpt-5.6-luna`, but Native
matched its nested model ID against the direct `openai/gpt-5.6-luna` Codex policy
and rejected the request. Compare the policy provider before matching the model
ID. The regression preserves direct OpenAI Codex selection and broker model
selection without changing credentials or customer preferences. This belongs in
Native's policy resolver; an Octogee override would hide the routing defect.
Remove this overlay when the selected Native base has equivalent provider-bound
matching. The fix is carried in the Octogee artifact; no upstream PR is open.

### Octogee migration Doctor option

`doctor --skip-recovery-backups` skips original-state capture, migration recovery
backup preparation, and diagnostic PostgreSQL readiness inventory. Octogee uses
it only for a private import under its existing source fence and target custody.
Native still owns migrations, maintenance admission, leases, identity validation
and transactions. A nonzero fast attempt retries ordinary Doctor while custody
remains valid; cancellation and lost custody stop the operation. Ordinary Doctor
behavior is unchanged.

Instrumented local PostgreSQL upgrades showed substantial time in original-state
capture and diagnostic inventory, while the actual schema transition was short.
The CLI option belongs in Native because an Octogee caller cannot select those
internal Doctor phases. This is an operator-requested Octogee-only optimization,
not an upstream contribution. Remove the overlay if Native supplies an equivalent
public migration path with the same safety boundaries.

### Retained boundaries and removal conditions

Retention decisions distinguish reproduced bugs from approved optional product
behavior. An open contribution or an existing fork-only consumer is not itself
proof of necessity. A merged upstream PR removes an overlay only when equivalent
behavior is present in the selected base and the affected consumer controls pass.

| Family | Native gap or approved behavior; why the owner is here | Remove when |
| --- | --- | --- |
| Requester identity and single approval reviewer | Public requester facts must survive queued/follow-up execution; one reviewer and live client authority must remain valid through the final native/Codex continuation. An adapter cannot own core effect admission. | Native public propagation, single capture and revocation semantics pass delayed/held continuation controls. |
| Channel membership sync and disclosure | Native now owns invitation-only and linked-session membership filtering. Octogee retains its approved `none`-policy channel-member access, authoritative empty-set sync, explicit-grant precedence and publication invalidation; invitation-only visibility does not replace that mutation contract. Native prepared membership facts replace the overlay target lookup callbacks. | Native authoritative membership methods and read/projection owners provide equivalent revocation and incarnation checks. |
| Mattermost channel session scope | Approved `threadSessionScope: channel` keeps one session per channel while preserving reply roots in both directions. Current writers deliberately select this product behavior. | Native supports that option, or the product explicitly adopts thread sessions and adapts membership/consumers. |
| Channel startup and strict stop | Channel startup must not borrow invoking identity; strict stop joins startup and running work, retains physical cleanup ownership, and retires only removed accounts. | Native proves hung-startup joins, late-stop retry and active-sibling preservation. |
| Reload admission, supersession and settlement | Scoped reference-counted waiting roots, supersession wakeups and model/service debt prevent dropped work or a falsely settled baseline. New/removal-only account changes avoid unrelated global drain after successful resolution; affected existing accounts and widening fallbacks retain it. Native subscription exclusions, synchronous and post-wait checkpoints remain. The separate session-list provider-reload fix is entirely native. | Native owns equivalent scoped-account, held-root, late-join, superseded-tail and post-commit settlement behavior. |
| Lifecycle lease and reclamation deadline | One monotonic worker-visible budget prevents late commits. Native's five-second cap is preserved; the overlay carries one worker-visible monotonic deadline and refuses late authorization. | Native carries the same worker-visible absolute deadline and refuses cancelled, expired and late authorization, or the relevant lifecycle consumer is retired. |
| Detach, reattach and retained PostgreSQL | Approved configured-agent transfer retains original logical/physical identity under native creation/deletion custody; missing PG anchors must refuse rather than create. Native #188350 owns unconfigured retained-store creation admission; its duplicate overlay is removed. | Native public transfer preserves namespace/history and rollback/recovery custody, or a supported migration owner replaces it. |
| Outbound delivery custody | Retirement refuses unfinished authoritative delivery state and fences racing enqueue across all affected agent identities; empty caches are insufficient. | Native detach/deletion fences the same queue and retains idempotent receipts. |
| Local checkpoint and credential snapshots | Native backup/restore owners publish paired SQLite state exclusively into fresh targets; PG agents retain anchors, not fictional remote rollback. Installation authority is sanitized. | Native public checkpoint supplies equivalent paired-state, no-replace and retained-PG guarantees, or the authorized recovery consumer is removed. |
| Cron migration custody | Held/exported/staged/activated ownership, retired fences, hash-bound chunks and drain are beyond ordinary native CRUD. Projection identity includes effective agent plus declaration. | Native migration provides equivalent activation, rollback, drain and two-engine round trip. |
| Retained legacy cron/state inputs | Fingerprints/order/schema checks admit only recognized retained formats and refuse unknown partial schemas; native canonical schemas remain authoritative. | The supported retained restore/move inputs are retired, or native adopts their exact migration. Historical fixtures alone do not prove a deployed inventory; no deployed old-format inventory was inspected in this recut. |
| PostgreSQL web-secret index reads | Cold GLOBAL state makes native's synchronous installed-index read fail during Builder `secrets.reload`; the existing async reader owns worker access and validation. | Native awaits the worker-backed reader here and the same cold-GLOBAL/provider conformance control passes without this overlay. |
| PostgreSQL cron enabled JSON | Native's SQLite JSON-value assumption fails PG bound enabled updates; the codec uses each engine's existing JSON expression. | Native equivalent passes both-engine false/true transitions without losing authored fields. |
| Memory shadow database retirement | Physical admission must retire before unlinking shadow files, preventing writes through live descriptors. | Native owns equivalent descriptor/late-owner retirement. |
| Voice relay and computer authority | Approved public broker transport retains native session/media ownership; desktop control release, observation/token lifetime and node execution remain bounded. | Native public contracts preserve transport validation, cancellation, fresh observation and late-dispatch refusal. |
| PostgreSQL Talk entry initialization | Reproduced native main-thread database open prevents canonical realtime voice startup. PR #188580 reuses the native execution worker while preserving opaque SDK adoption. | The selected native base contains equivalent behavior and PostgreSQL/SQLite plus public Talk controls pass. |
| Final-reply notification | Activity tools require terminal final-content classification, not agent-completion inference. Only the public observer flag is retained; delivery custody is native. | Native supplies equivalent classification or the observer is removed. |
| Dashboard participant labels | Current same-session history supplies a human label missing from native observation projection. This optional presentation is used by the embedded full native Dashboard, with no access/identity mutation; the current browser/computer/workbench islands do not own its header. | Native projects equivalent labels or the embedded native chat consumer is removed. |
| Dependency and npm packaging | Exact fast-uri/npm pins and the disposable npm distribution patch need installed-byte verification; version equality does not qualify nested dependencies. | Stock/native installed closures contain the fixes and the dependency gate passes. The expired fast-uri release-age exception is removed. |
| Generated schemas, inventories and test support | Describe retained APIs and canonical native owners, not independent features. | Regeneration after the owning feature's removal eliminates them. |

### Qualification and explicit limits

Pinned pnpm 12.15.0 and the frozen lockfile build the source with full
`pnpm build package`. The clean final source and `dist/build-info.json.commit`
both identify `471d2fdce16ab055ed2e766126a1c4757773f90f`; the sequential root and
Mattermost archives and regenerated hosted islands contain that build. App island
coexistence and consumer contracts pass (196 tests), with 24 license/runtime
controls. Pin coherence is checked against the same source SHA.

The aggregate check against explicit base `4591070` passes every preflight,
all 110 package-lock checks and production, scripts and root test typechecks,
then fails lint. Three owned lint findings were corrected and their scoped lint
passes. The remaining 15 errors are in files byte-identical to the frozen base;
there is no aggregate `pnpm check` success claim. The SQLite worker ratchet is
unchanged at 169 live calls against that base. Focused formatting and subsequent
policy checks are separate evidence, not a substitute aggregate result. The
earlier full overlay Mattermost run retained one macOS loopback-alias fixture
failure; it is not a demonstrated channel behavior failure or an all-suite pass.

Linux amd64 installed-package qualification passes on Node 26.13.0: all 871
Mattermost files and all 15 patched files in both npm roots match the prepared
archives. The actual `openclaw-full-plugin-installer` target also passes native
registry refresh, bundled trust, source-match verification of 188 Codex and 10
Parallel runtime files, and all three native-hook imports. Native source still
pins npm 12.2.1 and fast-uri 4.2.3. Stock npm's
nested closure does not replace the disposable distribution patch merely by
matching its version. Root Undici 8.12.3 is distinct from npm's nested patched
Undici 6.29.1 and ip-address 10.7.4. These installed-package and installer results
do not qualify complete Shared or Builder images. Complete-image config/runtime
acceptance is a separate gate before TEST shipment; its final-source results are
recorded in the runtime PR.

Complete-image qualification must materialize both classes through their real
policy/pre-boot/agent writers, validate before and after isolated Doctor, and
strictly compare semantics with negative controls. Do not translate default
config keys or hide model/provider warnings. Verify actual installed plugins,
native hooks, Memory/Skills workers, cold/retained Builder plugin roots and
no-network model resolution. Full Doctor stays off healthy boots; bounded
failed-boot recovery and driver-artifact checks remain. Arm64, live provider
inference, browser microphone/duplex/interruption and interactive desktop
acceptance are not claimed. The upstream PR-head synthetic Talk proof above is
separate from final Octogee TEST acceptance; building these artifacts deploys
neither TEST nor PROD.

| Package | Write-once object and generation | Bytes | SHA256 |
| --- | --- | ---: | --- |
| root | `openclaw-fork-f958d0ea.tgz#1793388147057652` | 129301061 | `f958d0eac50414f72f6e39ca0789a2cbe7b699e6c258abeaa84f2a607ee725d5` |
| mattermost | `openclaw-mattermost-e19347f5.tgz#1793388092260895` | 1272450 | `e19347f5e76a2d5050232766478f6d5a7410e49a5240175272ee1fca93f39a4b` |

Generation-bound readbacks reproduce both complete hashes above. Hash-addressed
objects are write-once. Complete-image qualification results and image digests
belong in the runtime PR against its final Octogee source SHA, outside this
recursive build input. Artifact publication alone does not qualify an image or
a deployment.

### Upstream contributions

#186891 (Mattermost inbound parity) and #186893 (Mattermost message actions)
are open and carried on this base as described above; remove each when the
selected base contains it. #178755 (detach) and #178973 (local checkpoint)
remain draft/open. #181951 (retained PG refusal) is closed unmerged and superseded
by merged #188350, present in this selected base; its duplicated guard is dropped.
#188580 (PostgreSQL Talk startup) remains open at the reviewed head above and is
carried pending native adoption. The account-addition reload repair is carried
from coordinated source `4d2d2f47`; no upstream PR is recorded for that repair.
#182783 is closed unmerged because merged #186296 adopted it into this selected base.
#178970 remains open but native #181198 already supersedes it. Previously adopted PostgreSQL recovery, cache,
catalog and plugin-preparation fixes are not reintroduced. The worker-backed
web-secret fix has not been submitted upstream. Contribution status is separate
from necessity and runtime qualification.

## Native CUA desktop-discovery preservation

`Dockerfile.cua-driver` builds the Linux SDK from the official
[CUA 0.36.0 tag](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.36.0),
exact source `6d6c734c127025fb39ad5d585a10382808b39dc1`, with
`cua-desktop-discovery.patch`, into the `octogee-cua-driver:inputs-<hash>`
image keyed by that Dockerfile and patch. `Dockerfile.base` consumes it as the
`cua-driver-builder` stage through the `CUA_DRIVER_IMAGE` build context, so a
base rebuild for any other reason reuses the compiled driver. The published modifier fix is already present,
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
digest. The CUA Dockerfile and patch remain immutable base-fingerprint inputs,
so a driver change still rebuilds the base.

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
