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

## Current overlay: October 27 frozen main

This daily refresh freezes latest fetched OpenClaw main at
`43dc38e6c1370e7682156b8a84ed6fc1abfaa0b7`. It independently qualifies that exact
tip, without substituting an older green commit or chasing a later tip. The clean
overlay is [`8b575ce4fa111785aef9763011e54395563cb1a8`](https://github.com/ceckert/openclaw/commit/8b575ce4fa111785aef9763011e54395563cb1a8),
on `codex/openclaw-refresh-20261027`. The isolated Octogee checkout starts from
main `c7d5dd19330b3da3cf8ba05d9d0fba65e9c23a9a`.

The selected tip's [push CI](https://github.com/openclaw/openclaw/actions/runs/40521188258)
passes security-fast and skips 42 jobs, including build, PostgreSQL, UI, native-app
and ordinary test lanes. It is not full runtime qualification. The most recent successful
[full scheduled CI](https://github.com/openclaw/openclaw/actions/runs/37419202402)
is older `d8612ec864bb4c872616cfda5340c53803655f5f`: 154 jobs pass and nine skip.
Those skips are Node24 compatibility, PR fail-fast, Android screenshots, check
plan, iOS device-family screenshots, the conditional additional-extension/shared
SDK declaration job, iOS release E2E, iOS screenshot evidence and full-release
child evidence sealing. Those results do not qualify this selected tip.

### Native adoption and overlay reassessment

Native invitation-only visibility and linked-session membership propagation now
own the prepared read/projection path. The overlay no longer resolves those same
targets again. Eleven previously patched files now match native exactly, including
sharing authorization, source custody, describe, mutation and several read owners.
The channel-member exception still belongs at core effect admission: current
Octogee members deliberately use `sessions.others: none`; channel membership must
admit their channel work without disclosing other sessions. An explicit role
still caps mutation, authoritative empty membership revokes access, and pending
work rechecks its original session incarnation and live caller.

Native also supplies the declaration library previously added for
`Promise.withResolvers`; that overlay is dropped. The expired fast-uri cooldown
exception is removed; pinned pnpm still accepts the frozen lockfile. GLOBAL35 and
AGENT37 remain native's canonical schemas; protocol remains 4. Previously adopted
PostgreSQL recovery/cache/catalog fixes and native plugin preparation are not
reintroduced. MCP cleanup, Mattermost server locking, CUA discovery, hosted cron
extension points and avatar-denial caching have no retained production delta
in OpenClaw core.

The cold PostgreSQL web-secret path still calls the synchronous installed-plugin
index reader in this frozen base. The overlay keeps the existing async,
worker-backed owner and its cold-GLOBAL/provider conformance regression. The cron
enabled JSON codec still needs its engine-specific expression. Native's five-second
reclamation decision cap still differs from the retained bounded ten-second,
worker-visible monotonic deadline. Authorization, strict stop, transfer, delivery
custody, checkpoint and recovery boundaries retain their owning tests and removal
conditions below.

The retained Dashboard label projection still uses matching same-session history
without changing identity or stored metadata. All 11 label cases pass. Reload
fixtures now use native's current harness and notification type, with exact
identity, restart and coalescing assertions retained; 35 cases and all four owning
Gateway test type partitions pass. These fixture corrections change no runtime
behavior.

### Retained boundaries and removal conditions

Retention decisions distinguish reproduced bugs from approved product behavior.
Contribution status alone does not justify a patch.

| Family | Native gap or approved behavior; why the owner is here | Remove when |
| --- | --- | --- |
| Requester identity and single approval reviewer | Public requester facts must survive queued/follow-up execution; one reviewer and live client authority must remain valid through the final native/Codex continuation. An adapter cannot own core effect admission. | Native public propagation, single capture and revocation semantics pass delayed/held continuation controls. |
| Channel membership sync and disclosure | Native now owns invitation-only and linked-session membership filtering. Octogee retains its approved `none`-policy channel-member access, authoritative empty-set sync, explicit-grant precedence and publication invalidation; invitation-only visibility does not replace that mutation contract. Native prepared membership facts replace the overlay target lookup callbacks. | Native authoritative membership methods and read/projection owners provide equivalent revocation and incarnation checks. |
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
| Dependency and npm packaging | Exact fast-uri/npm pins and the disposable npm distribution patch need installed-byte verification; version equality does not qualify nested dependencies. | Stock/native installed closures contain the fixes and the dependency gate passes. The expired fast-uri release-age exception is removed. |
| Generated schemas, inventories and test support | Describe retained APIs and canonical native owners, not independent features. | Regeneration after the owning feature's removal eliminates them. |

### Qualification and explicit limits

Pinned pnpm 12.15.0 accepts the frozen lockfile under Node 26.12.1 without the
expired URI exception. The clean full `pnpm build package` and matching build-info
are required for the final source above. Root and Mattermost are packed
sequentially from that exact build; native archive inventory/import-graph checks
and clean prepack/postpack restoration are required before publication.

Aggregate `pnpm check` is **failed**: 26 lint errors are in files byte-identical to
the frozen native base. Its generated preflights, production core/UI/extensions,
scripts and root tooling/test types pass. The four affected Gateway test type
partitions pass separately. No aggregate native CI clearance is claimed.

Boundary qualification includes 366 Gateway cases for strict stop, reload,
desktop authority, disclosure and transfer, plus the retained requester/reviewer,
membership, reclamation, cron, plugin, Memory and voice suites. The final affected reload
fixture suites pass 35 cases. The isolated core catalog/transfer/recovery
suites pass 64 cases against a fresh, ordinary PostgreSQL16 owner. Native routine,
trigger and expression definitions regenerate unchanged from this source.
The broader native PostgreSQL run and its exact counts are recorded in the PR;
its source differs only in test fixtures outside every planned PG target, with
all runtime bytes and PG test inputs unchanged.

Hosted islands regenerate from this same built source. Native palette variables
and color mixes resolve to opaque browser chrome colors during generation, with
CSS cascade precedence preserved. All 128 host-consumer and pre-paint theme
cases pass; provenance/pin, license, package/base-image and final-head Linux CI
remain separate gates. An isolated installed prefix verifies all 874 Mattermost
files, both 15-file patched npm closures, Parallel's ten source-matched files,
Codex's 183 runtime files, native registry/bundled trust and three hook imports.
The source-owned root Undici pin is 8.12.3; npm's separate patched nested closure
retains Undici 6.29.1 and ip-address 10.7.4.

The actual Linux amd64 full-plugin-installer passes native registry, bundled
trust, source-match, three hook imports and complete installed-byte checks.
Complete Shared/Builder image results, published digest and real-writer/strict
Doctor/hooks/Memory/Skills proof belong in the PR. Image digests stay out of this recursive build input. Arm64,
live provider inference and interactive desktop acceptance are not claimed.
Full Doctor remains off healthy boots; bounded failed-boot recovery and driver
artifact checks remain. Native per-agent provider/tool-schema Doctor warnings
stay visible; separate no-network native model-resolution probes must cover the
authored catalogs without translating config keys or hiding those warnings.

| Package | Write-once object and generation | Bytes | SHA256 |
| --- | --- | ---: | --- |
| root | `openclaw-fork-543c2c5e.tgz#1793114916311419` | 135264994 | `543c2c5e1af204e3a224674acb65a6d455d1903d71addd3d9912eb1a6775a399` |
| mattermost | `openclaw-mattermost-f2c67dde.tgz#1793114925810656` | 1255687 | `f2c67ddeb1bb39e4bc5eb227852f53260c3559e32b451277000ac4ca34cccf9d` |

Generation-bound readbacks must reproduce both complete hashes before object
pins and mirrored aliases are accepted. Hash-addressed objects are write-once.

### Upstream contributions

#178755 (detach) and #178973 (local checkpoint) remain draft/open. #181951
(retained PG refusal) and #182783 (session-list reload) remain open. #178970 is
still open but native #181198 already supersedes it. Previously adopted #181201,
#181676, #183114, #183172, #183184, #183398, #183598 and #183623 are not
reimported. The worker-backed web-secret fix has not been submitted upstream.
These statuses are separate from retention and runtime qualification.

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
