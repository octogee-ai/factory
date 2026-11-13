#!/usr/bin/env bash

octogee_verify_grafana_health() {
  local context="$1"
  local health
  health="$(kubectl get \
    --raw=/api/v1/namespaces/monitoring/services/http:grafana:80/proxy/api/health \
    --context="$context" --request-timeout=15s)" || {
    echo "Could not query Grafana health through the Kubernetes service proxy" >&2
    return 1
  }
  if ! printf '%s' "$health" | node -e '
const fs = require("node:fs");
const health = JSON.parse(fs.readFileSync(0, "utf8"));
if (health.database !== "ok") throw new Error("Grafana database is unhealthy");
'; then
    echo "Grafana health verification failed" >&2
    return 1
  fi
}
