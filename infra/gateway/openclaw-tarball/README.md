# OpenClaw Private Fork Tarball — Patch Ritual

This is **the** canonical doc for rolling OpenClaw forward. We do this dance
every few weeks; the steps below ceremonialize it so future-Claude (or
future-Chris) can execute cold without thinking.

`Dockerfile.base` installs OpenClaw from a local tarball at
`openclaw-fork.tgz` in this directory. The tarball is a private build of
OpenClaw with Octogee-specific patches that haven't landed upstream yet.
The `.tgz` file is gitignored. Cloud Build stages it from GCS before the
Docker build runs; local docker builds need it copied manually.

> **Quick links**
> - [The ritual](#the-ritual) — when you're rolling forward
> - [Common gotchas](#common-gotchas) — paper cuts that have bitten us
> - [Diagnostic-patch policy](#diagnostic-patch-policy) — when to drop diags
> - [Current patches](#current-patches) — what's in the stack today

---

## When to do this

Two triggers:

1. **Upstream OpenClaw cuts a release we want to adopt.** Watch
   `git log origin/main` in the fork checkout; the user-facing tags are
   `vYYYY.M.N` (sometimes with `-N` suffix for hotfixes).
2. **We're adding/changing/removing a fork patch** without an upstream version
   bump.

Either way, the ritual is the same — you produce a new tarball, upload it
to GCS, bump the pin in two cloudbuild files, build the base image, then
let CI ship the gateway image to TEST.

End-to-end this takes ~25 minutes of clock time, ~5 minutes of attention.
Most of the wait is two Cloud Builds + one Release CI run.

---

## Pre-flight

Before you start, verify:

- **Local fork checkout** at `~/workspace/openclaw/openclaw` with two remotes:
  - `origin` → `openclaw/openclaw` (upstream, read-only — used for `git fetch --tags`)
  - `ceckert` → `ceckert/openclaw` (Chris's mirror — where the `octogee/*`
    integration branches are pushed for record-keeping)
- **Working tree clean** in both `~/workspace/openclaw/openclaw` and
  `~/workspace/octogee-ai/octogee` (`git status` shows nothing pending).
- **Octogee monorepo on `main`** with no uncommitted edits — the cloudbuild
  bumps go straight to main, and a wrong-branch commit is the #1 paper cut
  in this flow.
- **`gcloud` authed** with `octogee` project default (`gcloud config get project`
  → `octogee`).
- **`kubectl` context** available: `gke_octogee_us-central1_octogee-gateway`.
  TEST and PROD are namespaces in that one cluster (`octogee-test` /
  `octogee`); there is no separate test cluster context.

---

## The ritual

Every step has a **▸ command**, an **✓ expected outcome**, and (where
relevant) a **⚠ gotcha** flag pointing at [Common gotchas](#common-gotchas).
Run sequentially.

### Step 1 — Fetch upstream tags

▸
```bash
cd ~/workspace/openclaw/openclaw
git checkout main && git pull --ff-only origin main
git fetch origin --tags
git tag --sort=-v:refname | head -5
```

✓ The new target tag (`vYYYY.M.N`) appears at the top of the list.

### Step 2 — Pin the variables for this cycle

▸
```bash
NEW_TAG=v2026.5.4              # ← upstream tag you're moving to
PREV_TAG=v2026.5.3-1            # ← previous integration branch's base tag
```

✓ Both vars set in your shell. Used everywhere below.

### Step 3 — Cut the integration branch

▸
```bash
git checkout -b octogee/gateway-scaling-patches-${NEW_TAG#v} ${NEW_TAG}
```

✓ You're on the new branch, working tree clean, head at the upstream tag.

### Step 4 — Cherry-pick the prior fork stack

Oldest-first preserves history order in `git log`.

▸
```bash
git cherry-pick $(git log --format=%H ${PREV_TAG}..octogee/gateway-scaling-patches-${PREV_TAG#v} | tac)
```

✓ Each patch lands cleanly. Auto-merges in already-modified files are fine
— git will say `Auto-merging <file>` and continue. Manual conflict means
upstream changed something underneath the patch; resolve, `git add`,
`git cherry-pick --continue`.

### Step 5 — Audit upstream relevance

For each patched file, check whether upstream changed it between
`${PREV_TAG}` and `${NEW_TAG}`:

▸
```bash
# List the files our patches touch, then diff them upstream:
git log v${PREV_TAG#v}..HEAD --name-only --pretty=format: | sort -u | grep -v '^$'
git diff ${PREV_TAG}..${NEW_TAG} -- <each-of-those-files>
```

✓ For each patch, decide one of:
- **Keep** — no upstream diff in the file, or the upstream diff is unrelated
  to what the patch does.
- **Drop** — upstream landed equivalent behavior, the patch is redundant.
- **Drop diagnostic** — see [Diagnostic-patch policy](#diagnostic-patch-policy).

If you drop a patch, redo Step 4 without it. **Always confirm the audit
findings with the operator before dropping anything** — sometimes a patch
exists for a reason that isn't obvious from the file diff.

### Step 6 — Build OpenClaw

▸
```bash
pnpm install --frozen-lockfile
pnpm build                       # ⚠ NOT build:docker — see "Why pnpm build" below
```

✓ Build completes with no errors. `dist/` is populated.

### Step 7 — Pack the tarball

▸
```bash
mkdir -p /tmp/openclaw-fork
npm pack --pack-destination /tmp/openclaw-fork --ignore-scripts   # ⚠ NOT pnpm pack
ls -la /tmp/openclaw-fork/
```

✓ A single `openclaw-<version>.tgz` file, ~20-25 MB, ~7-10k files.

### Step 8 — Capture fork SHA

▸
```bash
SHA=$(git rev-parse --short=8 HEAD)
echo $SHA
```

✓ 8-char hex string. This becomes both the tarball name and the
`_OPENCLAW_FORK_SHA` substitution in cloudbuild.

### Step 9 — Upload tarball to GCS

▸
```bash
gcloud storage cp /tmp/openclaw-fork/openclaw-*.tgz \
  gs://octogee-openclaw-fork/openclaw-fork-${SHA}.tgz \
  --project=octogee
gcloud storage ls -L gs://octogee-openclaw-fork/openclaw-fork-${SHA}.tgz \
  --project=octogee | grep Content-Length
```

✓ Upload completes; Content-Length matches the local file size.

### Step 10 — Mirror the integration branch

▸
```bash
git push ceckert octogee/gateway-scaling-patches-${NEW_TAG#v}
```

✓ Branch pushed to `ceckert/openclaw` for record-keeping. Future audits
(`git log v...`) work without the local checkout.

### Step 11 — Bump `cloudbuild-base.yaml` (the BASE config)

In the octogee monorepo, edit `cloudbuild-base.yaml`:

- `_OPENCLAW_VERSION` → `${NEW_TAG#v}`
- `_OPENCLAW_FORK_SHA` → `$SHA`
- Update the comment block listing the patches (one line per patch with the
  new short SHAs from `git log v${NEW_TAG#v}..HEAD --oneline`).

✓ Diff shows both substitution changes plus the comment refresh.

### Step 12 — Bump `cloudbuild.yaml` (the GATEWAY config)

▸ **Don't forget this file.** ⚠ This is the second most-common paper cut.

Edit `cloudbuild.yaml`:

- `_OPENCLAW_VERSION` → `${NEW_TAG#v}` (same value as Step 11)
- `_OPENCLAW_FORK_SHA` → `$SHA` (same value as Step 11)

The gateway image's `FROM` resolves the base by `_OPENCLAW_VERSION` tag —
if you only bump one file, the gateway image silently builds against the
wrong base and the boot banner reports the old version. **Always bump
both.**

✓ `git diff cloudbuild-base.yaml cloudbuild.yaml` shows version + fork-SHA
in both files. Don't commit yet.

### Step 13 — Build the base image

The base image must exist before the gateway image build runs (CI does
`docker pull <base>:${_OPENCLAW_VERSION}`).

▸
```bash
gcloud builds submit --config cloudbuild-base.yaml \
  --substitutions=_OPENCLAW_VERSION=${NEW_TAG#v},_OPENCLAW_FORK_SHA=${SHA} \
  --project=octogee --async
```

This returns a build ID. Poll it:

```bash
BUILD_ID=<id-from-above>
until s=$(gcloud builds describe $BUILD_ID --project=octogee --format='value(status)' 2>/dev/null); \
    [ -n "$s" ] && [ "$s" != "QUEUED" ] && [ "$s" != "WORKING" ]; \
    do echo "$(date +%H:%M:%S) status=$s"; sleep 30; done; echo "FINAL: $s"
```

✓ Final status: `SUCCESS`. Takes ~5-7 min.

### Step 14 — Confirm you're on `main`

▸
```bash
cd ~/workspace/octogee-ai/octogee
git status
```

✓ On `main`, no untracked files staged accidentally, only the two cloudbuild
files modified. ⚠ If you're not on main, **stash the bumps**, switch, pull
fast-forward, pop the stash. Don't commit cloudbuild bumps to a feature
branch — they need to ride main to trigger Release CI.

### Step 15 — Commit + push the cloudbuild bumps

Per the [docs-direct-to-main](../../CLAUDE.md) pattern (build/infra config
is treated like docs), straight to main, no PR.

▸
```bash
git add cloudbuild-base.yaml cloudbuild.yaml
git commit -m "chore(gateway): roll forward to OpenClaw ${NEW_TAG#v} (fork ${SHA})

[describe cherry-pick health: clean? auto-merges? upstream audit findings?]
[note any patches dropped this cycle and why]
[note diagnostic-patch decision per the policy]"
git push origin main
```

✓ Push lands on origin/main. Release CI fires automatically.

### Step 16 — Watch Release CI

▸
```bash
gh run list --branch main --limit 3 --json databaseId,name,status,headSha
gh run watch <release-run-id> --exit-status
```

✓ All steps green. The deploy step ends with `Deploy to GKE via Helm`
and `TEST auto-rollout — bump glmGateways/gw-test.imageTag`. Helm-test
warning about MM admin token is pre-existing and unrelated.

⚠ If the deploy step fails on `Break stale Helm pending-upgrade locks`
with `context deadline exceeded`, see [Common gotchas](#common-gotchas)
→ "Helm pending-rollback / pending-upgrade".

### Step 17 — Verify the boot banner

After CI succeeds, the **default** gateway pod should have rolled to the
new image. The boot banner is the truth source.

▸
```bash
kubectl --context gke_octogee_us-central1_octogee-gateway -n octogee-test \
  logs -l app=octogee-gateway,glmInstanceName=default -c gateway --tail=2000 \
  | grep '\[entrypoint\] boot:' | tail -1
```

✓ Banner reads `gateway-image=<new-short-sha> openclaw=${NEW_TAG#v} fork=${SHA}`.

⚠ If the banner still shows the old SHA after CI succeeds, you've hit the
[Cowboy/glm-controller listener race](#cowboy--glm-controller-bootstrap-vs-listener-race)
— see gotchas below.

### Step 18 — Smoke + tools sanity (TEST)

Send a coach a real message in TEST and verify the agent responds with
fresh-build markers. If you've changed any plugin-related patch (e.g.
mattermost-tools tool dispatch), now's when you confirm.

✓ Operator decides this passes.

### Step 19 — Update the patch list

Edit the [Current patches](#current-patches) section of this file with
any added/dropped/diagnostic-policy-flipped patches from this cycle.
Commit the doc update direct to main.

✓ This file matches `git log v${NEW_TAG#v}..octogee/gateway-scaling-patches-${NEW_TAG#v}`.

### Step 20 — PROD promote (separate decision)

PROD doesn't auto-roll — it's gated on `workflow_dispatch` of the
Release workflow. The same gateway image SHA is already in Artifact
Registry from Step 16's build. When you (the operator) decide PROD is
ready, dispatch the Release workflow with `env=prod`. Out of scope for
this ritual.

---

## Common gotchas

Stickies, in order of how often they bite us.

### Forgetting `cloudbuild.yaml` after editing `cloudbuild-base.yaml`

**Symptom:** TEST boot banner shows old `openclaw=...` even though Cloud
Build's base image build for the new version succeeded.

**Cause:** `_OPENCLAW_VERSION` is the tag the gateway Dockerfile uses to
`FROM` the base. If only `cloudbuild-base.yaml` was bumped, the gateway
build pulls the old base.

**Fix:** Step 12 — always bump both files in lockstep with the same
values. The boot banner from Step 17 catches this within seconds of the
deploy completing.

### Wrong-branch commit

**Symptom:** You committed cloudbuild bumps to a feature branch. Push to
main doesn't include them. Release CI rebuilds the same old SHA.

**Cause:** You forgot to `git checkout main` before `git add`/`git commit`.

**Fix:**
```bash
git stash push -m "openclaw bumps" cloudbuild-base.yaml cloudbuild.yaml
git checkout main && git pull --ff-only origin main
git stash pop
# now commit + push
```

### Cowboy / glm-controller bootstrap-vs-listener race

**Symptom:** TEST helm rev advances, Release CI green, but the boot
banner still shows the old gateway image SHA.

**Cause:** PR #852 added a post-deploy step that writes the new SHA to
`glmGateways/gw-test.imageTag` in Firestore. glm-controller has an
`onSnapshot` listener supposed to fire a follow-up reconcile when that
field changes. But the helm upgrade in the same Release run may
**restart glm-controller**, and its bootstrap-tick can land **before**
the Firestore write — at which point the listener-fire from the post-deploy
step is missed (we've seen exactly one reconcile in the controller log
after a release where two were expected).

**Fix:**
```bash
kubectl --context gke_octogee_us-central1_octogee-gateway -n octogee-test \
  rollout restart deployment/glm-controller
kubectl --context gke_octogee_us-central1_octogee-gateway -n octogee-test \
  rollout status deployment/glm-controller --timeout=120s
```

The fresh glm-controller bootstraps from current Firestore (which now
has the new SHA), reconciles, runs `helm upgrade --set
gateway.instances.default.image.tag=<new-sha>`, and rolls the pod. Boot
banner from Step 17 should now be correct within 60s.

This is a known follow-up; not yet fixed in glm-controller.

### Helm pending-rollback / pending-upgrade

**Symptom:** Deploy step fails on `Break stale Helm pending-upgrade
locks` with `context deadline exceeded`, OR `helm status octogee` shows
`pending-rollback` or `pending-upgrade` for several minutes.

**Cause:** A previous deploy got stuck (helm hooks timed out, network
hiccup, etc.). CI tries to roll back to the last `deployed` revision but
that rollback itself can time out under load.

**Fix:** Wait ~3 minutes — frequently the rollback completes
asynchronously and the next CI run succeeds. If it doesn't:
```bash
helm --kube-context gke_octogee_us-central1_octogee-gateway -n octogee-test \
  history octogee --max 10
# Find the most recent "deployed" revision; let's say it's 122:
helm --kube-context gke_octogee_us-central1_octogee-gateway -n octogee-test \
  rollback octogee 122 --wait --timeout 5m
```

Then re-run Release CI via `workflow_dispatch` (no commit needed if
cloudbuild bumps are already on main).

### `pnpm pack` hangs at 100% CPU

**Symptom:** `pnpm pack` runs for 5+ minutes, no output, single core
pegged. Stack samples identical.

**Cause:** OpenClaw's `package.json` `exports` map has 309 entries and
`dist/` holds ~108k files. pnpm pack's file-inclusion check is roughly
`O(files × exports × glob_negations)` and hits catastrophic regex
backtracking.

**Fix:** Always use `npm pack --ignore-scripts` (Step 7). It uses
`npm-packlist` (different algorithm), finishes in ~5 seconds, produces a
file-content-identical tarball. The `--ignore-scripts` flag also skips
the `prepack` lifecycle hook (`scripts/openclaw-prepack.ts`) which has
the same regex-walk problem.

### `pnpm run build:docker` produces an incomplete dist tree

**Symptom:** `npm pack` aborts with
`ENOENT: lstat 'dist/extensions/<name>/index.js'`.

**Cause:** `build:docker` is a partial build (`tsdown` + a few helpers)
that doesn't build every extension. The pack walks `dist/` looking for
files referenced by the `exports` map and finds gaps.

**Fix:** Always use `pnpm build` (the full build-all script, Step 6),
not `pnpm run build:docker`. Slower but it's the only build that
produces a packable dist tree.

### Mismatched `_OPENCLAW_FORK_SHA` between cloudbuild files

**Symptom:** Base build is fine, gateway build is fine, but the boot
banner reports a `fork=` SHA that doesn't match what's in
`cloudbuild-base.yaml`.

**Cause:** The gateway Dockerfile takes `OPENCLAW_FORK_SHA` as a
`--build-arg` from `cloudbuild.yaml`, separate from the base build. If
`cloudbuild.yaml`'s value is stale, the boot banner is wrong even
though the actual binary is correct (the fork SHA in the banner is for
operator confirmation, not for build correctness).

**Fix:** Step 12 — keep `_OPENCLAW_FORK_SHA` identical in both files.

---

## Diagnostic-patch policy

Some of our patches are diagnostic-only (timing instrumentation, no
behavior change). They exist to chase a specific bug or confirm a
specific theory. Without a policy, they accrete forever.

**Default policy:**

1. **Add** a diagnostic patch when needed for an active investigation.
2. **Carry it forward one cycle after introduction** to confirm the new
   OC version doesn't regress what the diagnostic was tracking.
3. **Drop it the cycle after that** unless the operator has a specific
   reason to keep it (open regression risk, ongoing investigation, etc.).
4. **Operator override is always available** — when in doubt, ask. The
   answer is usually "drop unless you re-need it."

The cloudbuild-base.yaml patch comment block records the per-patch
decision for the current cycle (e.g. *"Diagnostic patches X+Y carried
forward one more cycle to confirm no regressions from the V → W jump.
Reassess next OC upgrade."*). Update it every cycle.

---

## Current patches

Authoritative source: `git log v<OPENCLAW_VERSION>..octogee/gateway-scaling-patches-v<OPENCLAW_VERSION>` in the fork checkout. As of v2026.5.4 the fork carries five patches — three essential, two diagnostic-only.

**Essential:**

- **Per-account surgical channel reload** — `src/gateway/config-reload-plan.ts`,
  `src/gateway/server-reload-handlers.ts`. Adds a per-account bucket to
  `GatewayReloadPlan` so a `config.patch` that only touches
  `channels.mattermost.accounts.<slug>.*` calls `stopChannel(kind, accountId)`
  + `startChannel(kind, accountId)` — leaving every other tenant's MM
  WebSocket connected. Without this, a single customer signup
  disconnects every other coach account at once.
  Log proof at runtime: `[octogee-patch] restarting mattermost account=<slug>-coach`

- **Env-gated `isControlUiVisible` override for sidecar bridges** —
  `src/infra/agent-events.ts`. When `OPENCLAW_BROADCAST_ALL_AGENT_RUNS=1`,
  `registerAgentRunContext` forces `isControlUiVisible=true` regardless of
  the run's channel. Vanilla OC only broadcasts `agent` events for `webchat`
  channels (the literal string in `src/utils/message-channel-constants.ts`);
  for MM/Slack/Telegram/Discord runs the global broadcast at
  `server-chat.ts:678` is suppressed by design. The chat-proxy sidecar is
  Octogee's intended consumer of those events, so we opt in via env.
  Default behavior unchanged when the env var is unset.
  Env var is set in `helm/octogee/charts/gateway/templates/deployment.yaml`.
  See `docs/ACTIVITY-STREAM-SPEC.md` §15.7 for context + scope-discipline note.

- **`config.patch` returns post-write hash** —
  `src/gateway/server-methods/config.ts`. Includes the merged-config hash
  in the `config.patch` response payload so the local-provisioner can
  cache by hash and skip redundant patches when nothing actually changed.
  Without this, every provisioner reconcile round-trips a patch even on a
  no-op, multiplying control-plane traffic per tenant on busy clusters.

**Diagnostic (carried forward to confirm no regressions; reassess each cycle per the [policy](#diagnostic-patch-policy)):**

- **Per-phase `config.patch` timing instrumentation** —
  `src/gateway/server-methods/config.ts`. Logs duration of parse / merge /
  apply / persist phases inside `config.patch` so we can spot regression
  points when a roll-forward suddenly slows down control-plane writes.

- **WS-upgrade timing instrumentation** —
  `src/gateway/server-http.ts`. Logs how long the gateway WebSocket upgrade
  callback takes per connection. Helps identify boot-time saturation
  windows where new sidecar/MM connections queue behind reload work.

Patches deleted at the v2026.4.29 roll-forward (kept in git history on
`octogee/gateway-scaling-patches-v2026.4.24` and `-v2026.4.25` if you need
to spelunk):

- MM WebSocket keepalive ping → landed upstream as `0e97f962ac` (#73979).
- AJV plugin defaults leaking into `event.sourceConfig` (the SIGUSR1-on-mount cascade) → landed upstream as `057b8276cc` (#73267) in v2026.4.28.
- Channel/sidecar startup-handshake hang (4.25/4.26 blocker) → landed upstream as `8d58ad4c15`.
- MM per-message latency instrumentation + emit-timing-summary-on-settle — diagnostic-only, dropped now that the bugs they helped chase are fixed.
- Control-plane write rate-limit configurable — never deployed; surgical reload kept actual `config.patch` traffic well below the 3/60s upstream cap.

---

## GCS bucket

Tarballs live at `gs://octogee-openclaw-fork/openclaw-fork-<short-sha>.tgz`.
The pinned SHA is tracked via `_OPENCLAW_FORK_SHA` in `cloudbuild-base.yaml`
*and* `cloudbuild.yaml` (must match — see Step 12). Object names include
the short SHA so builds pin to a specific immutable artifact — bump the
substitution to roll forward.

---

## Why `npm pack`, not `pnpm pack`

Through v2026.4.20 the RUNBOOK said `pnpm pack`. From v2026.4.24 onward
the OpenClaw `package.json` `exports` map has 309 entries and `dist/`
holds ~108k files. pnpm pack's file-inclusion check is roughly
`O(files × exports × glob_negations)` and hits catastrophic regex
backtracking — the process pegs 100% CPU with frozen memory and
identical stack across samples, never completing.

`npm pack` uses `npm-packlist` (a different algorithm) and finishes in
~5 seconds with a structurally identical tarball. This is a one-package
pack (no workspace deps), so the artifacts are file-content identical —
the `package.json` `files` declaration is what both tools honor.

`--ignore-scripts` skips the `prepack` lifecycle hook
(`scripts/openclaw-prepack.ts`), which has the same regex-walk
problem in `writeDistInventory`. The full `pnpm build` above produces
all the dist artifacts prepack would have produced — the only thing
prepack adds is `dist/postinstall-inventory.json`, which the gateway
base image doesn't consume.

## Why `pnpm build`, not `pnpm run build:docker`

`build:docker` is a partial build (`tsdown` + a few helpers) that's
faster but doesn't build every extension. If the resulting `dist/`
tree is missing files referenced by `npm pack`'s file walk you'll get
`ENOENT: lstat 'dist/extensions/<name>/index.js'` and the pack
aborts. The full `pnpm build` runs the complete build-all script,
including every extension's tsdown step. It's slower but it's the
only build that produces a packable dist tree.

---

## Local docker build

If you need to build the base image locally (not via Cloud Build), fetch
the pinned tarball first:

```bash
gcloud storage cp \
  gs://octogee-openclaw-fork/openclaw-fork-<sha>.tgz \
  infra/gateway/openclaw-tarball/openclaw-fork.tgz --project=octogee
docker build -f infra/gateway/Dockerfile.base .
```

---

## Reverting to upstream npm

When the patches all land upstream and we no longer need a fork:

1. Delete the `COPY …` + `RUN npm install -g /tmp/openclaw-fork.tgz` block
   in `Dockerfile.base` and restore `RUN npm install -g openclaw@${OPENCLAW_VERSION}`.
2. Delete the `fetch-fork-tarball` step and `_OPENCLAW_FORK_*`
   substitutions from `cloudbuild-base.yaml` *and* `cloudbuild.yaml`.
3. Drop the boot-banner `fork=` field in `infra/gateway/entrypoint.sh`.
4. Delete this directory + the GCS bucket.
