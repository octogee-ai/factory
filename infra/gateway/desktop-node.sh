#!/usr/bin/env bash
set -euo pipefail

: "${OCTOGEE_DESKTOP_NODE_NAME:?OCTOGEE_DESKTOP_NODE_NAME is required}"
: "${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}"
: "${OPENCLAW_GATEWAY_PASSWORD:?OPENCLAW_GATEWAY_PASSWORD is required}"

if ! command -v wtype >/dev/null 2>&1; then
  echo "desktop-node: wtype is required for CUA Wayland keyboard input" >&2
  exit 1
fi

export HOME="${HOME:-/home/node}"
state="$HOME/.openclaw"
mkdir -p "$state"
node --input-type=module - "$state/openclaw.json" <<'JS'
import fs from "node:fs";
const file = process.argv[2];
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
config.plugins ??= {};
config.plugins.entries ??= {};
config.plugins.entries["cua-computer"] = { enabled: true };
config.nodeHost ??= {};
config.nodeHost.browserProxy = { enabled: false };
config.desktop = { host: {
  enabled: true, managed: false, port: 5901,
  passwordFile: `${process.env.XDG_RUNTIME_DIR}/octogee-openclaw-vnc/password`,
} };
fs.writeFileSync(file, JSON.stringify(config) + "\n", { mode: 0o600 });
JS

wayland_socket() {
  ls "$XDG_RUNTIME_DIR" 2>/dev/null | grep -E '^wayland-[0-9]+$' | head -n1
}
until socket="$(wayland_socket)" && [ -n "$socket" ]; do
  echo "desktop-node: waiting for a Wayland socket in $XDG_RUNTIME_DIR"
  sleep 2
done
export WAYLAND_DISPLAY="$socket"
export DISPLAY="${DISPLAY:-:0}"
export XDG_SESSION_TYPE=wayland
export XDG_CURRENT_DESKTOP=Hyprland
export CUA_DRIVER_RS_ENABLE_WAYLAND=1
export DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/octogee-desktop-node-has-no-session-bus

until curl -fsS --max-time 2 http://127.0.0.1:18789/healthz >/dev/null 2>&1; do
  echo "desktop-node: waiting for the gateway on 127.0.0.1:18789"
  sleep 2
done

openclaw doctor --lint --only cua-computer/driver-artifacts
exec openclaw node run --host 127.0.0.1 --port 18789 --display-name "$OCTOGEE_DESKTOP_NODE_NAME"
