#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Status page secrets (status.octogee.com, Upptime in octogee-ai/status)
# ═══════════════════════════════════════════════════════════════════════════
#
# Copies the operator's .env values into the status repo's GitHub Actions
# secrets, then re-runs Upptime's Setup CI so the new values take effect.
# Idempotent — re-run after rotating either value.
#
#   STATUS_GH_PAT               → GH_PAT
#   STATUS_DISCORD_WEBHOOK_URL  → NOTIFICATION_DISCORD_WEBHOOK_URL
#
# Usage:
#   ./scripts/setup-status-secrets.sh [--env-file=PATH] [--no-setup-run]
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/lib/shell-env.sh
source "$SCRIPT_DIR/lib/shell-env.sh"

STATUS_REPO="octogee-ai/status"
ENV_FILE="$REPO_DIR/.env"
RUN_SETUP=true

for arg in "$@"; do
  case $arg in
    --env-file=*)   ENV_FILE="${arg#*=}" ;;
    --no-setup-run) RUN_SETUP=false ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }

set_status_secret() {
  local secret_name="$1" env_key="$2" value
  value="$(read_env_file_value "$ENV_FILE" "$env_key")"
  printf '%s' "$value" | gh secret set "$secret_name" --repo "$STATUS_REPO" >/dev/null
  echo "Set $secret_name on $STATUS_REPO from $env_key"
}

gh_pat="$(read_env_file_value "$ENV_FILE" STATUS_GH_PAT)"
GH_TOKEN="$gh_pat" gh api "repos/$STATUS_REPO" --silent || {
  echo "GitHub rejected STATUS_GH_PAT — expired, revoked, or mistyped" >&2
  exit 1
}
unset gh_pat

discord_url="$(read_env_file_value "$ENV_FILE" STATUS_DISCORD_WEBHOOK_URL)"
[[ "$discord_url" =~ ^https://(discord|discordapp)\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$ ]] || {
  echo "STATUS_DISCORD_WEBHOOK_URL is not a Discord webhook URL" >&2
  exit 1
}
unset discord_url

set_status_secret GH_PAT STATUS_GH_PAT
set_status_secret NOTIFICATION_DISCORD_WEBHOOK_URL STATUS_DISCORD_WEBHOOK_URL

if [[ "$RUN_SETUP" == true ]]; then
  gh workflow run setup.yml --repo "$STATUS_REPO" >/dev/null
  echo "Started Setup CI: https://github.com/$STATUS_REPO/actions/workflows/setup.yml"
fi
