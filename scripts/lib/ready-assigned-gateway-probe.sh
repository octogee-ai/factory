#!/usr/bin/env bash

ready_gateway_deployments() {
  local context="$1" namespace="$2"

  kubectl --context "$context" get deployment -n "$namespace" \
    -l 'app=octogee-gateway' -o json | \
    python3 -c '
import json
import sys

for item in sorted(json.load(sys.stdin).get("items", []), key=lambda value: value["metadata"]["name"]):
    desired = item.get("spec", {}).get("replicas", 1)
    ready = item.get("status", {}).get("readyReplicas", 0)
    if desired > 0 and ready >= desired:
        print(item["metadata"]["name"])
'
}

probe_ready_assigned_gateway_gitea_broker() {
  local context="$1" namespace="$2"
  local deployments deployment broker_output

  if ! deployments="$(ready_gateway_deployments "$context" "$namespace")"; then
    echo "Could not list Ready gateway deployments for the Gitea broker probe" >&2
    return 1
  fi

  if [[ -z "$deployments" ]]; then
    echo "No Ready gateway deployment is available for the Gitea broker probe" >&2
    return 1
  fi

  while IFS= read -r deployment; do
    [[ -z "$deployment" ]] && continue
    if ! broker_output="$(kubectl --context "$context" exec "deployment/$deployment" -n "$namespace" -c gateway -- \
      sh -c 'node -e "const safe=!!process.env.GITEA_ADMIN_BROKER_URL&&!process.env.GIT_API_TOKEN;process.exit(safe?0:1)" && exec /octogee/scripts/node_modules/.bin/tsx /octogee/scripts/entrypoints/gitea-broker-probe.ts' \
      2>&1)"; then
      if grep -Fq "has no assigned tenant for the Gitea broker probe" <<<"$broker_output"; then
        continue
      fi

      echo "Gitea admin broker probe failed on Ready gateway $deployment: $broker_output" >&2
      return 1
    fi

    printf '%s\n' "$deployment"
    return 0
  done <<<"$deployments"

  echo "No Ready gateway has an assigned tenant for the Gitea broker probe" >&2
  return 1
}
