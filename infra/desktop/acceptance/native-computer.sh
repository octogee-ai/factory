#!/usr/bin/env bash
set -euo pipefail

: "${OPENCLAW_GATEWAY_TOKEN:?run inside the Builder VM gateway container}"
node_name="${OCTOGEE_DESKTOP_NODE_NAME:-octogee-desktop}"
gateway_url="${OPENCLAW_GATEWAY_URL:-ws://127.0.0.1:18789}"
control_url="${GATEWAY_COMPUTER_CONTROL_URL:-http://127.0.0.1:7777}"
target_url="${OCTOGEE_ACCEPT_TARGET_URL:-https://example.com/}"
expected_title="${OCTOGEE_ACCEPT_EXPECTED_TITLE:-Example Domain}"

export OPENCLAW_GATEWAY_PASSWORD="$OPENCLAW_GATEWAY_TOKEN"
OPENCLAW_STATE_DIR="$(mktemp -d)"
export OPENCLAW_STATE_DIR
trap 'rm -rf "$OPENCLAW_STATE_DIR"' EXIT
printf '{"gateway":{"auth":{"mode":"password"}}}\n' > "$OPENCLAW_STATE_DIR/openclaw.json"

oc() { openclaw "$@" --url "$gateway_url" --json; }

chromium_title() {
  curl -fsS "$control_url/windows" | jq -r '.[] | select(.class | test("chromium"; "i")) | .title' | head -n1
}

status="$(oc nodes status --connected)"
node_json="$(printf '%s' "$status" | jq -c --arg name "$node_name" '.nodes[] | select(.displayName == $name)')"
if [ -z "$node_json" ]; then
  echo "no connected node named $node_name"
  printf '%s\n' "$status"
  exit 1
fi
if ! printf '%s' "$node_json" | jq -e '.paired == true and (.commands | index("computer.act")) != null and (.commands | index("screen.snapshot")) != null' >/dev/null; then
  echo "$node_name is not paired with computer.act and screen.snapshot"
  printf '%s\n' "$node_json"
  exit 1
fi
node_id="$(printf '%s' "$node_json" | jq -r '.nodeId')"

execution_id="$(cat /proc/sys/kernel/random/uuid)"
act() {
  local params
  params="$(jq -c --arg id "$execution_id" '. + {executionId: $id}' <<< "$1")"
  oc nodes invoke --node "$node_id" --command computer.act --invoke-timeout 30000 --params "$params"
}

oc nodes invoke --node "$node_id" --command screen.snapshot --invoke-timeout 30000 \
  --params "$(jq -cn --arg id "$execution_id" '{executionId: $id}')" \
  | jq -e '(.payload // (.payloadJSON | fromjson)).displayFrameId' >/dev/null

title_before="$(chromium_title)"
act '{"action":"key","keys":"ctrl+l"}' >/dev/null
act "$(jq -cn --arg url "$target_url" '{action: "type", text: $url}')" >/dev/null
act '{"action":"key","keys":"Return"}' >/dev/null

title_after=""
for _ in $(seq 1 40); do
  title_after="$(chromium_title)"
  [[ "$title_after" == *"$expected_title"* ]] && break
  sleep 0.5
done

act '{"action":"__close_execution","reason":"acceptance-complete"}' >/dev/null || true

printf 'node=%s before=%q after=%q\n' "$node_id" "$title_before" "$title_after"
if [[ "$title_after" != *"$expected_title"* ]]; then
  echo "native computer acceptance failed: Chromium did not navigate through computer.act"
  exit 1
fi
echo "native computer acceptance ok"
