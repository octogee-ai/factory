#!/bin/sh
set -e

OPENCLAW_DIR=/home/node/.openclaw
TEMPLATES_DIR="${OCTOGEE_TEMPLATES_DIR:-/octogee/templates}"

# Consistent ISO timestamp logging (matches OpenClaw gateway format)
log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000+00:00) [entrypoint] $*"
}

# ── Boot banner ─────────────────────────────────────────────────────────────
# One grep-able line so operators can confirm what's running without
# exec'ing in to read package.json. BUILD_SHA + OPENCLAW_VERSION +
# OPENCLAW_FORK_SHA are baked in by Cloud Build.
log "boot: gateway-image=${BUILD_SHA:-unknown} openclaw=${OPENCLAW_VERSION:-unknown} fork=${OPENCLAW_FORK_SHA:-unknown}"

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
# Gateway auth token — generated per pod boot. NEVER written to the JSON
# config on disk. OpenClaw reads it from $OPENCLAW_GATEWAY_TOKEN natively
# (openclaw/src/gateway/startup-auth.ts:111). chat-proxy fetches the live
# token from Secret Manager (published below) when it opens upstream WS.
export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-$(cat /dev/urandom | tr -dc 'a-f0-9' | head -c 48)}"
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
fi
# Secret rotation / reconciliation (env-sync) happens later via pre-boot-config.ts
# — nothing else fixed up here. The template is canonical; don't re-derive.

# Publish the fresh gateway auth token to Secret Manager so chat-proxy can
# open authenticated upstream WS connections.
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
# Skipped silently when GCP_PROJECT_ID is unset (docker-compose local dev,
# where chat-proxy uses the OPENCLAW_GATEWAY_TOKEN env fallback instead).
if [ -n "${GCP_PROJECT_ID:-}" ]; then
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

# ── Pre-boot: seed restart-triggering config from Firestore ─────────────
# Queries advisory slugs + enforcement overrides BEFORE OpenClaw starts,
# so the gateway boots with complete plugin config (no post-boot SIGUSR1).
if [ -f "$OPENCLAW_DIR/openclaw.json" ] && [ -f "${SA_KEY_PATH:-$OPENCLAW_DIR/secrets/octogee-test-sa-key.json}" ]; then
  log "Pre-boot: seeding plugin config from Firestore..."
  /octogee/scripts/node_modules/.bin/tsx /octogee/scripts/pre-boot-config.ts || log "Pre-boot: non-fatal, continuing..."
fi

# ── Boot sync: REMOVED ───────────────────────────────────────────────────────
# The gateway now boots with only the default account (written by
# pre-boot-config.ts). Customer workspaces + openclaw.json customer entries
# are restored post-boot by the fleet controller, one customer at a time via
# the HTTP endpoint exposed by local-provisioner.
# See docs/GATEWAY-FLEET-CONTROLLER-SPEC.md

# ── Start provisioner in background with auto-restart ───────────────────────
(
  while true; do
    log "Starting Octogee provisioner..."
    /octogee/scripts/node_modules/.bin/tsx \
      /octogee/scripts/local-provisioner.ts \
      || true
    log "Provisioner exited — restarting in 5s..."
    sleep 5
  done
) &

# ── Start site build API in background with auto-restart ───────────────────
(
  while true; do
    log "Starting site build API..."
    /octogee/scripts/node_modules/.bin/tsx \
      /octogee/scripts/site-build-api.ts \
      || true
    log "Site build API exited — restarting in 5s..."
    sleep 5
  done
) &

# ── Start preview proxy in background with auto-restart ────────────────────
(
  while true; do
    log "Starting preview proxy..."
    /octogee/scripts/node_modules/.bin/tsx \
      /octogee/scripts/preview-proxy.ts \
      || true
    log "Preview proxy exited — restarting in 5s..."
    sleep 5
  done
) &

# ── Helper: wait until port 18789 is free. ─────────────────────────────────
# Detects whether ANY process is listening on 18789 by reading /proc/net/tcp
# (always present, no extra dependencies). Replaces the prior /proc/*/cmdline
# scan which assumed the OpenClaw process title was a known string — the
# 2026-05-13 TEST crash-loop fired on 2026.5.2 AND 2026.5.7 because neither
# version's cmdline matched the earlier `openclaw gateway run` /
# `openclaw-gateway` patterns, so the guard returned "nothing running" while
# OpenClaw's SIGUSR1-spawned successor was still alive, and the supervisor
# raced for port 18789. Port-based detection has no openclaw-version
# coupling and is the actual invariant we care about (the supervisor must
# not respawn while anyone holds the listener).
#
# 18789 in hex is 4965. /proc/net/tcp emits "local_address: 00000000:4965"
# (IPv4 0.0.0.0) and /proc/net/tcp6 emits "...:00000000:4965" (IPv6 ::).
# State 0A = LISTEN.
wait_for_gateway_exit() {
  port_hex=$(printf '%04X' 18789)
  while true; do
    if ! grep -qE "^\s*[0-9]+:\s+[0-9A-F]+:${port_hex}\s.*\s0A\s" \
         /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
      return 0
    fi
    log "OpenClaw gateway port 18789 still bound; supervisor waiting..."
    sleep 1
  done
}

# ── Start OpenClaw gateway under a single-instance supervisor ───────────────
# Previously this was `exec openclaw ...` which made OpenClaw PID 1 and tied
# its lifecycle to the container's. OpenClaw self-restarts via SIGUSR1 when
# its chokidar watcher detects an openclaw.json change — under `exec` that
# cascaded into a whole-pod restart, losing the provisioner's in-memory
# state, PVC-cached gitea tokens, etc., and taking ~6+ minutes to recover.
#
# Matching the while-loop pattern used above for provisioner / site-build /
# preview-proxy, OpenClaw runs as a supervised child: when it exits
# (crash OR self-restart), this loop respawns it without taking the pod
# down. Other services keep running; only tenant MM WebSockets blip.
#
# The wait_for_gateway_exit() guard enforces at-most-one gateway per pod.
# On config-driven restarts OpenClaw itself forks a replacement child
# ("restart mode: full process restart (spawned pid N)") before the parent
# exits. Without the guard, the supervisor saw the parent exit and
# respawned its own gateway alongside OpenClaw's self-spawned child — two
# processes racing on port 18789. Observed 2026-04-20 in prod when a Face
# model switch via the admin dashboard triggered
# `plugins.entries.octogee-router.config.faceModelOverrides.*` reload; the
# pod had to be rollout-restarted manually. The guard blocks the
# supervisor's next respawn until OpenClaw's own child (or any other
# `openclaw gateway run`) fully exits, so only one instance is ever live.
(
  while true; do
    wait_for_gateway_exit
    log "Starting OpenClaw gateway... (build: ${BUILD_SHA:-unknown})"
    openclaw gateway run --bind lan --port 18789 || true
    log "OpenClaw gateway exited — restarting in 2s..."
    sleep 2
  done
) &

# ── OpenClaw file-log mirror to container stdout ────────────────────────────
# `openclaw logs` reads from a richer file log (/tmp/openclaw-1000/openclaw-
# YYYY-MM-DD.log) via RPC; that channel is wider than what OpenClaw itself
# writes to stdout under OPENCLAW_LOG_LEVEL=info. Mirror the file log so
# kubectl/stern see the same content as `openclaw logs`.
#
# `tail -F` (capital F) follows by name, so the daily-rotated date-stamped
# files keep streaming after midnight UTC without supervisor intervention.
# The `[openclaw-file]` prefix distinguishes mirrored lines from OpenClaw's
# direct stdout and from the entrypoint's own `log` lines.
(
  while true; do
    until ls /tmp/openclaw-1000/openclaw-*.log >/dev/null 2>&1; do sleep 2; done
    tail -F /tmp/openclaw-1000/openclaw-*.log 2>&1 \
      | sed -u 's/^/[openclaw-file] /' || true
    sleep 2
  done
) &

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
