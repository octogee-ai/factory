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

### Step 5b — Agentic-harness surface audit

**Why this exists:** Step 5 only answers "do our patches still apply." It
is blind to the opposite risk — upstream *adding* a steering/observability
surface (agent thinking, tool-progress, in-flight interrupt/steer hooks,
run-lifecycle events, structured diagnostic channels) that the Octogee
sidecar + PWA activity stream *should* be riding on but isn't. The
`isControlUiVisible` / `OPENCLAW_BROADCAST_ALL_AGENT_RUNS` patch is the
proof case: one ride-along we deliberately wired. Every release adds more.
Once Octogee runs fully on OpenClaw we lose the dogfooding signal that
tells us what best-in-class steering even looks like, so a missed surface
becomes *silent*. This step forces a look every cycle.

**Cadence:** every preview-to-current promotion cycle (skip preview
refreshes — those just track upstream's pre-stable iterations on a
slot that hasn't changed semantically).
**Teeth:** purely advisory — you MUST produce + file the triage table, but
findings never gate the roll. Recording-with-eyes-on is the protection;
adoption is a separate, deliberate decision.

▸ Sweep `${PREV_TAG}..${NEW_TAG}` across the harness surfaces:

```bash
# new/changed gateway RPC verbs (control + observability surface)
git diff --stat ${PREV_TAG}..${NEW_TAG} -- \
  src/gateway/server-methods-list.ts src/gateway/method-scopes.ts src/gateway/server-methods/
# broadcast / agent-event surface (the class our isControlUiVisible patch rides)
git diff --stat ${PREV_TAG}..${NEW_TAG} -- \
  src/infra/agent-events.ts src/utils/message-channel-constants.ts src/gateway/protocol/
# ride-along observability — new structured reason codes / diagnostic channels
git diff --stat ${PREV_TAG}..${NEW_TAG} -- src/logging/
# run lifecycle / thinking / tool-progress / in-flight steering
git diff --stat ${PREV_TAG}..${NEW_TAG} -- \
  src/agents/pi-embedded-runner/ src/agents/command/
# keyword sweep of the commit log
git log ${PREV_TAG}..${NEW_TAG} --oneline --regexp-ignore-case --grep \
  -E 'broadcast|agent.?event|tool.?progress|thinking|reasoning|session_(start|end|status)|control.?ui|steer|draft|preamble|interrupt|abort|elicit'
```

▸ For every non-trivial feat() hit, check whether upstream also wired
it through to the **Control UI** (the OC production web interface at
`ui/`). The UI-landing answer is the tripwire for default action — see
the action mapping below.

```bash
# Per candidate commit, list ui/ touches:
git show --name-only --pretty=format: <commit-sha> | grep -E '^ui/'
# Or sweep the whole range for ui/ commits that mention the feature's keywords:
git log ${PREV_TAG}..${NEW_TAG} --oneline --regexp-ignore-case \
  --grep='<feature-keyword>' -- ui/
# Or fastest — grep ui/src/ for the new field/type name:
grep -rln '<NewTypeOrField>' ui/src/
```

The rule (validated on 2026-05-24 promotion cycle, 5.20→5.24-beta.1):
upstream itself follows a *harness-signal-first, UI-consumer-second*
pattern — adding a session-entry field or diagnostic event type
several releases before wiring it into the OC Web UI. So "is this
new surface user-meaningful enough that upstream consumes it
themselves" is a stronger adoption signal than "did upstream merge
the feat()." If even upstream hasn't dogfooded a new surface in their
own UI yet, our PWA absolutely shouldn't be racing them to it.

▸ For every non-trivial hit, add a row to the cycle's triage table:

| Surface | New/changed this release | UI-landed in `ui/`? | Consumed by chat-proxy/PWA today? | Steering vs. observability value | Action |
|---|---|---|---|---|---|

✓ **Action** is one of (default mapping by UI-landed status):

| Kind | UI-landed? | Default action |
|---|---|---|
| Observability feat | ❌ no | **watch** — re-check next cycle; file in backlog if persistent |
| Observability feat | ✅ yes | **adopt** — file against `docs/ACTIVITY-STREAM-SPEC.md`, wire consumer |
| Steering feat | ❌ no | **watch** |
| Steering feat | ✅ yes | **adopt-now candidate** if it's a capability we want |
| Internal tracing / infra-only | (either) | **N/A** — nothing to ride |

Override the default freely when context justifies it — a
regression-class gap is `adopt-now` regardless, a capability we'll
never use is `N/A` even with UI adoption. The default just keeps the
audit honest under churn. Do **not** spin a new spec; the
`ACTIVITY-STREAM-SPEC.md` is the canonical backlog home. Paste the
table into the roll-forward commit / PR body so the decision trail
lives with the bump.

### Step 5c — Cross-channel feature-hoist sweep

**Why this exists:** Step 5 (defensive: did our patches become
redundant) and Step 5b (harness-surface adoption) both look at
*core* gateway code. They are blind to the channel-plugin layer
upstream owns end-to-end. Telegram, Discord, Slack, iMessage, Signal,
WhatsApp, WebChat each get their own `extensions/<name>/` directory
that iterates fast on UX features — typing indicators, reaction-based
approvals, forum topics, progress drafts, model-picker pagination,
attachment commands. Mattermost is the integration **Octogee owns
end-to-end** (the `mattermost-tools` plugin lives in our repo, not
upstream's `extensions/mattermost/`). So when upstream lands a UX
feature in Telegram or Signal that has a MM-primitive analog, we want
to know — that's the "hoist candidate" backlog the PWA Activity
Stream and the MM ergonomics roadmap both feed off.

**Cadence:** every cycle (preview refresh + preview-to-current
promotion alike). Channel plugins iterate independently of OC version
semantics; even a beta-to-beta delta has signal here.
**Teeth:** purely advisory, same as Step 5b — produce the triage
table, file findings, never gates the roll.

▸ Sweep `${PREV_TAG}..${NEW_TAG}` for top-tier channel commits:

```bash
git log ${PREV_TAG}..${NEW_TAG} --oneline | grep -E \
  '^[a-f0-9]+ (feat|fix)\((telegram|discord|slack|imessage|signal|whatsapp|webchat)'
# Plus the cross-channel-pattern keyword sweep (catches things tagged
# under feat(gateway) / feat(agents) that still surface chat-UX):
git log ${PREV_TAG}..${NEW_TAG} --oneline --regexp-ignore-case --grep \
  -E 'typing|progress.?draft|reaction.?approv|forum.?topic|threading|presence|talk.?voice'
```

▸ For every non-trivial hit, add a row to the cycle's triage table:

| Commit | Channel | What it does | MM has primitive? | Hoist value | Action |
|---|---|---|---|---|---|

✓ **Hoist value rubric** (default mapping; override freely):

| Kind | MM has primitive? | Default action |
|---|---|---|
| Chat-feed UX (typing, reactions, progress drafts, presence) | yes → user_typing WS, reactions API, threads | **HIGH** — file against `docs/ACTIVITY-STREAM-SPEC.md` (or its Appendix B for live-signal additions) |
| Approval / tool-gating UX (reaction approvals, slash-command confirms) | yes → reactions API | **HIGH** — file as tool-approval backlog item (currently in `ACTIVITY-STREAM-SPEC.md`; spin a dedicated `MM-HOIST-BACKLOG.md` only if items accumulate that don't fit) |
| Channel-shape feature (forum topics, channel-of-channels) | partial → MM channels/threads | **MEDIUM** — watch; file only if upstream pattern compounds across multiple plugins |
| Setup / auth / paywall tier (owner-auth gating, native plugin install UX) | likely no analog | **N/A** — operator-tier concern, not chat UX |
| Channel-specific quirks (Telegram bot-command aliases, iMessage tapbacks without MM analog) | no | **N/A** |

Do **not** spin a new spec preemptively — `ACTIVITY-STREAM-SPEC.md` is
the canonical backlog home for chat-feed signal stuff. Create
`docs/specs/MM-HOIST-BACKLOG.md` only if signals accumulate that
genuinely don't fit there (e.g. multi-cycle pattern of channel-shape
features). Paste the table into the roll-forward commit / PR body so
the decision trail lives with the bump.

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
— update the `label: current` entry's `version` + `forkSha` to the same
values. ⚠ This is a hard obligation: `bases:` is the single source of
truth for `scripts/rebuild-matrix-bases.sh` and the
`gateway-base-rebuild.yml` workflow. The `current` `bases:` entry MUST
equal `cloudbuild.yaml`'s `_OPENCLAW_VERSION`/`_OPENCLAW_FORK_SHA` or the
base that the gateway image FROMs won't get rebuilt. (`bases:` is a
separate top-level key from `versions:`; `gateway-build.yml` only reads
`versions:`.)

✓ Diff shows both substitution changes, the comment refresh, and the
`current` `bases:` entry updated to match.

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

### Step 12b — Rotate slots in `oc-build-matrix.yaml`

We carry three rotating slots — `preview`, `current`, `previous` — in
both blocks of `oc-build-matrix.yaml`. Which slot you're touching this
cycle determines what you edit. CI builds the gateway against every
entry in `versions:` on every push to main, alongside the version
pinned in `cloudbuild.yaml`.

| Slot | What it tracks | When to touch |
|---|---|---|
| `preview` | upstream's next stable in flight (whatever upstream cuts) | refresh in place each time upstream cuts a new pre-stable; empty between cycles |
| `current` | the stable canonical (the cloudbuild.yaml `_OPENCLAW_VERSION` pin) | replaced when you promote a preview to GA |
| `previous` | the just-replaced current (rollback safety net + A/B baseline) | set at promotion time; the old `previous` is dropped at the next promotion |

`bases:` always carries entries for every slot that exists. `versions:`
carries `preview` + `previous` (gateway-build.yml excludes the
`current` version since the main `build` job already produces it as the
bare `:<sha>` image — listing it here would double-build).

**This cycle is a preview refresh** (upstream cut a new pre-stable but
`current` is unchanged):

- `versions:` — replace the existing `preview` entry's `version` (and
  if you re-cut the integration branch, you also bump `forkSha` in the
  matching `bases:` row below). Keep the `previous` entry untouched.
- `bases:` — replace the `preview` entry's `version` + `forkSha`.
  `config: cloudbuild-base-beta.yaml` stays (no `:latest` clobber).
  Keep the `current` + `previous` entries untouched.
- ⚠ Skip Step 12 entirely — `cloudbuild.yaml` does NOT change on a
  preview refresh. The whole point of `preview` is to test an upstream
  pre-stable without disturbing the production `current`.

**This cycle is a preview-to-current promotion** (upstream cut a stable
we're adopting):

- `versions:` — DROP the entry for the old `previous` (no longer
  needed), CHANGE the old `previous` entry to track what was `current`
  (its row already exists if `current` was rotated in correctly last
  cycle — otherwise add it now), and DROP the entry for the new
  `current` (which is what `preview` was — gateway-build.yml will
  exclude it via the cloudbuild.yaml pin).
- `bases:` — drop the old `previous` row; relabel the old `current` row
  to `previous`; relabel the old `preview` row to `current` and switch
  its `config:` from `cloudbuild-base-beta.yaml` to `cloudbuild-base.yaml`
  (now that it gets `:latest`). Keep its `version` + `forkSha`.
- Step 12 IS required this cycle — `cloudbuild.yaml` and
  `cloudbuild-base.yaml` both bump to the promoted version + fork SHA.

**This cycle is a fork-only refresh on the current slot** (we changed
patches without bumping the upstream OC tag):

- Bump `_OPENCLAW_FORK_SHA` in `cloudbuild.yaml` + `cloudbuild-base.yaml`
  (Step 12 still required), bump the `forkSha` field in the `current`
  row of `bases:`. `versions:` doesn't change (no version-string move).

✓ `git diff infra/gateway/oc-build-matrix.yaml` shows only the slots
you intended to move. Commit with the cloudbuild bumps (if any) in
Step 15 (one commit).

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

This rebuilds **every** base in the `bases:` block (`current` +
`previous` + `preview`, plus any ad-hoc diag entries) from the current
checkout with the correct per-base config and fork SHA. Poll until the
`current` slot's base is `SUCCESS`:

```bash
gcloud builds list --project=octogee --ongoing
# or describe-loop the specific id from the script output
```

✓ `octogee-gateway-base:${NEW_TAG#v}` (the `current` slot's version) is
`SUCCESS` in AR (~10 min/base, parallel-async).

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
>
> **Fork-only bumps are safe too (freshness gate).** The base build
> pushes a fork-qualified sentinel
> `octogee-gateway-base:${NEW_TAG#v}-fork-<forkSha>` alongside the bare
> `:${NEW_TAG#v}`. `gateway-build.yml`'s `current`-slot poll-gate waits for
> *that sentinel*, not the bare version tag — so a fork-SHA-only bump
> (version unchanged → bare tag already exists, stale) still blocks the
> gateway build until the new-fork base actually lands, instead of
> building FROM the stale base. Closed the gap #990's existence-only
> gate left for no-version-bump cycles (the 2026.5.18 `6ed39d7e` case).

> **Flake recovery — `prebake-model.mjs` HF connect-timeout.** The base
> build downloads the octogee-router embedding model (`Xenova/all-MiniLM-L6-v2`)
> from the HF CDN at build time. Cloud Build egress to that CDN
> occasionally connect-times-out, failing one base in the set with
> `prebake-model.mjs … TypeError: fetch failed … ConnectTimeoutError`.
> It's transient and tends to hit a *different* base each run. Recovery:
> re-run the failed job — `gh run rerun <gateway-base-rebuild-run-id> --failed`
> — and re-watch; already-SUCCESS bases are cache-skipped, so reruns
> converge. As of the 6.9-beta.1 cycle `prebake-model.mjs` retries the
> download 5× with backoff, so this should now be rare; the re-run recipe
> stands if it slips through.
>
> **Flake recovery — base build `TIMEOUT` on `RUN npm install -g …fork.tgz`
> (Step 6/23).** Distinct from the HF prebake flake above: this one times
> out at the 30m wall-clock on the *fork-tarball npm install*, not the
> model download. Seen on the 6.9 GA promotion when `rebuild-matrix-bases.sh
> --apply` fired all three bases at once — registry/network contention
> stalled one `npm install -g` while the other two sailed through (same
> Dockerfile, so it's the environment, not the build). Recovery: re-submit
> **only** the timed-out slot so it builds alone, using the script's own
> invocation with the **real** computed hash (NOT a bare manual build — see
> next note). Get the hash from the dry-run (`scripts/rebuild-matrix-bases.sh`),
> then:
> ```bash
> gcloud builds submit --async --project=octogee \
>   --config="$PWD/cloudbuild-base.yaml" \
>   --substitutions="_OPENCLAW_VERSION=<ver>,_OPENCLAW_FORK_SHA=<fork>,_BASE_INPUT_HASH=<computed-hash>"
> ```
> Solo it flies (~6-8m). The post-merge `gateway-base-rebuild` guardrail
> re-fires all three on push regardless — if it re-flakes there it's
> cosmetic, since the pre-built hash-stamped bases already satisfy the
> Release's poll-gate.
>
> **Do NOT trust a manual `gcloud builds submit --config cloudbuild-base.yaml`
> as the base for a Release.** It stamps the sentinel `_BASE_INPUT_HASH`
> as `manual` → `…-base-manual`, but `gateway-build.yml` waits for the
> *computed* hash `sha256sum(Dockerfile.base, <base-config>, oc-build-matrix.yaml)`.
> A manual build's `-base-manual` tag is invisible to that wait, so the
> Release still times out (the GA-Day-cycle outage: a flaked
> `gateway-base-rebuild` left no hash-stamped current base, and the manual
> pre-builds didn't count toward the wait). `rebuild-matrix-bases.sh`
> computes the real hash; the push-triggered `gateway-base-rebuild.yml` is
> the canonical producer. The manual command is for throwaway local probes
> only — never as the pre-merge gate.

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
images (gateway, gateway-edge, chat-proxy) on the same SHA via matrix.
There's no deploy step — that's intentional, [see the architectural rule](#architectural-rule-for-this-flow).

▸
```bash
gh run list --branch main --limit 3 --json databaseId,name,status,headSha
gh run watch <release-run-id> --exit-status
```

✓ All steps green. The CI run ends after the matrix builds finish; the
new SHA is now in Artifact Registry as
`octogee-gateway:<short-sha>`, `octogee-chat-proxy:<short-sha>`,
`gateway-edge:<short-sha>`.

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
mattermost-tools tool dispatch), now's when you confirm. If you touched
codex staging (`Dockerfile.base`/`entrypoint.sh`), confirm the entrypoint
logged `Codex plugin: symlinked …` (not the `⚠ … absent` branch) and
`openclaw plugins doctor` is clean in the pod.

⚠ **Distrust a bad *build*, not the version.** A gateway image that
crash-loops is almost always a build-specific delta (a transitive npm
dep, the fork SHA, base-image drift) — not the OpenClaw version itself.
The boot banner is the authoritative version check; a sibling registry
tag can lie. The historical crash-mode was the SIGUSR1 config-reload race
(a pod that booted clean still crash-looped *after* a reload-triggered
restart); 5.27+ defers that restart until idle, which largely de-fanged
it, but the stance is unchanged: watch the pod stay up under real
workload, and *minimize* reloads rather than manufacturing one to
certify. If it does crash-loop, capture the process title before rolling
back:
```bash
kubectl --context gke_octogee_us-central1_octogee-gateway -n octogee-test \
  exec deploy/octogee-gateway-default -c gateway -- \
  sh -c 'cat /proc/*/cmdline 2>/dev/null | tr "\0" " " | grep -i openclaw'
```

✓ Operator decides this passes.

### Step 19 — Update the patch list (only when the `current` slot changes)

[Current patches](#current-patches) anchors to the `current` slot's
SHAs, not the `preview` slot's. Edit it only when this cycle touched
`current` — i.e. a preview-to-current promotion, a fork-only refresh
on `current`, or an actual patch add/drop/policy-flip. **Skip on a pure
preview refresh** (preview-slot SHAs live in `oc-build-matrix.yaml`'s
preview entry; the integration branch on ceckert is authoritative).
Commit the doc update direct to main (same flow as Step 15).

✓ When applicable: this file matches `git log ${NEW_TAG}..octogee/gateway-scaling-patches-${NEW_TAG}` for the `current` slot's `NEW_TAG`.

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

### Base build fails at codex staging (`@openclaw/codex missing from staged /opt tree`)

**Symptom:** `octogee-gateway-base` build dies at the codex step with
`FATAL: @openclaw/codex missing from staged /opt tree` — but the line
just above shows `Installed plugin: codex` (the install itself
*succeeded*). Distinct from the source-only failure above: here the
install works, the *staging assertion* fails.

**Cause:** `openclaw plugins install`'s on-disk layout is an upstream
impl detail that **moves between releases**. ≤5.27 placed the package
flat at `~/.openclaw/npm/node_modules/@openclaw/codex`; the 5.28
plugin-subsystem refactor (84 files / +5302 LOC) moved it to a per-plugin
project dir `~/.openclaw/npm/projects/openclaw-codex-<hash>/node_modules/@openclaw/codex`
and added a generated `~/.openclaw/plugins/installs.json` registry. A
staging assertion (or entrypoint restore guard) hard-coded to the old
path breaks the moment upstream reshuffles. Caught on the 5.28-beta.2
preview (2026-05-29); alpha.1 had built fine days earlier on the same
Dockerfile — pure upstream drift.

**Fix (already in place — `Dockerfile.base` + `entrypoint.sh`):** both
the staging assertion and the runtime restore guard use a
**layout-agnostic** check — `find <staged-npm> -type d -path
'*/node_modules/@openclaw/codex' | grep -q .` — and stage/symlink the
**whole** `~/.openclaw/npm` tree, so whatever layout comes along is
carried. If this fails *again* it's a package rename/scope change, not a
path-depth change (the `find` already handles arbitrary nesting). The
base build's codex step is now self-validating: a green base build proves
the staging.

**Runtime fact — don't re-derive:** codex loads at runtime from
`openclaw.json` (`plugins.entries.codex.enabled: true`) resolving the
package from the npm managed-root — **NOT** from `plugins/installs.json`.
That registry is a lazy cache (regenerated on demand; absolute-path +
content-hash specific); it is **not staged, not restored, and not
required** for the harness to load. Only the `npm` tree needs to survive
the runtime emptyDir, which the existing whole-`npm` symlink already does.

**Verify a staging change cheaply (no full gateway build needed):**
`kubectl run` a throwaway pod on the freshly-built base image in
`octogee-test`, run the entrypoint's `find` guard + the symlink into a
fake `$HOME/.openclaw` + a minimal `openclaw.json` that enables codex,
then `openclaw plugins doctor` / `openclaw plugins list | grep codex`
(expect "No plugin issues detected" + codex `enabled`, resolving from the
`projects/` path). Use `--restart=Never` + poll + `logs`, **not**
`-i --rm` — the attach times out during the large base-image pull and
kills the pod before it runs.

### Base build times out (~10m cliff)

**Symptom:** `octogee-gateway-base` (or the gateway image) build fails
with a Cloud Build timeout right around 10 minutes.

**Cause:** The OpenClaw runtime build grew over time (the 5.28 plugin
refactor + added deps); base builds drifted from comfortably-under-10m to
landing right at the old `timeout: "600s"` cliff.

**Fix (already in place):** all three build configs carry `timeout:
"1800s"` (30m headroom) — `cloudbuild-base.yaml`, `cloudbuild-base-beta.yaml`,
`cloudbuild.yaml`. This is a legitimate "the build got bigger" bump, not a
threshold-dodge (the builds succeed, they just need wall-clock). If you
see timeouts again, the build grew further — bump the headroom, don't
shave the build.

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

Authoritative source: `git log v<OPENCLAW_VERSION>..octogee/gateway-scaling-patches-v<OPENCLAW_VERSION>` in the fork checkout. As of v2026.6.9 GA (current, fork-refreshed to `72f6897f`) the fork carries **seven logical essential patches across nine commits, zero diagnostics** (Hunks A+B of the activity harness-signal feature count as one logical patch, delivered as two commits + a 5.22-introduced allowlist extension that adopts upstream's message-lifecycle / turn-start diagnostic event types under the same env gate; carried forward through every cycle since). Top is the device-token self-pairing-lockdown security patch; the mattermost connect-log ✅ marker (operator-visibility patch) is mirrored across all slots so the marker shows up regardless of which OC version a gateway runs — explicitly kept per operator preference ("it brings me joy"; single-line log delight in dense boot/reschedule logs).

Live short SHAs at v2026.6.9 GA (top of current's integration branch is `72f6897f` after the 2026-06-23 fork-SHA-only refresh) — these rotate every cycle since cherry-pick creates new commits each time; the "Essential" section below cites the **original introduction** commit IDs for provenance:
- `72f6897f` — exempt trusted control-plane (`usesSharedGatewayAuth`) from the config.patch write rate-limit
- `6f734689` — device-token self-pairing lockdown (narrows local-backend bypass to `authMethod === "device-token"`)
- `1e13a9b0` — Hunk A allowlist extension: adopt 5.22 message-lifecycle + turn-start events
- `29a7bdfe` — mattermost connect log: ✅ marker for operator visibility on GW startup
- `142a1676` — activity harness-signal Hunk B: session-correlated execution-phase
- `98c5d057` — activity harness-signal Hunk A: env-gated diagnostic-event broadcast
- `45a34441` — env-gated isControlUiVisible override
- `c613bbd9` — config.patch returns post-write hash
- `7b6aa559` — per-account surgical channel reload

The Hunk B execution-phase wrap now lives at `src/agents/embedded-agent-runner/run.ts` — upstream renamed `pi-embedded-runner` to `embedded-agent-runner` before 6.9; the cherry-pick rides the rename. WATCH (6.9): upstream GA-landed a `security.event` diagnostic type (`DiagnosticSecurityEvent`, emitted from our own `message-handler.ts`) — adjacent to the device-token patch but **not** session-correlated and not UI-landed, so left un-adopted; a session-correlated variant would be a Hunk-B-style adopt candidate for a PWA security feed.

Per-slot top SHAs:

| Slot | Version | Fork SHA |
|---|---|---|
| current | 2026.6.9 (GA) | `72f6897f` |
| previous | 2026.6.8 (GA) | `c13e804a` |
| preview | 2026.6.10-beta.1 | `13add4e3` |

**Essential:**

- **Trusted control-plane `config.patch` rate-limit exemption** (introduced
  `72f6897f`, 2026-06-23) — `src/gateway/server-methods.ts` (the control-plane
  write gate) + `usesSharedGatewayAuth?` surfaced on `GatewayClient`
  (`server-methods/shared-types.ts`, sibling to the existing `isDeviceTokenAuth`).
  `config.patch` from a connection that authenticated with the shared gateway
  control-plane token (`client.usesSharedGatewayAuth === true` — server-set at
  the connect handshake, the same signal `server-shared-auth-generation`
  already gates on; **not** the spoofable self-reported actor/`client.id`)
  skips the 3/60s control-plane write cap. The in-pod provisioner fires one
  idempotent `config.patch` per customer when a blue/green roll mounts N at
  once; the cap throttled that to ~1 write/48s, serializing the roll at
  ~48s/customer for a non-problem — the config-write/reload storm it guards is
  already neutralized for these writes by our per-account surgical channel
  reload + `config.patch` post-write-hash (no-op skip) patches (live TEST: hot
  ~0.5s reloads, zero WS drops). Narrow: only `config.patch` **and**
  `usesSharedGatewayAuth`; every untrusted caller (device-token, anonymous)
  and every other control-plane write keeps the cap, and `config.patch` is
  already `operator.admin`-scoped. **Supersedes** the deleted "control-plane
  write rate-limit configurable" patch — grant the bypass to the trusted local
  system, don't re-make the cap configurable. **Not** diagnostic-only.

- **Activity harness-signal for sidecar bridges (Hunks A+B)** — one
  logical essential feature, two commits, single env gate
  `OPENCLAW_BROADCAST_DIAGNOSTIC_EVENTS=1` (default-off → vanilla
  byte-identical). Closes the OC-side precondition for
  `ACTIVITY-STREAM-SPEC.md` Appendix B B-P1-1 (+ B-P1-2 via Hunk B). Same
  class/justification as `isControlUiVisible`; **not** diagnostic-only,
  **not** subject to the carry-then-drop policy. Contract:
  `docs/specs/ACTIVITY-HARNESS-SIGNAL-SPEC.md` §1.
  - **Hunk A — env-gated diagnostic broadcast** (originally introduced as `f1ae7fe8` on the 2026.5.18 integration branch; live SHA on the current branch is in the short list above):
    `src/gateway/server-runtime-subscriptions.ts` (+ `server-broadcast.ts`
    scope guard; `diagnosticUnsub` threaded through the shutdown bundle in
    `server-runtime-handles.ts` / `server.impl.ts` / `server-close.ts`,
    symmetrical with `heartbeatUnsub`). An allowlisted slice of the
    in-process diagnostic taxonomy (`session.long_running|stalled|stuck`,
    `session.recovery.requested|completed`, `tool.loop`,
    `session.execution_phase` — all sessionKey-bearing) re-emitted as a
    new top-level `diagnostic` broadcast `{ sessionKey, type, ts, data }`,
    scope `[READ_SCOPE]` (symmetrical with `sessions.changed`). Vanilla OC
    keeps this taxonomy in-process with no WS surface; the chat-proxy
    sidecar is the intended consumer (the "is the agent stuck / what's it
    waiting on" feed). Default-off → no listener registered.
  - **Hunk B — session-correlated execution-phase** (originally introduced as `6ed39d7e` on the 2026.5.18 integration branch; live SHA on the current branch is in the short list above):
    OC's native `diagnostic.phase.completed` has no `sessionKey` and its
    trace context is OTel-only — uncorrelatable from the sidecar. Adds an
    additive `DiagnosticSessionExecutionPhaseEvent` (type
    `session.execution_phase`, explicit `sessionKey?`) to the
    `DiagnosticEventPayload` union (no existing type changes) + one gated
    wrap on `params.onExecutionPhase` in
    `src/agents/pi-embedded-runner/run.ts` (immediately after the
    `effectiveSessionKey` reassign, mirroring that idiom — covers run.ts
    `notifyExecutionPhase` and the direct `attempt.ts` calls, all of which
    read `params.onExecutionPhase`). Default-off → params untouched. The
    new type is in Hunk A's allowlist so it rides the same `diagnostic`
    broadcast (B-P1-2's live phase/plan timeline).

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

  Consumer-side contract for `config.patch` (merge semantics, the upstream
  destructive-array guard, `replacePaths` conventions all monorepo callers
  must follow): `docs/architecture/OPENCLAW-CONFIG-PATCH.md`. On rolls,
  check upstream diffs to `server-methods/config.ts` /
  `config/patch-replace-paths.ts` against that doc — the guard's path
  grammar is load-bearing for provisioning (mount/evict/migrate all
  break loudly if it drifts; see PR #1458).

**Diagnostics — none.** All diagnostic patches dropped at the v2026.5.18
fresh reset:

- **Per-phase `config.patch` timing instrumentation** — dropped. No open
  investigation; carried many cycles with no signal needed. Last on
  `octogee/gateway-scaling-patches-v2026.5.16-beta.6` (`5606fd35`).
- **MM start-account lifecycle trace** — dropped. Its investigation (the
  `channels.mattermost.start-account` ~225s wedge + duplicate reply) is
  **resolved upstream in 5.18**: #82592 (bound traced channel startup
  handoff + abort guard) and #82346 (logout aborting active runs) are
  both in this release. Instrumenting a problem fixed upstream is dead
  weight. Last on `…-v2026.5.16-beta.6` (`36795ce3`); re-add only if the
  wedge recurs on 5.18 in prod.
- **WS-upgrade timing instrumentation** — dropped earlier at v2026.5.12
  (the 5.7→5.12 `server-http.ts` refactor removed its `__octogeeMark()`
  call sites). Last carried at `c0f79f1b` (`…-v2026.5.7`).

Per the [diagnostic-patch policy](#diagnostic-patch-policy): re-port any
of these to the current tree only if a fresh investigation needs the
signal. Patch-free vanilla 5.18 was evaluated as a matrix preview and
rejected — all 3 essentials remain required (surgical reload's N-tenant
reconnect blast-radius is not mooted by fast SIGUSR1; isControlUiVisible
is functional for the PWA activity stream, not perf).

Patches deleted at the v2026.4.29 roll-forward (kept in git history on
`octogee/gateway-scaling-patches-v2026.4.24` and `-v2026.4.25` if you need
to spelunk):

- MM WebSocket keepalive ping → landed upstream as `0e97f962ac` (#73979).
- AJV plugin defaults leaking into `event.sourceConfig` (the SIGUSR1-on-mount cascade) → landed upstream as `057b8276cc` (#73267) in v2026.4.28.
- Channel/sidecar startup-handshake hang (4.25/4.26 blocker) → landed upstream as `8d58ad4c15`.
- MM per-message latency instrumentation + emit-timing-summary-on-settle — diagnostic-only, dropped now that the bugs they helped chase are fixed.
- Control-plane write rate-limit configurable — never deployed. **Superseded** (2026-06-23, `72f6897f`) by the active "trusted control-plane config.patch rate-limit exemption" essential above: instead of making the cap configurable, we exempt the trusted local control-plane (`usesSharedGatewayAuth`) from the config.patch cap and keep 3/60s for everyone else.

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

## Ad-hoc A/B base builds (diagnostic experiments)

The `preview` slot (see Step 12b) handles the routine "upstream cut a
pre-stable" case. This section covers the **ad-hoc diagnostic** case:
you need an extra base image carrying an investigation-only patch
(`<ver>-diag`) for an A/B against the `current` slot — something
beyond what the three named slots cover.

Both this flow and the `preview` slot share `cloudbuild-base-beta.yaml`
(committed, tracked) — the production `cloudbuild-base.yaml` minus the
`:latest` tag/push. It still pushes the version-specific tag, so the
only difference is the prod base-latest pointer stays clean. Version
labels can carry `-diag` / `-beta.N` suffixes freely (Cloud Build
substitutions don't validate them, unlike
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
6. **Retag sidecars** (`octogee-chat-proxy`, `gateway-edge`) from a main
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
4. Delete this directory + the GCS bucket (note: the bucket also holds
   `router-deps-*.tgz` objects — see the cross-link below).

---

## See also

The same `gs://octogee-openclaw-fork/` bucket also holds the
**octogee-router dep tree cache** — `router-deps-<sha8>.tgz`, keyed by
`sha256(package-lock.json)[:8]`. Same fetch pattern (parallel step in
`cloudbuild-base.yaml`), separate bump ritual at
[../extensions/octogee-router/README.md](../extensions/octogee-router/README.md).
Whenever you `npm install` something in that package, run
`scripts/pack-router-deps.sh` before pushing or the next base build
404s on the new cache key.
