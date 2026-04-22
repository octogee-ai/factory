# OpenClaw Private Fork Tarball

`Dockerfile.base` installs OpenClaw from a local tarball at
`openclaw-fork.tgz` in this directory. The tarball is a private build of
OpenClaw with Octogee-specific patches that haven't landed upstream yet.

The `.tgz` file is gitignored. Cloud Build stages it from GCS before the
Docker build runs; local docker builds need it copied manually.

## Current patches

- **MM WebSocket keepalive ping** — `extensions/mattermost/src/mattermost/monitor-websocket.ts`
  sends `ws.ping()` every 15s (half of MM's ~30s server-side idle deadline)
  so idle WSes don't get swept by MM's read timeout. Without this, all
  coach accounts disconnect in lockstep every 2–4 minutes when the gateway
  has been idle.
  Log proof at runtime: `[octogee-patch] mattermost ws keepalive armed: pingIntervalMs=15000`
- **MM per-message latency instrumentation** — new `extensions/mattermost/src/mattermost/monitor-timing.ts`
  module plus hooks in `monitor.ts`. Emits one `[mm-timing]` log line per
  delivered (or failed) reply with span durations (ws→handle, handle→typing,
  typing→first, first→delivered). Replaces the need for
  `OPENCLAW_LOG_LEVEL=debug` + grep-a-dozen-landmarks when diagnosing
  inbound→reply latency.
  Log proof at runtime: `[mm-timing] channel=… post=… total=…ms | ws→handle=…ms | …`

## GCS bucket

Tarballs live at `gs://octogee-openclaw-fork/openclaw-fork-<short-sha>.tgz`.
The pinned SHA is tracked via `_OPENCLAW_FORK_SHA` in `cloudbuild-base.yaml`.
Object names include the short SHA so builds pin to a specific immutable
artifact — bump the substitution to roll forward.

## Rebuilding + uploading a new tarball

From the OpenClaw fork checkout (`~/workspace/openclaw/openclaw`,
branch `octogee/gateway-scaling-patches`):

```bash
pnpm install --frozen-lockfile
pnpm run build:docker
pnpm pack --pack-destination /tmp/openclaw-fork
# record the short SHA
SHA=$(git rev-parse --short HEAD)
gcloud storage cp /tmp/openclaw-fork/openclaw-*.tgz \
  gs://octogee-openclaw-fork/openclaw-fork-${SHA}.tgz --project=octogee
```

Then bump `_OPENCLAW_FORK_SHA` in `cloudbuild-base.yaml` to `$SHA` and
submit the base image build.

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
