#!/usr/bin/env bash
set -euo pipefail
OPENCLAW_SOURCE_REPOSITORY=https://github.com/openclaw/openclaw.git
OPENCLAW_SOURCE_REF=refs/heads/main
OPENCLAW_SOURCE_COMMIT="$(git ls-remote --exit-code "$OPENCLAW_SOURCE_REPOSITORY" "$OPENCLAW_SOURCE_REF" | awk 'NR == 1 {print $1}')"
printf '%s' "$OPENCLAW_SOURCE_COMMIT" | grep -Eq '^[0-9a-f]{40}$'

EVIDENCE="$(mktemp -d)"
trap 'chmod -R u+w "$EVIDENCE"; rm -rf "$EVIDENCE"' EXIT
bash scripts/lib/ops-agent-evidence.sh "file://$CI_REPO_ROOT" "$OCTOGEE_SOURCE_COMMIT" "$EVIDENCE/octogee/source/octogee"
bash scripts/lib/ops-agent-evidence.sh "$OPENCLAW_SOURCE_REPOSITORY" "$OPENCLAW_SOURCE_COMMIT" "$EVIDENCE/octogee/source/openclaw"
chmod -R a-w "$EVIDENCE"
python3 - "$EVIDENCE" "$RUNNER_TEMP/ops-agent-evidence.tar.gz" <<'PYTAR'
import sys, tarfile
from pathlib import Path
def ownership(entry):
    entry.uid = entry.gid = 0
    entry.uname = entry.gname = ""
    return entry
with tarfile.open(sys.argv[2], "w:gz") as archive:
    archive.add(Path(sys.argv[1]) / "octogee", arcname="octogee", filter=ownership)
PYTAR

RUNTIME_IMAGE="${AR_REPOSITORY}/octogee-ops-agent-runtime:${SHORT_SHA}"
FINAL_IMAGE="${AR_REPOSITORY}/octogee-ops-agent:${SHORT_SHA}"
crane append --base "$RUNTIME_IMAGE" --new_layer "$RUNNER_TEMP/ops-agent-evidence.tar.gz" --new_tag "$FINAL_IMAGE"
crane tag "$FINAL_IMAGE" latest
