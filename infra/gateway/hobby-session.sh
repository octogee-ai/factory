#!/usr/bin/env bash
set -euo pipefail
children=()
browser_pid=""
restart_browser=0
cleanup() {
  trap '' TERM INT
  for pid in "${children[@]}" "$browser_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid"; fi
  done
  wait || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
request_browser_restart() {
  restart_browser=1
  if [[ -n "$browser_pid" ]]; then kill -TERM "$browser_pid" 2>/dev/null || true; fi
}
trap request_browser_restart USR1
export OCTO_SUPERVISOR_PID=$$
password_file="$XDG_RUNTIME_DIR/octogee-openclaw-vnc/password"
python3 - "$password_file" <<'PYTHON'
import os, secrets, string, sys
from pathlib import Path
os.umask(0o077)
Path(sys.argv[1]).write_text(''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8)) + '\n')
PYTHON
tigervncpasswd -f < "$password_file" > "$XDG_RUNTIME_DIR/vnc-password"
chmod 600 "$XDG_RUNTIME_DIR/vnc-password"
Xvnc :0 -geometry 1440x900 -depth 24 -SecurityTypes VncAuth -PasswordFile "$XDG_RUNTIME_DIR/vnc-password" -localhost -rfbport 5901 &
children+=("$!")
for _ in $(seq 1 100); do
  xdpyinfo >/dev/null 2>&1 && break
  kill -0 "${children[0]}"
  sleep 0.2
done
xdpyinfo >/dev/null
openbox &
children+=("$!")
/usr/local/bin/octo-desktop-control &
children+=("$!")
/usr/local/bin/entrypoint.sh &
children+=("$!")
OPENCLAW_STATE_DIR="$HOME/.openclaw-desktop" OPENCLAW_CONFIG_PATH="$HOME/.openclaw-desktop/openclaw.json" \
  OPENCLAW_GATEWAY_PASSWORD="${OPENCLAW_GATEWAY_TOKEN:?OPENCLAW_GATEWAY_TOKEN is required}" \
  /usr/local/bin/octogee-desktop-node &
children+=("$!")
/usr/local/bin/octo-desktop-browser about:blank &
browser_pid=$!
while true; do
  exited=""
  status=0
  wait -n -p exited "${children[@]}" "$browser_pid" || status=$?
  if [[ ! -v exited ]]; then exited=""; fi
  if [[ "$exited" == "$browser_pid" || -z "$exited" ]]; then
    if (( restart_browser )); then
      wait "$browser_pid" || true
      restart_browser=0
    elif [[ -z "$exited" ]]; then
      echo "hobby-desktop: wait failed without a process exit (status=$status)" >&2
      exit 1
    else
      echo "hobby-desktop: Chromium exited (status=$status); restarting" >&2
      sleep 2
    fi
    /usr/local/bin/octo-desktop-browser about:blank &
    browser_pid=$!
  else
    echo "hobby-desktop: required process $exited exited (status=$status)" >&2
    exit 1
  fi
done
