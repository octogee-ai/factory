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

## Current overlay: October 26 frozen main

The daily refresh freezes latest fetched OpenClaw main at
`bd111bf8e030fd5abddeb89d70d8abdc63467f86`. It independently qualifies that exact
snapshot; no older green commit or later tip is substituted. The clean overlay is
[`b60195e7556d96e2c7973eba14623f7dcb508c94`](https://github.com/ceckert/openclaw/commit/b60195e7556d96e2c7973eba14623f7dcb508c94),
published on `codex/gateway-pg-secrets-reload-20261026`. This follow-up starts from
Octogee main `a2cff0a1ad8b9c152a02ec6f3b5f44c2cb4601ca` in an isolated checkout.
Its preceding `55c4bd0a587258d7d9611b4d2cca17bfcb82806f` package exposed the
running Builder reload failure described below during TEST deployment. The frozen
native base, dependency lockfile, CUA input and other overlay families remain unchanged.

The frozen tip's [push CI](https://github.com/openclaw/openclaw/actions/runs/40388028999)
is cancelled with zero jobs, so supplies no qualification. The latest inspected
successful [full scheduled CI](https://github.com/openclaw/openclaw/actions/runs/37419202402)
is for older `d8612ec864bb4c872616cfda5340c53803655f5f`: 154 jobs pass and nine
skip. Its skips are Node24 compatibility, PR fail-fast, Android screenshots, check
plan, iOS device-family screenshots, the conditional additional-extension/shared
SDK declaration job, iOS release E2E, iOS screenshot evidence, and full-release
child evidence sealing. Those results do not qualify the selected tip.

### Native adoption and review corrections

Native now owns PostgreSQL operator recovery (#183623), admitted read-only cache
reuse (#183398), and relation-scoped catalog attribute reuse (#183598). Their
duplicate production patches are removed. Native shared keyed plugin-preparation
sessions also replace the old close-resource implementation patch. One regression
still checks that closing unrelated agent databases does not invalidate a prepared
plugin artifact; it is coverage, not an unadopted production fix. MCP stdio cleanup,
Mattermost server locking and bounded CUA discovery have no retained production
delta in OpenClaw. Canonical schemas are GLOBAL34/AGENT37; protocol remains 4.

Cluster Builders use PostgreSQL for GLOBAL and agent state. Native web-provider
secret preparation synchronously read a cold installed-plugin index, causing
`secrets.reload` to fail at the main-thread PostgreSQL guard. The async owner now
awaits native's existing worker-backed index reader, preserving its validation,
managed-install recovery and publication checks. A real PostgreSQL conformance
control with the Builder's `parallel-free` provider fails before this two-line fix
and passes afterward; the existing web-secret/reload suites pass 40 cases. Astra
reviewed the exact red, green and patch. The preceding overlay has the same defect;
restoring the removed PostgreSQL patches would not repair it.

Astra reviewed all retained families against native behavior and current Octogee
consumers, then reviewed the remediation. It identified a P2 target-profile
lifetime defect: membership sync held a released profile list across awaited
preparation. The handler now retains native `prepareUserProfileCatalog`, rechecks
the exact canonical target ID at each addition commit guard and releases in
`finally`. A real native profile merge reproduces the failure before the fix;
all 25 owning tests pass afterward. Removals can still revoke obsolete derived
rows. Caller, provenance, session-incarnation and explicit-grant boundaries remain.

Three other overlays are removed: unused hosted cron UI extension points and
their orphan test; the ineffective assistant-media `cfg`-only hunk; and avatar
denial caching/retry changes. Native already deletes failed avatar entries and
notifies consumers after authentication restoration. Current media consumers use
source-only URLs; session-bound member-media access remains unsupported rather
than being silently broadened.

The participant-label helper remains an active full-Dashboard `/chat` fix. Native
renders an opaque observation ID even when loaded history supplies the matching
sender's name. A mounted native control fails that assertion; all 11 retained
cases pass, including namespace mismatch, authoritative labels and replaced
sessions. Identity and stored metadata are unchanged.

Voice relay validation follows native's moved SDK lifecycle owner. Reload waiting
roots use native's shared work-admission state, rather than a duplicate async
context. The public agent protocol schema is split coherently to satisfy the line
limit; validators, channel metadata, worker inventory and config baseline are
regenerated. Native package declaration emit needs `ES2024.Promise` for its own
`Promise.withResolvers`; only that library fragment is added, without a runtime
polyfill or target change.

The final desktop authority run exposed two stale test-only fragments: an unused
undefined fixture return and a cancellation test already covered by native's
pairing-revocation cases. Both are removed; all 82 desktop authority/service/host/
node cases pass. Astra reviewed this final cleanup. Its exact delta from the
predecessor is 14 test-line deletions in one file, with no production changes.
The complete native PG result in the PR uses byte-identical runtime and PG test
inputs; this desktop test is outside all 153 planned PG targets.

### Retained boundaries and removal conditions

The following are current retention decisions, not blanket runtime certification.
An open contribution or an existing fork consumer alone does not justify a patch.

| Family | Native gap or approved behavior; why the owner is here | Remove when |
| --- | --- | --- |
| Requester identity and single approval reviewer | Public requester facts must survive queued/follow-up execution; one reviewer and live client authority must remain valid through the final native/Codex continuation. An adapter cannot own core effect admission. | Native public propagation, single capture and revocation semantics pass delayed/held continuation controls. |
| Channel membership sync and disclosure | Restrictive members need channel access with explicit-grant precedence, authoritative empty-set revocation, prepared membership reads and publication invalidation. Broadening `sessions.others` would weaken the boundary. | Native authoritative membership methods and read/projection owners provide equivalent revocation and incarnation checks. |
| Mattermost channel session scope | Approved `threadSessionScope: channel` keeps one session per channel while preserving reply roots in both directions. Current writers deliberately select this product behavior. | Native supports that option, or the product explicitly adopts thread sessions and adapts membership/consumers. |
| Channel startup and strict stop | Channel startup must not borrow invoking identity; strict stop joins startup and running work, retains physical cleanup ownership, and retires only removed accounts. | Native proves hung-startup joins, late-stop retry and active-sibling preservation. |
| Reload admission, supersession and settlement | Scoped reference-counted waiting roots, supersession wakeups and model/service debt prevent dropped work or a falsely settled baseline. Native synchronous and post-wait checkpoints remain. | Native owns equivalent held-root, late-join, superseded-tail and post-commit settlement behavior. |
| Lifecycle lease and reclamation deadline | One monotonic worker-visible budget prevents late commits. Native's five-second cap fails the actual six-second cold-parent control; the retained ten-second aggregate remains bounded. | Native supports the demonstrated owner delay while preserving cancelled, expired and absolute-budget refusal. |
| Detach, reattach and retained PostgreSQL | Approved transfer retains original logical/physical identity under native creation/deletion custody; missing PG anchors must refuse rather than create. | Native public transfer preserves namespace/history and rollback/recovery custody, or a supported migration owner replaces it. |
| Outbound delivery custody | Retirement refuses unfinished authoritative delivery state and fences racing enqueue across all affected agent identities; empty caches are insufficient. | Native detach/deletion fences the same queue and retains idempotent receipts. |
| Local checkpoint and credential snapshots | Native backup/restore owners publish paired SQLite state exclusively into fresh targets; PG agents retain anchors, not fictional remote rollback. Installation authority is sanitized. | Native public checkpoint supplies equivalent paired-state, no-replace and retained-PG guarantees, or the authorized recovery consumer is removed. |
| Cron migration custody | Held/exported/staged/activated ownership, retired fences, hash-bound chunks and drain are beyond ordinary native CRUD. Projection identity includes effective agent plus declaration. | Native migration provides equivalent activation, rollback, drain and two-engine round trip. |
| Retained legacy cron/state inputs | Fingerprints/order/schema checks admit only recognized retained formats and refuse unknown partial schemas; native canonical schemas remain authoritative. | Those retained inputs are unsupported or native adopts their exact migration. |
| PostgreSQL web-secret index reads | Cold GLOBAL state makes native's synchronous installed-index read fail during Builder `secrets.reload`; the existing async reader owns worker access and validation. | Native awaits the worker-backed reader here and the same cold-GLOBAL/provider conformance control passes without this overlay. |
| PostgreSQL cron enabled JSON | Native's SQLite JSON-value assumption fails PG bound enabled updates; the codec uses each engine's existing JSON expression. | Native equivalent passes both-engine false/true transitions without losing authored fields. |
| Memory shadow database retirement | Physical admission must retire before unlinking shadow files, preventing writes through live descriptors. | Native owns equivalent descriptor/late-owner retirement. |
| Voice relay and computer authority | Approved public broker transport retains native session/media ownership; desktop control release, observation/token lifetime and node execution remain bounded. | Native public contracts preserve transport validation, cancellation, fresh observation and late-dispatch refusal. |
| Final-reply notification | Activity tools require terminal final-content classification, not agent-completion inference. Only the public observer flag is retained; delivery custody is native. | Native supplies equivalent classification or the observer is removed. |
| Dashboard participant labels | Current same-session history supplies a human label missing from native observation projection. This is presentation, with no access/identity mutation. | Native projects equivalent labels or the embedded native chat consumer is removed. |
| Dependency and npm packaging | Exact fast-uri/npm pins and the disposable npm distribution patch need installed-byte verification; version equality does not qualify nested dependencies. | Stock/native installed closures contain the fixes and the dependency gate passes. The release-age exclusion expires at `2026-10-26T22:51:36.634Z`. |
| Generated schemas, inventories and test support | Describe retained APIs and canonical native owners, not independent features. | Regeneration after the owning feature's removal eliminates them. |

### Qualification and explicit limits

Pinned pnpm 12.15.0 installs the frozen lockfile under Node 26.12.1. The clean full
`pnpm build package` passes; its build-info matches `b60195e7556d96e2c7973eba14623f7dcb508c94`.
Root and Mattermost are packed sequentially from that build. Native tarball
inventory/import-graph checks pass; prepack/postpack leave the source clean.

`pnpm check` remains **failed** with 23 lint errors, all in files byte-identical
to the frozen native base. Generated preflights and core/UI/extension, script and
root-test typechecks pass. This is not aggregate native CI clearance.
The current PostgreSQL reload regression passes, as do 40 affected native web-secret,
model-publication and lifecycle tests. Regenerated islands pass 69 host-consumer
and coexistence cases; their shared chunks have unchanged content after generated
chunk references are normalized.

The unchanged overlay families retain their preceding qualification: 25 membership,
11 participant-label and 70 reclamation/lifetime/admission/file-copy cases, with
the five-second native reclamation negative control failing at checkpoint expiry.
The preceding isolated full native PG16 qualification passed 1,343 tests with 40
skips over nine shards; this follow-up does not claim a new whole-suite PG run.
Canonical PostgreSQL routine, trigger and expression provenance is regenerated
from this exact source against a separate PG16 fixture; all definitions remain
unchanged. Final-head Linux CI verifies affected Octogee packages separately.

An isolated npm prefix passes exact build-info, all 874 Mattermost files, both
15-file patched npm closures, Parallel's ten source-matched files, Codex's 193
runtime files, native bundled trust/registry refresh and three hook imports.
The actual Linux amd64 full-plugin-installer passes those same installed-byte,
source-match, registry and native-hook gates using the current input-keyed CUA
image. This recut qualifies Linux amd64; arm64 remains unqualified. The dependency
lockfile and patched npm closure are unchanged from the preceding installed-prefix
advisory inventory. Complete-image qualification remains a separate required gate:
real Shared/Builder writers, strict isolated Doctor comparisons, installed
plugins/hooks/Memory/Skills and the published image digest belong in the PR.
Platform model catalogs omit credential fields. The former profile-ID strings
were interpreted as plaintext by native Doctor when a profile write had deferred,
creating conflicting credentials. Both normal catalog updates and OAuth cleanup
replace their owned catalog definitions without those markers. Authentication
continues through native broker-profile materialization; conflicting credentials
remain refused.

The running-Gateway check additionally materializes broker profiles, exercises
public `secrets.reload` and verifies public model catalogs. That isolated check
uses native channel suppression; live channel readiness is verified during
TEST/PROD convergence. Bounded failed-boot recovery and the normal operator
deployment path remain in place.

| Package | Write-once object and generation | Bytes | SHA256 |
| --- | --- | ---: | --- |
| root | `openclaw-fork-e8395f6c.tgz#1793071774174106` | 134787427 | `e8395f6c63f78a4f01fa5a586e17b0fcaddd61d8f8f2b0bdbb641ded9b4be1b5` |
| mattermost | `openclaw-mattermost-e1623c45.tgz#1792939044881470` | 1255051 | `e1623c45f5b00466cb9fd129c65f72a0042fdb9ea20ba4bdbe89d461d329ac81` |

Generation-bound downloads reproduce both complete hashes. The unchanged
Mattermost object is reused only after its full generation-bound verification.
The complete image digest belongs in the PR, avoiding a recursive build input.

Native Doctor still omits valid per-agent `models.json` providers from one
provider validation path and cannot prepare their model-specific tool-schema
inspection. Its unknown-provider and tool-schema warnings remain visible. The
complete-image qualification therefore also probes native normal model resolution
against each authored catalog with network access forbidden; this does not claim
live provider credentials/inference or interactive desktop acceptance.

### Upstream contributions

Contribution status is distinct from retention. This refresh has not submitted
the worker-backed web-secret fix upstream. #178755 (detach) and #178973
(local checkpoint) remain draft/open; #181951 (retained PG refusal) and #182783
(session-list reload) remain open. #178970 remains open but native #181198
supersedes it. Previously adopted #181201, #181676, #183114, #183172 and #183184
are not reimported. This frozen base additionally contains #183398, #183598 and
#183623, so their former duplicate patches are dropped. None of these statuses
certifies the entire overlay or future upstream main.

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
