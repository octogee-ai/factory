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
let CI build the gateway bundle (3 sidecar images). **Cowboy is the sole
deployer** — the new image sits in Artifact Registry until the operator
triggers a rollout from the admin Gateways tab. PROD and TEST follow the
same operator-driven path.

End-to-end this takes ~25 minutes of clock time, ~5 minutes of attention.
Most of the wait is two Cloud Builds + one Release CI run.

---

## Architectural rule for this flow

> **`gateway-build.yml` produces artifacts. Cowboy deploys ALL gateway
> builds.** CI does not write Firestore, does not call helm, does not roll
> pods. Every gateway rollout — TEST and PROD — happens because an operator
> (or Cowboy reconciling an existing desired-state) requested it. This
> ritual ends at "the new SHA is in Artifact Registry"; the operator picks
> it up from the admin Gateways tab when they're ready.

Keep this in mind reading the steps below: any temptation to add a
"deploy step" or "auto-rollout step" to CI is wrong. The race conditions
that arise from CI competing with Cowboy for the helm lock are not worth
the convenience.

---

## Pre-flight

Before you start, verify:

- **Local fork checkout** at `~/workspace/openclaw/openclaw` with two remotes:
  - `origin` → `openclaw/openclaw` (upstream, read-only — used for `git fetch --tags`)
  - `ceckert` → `ceckert/openclaw` (Chris's mirror — where the `octogee/*`
    integration branches are pushed for record-keeping)
- **Working tree clean** in `~/workspace/openclaw/openclaw` (`git status`
  shows nothing pending).
- **A clean main worktree** for the octogee monorepo. The primary checkout
  at `~/workspace/octogee-ai/octogee` is often on a feature branch, and
  the `.claude/worktrees/*` paths get reassigned by other sessions. The
  reliable move is to **create a fresh worktree on `main`** at Step 14
  (`git worktree add /tmp/octogee-oc-bumps main`) and commit there. See
  the [wrong-worktree gotcha](#wrong-worktree-or-feature-branch).
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

Branch convention: **keep the `v` prefix** in the branch name (matches
every existing `octogee/gateway-scaling-patches-v*` branch on `ceckert/openclaw`).

▸
```bash
git checkout -b octogee/gateway-scaling-patches-${NEW_TAG} ${NEW_TAG}
```

✓ You're on the new branch (e.g. `octogee/gateway-scaling-patches-v2026.5.5`),
working tree clean, head at the upstream tag.

### Step 4 — Cherry-pick the prior fork stack

Oldest-first preserves history order in `git log`.

▸
```bash
git cherry-pick $(git log --format=%H ${PREV_TAG}..octogee/gateway-scaling-patches-${PREV_TAG} | tac)
```

✓ Each patch lands cleanly. Auto-merges in already-modified files are fine
— git will say `Auto-merging <file>` and continue. Manual conflict means
upstream changed something underneath the patch; resolve, `git add`,
`git cherry-pick --continue`.

### Step 5 — Audit upstream relevance

You need to know two things per patch: did upstream touch the same file,
and if so, did upstream make our patch redundant.

▸ List **only the files our cherry-picked patches touch** (NOT all upstream
files in the range — that would be ~500 commits' worth):

```bash
# Files our patches touch — compare against the upstream tag we branched from:
git log ${NEW_TAG}..HEAD --name-only --pretty=format: | sort -u | grep -v '^$'
```

▸ For each of those files, diff between the previous and new upstream tags:

```bash
git diff --stat ${PREV_TAG}..${NEW_TAG} -- <each-of-those-files>
```

▸ For files where upstream did change something, look at what:

```bash
git log ${PREV_TAG}..${NEW_TAG} --oneline -- <file>
```

▸ Keyword sweep the upstream commit log for behaviors our patches own — if
upstream landed any of these, the corresponding patch is redundant:

```bash
for kw in "isControlUiVisible" "broadcast.*agent" "surgical" \
          "per-account.*reload" "config.*patch.*hash" \
          "ws.*upgrade.*timing" "config.patch.*timing"; do
  hits=$(git log ${PREV_TAG}..${NEW_TAG} --oneline --grep="$kw" 2>/dev/null | wc -l | tr -d ' ')
  echo "  $kw: $hits hits"
done
```

✓ For each patch, decide one of:
- **Keep** — no upstream diff in the file, or the upstream diff is unrelated
  to what the patch does (auto-merge that landed cleanly is usually this case).
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
git push ceckert octogee/gateway-scaling-patches-${NEW_TAG}
```

✓ Branch pushed to `ceckert/openclaw` for record-keeping. Future audits
(`git log v...`) work without the local checkout.

### Step 11 — Bump `cloudbuild-base.yaml` (the BASE config)

In the octogee monorepo, edit `cloudbuild-base.yaml`:

- `_OPENCLAW_VERSION` → `${NEW_TAG#v}`
- `_OPENCLAW_FORK_SHA` → `$SHA`
- Update the comment block listing the patches (one line per patch with the
  new short SHAs from `git log v${NEW_TAG#v}..HEAD --oneline`).

Then **sync the `bases:` block** in `infra/gateway/oc-build-matrix.yaml`
— update the `label: canonical` entry's `version` + `forkSha` to the same
values. ⚠ This is a hard obligation: `bases:` is the single source of
truth for `scripts/rebuild-matrix-bases.sh` and the
`gateway-base-rebuild.yml` workflow. The canonical `bases:` entry MUST
equal `cloudbuild.yaml`'s `_OPENCLAW_VERSION`/`_OPENCLAW_FORK_SHA` or the
base that the gateway image FROMs won't get rebuilt. (`bases:` is a
separate top-level key from `versions:`; `gateway-build.yml` only reads
`versions:`.)

✓ Diff shows both substitution changes, the comment refresh, and the
canonical `bases:` entry updated to match.

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

### Step 12b — Rotate the previous canonical into `oc-build-matrix.yaml`

CI builds the gateway against every OC version listed in
[`infra/gateway/oc-build-matrix.yaml`](../oc-build-matrix.yaml) on every
push to main, alongside the new canonical. After a canonical bump, you
want the **previous** canonical to live there as the known-good A/B
baseline for at least one cycle, so a regression in the new canonical
is one dropdown-pick away from a comparison gateway.

Edit `infra/gateway/oc-build-matrix.yaml` — **both blocks**:

- `versions:` — add an entry for the previous canonical (`PREV_TAG#v`)
  with `label: baseline-known-good` and `required: true`. Drop the
  canonical-before-previous if still there (one baseline is enough).
  Keep beta entries (`required: false`) unless their base was deleted.
- `bases:` — add the matching base entry for that same previous canonical
  (`version` + `forkSha` + `config: cloudbuild-base.yaml`). Every
  `versions:` entry needs a `bases:` entry or its base never rebuilds.
  Conversely, drop the `bases:` entry for any version you removed from
  `versions:`.

✓ `git diff infra/gateway/oc-build-matrix.yaml` shows the previous
canonical added to **both** `versions:` and `bases:`. Commit this with
the cloudbuild bumps in Step 15 (one commit, three files).

### Step 13 — Build the base image (via the matrix-bases script)

The canonical base must exist in AR **before** Step 15's Release CI runs
— `gateway-build.yml` does `docker pull octogee-gateway-base:${_OPENCLAW_VERSION}`
for the bare `:<sha>` image, and for a fresh version that tag won't
exist yet. So you pre-build it.

**Do not hand-craft `gcloud builds submit --config cloudbuild-base.yaml`
anymore.** The single source of truth is the `bases:` block you synced
in Step 11; build from it:

▸
```bash
cd ~/workspace/octogee-ai/octogee
scripts/rebuild-matrix-bases.sh            # dry-run: prints the plan
scripts/rebuild-matrix-bases.sh --apply    # submits all base builds (async)
```

This rebuilds **every** base in the `bases:` block (canonical +
diag/beta) from the current checkout with the correct per-base config
and fork SHA. Poll until the canonical one is `SUCCESS`:

```bash
gcloud builds list --project=octogee --ongoing
# or describe-loop the specific id from the script output
```

✓ Canonical `octogee-gateway-base:${NEW_TAG#v}` is `SUCCESS` in AR
(~10 min/base, parallel-async).

> **The post-merge guardrail (don't double-kick).** Step 15's push
> touches `cloudbuild-base.yaml` + `oc-build-matrix.yaml`, which
> auto-fires `gateway-base-rebuild.yml` → another full
> `rebuild-matrix-bases.sh --apply`. That's the guardrail that makes a
> bare `Dockerfile.base`/`entrypoint.sh` edit (no version bump) safe
> *without any manual step* — just merge and it propagates. For a
> version bump the pre-merge `--apply` here is still required for the
> ordering above; the post-merge re-run is idempotent (rebuilds the
> same tags from the same commit). For a Dockerfile.base/entrypoint.sh-
> only change, skip this step entirely — let the merge auto-fire it.

### Step 14 — Stage the cloudbuild bumps on a clean main worktree

Most other steps don't care which checkout you're in, but this one does:
the bumps need to land on `main` in a worktree that has nothing else
staged. Two reasons that's tricky in practice:

1. The primary checkout (`~/workspace/octogee-ai/octogee`) is often on a
   feature branch and you'd have to disturb it.
2. Existing `.claude/worktrees/*` paths get reassigned by other sessions —
   a worktree that was on main an hour ago might not be now.

The reliable path: **create a fresh main worktree just for this commit.**

▸ If you've already edited cloudbuild files in a different (wrong) checkout,
save the diff first and restore the original files there:

```bash
# from wherever you accidentally edited:
git diff cloudbuild-base.yaml cloudbuild.yaml > /tmp/oc-bumps.patch
git checkout -- cloudbuild-base.yaml cloudbuild.yaml
```

▸ Create + use a clean main worktree:

```bash
cd ~/workspace/octogee-ai/octogee
git worktree add /tmp/octogee-oc-bumps main
cd /tmp/octogee-oc-bumps
git pull --ff-only origin main
git apply /tmp/oc-bumps.patch          # if you saved one above
# (otherwise edit cloudbuild-base.yaml + cloudbuild.yaml here directly per Steps 11-12)
```

✓ `git status` shows `cloudbuild-base.yaml`, `cloudbuild.yaml`, and
`infra/gateway/oc-build-matrix.yaml` modified on `main` (no untracked
feature-branch detritus).

### Step 15 — Commit + push the cloudbuild bumps

Per the [docs-direct-to-main](../../CLAUDE.md) pattern (build/infra config
is treated like docs), straight to main, no PR.

▸
```bash
git add cloudbuild-base.yaml cloudbuild.yaml infra/gateway/oc-build-matrix.yaml
git commit -m "chore(gateway): roll forward to OpenClaw ${NEW_TAG#v} (fork ${SHA})

[describe cherry-pick health: clean? auto-merges? upstream audit findings?]
[note any patches dropped this cycle and why]
[note diagnostic-patch decision per the policy]"
git push origin main
```

✓ Push lands on origin/main. Release CI fires automatically.

### Step 16 — Watch Release CI

`release.yml` orchestrates `gateway-build.yml`, which builds the 3 sidecar
images (gateway, workspace-api, chat-proxy) on the same SHA via matrix.
There's no deploy step — that's intentional, [see the architectural rule](#architectural-rule-for-this-flow).

▸
```bash
gh run list --branch main --limit 3 --json databaseId,name,status,headSha
gh run watch <release-run-id> --exit-status
```

✓ All steps green. The CI run ends after the matrix builds finish; the
new SHA is now in Artifact Registry as
`octogee-gateway:<short-sha>`, `octogee-chat-proxy:<short-sha>`,
`workspace-api:<short-sha>`.

The release does not roll any pods. Nothing in TEST has moved yet.

### Step 17 — Operator triggers TEST rollout via admin Gateways tab

Open `app-octogee-test.web.app/admin/gateways` (or the prod equivalent
for PROD). Find the `gw-test` row, click Rollout, pick the new SHA.
Cowboy reads the desired-state write from Firestore, runs
`helm upgrade --install octogee-gw-default --set gateway.imageTag=<sha> ...`,
and rolls the gateway pod's three containers on the new SHA.

The new pod boots with the build-baked banner:

▸
```bash
kubectl --context gke_octogee_us-central1_octogee-gateway -n octogee-test \
  logs -l app=octogee-gateway,glmInstanceName=default -c gateway --tail=2000 \
  | grep '\[entrypoint\] boot:' | tail -1
```

✓ Banner reads `gateway-image=<new-short-sha> openclaw=${NEW_TAG#v} fork=${SHA}`.

⚠ If Cowboy logs `another operation (install/upgrade/rollback) is in
progress — retry in 30000ms` repeatedly, see
[Helm pending-upgrade lock on octogee-gw-default](#helm-pending-upgrade-lock-on-octogee-gw-default).

### Step 18 — Smoke + tools sanity (TEST)

Send a coach a real message in TEST and verify the agent responds with
fresh-build markers. If you've changed any plugin-related patch (e.g.
mattermost-tools tool dispatch), now's when you confirm.

✓ Operator decides this passes.

### Step 19 — Update the patch list

Edit the [Current patches](#current-patches) section of this file with
any added/dropped/diagnostic-policy-flipped patches from this cycle.
Commit the doc update direct to main (same flow as Step 15).

✓ This file matches `git log ${NEW_TAG}..octogee/gateway-scaling-patches-${NEW_TAG}`.

### Step 20 — PROD promote (separate decision, same path)

The PROD rollout is identical to Step 17: open `app.octogee.com/admin/gateways`,
pick the SHA, click Rollout. The same gateway image SHA from Step 16 is
already in Artifact Registry; PROD just hasn't been told to use it yet.

There's no special "release to prod" CI flow — the build already happened.
Out of scope for this ritual otherwise.

### Step 21 — Cleanup the temporary worktree

▸
```bash
cd ~/workspace/octogee-ai/octogee
git worktree remove /tmp/octogee-oc-bumps
```

✓ Worktree gone, `git worktree list` no longer shows the tmp path.

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

### Wrong worktree or feature branch

**Symptom:** You committed cloudbuild bumps to a feature branch (or to a
claude-worktree that got reassigned out from under you). Push doesn't
land on main. Release CI rebuilds the same old SHA, or worse, you mix
the bumps with unrelated feature work.

**Cause:** The primary checkout at `~/workspace/octogee-ai/octogee` is
often on a feature branch. The `.claude/worktrees/*` paths get reassigned
by other sessions — a worktree that was on main when you started might
be on a feature branch by the time you're ready to commit.

**Fix:** Save your diff, restore the misplaced files, create a fresh main
worktree just for the commit (covered in Step 14 — that's the canonical
recovery, do it preventatively instead of reactively):

```bash
# wherever the cloudbuild edits ended up:
git diff cloudbuild-base.yaml cloudbuild.yaml > /tmp/oc-bumps.patch
git checkout -- cloudbuild-base.yaml cloudbuild.yaml

cd ~/workspace/octogee-ai/octogee
git worktree add /tmp/octogee-oc-bumps main
cd /tmp/octogee-oc-bumps
git pull --ff-only origin main
git apply /tmp/oc-bumps.patch
git add cloudbuild-base.yaml cloudbuild.yaml
git commit -m "..."
git push origin main

# then:
cd ~/workspace/octogee-ai/octogee
git worktree remove /tmp/octogee-oc-bumps
```

### Helm pending-upgrade lock on `octogee-gw-default`

**Symptom:** Cowboy reconciles every 30s with the same error:
```
🤠 cowboy  reconcile tick failed: (source=helm) helm upgrade --install
octogee-gw-default failed (code=1): Error: UPGRADE FAILED: another
operation (install/upgrade/rollback) is in progress — retry in 30000ms
```
TEST stays on the old SHA indefinitely. The `helm history octogee-gw-default`
shows the most recent revision in `pending-upgrade` or `pending-rollback`.

**Cause:** A previous Cowboy reconcile started a `helm upgrade` that didn't
complete — the helm release secret is still marked in-flight. Cowboy has
no lock-recovery logic; it just retries forever, and each retry hits the
same lock. (Historical note: this used to be triggered by a CI auto-rollout
step that competed with Cowboy for the lock. That step was removed in
2026-05-06; if you see this again, the trigger is something else — maybe
an admin Gateways tab click that timed out, or a network partition mid-helm.)

**Fix:** Find the last `deployed` revision and rollback to it manually.

```bash
helm --kube-context gke_octogee_us-central1_octogee-gateway -n octogee-test \
  history octogee-gw-default --max 10
# Find the most recent "deployed" status. Let's say it's revision 2:
helm --kube-context gke_octogee_us-central1_octogee-gateway -n octogee-test \
  rollback octogee-gw-default 2 --wait --timeout 5m
```

✓ A new revision lands with status `deployed (Rollback to 2)`. On Cowboy's
next tick it succeeds: `[helm-runner] upserted release=octogee-gw-default`.
The new SHA from Firestore desired-state lands; the gateway pod rolls.
Boot banner shows the new SHA within ~60-90s of the rollback.

For PROD, swap `octogee-test` for `octogee` and use `octogee-gw-default`
release in that namespace.

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

### Base build fails at `openclaw plugins install @openclaw/<x>`

**Symptom:** `octogee-gateway-base` build dies with
`FATAL: @openclaw/<plugin> install failed` →
`package install requires compiled runtime output for TypeScript entry
./index.ts`.

**Cause:** Several official OpenClaw plugins (`@openclaw/mattermost`,
historically) publish a **TypeScript-source-only** registry package with
no compiled `dist/`. OC 5.x's plugin loader rejects source-only installs
in non-dev paths. These plugins are *also shipped as bundled extensions*
in the OC dist tree (`dist/extensions/<x>/index.js`) — the registry
install was redundant. It failed **silently for months** because the old
recipe was `openclaw plugins install … | tail` and `sh` has no
`pipefail`, so `tail`'s exit code greened the layer. #979's hardening
(`exit 1` on failure) correctly surfaced the long-dead failure.

**Fix:** If the plugin is bundled (`ls dist/extensions/<x>/index.js` in
the fork checkout), the registry install is dead weight — remove that
`RUN openclaw plugins install @openclaw/<x>` block from
`Dockerfile.base`. Do **not** re-mask it with `|| true`. Confirm bundled
status before removing; a genuinely-unbundled plugin still needs a
working (compiled) install. Upstream #82425 ("repair source-only
official plugin installs") is the broader fix landing in 5.16+.

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

Authoritative source: `git log v<OPENCLAW_VERSION>..octogee/gateway-scaling-patches-v<OPENCLAW_VERSION>` in the fork checkout. As of v2026.5.12 the fork carries four patches — three essential, one diagnostic.

Short SHAs at v2026.5.12 (top of branch is `36f89b65`):
- `36f89b65` — env-gated isControlUiVisible override
- `92f5a74a` — diagnostic per-phase config.patch trace
- `88608268` — config.patch returns post-write hash
- `a2db297c` — per-account surgical channel reload

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
  See `docs/ACTIVITY-STREAM-SPEC.md` Appendix A.5 (+ the A10-amendment
  entry in `docs/decisions/DECISIONS.md`) for context + scope-discipline note.

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

Patch dropped at the v2026.5.12 roll-forward:

- **WS-upgrade timing instrumentation** (was `src/gateway/server-http.ts`) —
  diagnostic-only. The 5.7 → 5.12 jump heavily refactored `server-http.ts`
  upstream (new `resolvePluginRoutePathContext` + `checkGatewayHttpRequestAuth`
  + `VOICECLAW_REALTIME_PATH` + `preauthConnectionBudget`), and the patch's
  `__octogeeMark()` call sites no longer exist. Last carried at
  `c0f79f1b` (on `octogee/gateway-scaling-patches-v2026.5.7`). Re-port to
  the new shape if WS-upgrade timing signal becomes needed again.

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

## Preview / diagnostic A/B base builds

Use this when you need a base image that must **not** touch the
production canonical tags — beta previews (`<ver>-beta.N`), or a
diagnostic build carrying an investigation-only patch (`<ver>-diag`)
for an A/B against the known-good version.

`cloudbuild-base-beta.yaml` (committed, tracked) is the production
`cloudbuild-base.yaml` minus the `:latest` tag/push. It still pushes the
version-specific tag, so the only difference is the prod base-latest
pointer stays clean. Version labels can carry `-diag` / `-beta.N`
suffixes freely (Cloud Build substitutions don't validate them, unlike
`scripts/build-pinned-gateway.sh`'s regex).

The full A/B flow (real example: 5.12 vs 5.16-beta.6 lockup hunt):

1. **Two fork branches, identical investigation patch.** Branch each off
   its OC tag, cherry-pick the canonical stack, then cherry-pick the
   *same* diagnostic commit onto both. Identical instrumentation is what
   makes the A/B isolate the OC-version delta from instrumentation noise.
2. **Build + pack + upload + mirror** each (Steps 6–10), distinct fork
   SHAs.
3. **Register both blocks of `oc-build-matrix.yaml`** — this is now the
   driver, not a manual `gcloud builds submit`:
   - `versions:` — one entry per A/B version, `required: false`
     (diag/preview must never gate a merge; the beta base may not exist
     for an arbitrary commit).
   - `bases:` — matching entry per version: `version`, `forkSha` (the
     fork SHA from step 2), `config: cloudbuild-base-beta.yaml` (the
     no-`:latest`-clobber variant — diag/beta must not touch prod tags).
4. **Base images** — driven from the `bases:` block, not hand-crafted:
   ```bash
   scripts/rebuild-matrix-bases.sh --apply   # builds every base incl. the new A/B ones
   ```
   (Pushing the `oc-build-matrix.yaml` change also auto-fires
   `gateway-base-rebuild.yml` which runs the same thing — but build them
   pre-merge so they exist when the gateway images in step 5 need them.)
5. **Gateway images** — the `scripts/build-pinned-gateway.sh` mechanic,
   but its arg regex rejects `-beta.N`/`-diag`, so replicate it inline:
   `git archive HEAD | tar -x -C $TMP` then from `$TMP`
   `gcloud builds submit --config cloudbuild.yaml
   --substitutions=_IMAGE_TAG=<sha>-oc<ver>,_OPENCLAW_VERSION=<ver>,_OPENCLAW_FORK_SHA=<fork>`.
   (Once the `versions:` entry is merged, CI also regenerates these
   per-SHA — the inline build is just for getting the first bundle now.)
6. **Retag sidecars** (`octogee-chat-proxy`, `workspace-api`) from a main
   SHA that has them to the `<sha>-oc<ver>` bundle tag — they're
   OC-agnostic so they alias, not rebuild. Cowboy then deploys all three
   under one `imageTag`.
7. **Deploy via a canary**, never by rolling `gw-test`/`gw-prod` — Add
   Gateway in the admin Gateways tab with `imageTag=<sha>-oc<ver>`,
   migrate one customer, compare. (Cowboy is still the sole deployer.)
8. **Teardown when the investigation closes** — remove the entries from
   **both** `versions:` and `bases:` so `rebuild-matrix-bases.sh` stops
   rebuilding dead bases every cycle.

`cloudbuild-base-beta.yaml` is intentionally generic + tracked because
this pattern recurs every beta/diagnostic cycle — don't recreate it
ad-hoc.

---

## Reverting to upstream npm

When the patches all land upstream and we no longer need a fork:

1. Delete the `COPY …` + `RUN npm install -g /tmp/openclaw-fork.tgz` block
   in `Dockerfile.base` and restore `RUN npm install -g openclaw@${OPENCLAW_VERSION}`.
2. Delete the `fetch-fork-tarball` step and `_OPENCLAW_FORK_*`
   substitutions from `cloudbuild-base.yaml` *and* `cloudbuild.yaml`.
3. Drop the boot-banner `fork=` field in `infra/gateway/entrypoint.sh`.
4. Delete this directory + the GCS bucket.
