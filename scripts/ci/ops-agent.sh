#!/usr/bin/env bash
set -euo pipefail
OPENCLAW_SOURCE_REPOSITORY=https://github.com/ceckert/openclaw.git
OPENCLAW_SOURCE_COMMIT="$(node -p 'require("./infra/gateway/openclaw-tarball/current.json").sourceSha')"
printf '%s' "$OPENCLAW_SOURCE_COMMIT" | grep -Eq '^[0-9a-f]{40}$'

EVIDENCE="$(mktemp -d)"
trap 'chmod -R u+w "$EVIDENCE"; rm -rf "$EVIDENCE"' EXIT
bash scripts/lib/ops-agent-evidence.sh "$OPENCLAW_SOURCE_REPOSITORY" "$OPENCLAW_SOURCE_COMMIT" "$EVIDENCE/openclaw"
bash scripts/lib/ops-agent-evidence.sh "file://$CI_REPO_ROOT" "$OCTOGEE_SOURCE_COMMIT" "$EVIDENCE/octogee"
chmod -R a-w "$EVIDENCE"
bash scripts/lib/ops-agent-evidence-layer.sh "$EVIDENCE/openclaw" octogee/source/openclaw "$RUNNER_TEMP/ops-agent-openclaw-evidence.tar.gz"
bash scripts/lib/ops-agent-evidence-layer.sh "$EVIDENCE/octogee" octogee/source/octogee "$RUNNER_TEMP/ops-agent-octogee-evidence.tar.gz"

RUNTIME_IMAGE="${AR_REPOSITORY}/octogee-ops-agent-runtime:${SHORT_SHA}"
FINAL_IMAGE="${AR_REPOSITORY}/octogee-ops-agent:${SHORT_SHA}"
crane append --base "$RUNTIME_IMAGE" \
  --new_layer "$RUNNER_TEMP/ops-agent-openclaw-evidence.tar.gz" \
  --new_layer "$RUNNER_TEMP/ops-agent-octogee-evidence.tar.gz" \
  --new_tag "$FINAL_IMAGE"
crane tag "$FINAL_IMAGE" latest
