#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
bootstrap-env.sh is deprecated and does not mutate an environment.

Octogee has exactly two managed environments: TEST and PROD. Rebuild either one
with the canonical target-bound sequence in docs/handbook/30-env-lifecycle.md.
After an authorized teardown, teardown-env.sh prints that exact sequence with
the environment, deployment target, project, namespace, and cluster substituted.

Do not run teardown-env.sh merely to inspect the recipe; it performs a real Helm
uninstall. The setup commands in the handbook are idempotent and can be run
directly for repair or provisioning.
EOF

exit 1
