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

Port the prior overlay oldest-first, then audit every patch against the
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

OVERLAY_SHA=$(git -C /path/to/openclaw rev-parse HEAD)
ROOT_OBJECT="openclaw-fork-${OVERLAY_SHA:0:8}.tgz"
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

The selected release is `v2026.9.3`, peeled to
[upstream commit `1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7`](https://github.com/openclaw/openclaw/commit/1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7).
[Runtime source `9f57512340deaa67fbccea01a5b4a0e8e254e21f`](https://github.com/ceckert/openclaw/commit/9f57512340deaa67fbccea01a5b4a0e8e254e21f)
on `ceckert/openclaw:codex/octogee-team-followups` carries these fixes:

| Fix | Behavior pinned by its regressions | Upstream contribution |
| --- | --- | --- |
| Config revision freshness | Agent create/update/delete expose the persisted config hash before deferred reload acceptance. The ordinary write limiter remains unchanged. | [PR #142169](https://github.com/openclaw/openclaw/pull/142169) |
| Account-scoped reload inspection | Source SecretRefs use account inspection when planning reloads; failed inspection and global policy changes retain whole-channel fallback. Runtime account resolution stays strict. | [PR #142193](https://github.com/openclaw/openclaw/pull/142193) |

| Native channel membership | Materialize canonical channel sessions through an admin-only sync RPC; permit native features for explicit members, revoke only service-authored grants, and preserve explicit owner grants in either grant order. | [Fork PR #4](https://github.com/ceckert/openclaw/pull/4) |
| Preferences and workspace icons | Resolve preferences without a session target, authorize icons with native visibility, and bound repeated credential failures while allowing recovery. | [Fork PR #4](https://github.com/ceckert/openclaw/pull/4) |

The root artifact is `openclaw-fork-9f575123.tgz` at generation `1788893543972817`
(SHA-256 `602b7a265dd3001417df68350c0ea5ebbf760d369a544ac8345a5096aa1a70a9`).
Mattermost is `openclaw-mattermost-47be64ed.tgz`
(SHA-256 `47be64edb595f797d8a0edb594a7b04296efcf7e14ea71dbe8d2dc43c2e97a04`).
The root package passed a full build on the exact runtime commit, focused native
membership/sharing and preferences/icon tests, and a clean joint npm installation
with the unchanged Mattermost artifact. Installed CLI, SQLite, plugin SDK,
Mattermost, FFI, PTY, parser and image runtime imports passed; the CUA driver
remains 0.22.2. Eleven live checks against the installed artifact proved native
channel discovery, board/task access, writes/events, immediate revocation,
rejoin and explicit owner-grant preservation using the actual Octogee helper.
Chrome verified the member dashboard, authorized workspace icon and responsive
composer. The prior minimal overlay passed 534 targeted gateway/Mattermost tests.

### Native Mattermost behavior

The custom channel-session, answer-commit, queued-delivery observation, and
Mattermost transcript-recovery patches are removed. Sessions and tool history
live in native OpenClaw SQLite state. New room messages receive native top-level
answers; replies within existing threads retain their thread root and native
thread session. We no longer force channel-wide context across threads or
reconstruct lost OpenClaw databases from Mattermost messages.

The templates omit custom thread scope and forced reply/streaming preferences.
Pre-boot removes unsupported fork keys from stored configs and preserves supported
native settings. Activity publication is disabled; the activity-tools plugin stays
enabled for its voice relay. Octogee's authorized transcript projection now includes
native top-level bot answers and conversations rooted in those answers.

Completely unmodified `v2026.9.3` passed 856 native Mattermost tests and a disposable
runtime experiment in `octogee-test` using its real Mattermost HTTP/WebSocket service,
private human/bot accounts, two file SecretRefs, and a deterministic model fixture.
The live checks covered DMs, coach/project rooms, human-rooted and bot-rooted threads,
single-answer placement, native history, Control UI-style `deliver:false`, explicit
backend delivery, cancellation and the next turn, tool results, model failure and
recovery, bot separation, and process restart with history preservation and resumed
delivery. Octogee's projection displayed the captured native human/bot posts.
These were API/runtime checks, not a browser UI or fleet rollout. The fixture pod,
tokens, users, and private rooms were cleaned up afterward.

Startup-default preservation is also dropped downstream: Octogee already provisions
explicit account policies and plugin enablement. A separate generic auto-enable
reproduction still loses an effective schema default; that is upstream follow-up,
not a reason to preserve Octogee's patch. No replacement control RPC is needed.

Native `ls` continues to replace the former discovery patch. Resolved-secret caching,
custom `secrets.apply`, no-archive deletion, database-recreation polling, and custom
fresh-chat terminal ownership remain removed. The Dockerfile's WebSocket import
rewrite is removed because the released Mattermost package resolves it natively.

## Temporary native CUA driver patch

`Dockerfile.base` builds the CUA SDK from the 0.22.2 backport commit
[`6309cc93dea771c7980a23d586608b465293a4de`](https://github.com/ceckert/cua/commit/6309cc93dea771c7980a23d586608b465293a4de)
and installs its Linux library into OpenClaw's native driver package. The
backport carries [CUA PR #3659](https://github.com/trycua/cua/pull/3659):
standalone modifier aliases need native keysym and evdev translations.
No Omarchy keybindings or OpenClaw tool semantics change.

The build runs the focused Wayland tests, requires native package version
0.22.2, and records the source commit in `octogee-patch.json` beside the
library. The Dockerfile is already part of the immutable base fingerprint;
changing the source pin produces a new base identity. The original npm Node
runtime and generated bindings remain from the same 0.22.2 release.

Remove the native builder stage and installer overlay when the selected
OpenClaw package uses a published CUA version containing the fix and passes
the modifier/launcher checks. An upstream merge alone does not update an
installed npm package. Until then, a driver version change deliberately fails
the image build and requires reassessing this backport.

## What the packers do

`pack-fork-tarball.sh` produces an installable root package. It vendors root
`workspace:*` dependencies and unpublished Codex/Parallel companions when
needed, so a tag does not depend on a companion publish race.

`pack-mattermost-tarball.sh` runs OpenClaw's plugin packer and verifies compiled
runtime output. Mattermost stays separate so its exact native channel runtime
is content-addressed independently from the root package.

Use `pnpm build`, not `pnpm run build:docker`: the full build creates every
compiled file needed by `npm pack`.
