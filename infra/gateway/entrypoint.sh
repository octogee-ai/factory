#!/bin/sh
set -e

OPENCLAW_DIR=/home/node/.openclaw
TEMPLATES_DIR="${OCTOGEE_TEMPLATES_DIR:-/octogee/templates}"

# Consistent ISO timestamp logging (matches OpenClaw gateway format)
log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000+00:00) [entrypoint] $*"
}

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
export GATEWAY_TOKEN="${GATEWAY_TOKEN:-$(cat /dev/urandom | tr -dc 'a-f0-9' | head -c 48)}"
if [ -f "$OPENCLAW_DIR/openclaw.json" ]; then
  log "openclaw.json already exists — preserving (provisioner is source of truth)"
  # Patch missing Mattermost fields (migration for pods with stale config)
  python3 - <<'PYEOF'
import json, os, sys
cfg_path = os.environ.get("OPENCLAW_DIR", "/home/node/.openclaw") + "/openclaw.json"
try:
    with open(cfg_path) as f:
        c = json.load(f)
    mm = c.setdefault("channels", {}).setdefault("mattermost", {})
    changed = False
    if mm.get("groupPolicy") != "open":
        mm["groupPolicy"] = "open"
        changed = True
    if mm.get("allowFrom") != ["*"]:
        mm["allowFrom"] = ["*"]
        changed = True
    # Remove default:true from Mac — only bound agents should respond
    for agent in c.get("agents", {}).get("list", []):
        if agent.get("id") == "mac" and agent.get("default"):
            del agent["default"]
            changed = True
    if changed:
        with open(cfg_path, "w") as f:
            json.dump(c, f, indent=2)
        print("[entrypoint] Patched openclaw.json: groupPolicy=open, allowFrom=[*]", flush=True)
except Exception as e:
    print(f"[entrypoint] Config patch skipped: {e}", flush=True)
PYEOF
else
  envsubst < /octogee/infra/gateway/openclaw.template.json > "$OPENCLAW_DIR/openclaw.json"
  chmod 600 "$OPENCLAW_DIR/openclaw.json"
  GW_SHORT=$(echo "$GATEWAY_TOKEN" | cut -c1-8)
  log "openclaw.json generated (gw=${GW_SHORT}...)"
fi

# ── Provision Mac's workspace if missing ────────────────────────────────────
MAC_WS="$OPENCLAW_DIR/workspace/ops"
if [ ! -f "$MAC_WS/SOUL.md" ] && [ -d "$TEMPLATES_DIR/mac-workspace" ]; then
  log "Setting up Mac workspace from templates..."
  mkdir -p "$MAC_WS"
  cp -n "$TEMPLATES_DIR/mac-workspace/"*.md "$MAC_WS/" 2>/dev/null || true
  mkdir -p "$MAC_WS/memory"
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
if [ -d /octogee/extensions ]; then
  mkdir -p "$OPENCLAW_DIR/extensions"
  for ext_dir in /octogee/extensions/*/; do
    ext_name=$(basename "$ext_dir")
    target="$OPENCLAW_DIR/extensions/$ext_name"
    mkdir -p "$target"
    # Copy source files only (no node_modules)
    rsync -a --exclude node_modules "$ext_dir" "$target/" 2>/dev/null || \
      cp -rn "$ext_dir"*.ts "$ext_dir"*.json "$target/" 2>/dev/null || true
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
  log "Plugin extensions installed: $(ls /octogee/extensions/)"
fi

# ── Pre-boot: seed restart-triggering config from Firestore ─────────────
# Queries advisory slugs + enforcement overrides BEFORE OpenClaw starts,
# so the gateway boots with complete plugin config (no post-boot SIGUSR1).
if [ -f "$OPENCLAW_DIR/openclaw.json" ] && [ -f "${SA_KEY_PATH:-$OPENCLAW_DIR/secrets/octogee-test-sa-key.json}" ]; then
  log "Pre-boot: seeding plugin config from Firestore..."
  /octogee/scripts/node_modules/.bin/tsx /octogee/scripts/pre-boot-config.ts || log "Pre-boot: non-fatal, continuing..."
fi

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

# ── Start site API in background with auto-restart ──────────────────────────
(
  while true; do
    log "Starting Octogee Site API..."
    /octogee/scripts/node_modules/.bin/tsx \
      /octogee/scripts/site-api.ts \
      || true
    log "Site API exited — restarting in 5s..."
    sleep 5
  done
) &

# ── Start OpenClaw gateway (foreground — Docker monitors this process) ───────
log "Starting OpenClaw gateway... (build: ${BUILD_SHA:-unknown})"
exec openclaw gateway run --bind lan --port 18789
