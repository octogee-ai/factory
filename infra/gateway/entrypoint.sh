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

# Consistent ISO timestamp logging (matches OpenClaw gateway format)
log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000+00:00) [entrypoint] $*"
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

# ── Bootstrap openclaw.json from env vars ───────────────────────────────────
# Always regenerate on boot — no stale config from prior deploys.
# envsubst replaces ${VAR} placeholders in the template. One line. No sed.
export MM_BOT_TOKEN="${MM_BOT_TOKEN:-}"
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

# ── Source operator-customization env (PVC-resident, additive) ─────────────
# Per docs/architecture/GATEWAY-PLATFORM-SPEC.md §Operator-class customization
# surface: operator-class gateways (PVC home) get a single shell-sourceable
# env file at ~/.openclaw/secrets/operator.env for additional credentials /
# integrations the platform doesn't manage (personal Discord bots, custom
# MCP credentials, personal API keys). Helm-invisible, survives every
# reschedule via PVC. First proven on gw-bender 2026-05-24 when the Discord
# bot token rehome needed a place to live that didn't require a platform-
# wide K8s Secret edit.
#
# Sourced AFTER the platform require block but BEFORE envsubst on
# openclaw.template.json, so operator-defined values can populate the
# template on a first-boot gateway. Position is also AFTER kubelet's K8s
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

# GATEWAY_ID is set by the deployment's env block; `export` makes it visible
# to envsubst below. Fail fast if it's missing — the template references it
# and a silently-empty substitution would yield `octogee-ops-` as the agent
# id (broken on both the K8s side and OpenClaw's agent routing).
export GATEWAY_ID="${GATEWAY_ID:?GATEWAY_ID env var is required (set via Helm values.env.gatewayId)}"
if [ ! -f "$OPENCLAW_DIR/openclaw.json" ]; then
  envsubst < /octogee/infra/gateway/openclaw.template.json > "$OPENCLAW_DIR/openclaw.json"
  chmod 600 "$OPENCLAW_DIR/openclaw.json"
  # Do NOT log any substring of $OPENCLAW_GATEWAY_TOKEN — this is the live
  # cross-service auth credential. The gatewayId is the correlator ops
  # people use to match pod ↔ SM secret ↔ heartbeat doc.
  log "openclaw.json generated from template (gatewayId=${GATEWAY_ID})"
else
  log "openclaw.json already exists — preserving (provisioner is source of truth)"

  # ── Re-sync openclaw.json gateway.auth.token from env (PVC drift fix) ──
  # Closes the chicken-and-egg gap discovered on gw-bender 2026-05-24:
  # the K8s secret gateway-auth-token-<id> can rotate, the env var picks
  # up the new value, but openclaw's own AJV-defaults round-trip
  # periodically re-persists openclaw.json's gateway.auth.token field.
  # On first boot openclaw reads OPENCLAW_GATEWAY_TOKEN env directly
  # (openclaw.template.json has no token placeholder for envsubst — the
  # template only sets gateway.auth.mode) and AJV persists it. Once
  # that persisted field goes stale relative to env, openclaw
  # authenticates with the old token while provisioner + chat-proxy use
  # the new one — auth fails forever, and the only fix path
  # (config.patch) itself requires valid auth. The K8s secret is the
  # source of truth (#1160); make the PVC field follow it on every
  # boot. python3 is always in the gateway image; avoids a jq dep.
  # Inline -c with single quotes so the script eval-substitutes cleanly
  # (heredoc inside eval "$(...)" parses oddly across sh implementations).
  python3 -c 'import json, os
p = os.environ["OPENCLAW_DIR"] + "/openclaw.json"
with open(p) as f:
    c = json.load(f)
c.setdefault("gateway", {}).setdefault("auth", {})["token"] = os.environ["OPENCLAW_GATEWAY_TOKEN"]
tmp = p + ".tmp"
with open(tmp, "w") as f:
    json.dump(c, f, indent=2)
os.replace(tmp, p)
'
  chmod 600 "$OPENCLAW_DIR/openclaw.json"
  log "openclaw.json gateway.auth.token re-synced from env"
  # ── End re-sync ────────────────────────────────────────────────────────
fi
# Secret rotation / reconciliation (env-sync) happens later via pre-boot-config.ts
# — nothing else fixed up here. The template is canonical; don't re-derive.

# Publish the fresh gateway auth token to Secret Manager so cattle chat-proxy
# can open authenticated upstream WS connections.
#
# Operator gateways intentionally run without platform Secret Manager access.
# Their gateway-edge sidecar is in the same pod and receives the same
# OPENCLAW_GATEWAY_TOKEN from the per-gateway K8s secret, so it authenticates
# locally from env instead of requiring the shell-bearing gateway container to
# mint/read platform SM versions at boot.
#
# Exit-code contract with publish-gateway-token.mjs:
#   0 — published successfully; boot continues
#   2 — setup-incomplete (secret missing, IAM not granted, Workload
#       Identity misconfigured). FATAL: crash-loop the pod so the
#       operator fixes setup-secrets.sh before traffic arrives at a
#       gateway chat-proxy can never authenticate against.
#   1 — transient SM error (UNAVAILABLE, DNS blip). WARN + continue;
#       the next boot retries. Ops agents keep working.
#
# Skipped when GCP_PROJECT_ID is unset (docker-compose local dev), or when the
# operator profile is active (locked KSA, no platform SM access).
if [ "${GATEWAY_PROFILE:-}" = "operator" ]; then
  log "operator profile: skipping gateway auth token Secret Manager publish; gateway-edge uses the in-pod OPENCLAW_GATEWAY_TOKEN"
elif [ -n "${GCP_PROJECT_ID:-}" ]; then
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

# ── Provision ops-agent workspace + agent dirs ──────────────────────────────
# Workspace (SOUL.md et al.) is shared across all gateways — it's the ops
# agent's personality and runbook, not per-gateway state.
# agentDir (agents/octogee-ops-{gatewayId}/{agent,sessions}) IS per-gateway
# and must exist before OpenClaw boots, otherwise the doctor silently
# creates `sessions/` later and logs it as a reconciliation event.
OPS_AGENT_ID="octogee-ops-${GATEWAY_ID}"
OPS_WS="$OPENCLAW_DIR/workspace/ops"
OPS_AGENT_DIR="$OPENCLAW_DIR/agents/$OPS_AGENT_ID"
if [ ! -f "$OPS_WS/SOUL.md" ] && [ -d "$TEMPLATES_DIR/ops-workspace" ]; then
  log "Setting up ops-agent workspace from templates..."
  mkdir -p "$OPS_WS"
  cp -n "$TEMPLATES_DIR/ops-workspace/"*.md "$OPS_WS/" 2>/dev/null || true
  mkdir -p "$OPS_WS/memory"
fi
# agentDir/sessions must pre-exist — OpenClaw's doctor treats a missing
# sessions dir as a repair. Create both before boot so doctor sees a clean
# tree on first start.
mkdir -p "$OPS_AGENT_DIR/agent" "$OPS_AGENT_DIR/sessions"

# ── SSH config (host alias for Gitea — used by per-customer GIT_SSH_COMMAND) ──
# No global SSH identity file — per-customer keys are generated by the provisioner
# and passed via GIT_SSH_COMMAND="-i {customer_key}". This prevents agents from
# falling back to a global admin key.
# Boot-sync uses HTTP clone with admin token for initial workspace restore.
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
# Dockerfile.operator ships the script). See
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
# this script ships ONLY in Dockerfile.operator and is gated on GATEWAY_PROFILE.
# Idempotent + non-fatal.
# See tests/specs/apply-operator-codex-sandbox.spec.ts.
CODEX_YOLO=/octogee/infra/gateway/apply-operator-codex-sandbox.mjs
if [ "${GATEWAY_PROFILE:-}" = "operator" ] && [ -f "$CODEX_YOLO" ]; then
  node "$CODEX_YOLO" || log "apply-operator-codex-sandbox: non-fatal failure"
fi

# ── Harden file permissions ─────────────────────────────────────────────────
# The init container sets 775 for PVC/emptyDir. Tighten sensitive files.
chmod 700 "$OPENCLAW_DIR" 2>/dev/null || true
chmod 600 "$OPENCLAW_DIR/openclaw.json" 2>/dev/null || true
find "$OPENCLAW_DIR/agents" -name "sessions.json" -exec chmod 600 {} \; 2>/dev/null || true
log "File permissions hardened"

# ── Install plugin extensions (staged in image → runtime location) ──────────
# Use rsync to copy extension source files only (excludes node_modules).
# node_modules are symlinked from /opt/octogee-router-deps (pre-built in base
# image) so the 1.2GB @huggingface/transformers is never copied at startup.
ROUTER_ENABLED="${OCTOGEE_ROUTER_ENABLED:-true}"
if [ -d /octogee/extensions ]; then
  mkdir -p "$OPENCLAW_DIR/extensions"
  for ext_dir in /octogee/extensions/*/; do
    ext_name=$(basename "$ext_dir")
    if [ "$ROUTER_ENABLED" != "true" ] && [ "$ext_name" = "octogee-router" ]; then
      log "Extensions: skipping ${ext_name} because OCTOGEE_ROUTER_ENABLED=${ROUTER_ENABLED}"
      continue
    fi
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

# ── Pre-boot: seed restart-triggering config from Firestore ─────────────
# Queries advisory slugs + enforcement overrides BEFORE OpenClaw starts,
# so the gateway boots with complete plugin config (no post-boot SIGUSR1).
if [ -f "$OPENCLAW_DIR/openclaw.json" ] && [ -f "${SA_KEY_PATH:-$OPENCLAW_DIR/secrets/octogee-test-sa-key.json}" ]; then
  log "Pre-boot: seeding plugin config from Firestore..."
  /octogee/scripts/node_modules/.bin/tsx /octogee/scripts/entrypoints/pre-boot-config.ts || log "Pre-boot: non-fatal, continuing..."
fi

# ── Pre-boot: per-gateway Mac ops MM identity (#998) ────────────────────
# Replaces the shared `mac-gw-prod` user with mac-${GATEWAY_ID} so two
# gateways in the same env stop fighting for one MM session. Idempotent
# in MM (find-or-create), writes the PAT to the PVC, and patches
# openclaw.json's accounts.default.botToken so OpenClaw connects as the
# per-gateway identity instead of the shared envsubst'd MM_BOT_TOKEN.
# Non-fatal: a transient MM error must not crash the gateway boot — the
# next reboot retries, and OpenClaw will keep the previously-patched
# token in openclaw.json meanwhile.
if [ -f "$OPENCLAW_DIR/openclaw.json" ] && [ -n "${MM_URL:-}" ] && [ -n "${MM_ADMIN_PAT:-}" ]; then
  log "Pre-boot: bootstrapping per-gateway Mac ops MM identity (mac-${GATEWAY_ID})..."
  node /octogee/scripts/bootstrap-mac-ops.mjs || log "bootstrap-mac-ops: non-fatal failure, continuing..."
fi

# ── Boot sync: REMOVED ───────────────────────────────────────────────────────
# The gateway now boots with only the default account (written by
# pre-boot-config.ts). Customer workspaces + openclaw.json customer entries
# are restored post-boot by the fleet controller, one customer at a time via
# the HTTP endpoint exposed by local-provisioner.
# See docs/GATEWAY-FLEET-CONTROLLER-SPEC.md

# ── In-pod runners: supervised + observable ─────────────────────────────────
# Each runner is wrapped by supervise-runner.ts, which owns respawn AND writes
# a heartbeat that runner-metrics-exporter publishes (octogee_runner_up /
# _restart_total / _last_start). The thin shell `while true` guard here only
# re-runs the supervisor itself if IT ever dies; the supervisor handles the
# child's crash-loop. Replaces the bare per-runner respawn loops, which were
# invisible to monitoring (PID 1 stays alive, so a crash-looping child never
# showed as a container restart). See GATEWAY-RUNNER-OBSERVABILITY-SPEC.md.
TSX=/octogee/scripts/node_modules/.bin/tsx
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

# Platform provisioner owns Firestore/MM/Gitea/Secret Manager authority. Locked
# operator gateways intentionally do not have those credentials; running the
# provisioner there just crash-loops on PERMISSION_DENIED and pressures us to
# re-grant platform access. Until the reservation/scoped-provisioning boundary
# exists, keep platform-authoritative runners out of operator pods entirely.
if [ "${GATEWAY_PROFILE:-}" != "operator" ]; then
  supervise_runner provisioner 5000 "$TSX" /octogee/scripts/entrypoints/local-provisioner.ts
else
  log "Operator platform provisioner disabled: platform provisioning runs outside the locked operator gateway boundary"
  supervise_runner fleet-controller 5000 "$TSX" /octogee/scripts/entrypoints/fleet-controller.ts
fi
supervise_runner site-build 5000 "$TSX" /octogee/scripts/entrypoints/site-build-api.ts
supervise_runner preview-proxy 5000 "$TSX" /octogee/scripts/entrypoints/preview-proxy.ts
if [ "${GATEWAY_PROFILE:-}" != "operator" ]; then
  supervise_runner byosub-syncback 30000 "$TSX" /octogee/scripts/entrypoints/byosub-syncback-runner.ts
fi

# Builder-shell PTY server + tmux reconciler — operator profile plus explicit
# access unlock only. Cattle and locked operator gateways own no shells; their
# Helm Service omits the builder-shell port.
# BUILDER_SHELL_REQUIRE_KEY enforces the INTERNAL_SERVICE_KEY header on :3005
# (defense-in-depth over K8s-namespace isolation) so a compromised same-
# namespace pod can't bypass chat-proxy's Origin allowlist + ticket discipline.
# The reconciler flips Firestore shell docs to `dead` once their tmux session
# is gone (process exit / pod roll), co-located so it reads the same tmux.
if [ "${GATEWAY_PROFILE:-}" = "operator" ] && [ "${OPERATOR_SHELLS_ENABLED:-}" = "true" ]; then
  export BUILDER_SHELL_REQUIRE_KEY="${BUILDER_SHELL_REQUIRE_KEY:-true}"
  supervise_runner builder-shell 5000 "$TSX" /octogee/scripts/entrypoints/builder-shell-server.ts
  supervise_runner shell-reconciler 30000 "$TSX" /octogee/scripts/entrypoints/reconcile-shells-runner.ts
elif [ "${GATEWAY_PROFILE:-}" = "operator" ]; then
  log "Builder-shell disabled: operator trust boundary is not provisioned"
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
# other backgrounded jobs (provisioner, log-mirror, preview-proxy, etc.) —
# so `wait` at the bottom of this script keeps the pod up.
#
# Previously a `while true; openclaw || true; sleep 2; done` respawn loop
# ran here, gated on a `wait_for_gateway_exit` port-binding check. The
# respawn was meant to recover from hard crashes; the guard prevented
# stomping on openclaw's self-forked successor. Removed 2026-05-15 after
# the guard's "port still bound; supervisor waiting" loop spun forever in
# PROD on the first DM to Mac — openclaw added the operator's MM user id to
# `commands.ownerAllowFrom`, self-restarted via SIGUSR1, and the supervisor
# parent-exit + successor-holds-port pattern produced log spam with no
# productive action. Hard crash recovery is now K8s's job: the deployment
# has a liveness probe on TCP :18789 in helm/octogee-gateway/templates/
# deployment.yaml — port-frees-without-successor → pod restart after
# `periodSeconds × failureThreshold` of consistent failure (default 60s × 5
# = ~5 min before restart fires, then a fresh boot before the new pod
# serves). Tradeoff for the no-supervisor simplicity; if you need faster
# crash recovery, tighten `probes.liveness` in values.yaml.
log "Starting OpenClaw gateway... (build: ${BUILD_SHA:-unknown})"
openclaw gateway run --bind lan --port 18789 &

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
