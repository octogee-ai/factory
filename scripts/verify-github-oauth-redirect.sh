#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/lib/shell-env.sh
source "$SCRIPT_DIR/lib/shell-env.sh"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"
# shellcheck source=scripts/lib/github-oauth-redirect.sh
source "$SCRIPT_DIR/lib/github-oauth-redirect.sh"

TARGET=""
for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET="${arg#*=}" ;;
    --help|-h)
      echo "Usage: $0 --target=TARGET"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done
[[ -n "$TARGET" ]] || { echo "Usage: $0 --target=TARGET" >&2; exit 2; }

octogee_load_deployment_target "--target=$TARGET"
ENV_FILE="$REPO_DIR/.env.$TARGET_ID"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing target env file: $ENV_FILE" >&2
  exit 1
fi

GITHUB_CLIENT_ID="$(read_env_file_value "$ENV_FILE" GITHUB_CLIENT_ID)"
if [[ -z "$GITHUB_CLIENT_ID" ]]; then
  echo "GITHUB_CLIENT_ID is not configured in $ENV_FILE" >&2
  exit 1
fi

github_oauth_verify_redirect \
  "$GITHUB_CLIENT_ID" \
  "$TARGET_API_ORIGIN/api/connect/github/callback" \
  "${CURL_BIN:-curl}"
