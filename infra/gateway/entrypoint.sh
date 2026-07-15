#!/bin/sh
set -e

# OPENCLAW_DIR must be `export`ed: subprocesses (python in the openclaw.json
# re-sync block below, publish-gateway-token.mjs, openclaw itself) read it
# from their environment. Caught by independent audit on PR #1166 — the
# unexported assignment would have crash-looped every operator gateway boot
# (KeyError in the re-sync block → `set -e` exit). Same pattern as
# OPENCLAW_GATEWAY_TOKEN (L57) and GATEWAY_ID (L92).
export OPENCLAW_DIR=/home/node/.openclaw
TEMPLATES_DIR="${OCTOGEE_TEMPLATES_DIR:-/octogee/templates}"
TSX=/octogee/scripts/node_modules/.bin/tsx
GATEWAY_CLASS_EFFECTIVE="${GATEWAY_CLASS:-}"
if [ -z "$GATEWAY_CLASS_EFFECTIVE" ]; then
  if [ "${GATEWAY_PROFILE:-}" = "operator" ]; then
    GATEWAY_CLASS_EFFECTIVE="operator"
  else
    GATEWAY_CLASS_EFFECTIVE="shared"
  fi
fi

# Consistent ISO timestamp logging (matches OpenClaw gateway format)
log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000+00:00) [entrypoint] $*"
}

SUPERVISE="$TSX /octogee/scripts/entrypoints/supervise-runner.ts"
supervise_runner() {
  _name="$1"; shift
  _restart_delay_ms="$1"; shift
  (
    while true; do
      $SUPERVISE "$_name" "--restart-delay-ms=${_restart_delay_ms}" "$@" || true
      log "supervise-runner[$_name] exited — restarting in 5s..."
      sleep 5
    done
  ) &
}

# ── Boot banner ─────────────────────────────────────────────────────────────
# One grep-able line so operators can confirm what's running without
# exec'ing in to read package.json. BUILD_SHA + OPENCLAW_VERSION +
# OPENCLAW_FORK_SHA are baked in by Cloud Build. Second line proves
# runtime tuning (UV pool, V8 heap limit) actually took effect — kubectl
# sometimes shows env vars set but the Node process inherits something
# else; the heap_limit value is from V8 itself, not the env var.
log "boot: gateway-image=${BUILD_SHA:-unknown} openclaw=${OPENCLAW_VERSION:-unknown} fork=${OPENCLAW_FORK_SHA:-unknown}"
log "runtime: node=$(node -v) uv_pool=${UV_THREADPOOL_SIZE:-4-default} node_options=${NODE_OPTIONS:-unset} heap_limit=$(node -e 'console.log(Math.round(require("v8").getHeapStatistics().heap_size_limit/1024/1024)+"MB")' 2>/dev/null || echo unknown)"

# ── Ensure workspace structure exists (idempotent) ──────────────────────────
mkdir -p "$OPENCLAW_DIR/customers"
mkdir -p "$OPENCLAW_DIR/identity"
mkdir -p "$OPENCLAW_DIR/secrets"
mkdir -p "$OPENCLAW_DIR/agents"
MATTERMOST_ACCOUNT_SECRETS="$OPENCLAW_DIR/secrets/mattermost-accounts.json"
if [ ! -f "$MATTERMOST_ACCOUNT_SECRETS" ]; then
  umask 077
  printf '{}\n' > "$MATTERMOST_ACCOUNT_SECRETS"
fi
chmod 600 "$MATTERMOST_ACCOUNT_SECRETS"

# ── SSH config (host alias for Gitea — used by per-customer GIT_SSH_COMMAND) ──
# No global SSH identity file — per-customer keys are gateway-local and passed
# via GIT_SSH_COMMAND="-i {customer_key}". This prevents agents from falling
# back to a global admin key.
# Boot-sync uses brokered HTTP restore paths; no global SSH/admin identity lives
# in the gateway filesystem.
GIT_SSH_HOST="${GIT_SSH_HOST:-octogee-gitea-ssh.octogee.svc.cluster.local}"
mkdir -p "$HOME/.ssh"
cat > "$HOME/.ssh/config" <<SSHEOF
Host gitea
  HostName ${GIT_SSH_HOST}
  Port 2222
  User git
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
SSHEOF
chmod 600 "$HOME/.ssh/config"
log "SSH config written for Gitea (host: ${GIT_SSH_HOST}, no global identity file)"

# ── OpenClaw environment inputs ─────────────────────────────────────────────
export MM_URL="${MM_URL:-}"
export MM_INTERACTIONS_CALLBACK_BASE_URL="${MM_INTERACTIONS_CALLBACK_BASE_URL:-}"
export MM_INTERACTIONS_ALLOWED_SOURCE_IPS="${MM_INTERACTIONS_ALLOWED_SOURCE_IPS:-}"

# ── Require OPENCLAW_GATEWAY_TOKEN from the K8s secret ─────────────────────
# Platform-owned: Cowboy ensures the per-gateway K8s secret
# `gateway-auth-token-<gatewayId>` exists before `helm upgrade`; the chart
# threads it via secretKeyRef on init/gateway/gateway-edge. No fallback —
# absent env means the secretKeyRef binding broke or someone trimmed the
# chart's env block. Crash-loop loudly so the failure shows up in
# `kubectl describe pod` instead of silently producing a gateway that
# nobody can authenticate against.
#
# (Bender 2026-05-24 post-mortem: the previous three-tier resolver — env >
# openclaw.json > fresh random per boot — drifted on operator gateways
# where openclaw.json was edited out-of-band, and the kubectl-set-env
# workaround filling the gateway-edge gap caused field-manager collision
# that silently dropped INTERNAL_SERVICE_KEY when #1159's dedup landed.)
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  echo "████████████████████████████████████████████████████████████████" >&2
  echo "FATAL: OPENCLAW_GATEWAY_TOKEN is empty or unset." >&2
  echo "The chart's secretKeyRef → gateway-auth-token-<gatewayId> didn't" >&2
  echo "resolve. Likely causes:" >&2
  echo "  - Cowboy hasn't created the K8s secret yet (check glmGateways/<id>)" >&2
  echo "  - The chart's env block was edited to omit OPENCLAW_GATEWAY_TOKEN" >&2
  echo "  - The K8s secret was deleted out-of-band" >&2
  echo "████████████████████████████████████████████████████████████████" >&2
  exit 1
fi
export OPENCLAW_GATEWAY_TOKEN
# ── End require ────────────────────────────────────────────────────────────

# ── Source operator-customization env (local, additive) ────────────────────
# Per docs/architecture/GATEWAY-PLATFORM-SPEC.md §Operator-class customization
# surface: operator-class gateways may source a shell-readable env file at
# ~/.openclaw/secrets/operator.env for local-only credentials / integrations
# the platform doesn't manage. This file is convenience state on emptyDir,
# not a durability contract; durable operator-owned credentials belong in the
# builder/operator credential store or an explicit per-gateway Secret.
#
# Sourced after the platform require block and before OpenClaw starts, so
# operator-defined values are available to config environment substitutions.
# Position is also after kubelet's K8s
# env injection — operators can override their own gateway if they really
# want, though the design intent is additive-only.
#
# See infra/gateway/operator-env.example for format + the kubectl debug-pod
# recipe for editing the file on a running gateway's PVC.
OPERATOR_ENV="${OPENCLAW_DIR}/secrets/operator.env"
if [ -f "$OPERATOR_ENV" ]; then
  log "Sourcing operator env: $OPERATOR_ENV"
  set -a
  # shellcheck disable=SC1090
  . "$OPERATOR_ENV"
  set +a
fi
# ── End operator-env ───────────────────────────────────────────────────────

# GATEWAY_ID is set by the deployment's env block. Fail fast if it is missing.
export GATEWAY_ID="${GATEWAY_ID:?GATEWAY_ID env var is required (set via Helm values.env.gatewayId)}"

if [ "$GATEWAY_CLASS_EFFECTIVE" != "shared" ]; then
  if [ -z "${GATEWAY_BUILDER_SLUG:-}" ]; then
    log "FATAL: GATEWAY_BUILDER_SLUG is required for ${GATEWAY_CLASS_EFFECTIVE} durable config"
    exit 1
  fi
  export OPENCLAW_CONFIG_PATH="$OPENCLAW_DIR/system_config/openclaw.json"
else
  export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_DIR/openclaw.json}"
fi

rm -f "$OPENCLAW_DIR/system_config.boot-accepted"
supervise_runner system-config-status 5000 "$TSX" /octogee/scripts/entrypoints/system-config-status-server.ts

# ── Dedicated gateway system_config restore ─────────────────────────────────
# Builder/operator gateways run the tracked Gitea checkout as OpenClaw's active
# regular config file. Shared gateways keep an untracked template copy. Copy the
# raw template: OpenClaw resolves ${ENV} and SecretRefs in memory; envsubst would
# materialize credentials onto disk.
if [ "$GATEWAY_CLASS_EFFECTIVE" != "shared" ]; then
  log "Pre-boot: restoring system_config for builder slug ${GATEWAY_BUILDER_SLUG}..."
  until "$TSX" /octogee/scripts/entrypoints/system-config-restore.ts; do
    log "Pre-boot: system_config restore unavailable; repair services remain live, retrying in 5s..."
    sleep 5
  done
else
  if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
    mkdir -p "$(dirname "$OPENCLAW_CONFIG_PATH")"
    cp /octogee/infra/gateway/openclaw.template.json "$OPENCLAW_CONFIG_PATH"
    log "openclaw.json copied from raw template (gatewayId=${GATEWAY_ID})"
  fi
fi
chmod 600 "$OPENCLAW_CONFIG_PATH"

# Enforce the class-level OpenClaw policy before startup. The base template is
# shared-safe (exec/process denied, Codex disabled). Builder-class keeps the
# standard image but removes the exec/process denies for its one tenant. Operator
# class is handled later by the operator-image-only codex sandbox patch.
CLASS_POLICY=/octogee/infra/gateway/apply-gateway-class-policy.mjs
if [ "$GATEWAY_CLASS_EFFECTIVE" = "shared" ] && [ -f "$CLASS_POLICY" ]; then
  node "$CLASS_POLICY"
fi

# Publish the fresh gateway auth token to Secret Manager only when explicitly
# requested. The normal Kubernetes path keeps gateway auth pod-local:
# gateway-edge gets the same per-gateway OPENCLAW_GATEWAY_TOKEN env exception,
# uses it once to pair with OpenClaw, then persists a sidecar-only device token.
#
# The shell-bearing gateway container must not need platform Secret Manager
# reach under the platform-credential floor. Leaving this publisher as opt-in
# preserves a rollback hook for legacy deployments without making normal boots
# block on ADC/metadata or requiring a secretmanager role on the cattle GSA.
#
# Exit-code contract with publish-gateway-token.mjs:
#   0 — published successfully; boot continues
#   2 — setup-incomplete (secret missing, IAM not granted, Workload
#       Identity misconfigured). FATAL: crash-loop the pod so the
#       operator fixes setup-secrets.sh before traffic arrives at a
#       gateway chat-proxy can never authenticate against.
#   1 — transient SM error (UNAVAILABLE, DNS blip). WARN + continue;
#       the next boot retries. Gateway-local tools keep working.
#
# Skipped unless GATEWAY_AUTH_SECRET_MANAGER_PUBLISH=true/1 and GCP_PROJECT_ID
# is set.
if [ "${GATEWAY_AUTH_SECRET_MANAGER_PUBLISH:-}" = "true" ] || [ "${GATEWAY_AUTH_SECRET_MANAGER_PUBLISH:-}" = "1" ]; then
  if [ -z "${GCP_PROJECT_ID:-}" ]; then
    log "gateway auth token Secret Manager publish requested but GCP_PROJECT_ID is unset; skipping"
  else
    set +e
    node /octogee/scripts/publish-gateway-token.mjs
    PUBLISH_RC=$?
    set -e
    case "$PUBLISH_RC" in
      0)
        log "gateway auth token published to Secret Manager (gateway-auth-token-${GATEWAY_ID})"
        ;;
      2)
        log "████████████████████████████████████████████████████████████████"
        log "FATAL: GATEWAY_AUTH_PUBLISH_FAILED (setup-incomplete). Secret"
        log "shell missing, IAM missing, or Workload Identity misconfigured."
        log "Gateway cannot be authenticated by chat-proxy until this is fixed."
        log "Run: ./scripts/setup-secrets.sh --env=<env> to provision."
        log "Crash-looping pod so the failure surfaces in kubectl events."
        log "████████████████████████████████████████████████████████████████"
        exit 1
        ;;
      *)
        log "WARN: publish-gateway-token.mjs exit=${PUBLISH_RC} (transient) — chat-proxy will reject upstream WS until the next successful publish; not crash-looping since gateway can serve ops traffic meanwhile"
        ;;
    esac
  fi
else
  log "skipping gateway auth token Secret Manager publish; gateway-edge uses the in-pod OPENCLAW_GATEWAY_TOKEN/device token"
fi
# ── End gateway auth token publish ──────────────────────────────────────────

# ── Operator-profile: Claude Code first-run stamp ──────────────────────────
# Bender's PVC needed this stamped by hand on first boot — Claude's TUI
# drops into setup-wizard mode until ~/.claude.json carries
# hasCompletedOnboarding/_hasCompletedAuthFlow, even when
# `claude auth status` reports a valid max-tier login. The stamper:
#   - REQUIRES an existing ~/.claude/.credentials.json (refuses to fake
#     completion without underlying OAuth)
#   - PRESERVES every other key in ~/.claude.json
#   - is idempotent across reboots
# Operator-only by GATEWAY_PROFILE gate AND by COPY-set (only
# Dockerfile.operator-base ships the script). See
# tests/specs/stamp-claude-first-run.spec.ts.
STAMPER=/octogee/infra/gateway/stamp-claude-first-run.mjs
if [ "${GATEWAY_PROFILE:-}" = "operator" ] && [ -f "$STAMPER" ]; then
  # The stamper writes ~/.claude.json itself with 0600 — the
  # file-permission hardening block below does NOT cover it. If that
  # invariant ever moves to the entrypoint, add an explicit chmod here.
  node "$STAMPER" || log "stamp-claude-first-run: non-fatal failure"
fi

# ── Operator-profile: codex YOLO sandbox ────────────────────────────────────
# Operator-class is single-team — the gateway boundary IS the trust boundary,
# so codex's app-server runs danger-full-access + approvalPolicy=never (the
# agent acts without per-action approval prompts). Cattle gateways currently get
# the same Codex app-server posture from the template as a temporary unblock;
# this script ships ONLY in Dockerfile.operator-base and is gated on GATEWAY_PROFILE.
# Idempotent + non-fatal.
# See tests/specs/apply-operator-codex-sandbox.spec.ts.
CODEX_YOLO=/octogee/infra/gateway/apply-operator-codex-sandbox.mjs
if [ "${GATEWAY_PROFILE:-}" = "operator" ] && [ -f "$CODEX_YOLO" ]; then
  node "$CODEX_YOLO" || log "apply-operator-codex-sandbox: non-fatal failure"
fi

# ── Harden file permissions ─────────────────────────────────────────────────
# The init container sets 775 for PVC/emptyDir. Tighten sensitive files.
chmod 700 "$OPENCLAW_DIR" 2>/dev/null || true
chmod 600 "$OPENCLAW_CONFIG_PATH" 2>/dev/null || true
find "$OPENCLAW_DIR/agents" -name "sessions.json" -exec chmod 600 {} \; 2>/dev/null || true
log "File permissions hardened"

# ── Install plugin extensions (staged in image → runtime location) ──────────
# Use rsync to copy extension source files only (excludes node_modules).
if [ -d /octogee/extensions ]; then
  mkdir -p "$OPENCLAW_DIR/extensions"
  for ext_dir in /octogee/extensions/*/; do
    ext_name=$(basename "$ext_dir")
    target="$OPENCLAW_DIR/extensions/$ext_name"
    mkdir -p "$target"
    # Copy source files only (no node_modules)
    rsync -a --exclude node_modules "$ext_dir" "$target/" 2>/dev/null || \
      cp -rn "$ext_dir"*.ts "$ext_dir"*.mjs "$ext_dir"*.json "$target/" 2>/dev/null || true
    # Symlink node_modules:
    # 1. Prefer /opt/<ext-name>-deps (pre-built in base image — fast path)
    # 2. Fall back to staged /octogee/extensions/<ext>/node_modules
    # Remove stale symlink or dir first (volume may have old data from prior image)
    if [ -e "$target/node_modules" ] || [ -L "$target/node_modules" ]; then
      rm -rf "$target/node_modules"
    fi
    if [ -d "/opt/${ext_name}-deps/node_modules" ]; then
      ln -s "/opt/${ext_name}-deps/node_modules" "$target/node_modules"
      log "Extensions: symlinked ${ext_name} node_modules from base image"
    elif [ -d "$ext_dir/node_modules" ]; then
      ln -s "$ext_dir/node_modules" "$target/node_modules"
      log "Extensions: symlinked ${ext_name} node_modules from staged dir"
    fi
  done
  log "Plugin extensions installed: $(ls "$OPENCLAW_DIR/extensions" 2>/dev/null || true)"
fi

# ── Restore staged @openclaw/codex into the emptyDir ────────────────────────
# `openclaw plugins install` writes under ~/.openclaw/npm, which is an emptyDir
# at runtime (no PVC) — so the build-time install is shadowed every boot.
# The plugin tree is staged in the base image at /opt/openclaw-codex-deps;
# symlink the whole `npm` dir into place so the `codex` harness loads. Same
# /opt→emptyDir pattern as the extension node_modules symlinks above.
#
# The codex package's path within npm moves between OpenClaw releases (flat
# `node_modules/@openclaw/codex` ≤5.27; `projects/openclaw-codex-<hash>/...`
# in the 5.28 plugin refactor), so the presence check is layout-agnostic.
# We symlink the whole `npm` tree regardless of layout; loading is driven by
# openclaw.json (plugins.entries.codex.enabled) resolving the package from the
# managed npm root, not by the plugins/installs.json cache.
if find /opt/openclaw-codex-deps/npm -type d -path '*/node_modules/@openclaw/codex' 2>/dev/null | grep -q .; then
  if [ -e "$OPENCLAW_DIR/npm" ] || [ -L "$OPENCLAW_DIR/npm" ]; then
    rm -rf "$OPENCLAW_DIR/npm"
  fi
  ln -s /opt/openclaw-codex-deps/npm "$OPENCLAW_DIR/npm"
  log "Codex plugin: symlinked ~/.openclaw/npm → /opt/openclaw-codex-deps/npm"
else
  log "⚠ Codex plugin: /opt/openclaw-codex-deps absent — codex harness unavailable"
fi

# ── Pre-boot: sync env/runtime config into openclaw.json ─────────────────
# Must run on db-less builder/operator gateways too: system_config restore can
# bring back an old auth profile, but ANTHROPIC_BASE_URL is env-owned and is
# what keeps capped broker tokens from being sent directly to Anthropic.
# pre-boot-config.ts gates its optional Firestore-backed overrides internally.
if [ "$GATEWAY_CLASS_EFFECTIVE" = "shared" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  log "Pre-boot: applying env/runtime config patches..."
  "$TSX" /octogee/scripts/entrypoints/pre-boot-config.ts || log "Pre-boot: non-fatal, continuing..."
fi

if [ "$GATEWAY_CLASS_EFFECTIVE" != "shared" ]; then
  log "Pre-boot: hydrating native GitHub CLI auth from connector state..."
  timeout -k 5s 20s "$TSX" /octogee/scripts/entrypoints/github-cli-auth-hydrate.ts || log "github-cli-auth-hydrate: non-fatal failure"
fi

if [ "$GATEWAY_CLASS_EFFECTIVE" != "shared" ]; then
  export OPENCLAW_SERVICE_REPAIR_POLICY=external
  while true; do
    REPAIR_OK=true
    export OPENCLAW_DOCTOR_RESULT=ok
    log "Pre-boot: repairing and validating durable OpenClaw config..."
    if ! openclaw doctor --fix --non-interactive; then
      export OPENCLAW_DOCTOR_RESULT=error
      log "Pre-boot: OpenClaw Doctor failed; repair services remain live"
      REPAIR_OK=false
    fi
    if [ -f "$CLASS_POLICY" ] && ! node "$CLASS_POLICY"; then
      log "Pre-boot: gateway class policy failed; repair services remain live"
      REPAIR_OK=false
    fi
    if ! "$TSX" /octogee/scripts/entrypoints/pre-boot-config.ts; then
      log "Pre-boot: env/runtime reconciliation failed; repair services remain live"
      REPAIR_OK=false
    fi
    if ! "$TSX" /octogee/scripts/entrypoints/system-config-checkpoint.ts; then
      log "Pre-boot: durable config checkpoint failed; repair services remain live"
      REPAIR_OK=false
    fi
    if [ "$REPAIR_OK" = "true" ]; then
      break
    fi
    sleep 5
  done
fi

# ── Boot sync: REMOVED ───────────────────────────────────────────────────────
# Customer workspaces and OpenClaw customer entries are restored post-boot by
# the fleet controller, one customer at a time via its local HTTP endpoint.
# See docs/GATEWAY-FLEET-CONTROLLER-SPEC.md

# ── In-pod runners: supervised + observable ─────────────────────────────────
# Each remaining runner is wrapped by supervise-runner.ts, which owns respawn AND writes
# a heartbeat that runner-metrics-exporter publishes (octogee_runner_up /
# _restart_total / _last_start). The thin shell `while true` guard here only
# re-runs the supervisor itself if IT ever dies; the supervisor handles the
# child's crash-loop. Replaces the bare per-runner respawn loops, which were
# invisible to monitoring (PID 1 stays alive, so a crash-looping child never
# showed as a container restart). See GATEWAY-RUNNER-OBSERVABILITY-SPEC.md.
# The local fleet controller is db-less for every class. Cowboy owns liveness
# writes, and standard-image gateways mount customers from tenant-bound
# octogee-api broker reads rather than local Firestore credentials.
supervise_runner fleet-controller 5000 "$TSX" /octogee/scripts/entrypoints/fleet-controller.ts
if [ "$GATEWAY_CLASS_EFFECTIVE" != "operator" ]; then
  supervise_runner site-build 5000 "$TSX" /octogee/scripts/entrypoints/site-build-api.ts
else
  log "Operator site-build-api disabled: site publishing runs through trusted CI/CD, not the gateway pod"
fi
supervise_runner preview-proxy 5000 "$TSX" /octogee/scripts/entrypoints/preview-proxy.ts
if [ "$GATEWAY_CLASS_EFFECTIVE" != "operator" ]; then
  supervise_runner byosub-syncback 30000 "$TSX" /octogee/scripts/entrypoints/byosub-syncback-runner.ts
fi
if [ "$GATEWAY_CLASS_EFFECTIVE" != "shared" ]; then
  supervise_runner system-config-watch 5000 "$TSX" /octogee/scripts/entrypoints/system-config-watch.ts
fi

# ── Runner metrics exporter (all profiles) ──────────────────────────────────
# Serves /metrics on :9092 from the runner heartbeat files; one ServiceMonitor
# scrapes it. Its own thin guard — if the exporter dies, runner liveness goes
# dark, so keep it up.
(
  while true; do
    "$TSX" /octogee/scripts/entrypoints/runner-metrics-exporter.ts || true
    log "runner-metrics-exporter exited — restarting in 5s..."
    sleep 5
  done
) &

# ── Start OpenClaw gateway ──────────────────────────────────────────────────
# Single backgrounded child, no supervisor / respawn loop. OpenClaw 2026.5.x
# handles config-driven restarts internally: when chokidar detects a change
# to `openclaw.json`, openclaw forks a successor BEFORE the parent exits.
# The successor binds :18789 and serves traffic; the parent exits cleanly.
# Our entrypoint shell sees its tracked job complete but stays alive on the
# other backgrounded jobs (fleet-controller, site-build, preview-proxy, etc.) —
# so `wait` at the bottom of this script keeps the pod up.
#
# Kubernetes checks the durable config status server for liveness and OpenClaw
# :18789 for readiness. An OpenClaw failure removes the pod from service while
# leaving BuilderShell and config repair available. Failure of the repair plane
# itself restarts the pod.
log "Starting OpenClaw gateway... (build: ${BUILD_SHA:-unknown})"
touch "$OPENCLAW_DIR/system_config.boot-accepted"
chmod 600 "$OPENCLAW_DIR/system_config.boot-accepted"
openclaw gateway run --bind lan --port 18789 &

if [ "$GATEWAY_CLASS_EFFECTIVE" != "shared" ] && [ "${OPERATOR_SHELLS_ENABLED:-}" = "true" ]; then
  export BUILDER_SHELL_REQUIRE_KEY="${BUILDER_SHELL_REQUIRE_KEY:-true}"
  supervise_runner builder-shell 5000 "$TSX" /octogee/scripts/entrypoints/builder-shell-server.ts
elif [ "$GATEWAY_CLASS_EFFECTIVE" != "shared" ]; then
  log "Builder-shell disabled: runtime shell access is not enabled"
fi

# OpenClaw file-log mirror REMOVED 2026-05-18. The richer log is available
# on demand via `openclaw logs` from the running gateway, so permanently
# tailing /tmp/openclaw-*.log through an unbuffered `sed -u` to stdout was
# pure waste: continuous CPU/syscall churn plus ~2x container-stdout volume
# — a credible message-loop-latency contributor (see GATEWAY-PERFORMANCE-
# BASELINE). Do NOT reinstate an unconditional tail mirror. Proper
# root-cause follow-up: make OpenClaw log k8s-native (stdout) instead of to
# a rotating file, then no mirror is ever needed.

# ── Signal forwarding ──────────────────────────────────────────────────────
# Kubernetes sends SIGTERM → PID 1 (this sh) → our trap → SIGTERM every
# direct child → exit cleanly within the pod's terminationGracePeriodSeconds
# (default 30s). Without this trap, the shell ignores SIGTERM and k8s
# eventually SIGKILLs the pod, which drops MM WebSockets ungracefully.
shutdown() {
  # Clear the trap FIRST. `kill 0` below signals the entire process group,
  # which includes this shell — without clearing, the re-delivered SIGTERM
  # re-enters the handler and we loop (observed in 2026-04-17 rollout: the
  # entrypoint logged `received SIGTERM — forwarding to children` 6+ times
  # in the same second). Setting to '' makes subsequent signals ignored.
  trap '' TERM INT
  log "entrypoint: received SIGTERM — forwarding to children"
  kill -TERM 0 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# Block on all background jobs. `wait` with no args waits for every
# backgrounded child; our SIGTERM trap will interrupt it and run the
# shutdown handler before we exit.
wait
