# OpenClaw Private Fork Tarball

`Dockerfile.base` installs OpenClaw from a local tarball at
`openclaw-fork.tgz` in this directory. The tarball is a private build of
OpenClaw with Octogee-specific patches that haven't landed upstream yet.

The `.tgz` file is gitignored. Cloud Build stages it from GCS before the
Docker build runs; local docker builds need it copied manually.

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

**Diagnostic (carried forward to confirm no regressions; reassess each cycle):**

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

## GCS bucket

Tarballs live at `gs://octogee-openclaw-fork/openclaw-fork-<short-sha>.tgz`.
The pinned SHA is tracked via `_OPENCLAW_FORK_SHA` in `cloudbuild-base.yaml`.
Object names include the short SHA so builds pin to a specific immutable
artifact — bump the substitution to roll forward.

## Rebuilding + uploading a new tarball

From the OpenClaw fork checkout (`~/workspace/openclaw/openclaw`,
typically on a branch named `octogee/gateway-scaling-patches[-vX.Y.Z]`):

```bash
pnpm install --frozen-lockfile
pnpm build                           # full build (not build:docker — prepack needs the full dist tree)
npm pack --pack-destination /tmp/openclaw-fork --ignore-scripts
SHA=$(git rev-parse --short=8 HEAD)
gcloud storage cp /tmp/openclaw-fork/openclaw-*.tgz \
  gs://octogee-openclaw-fork/openclaw-fork-${SHA}.tgz --project=octogee
```

Then bump `_OPENCLAW_FORK_SHA` in `cloudbuild-base.yaml` to `$SHA` and
submit the base image build.

### Why `npm pack`, not `pnpm pack`

Through v2026.4.20 the RUNBOOK said `pnpm pack`. From v2026.4.24 onward
the OpenClaw `package.json` `exports` map has 309 entries and `dist/`
holds ~108k files. pnpm pack's file-inclusion check is roughly
`O(files × exports × glob_negations)` and hits catastrophic regex
backtracking — the process pegs 100% CPU with frozen memory and
identical stack across samples, never completing.

`npm pack` uses `npm-packlist` (a different algorithm) and finishes in
~5 seconds with a structurally identical tarball (~13MB, 7730 files).
This is a one-package pack (no workspace deps), so the artifacts are
file-content identical — the `package.json` `files` declaration is
what both tools honor.

`--ignore-scripts` skips the `prepack` lifecycle hook
(`scripts/openclaw-prepack.ts`), which has the same regex-walk
problem in `writeDistInventory`. The full `pnpm build` above produces
all the dist artifacts prepack would have produced — the only thing
prepack adds is `dist/postinstall-inventory.json`, which the gateway
base image doesn't consume.

### Why `pnpm build`, not `pnpm run build:docker`

`build:docker` is a partial build (`tsdown` + a few helpers) that's
faster but doesn't build every extension. If the resulting `dist/`
tree is missing files referenced by `npm pack`'s file walk you'll get
`ENOENT: lstat 'dist/extensions/<name>/index.js'` and the pack
aborts. The full `pnpm build` runs the complete build-all script,
including every extension's tsdown step. It's slower but it's the
only build that produces a packable dist tree.

## Local docker build

If you need to build the base image locally (not via Cloud Build), fetch
the pinned tarball first:

```bash
gcloud storage cp \
  gs://octogee-openclaw-fork/openclaw-fork-<sha>.tgz \
  infra/gateway/openclaw-tarball/openclaw-fork.tgz --project=octogee
docker build -f infra/gateway/Dockerfile.base .
```

## Reverting to upstream npm

When the patches land upstream:

1. Delete the `COPY …` + `RUN npm install -g /tmp/openclaw-fork.tgz` block
   in `Dockerfile.base` and restore `RUN npm install -g openclaw@${OPENCLAW_VERSION}`.
2. Delete the `fetch-fork-tarball` step and `_OPENCLAW_FORK_*`
   substitutions from `cloudbuild-base.yaml`.
3. Delete this directory + the GCS bucket.
