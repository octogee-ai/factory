#!/usr/bin/env bash
set -euo pipefail
OPENCLAW_SOURCE_REPOSITORY=https://github.com/ceckert/openclaw.git
OPENCLAW_SOURCE_COMMIT="$(node -p 'require("./platform/infra/gateway/openclaw-tarball/current.json").sourceSha')"
printf '%s' "$OPENCLAW_SOURCE_COMMIT" | grep -Eq '^[0-9a-f]{40}$'

RUNTIME_IMAGE="${AR_REPOSITORY}/octogee-ops-agent-runtime:${SHORT_SHA}"
RUNTIME_DIGEST="$(crane digest "$RUNTIME_IMAGE")"
printf '%s' "$RUNTIME_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'
EVIDENCE_RECIPE="$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  const hash = createHash("sha256");
  for (const file of process.argv.slice(1)) hash.update(file).update("\0").update(readFileSync(file)).update("\0");
  process.stdout.write(hash.digest("hex").slice(0, 12));
' platform/scripts/lib/ops-agent-evidence.sh platform/scripts/lib/ops-agent-evidence-layer.sh)"
EVIDENCE_PACKAGE="${AR_REPOSITORY}/octogee-ops-agent-openclaw-evidence"
EVIDENCE_TAG="${EVIDENCE_PACKAGE}:${RUNTIME_DIGEST#sha256:}-${OPENCLAW_SOURCE_COMMIT}-${EVIDENCE_RECIPE}"
FINAL_IMAGE="${AR_REPOSITORY}/octogee-ops-agent:${SHORT_SHA}"

EVIDENCE="$(mktemp -d)"
trap 'chmod -R u+w "$EVIDENCE"; rm -rf "$EVIDENCE"' EXIT

resolve_evidence_base() {
  bash .github/actions/release-digest-manifest/resolve-tag-digest.sh "$AR_REPOSITORY" "$GCP_PROJECT" "$EVIDENCE_TAG"
}

lookup_status=0
evidence_digest="$(resolve_evidence_base)" || lookup_status=$?
if [ "$lookup_status" = 3 ]; then
  bash platform/scripts/lib/ops-agent-evidence.sh "$OPENCLAW_SOURCE_REPOSITORY" "$OPENCLAW_SOURCE_COMMIT" "$EVIDENCE/openclaw"
  chmod -R a-w "$EVIDENCE/openclaw"
  bash platform/scripts/lib/ops-agent-evidence-layer.sh "$EVIDENCE/openclaw" octogee/source/openclaw "$RUNNER_TEMP/ops-agent-openclaw-evidence.tar.gz"
  crane append --base "$RUNTIME_IMAGE" \
    --new_layer "$RUNNER_TEMP/ops-agent-openclaw-evidence.tar.gz" \
    --new_tag "$EVIDENCE_TAG"
  lookup_status=0
  evidence_digest="$(resolve_evidence_base)" || lookup_status=$?
fi
if [ "$lookup_status" != 0 ]; then
  echo "could not resolve OpenClaw evidence base ${EVIDENCE_TAG}" >&2
  exit "$lookup_status"
fi
echo "OpenClaw evidence base: ${EVIDENCE_PACKAGE}@${evidence_digest}"

bash platform/scripts/lib/ops-agent-evidence.sh "file://$CI_REPO_ROOT" "$OCTOGEE_SOURCE_COMMIT" "$EVIDENCE/octogee"
chmod -R a-w "$EVIDENCE/octogee"
bash platform/scripts/lib/ops-agent-evidence-layer.sh "$EVIDENCE/octogee" octogee/source/octogee "$RUNNER_TEMP/ops-agent-octogee-evidence.tar.gz"
crane append --base "${EVIDENCE_PACKAGE}@${evidence_digest}" \
  --new_layer "$RUNNER_TEMP/ops-agent-octogee-evidence.tar.gz" \
  --new_tag "$FINAL_IMAGE"
crane tag "$FINAL_IMAGE" latest
