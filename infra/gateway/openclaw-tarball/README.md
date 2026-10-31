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

## Current overlay: October 31 main recut

This recut freezes OpenClaw main at `7f345d644b976af9d43264e6617aaacd4ed5f9a2`
(#189669), 530 commits after the previous `774e96e` base. The clean overlay is
`0c0b0183cc7ee78d1d64248a44299436a438dbd0` on `codex/gateway-refresh-20261031c`:
the October 30 overlay squash, the account-addition reload repair, the
Mattermost max-lines baseline prune, the new scheduled-requester patch below,
one regeneration commit (gateway protocol predicates, SQLite state catalogs,
bundled channel metadata and config-doc baseline) and one line-cap override. The
carried PostgreSQL voice consult fix and the previous metadata regeneration are
dropped.

The new base includes [#188397](https://github.com/openclaw/openclaw/pull/188397),
agent schema 38 to 39, which requires stopped-writer Doctor. The previous recut
excluded it for that reason. Octogee runs `openclaw doctor --fix
--non-interactive --skip-recovery-backups` on a release's first boot when the
installed build differs from `glmGateways/{id}.openclawHealthyBuild`
([Handbook 22](../../../docs/handbook/22-gateway-rollouts-cowboy.md)), so this
shipment exercises that path on every Builder and Shared gateway; TEST must
confirm each upgraded agent answers, not just that the Gateway reports ready.
Doctor's migration is one-way.

The base also includes [#189639](https://github.com/openclaw/openclaw/pull/189639)
(`c89a101`), which replaced the closed #189587. Before it, Doctor's auth-profile
migration snapshotted the SQLite anchor of a PostgreSQL agent store and exited 1
with "Auth profile backup differs from the planned source" whenever the store
held a legacy alias such as `claude-cli:work`; that failure looped the PROD
Builder on October 31. `fbbcf0c`, the first candidate for this recut, predates
it. A local control seeds the same schema 38 PostgreSQL store with the pinned
`e10db5d` build and runs the upgrade Doctor with Octogee's flags: an `fbbcf0c`
overlay build migrates the schema but exits 1 and leaves the alias, while this
build exits 0, reaches schema 39 and rewrites the alias to `anthropic:work`
after saving its backup.

CI qualification is an operator-selected exception. Push CI on main runs only
`security-fast`; the full suite runs on schedule, and its most recent
all-green run is
[37419202402](https://github.com/openclaw/openclaw/actions/runs/37419202402) on
`d8612ec864bb4c872616cfda5340c53803655f5f` (October 6). The scheduled full run on
exactly this base,
[41234198377](https://github.com/openclaw/openclaw/actions/runs/41234198377),
passed 144 jobs and failed four: Control UI e2e shards 2/7
(`cloud-session-disk-space`) and 5/7 (`chat-pull-requests`),
`checks-windows-node-test-2` (`update-repair-handoff`) and the aggregate
`openclaw/ci-gate`. It skipped `check-plan`, `control-ui-i18n`,
`checks-node-compat-node24`, `shared-sdk-declarations`, the iOS/Android release
e2e and screenshot jobs, `pr-failure-report` and `Seal full release child
evidence`. None of the failures covers a Gateway, agent-store or channel path
Octogee runs; this tip is otherwise qualified by the results below.

### Line-cap override

The overlay's three gateway method rows (`sessions.channel.sync`,
`cron.migration`, `agents.detach`) put `src/gateway/methods/core-descriptors.ts`
at 701 counted lines against native's 700. `.oxlintrc.json` caps that one file
at 710. Splitting the rows into a sibling module would also need
`scripts/check-protocol-since.mts` and the `core-method-policy.ts` family type to
read a second table. Remove the override when those rows leave the overlay or
native splits the table.

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

Native [#188580](https://github.com/openclaw/openclaw/pull/188580), landed as
`74343d9fc66edc984fe751b3f101dda412e02410` in the selected base, owns
worker-backed Talk entry initialization. The carried copy is dropped: all seven
of its production, test-support and worker-registration files match the selected
base exactly, and its PostgreSQL/SQLite regression passes unchanged.

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

### Dropped: PostgreSQL voice agent consults

Upstream merged #188965 as `d21ccbd811ae9b8653d6b75f829da02039bd2a8a`, which is
in the selected base. Every carried production file is byte-identical to the
base; only the pre-merge test layout differed. The carried commit is dropped.

### Scheduled requester for plugin tools

Scheduled runs carry only the owner bit, so a plugin tool cannot tell whose job
is running. Octogee's connector tools (#4957) need the verified creator to read
an owner's Google data for a scheduled briefing delivered to that owner's DM.
`resolveCronScheduledRequester` exposes the job's stored authenticated channel
requester as a separate `scheduledRequester {channel, accountId, senderId, to}`
plugin-context field, never as `requesterSenderId`, and only for
account-policy jobs whose run delivers through the creator's own channel account
with a resolved target. Native has no equivalent field; an Octogee adapter
cannot reconstruct the creator because the plugin context carries no job
identity. Its three regressions fail on the unpatched source (8 provenance
cases, the plugin-context forward, the attempt projection) and pass with it.
Embedded delivery-route and scheduled-authority projection moved into sibling
modules so the patch adds no lines to the two capped files it touches. Not
submitted upstream. Remove it when native exposes an equivalent verified
scheduled-creator fact to plugin tools.

### New channel-account reload

Adding a project account could wait for unrelated admitted Gateway work even
though no existing account needed restarting. The managed-writer regression is
red on the preceding recut and green with the repair from coordinated source
`4d2d2f47d96a7814656709571050a503259cf5fc`, carried in this overlay as
`6dc2946a5e8d28103f91ad2fb05ab89dc032e15a`. The reload owner captures the previous
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
| Requester identity and single approval reviewer | Public requester facts must survive queued/follow-up execution; one reviewer and live client authority must remain valid through the final native/Codex continuation. Scheduled runs expose the verified job creator as a separate `scheduledRequester` only when delivery uses the creator's own channel account. An adapter cannot own core effect admission or reconstruct the job creator. | Native public propagation, single capture and revocation semantics pass delayed/held continuation controls, and native exposes an equivalent verified scheduled-creator fact. |
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
| Final-reply notification | Activity tools require terminal final-content classification, not agent-completion inference. Only the public observer flag is retained; delivery custody is native. | Native supplies equivalent classification or the observer is removed. |
| Dashboard participant labels | Current same-session history supplies a human label missing from native observation projection. This optional presentation is used by the embedded full native Dashboard, with no access/identity mutation; the current browser/computer/workbench islands do not own its header. | Native projects equivalent labels or the embedded native chat consumer is removed. |
| Dependency and npm packaging | Exact fast-uri/npm pins and the disposable npm distribution patch need installed-byte verification; version equality does not qualify nested dependencies. | Stock/native installed closures contain the fixes and the dependency gate passes. The expired fast-uri release-age exception is removed. |
| Generated schemas, inventories and test support | Describe retained APIs and canonical native owners, not independent features. | Regeneration after the owning feature's removal eliminates them. |

### Qualification and explicit limits

Pinned pnpm 12.15.0, Node 26.12.1 (toolchain npm 11.20.0) and the frozen
lockfile built the source with full `pnpm build package` on a 10-CPU, 32 GB
macOS host. The clean final source and `dist/build-info.json.commit` both
identify `0c0b0183cc7ee78d1d64248a44299436a438dbd0`. The sequential root and
Mattermost archives and the regenerated hosted islands come from that build, and
prepack/postpack leave the source clean. Native `check-openclaw-package-tarball`
passes on the root archive. Its `vendor/npm.tgz` is npm 12.2.1 carrying all 15
files of the distribution patch (the patch reverse-applies cleanly and refuses to
apply forward). An isolated install of the root and Mattermost pair reports
`OpenClaw 2026.10.9 (0c0b018)`. The Mattermost archive is byte-identical to the
existing write-once `openclaw-mattermost-41b3b713.tgz` (full hash below) and is
reused.

The Linux amd64 `openclaw-full-plugin-installer` target of
`infra/gateway/Dockerfile.base` builds from these archives with the CUA 0.37.0
driver image: the CUA driver-artifact lint, `config.changed` publication,
Parallel source match (10 files), plugin registry refresh, Codex source match
(188 runtime files) and the native-hook imports pass.

`pnpm check` passes every stage except lint: conflict markers, the line-cap growth
ratchet, the SQLite worker and dialect ratchets, the max-lines, assertion,
timeout-race and mock-export ratchets, every policy guard, the npm package-lock
guard (all locks validate) and `tsgo` prod, scripts and test root. Lint fails on
18 `max-lines` findings, all in files byte-identical to the base. `pnpm
config:channels:check` passes.

Focused regressions on the final head: tools-allow provenance 8/8, plugin
context 9/9, the reload repair's channel-restart 14/14 and startup publication
6/6, `before_tool_call` hooks 32/32, phase hooks 46/46 (including native
#189652's tool enumeration, which also edits `hooks.ts`), host-hook contracts
54/54 and native's PostgreSQL auth-alias migration 4/4 against PostgreSQL 18.
`attempt-tool-run-context.test.ts` passes 6/7; the inherited failure
`keeps forced tools and frozen traces equivalent when overriding without a copy`
also fails without the scheduled-requester patch. Both projections differ only
in the requester-identity overlay's command-sender-authority symbol key, which
the native test's deep equality does not accept.

The schema 39 path ran on PostgreSQL 18: the pinned `e10db5d` build created a
schema 38 agent store holding a legacy `claude-cli:work` profile, and this
build's `doctor --fix --non-interactive --skip-recovery-backups` upgraded it to
39 in 20 seconds, migrated the alias after saving its backup and exited 0. The
installed Gateway then reported ready and listed that agent's sessions without a
stopped-writer refusal. Complete-image qualification, both gateway classes
through their real writers, Memory/Skills workers and a live chat/history turn
on upgraded agents remain for Build main and TEST.

| Package | Write-once object and generation | Bytes | SHA256 |
| --- | --- | ---: | --- |
| root | `openclaw-fork-88109db6.tgz#1793477808534077` | 118524896 | `88109db6c9af6761675b3ac9f12d225a098713c26b8793bea1cdaa1cb0be002a` |
| mattermost | `openclaw-mattermost-41b3b713.tgz#1793414287604477` (reused) | 1272386 | `41b3b7130a25e6b861cc44aaf0669451f2be2b814055b250412c62147102dce4` |

Hash-addressed objects are write-once. Complete-image qualification results and
image digests belong in the runtime PR against its final Octogee source SHA.
Artifact publication alone does not qualify an image or a deployment.

### Upstream contributions

#186891 (Mattermost inbound parity) and #186893 (Mattermost message actions)
are open and carried on this base as described above; remove each when the
selected base contains it. #178755 (detach) and #178973 (local checkpoint)
remain draft/open. #181951 (retained PG refusal) is closed unmerged and superseded
by merged #188350, present in this selected base; its duplicated guard is dropped.
#188580 (PostgreSQL Talk startup) and #188965 (PostgreSQL voice agent
consults, `d21ccbd`) are merged and present in this selected base; their carried
copies are dropped. The scheduled-requester patch is Octogee-only and not
submitted. The account-addition reload repair is carried
from coordinated source `4d2d2f47`; no upstream PR is recorded for that repair.
#182783 is closed unmerged because merged #186296 adopted it into this selected base.
#178970 is closed; native #181198 supersedes it. #189587 (PostgreSQL Doctor
auth-profile backup) closed in favor of #189639, present in this selected base.
Previously adopted PostgreSQL recovery, cache,
catalog and plugin-preparation fixes are not reintroduced. The worker-backed
web-secret fix has not been submitted upstream. Contribution status is separate
from necessity and runtime qualification.

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
Exact-pair architecture qualification is recorded in the current assessment above.
Real Wayland-session qualification remains separate from headless checks.

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
