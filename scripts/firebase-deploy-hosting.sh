#!/usr/bin/env bash
#
# firebase-deploy-hosting.sh — deploy a Firebase Hosting target, tolerating
# Firebase's no-op "current active version" release.
#
# When the built surface is byte-identical to what is already live, Firebase
# Hosting refuses the release with:
#   HTTP Error: 400, Can't release to `.../channels/live`: supplied version
#   `...` is the current active version.
# and `firebase deploy` exits 1. That is a successful no-op, not a failure —
# but in site.yml the hosting steps run before app/SSR, so a bare exit 1 aborts
# the whole job and strands every downstream surface (this is exactly what
# blocked a release when only the app had changed but the site had not).
#
# This wrapper swallows ONLY that specific no-op and propagates every other
# failure unchanged.
#
# Usage: firebase-deploy-hosting.sh <site|app> <firebase-project-id>
# Override the deploy command in tests with DEPLOY_CMD.
set -euo pipefail

target="${1:?usage: firebase-deploy-hosting.sh <site|app> <firebase-project-id>}"
project="${2:?usage: firebase-deploy-hosting.sh <site|app> <firebase-project-id>}"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

deploy_cmd=("npm" "run" "deploy:hosting:${target}" "--" "--project" "$project" "--non-interactive")
if [ -n "${DEPLOY_CMD:-}" ]; then
  read -r -a deploy_cmd <<<"$DEPLOY_CMD"
fi

if "${deploy_cmd[@]}" 2>&1 | tee "$log"; then
  exit 0
fi

if grep -q "is the current active version" "$log"; then
  echo "↩️  hosting:${target} unchanged — already the live version; treating no-op release as success"
  exit 0
fi

echo "firebase hosting:${target} deploy failed (see output above)" >&2
exit 1
