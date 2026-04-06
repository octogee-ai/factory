#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Environment Bootstrap — Single entry point
# ═══════════════════════════════════════════════════════════════════════════
#
# Runs setup-mattermost.sh and setup-secrets.sh in the correct order,
# then validates the result with verify-secrets.sh.
#
# This is the script to run when:
#   - Setting up a fresh environment
#   - Repairing secret drift after an incident
#   - Before the first `helm upgrade` on a new cluster
#
# Usage:
#   ./scripts/bootstrap-env.sh --env=test [--yes]
#   ./scripts/bootstrap-env.sh --env=prod
#
# What it does (in order):
#   1. setup-mattermost.sh  → admin PAT, bot token, team, K8s secret
#   2. setup-secrets.sh     → remaining K8s secrets (gitea, stripe, etc.)
#   3. verify-secrets.sh    → validates all required secrets + keys
#
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'

ENV=""
EXTRA_ARGS=()

for arg in "$@"; do
  case $arg in
    --env=*)  ENV="${arg#*=}" ;;
    --yes|-y) EXTRA_ARGS+=("--yes") ;;
    --help|-h)
      echo "Usage: $0 --env=prod|test [--yes]"
      echo ""
      echo "Runs setup-mattermost.sh, setup-secrets.sh, and verify-secrets.sh in order."
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test [--yes]"; exit 1; }

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Octogee Environment Bootstrap — ${ENV}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ── Step 1: Mattermost bootstrap ────────────────────────────────────────
echo -e "${BOLD}[1/3] Mattermost bootstrap${NC}"
echo ""
"$SCRIPT_DIR/setup-mattermost.sh" --env="$ENV" "${EXTRA_ARGS[@]}"
echo ""

# ── Step 2: Remaining secrets ───────────────────────────────────────────
echo -e "${BOLD}[2/3] Remaining K8s secrets${NC}"
echo ""
"$SCRIPT_DIR/setup-secrets.sh" --env="$ENV" "${EXTRA_ARGS[@]}"
echo ""

# ── Step 3: Verify everything ──────────────────────────────────────────
echo -e "${BOLD}[3/3] Verification${NC}"
echo ""
if "$SCRIPT_DIR/verify-secrets.sh" --env="$ENV"; then
  echo ""
  echo -e "${GREEN}${BOLD}Bootstrap complete — environment is ready for helm upgrade.${NC}"
  echo ""
  echo "  Next steps:"
  echo "    helm upgrade --install octogee helm/octogee \\"
  echo "      -f helm/octogee/values.${ENV}.yaml \\"
  echo "      -n <namespace> --create-namespace"
  echo ""
  echo "  After deploy:"
  echo "    helm test octogee -n <namespace>"
  echo ""
else
  echo ""
  echo -e "${RED}${BOLD}Bootstrap incomplete — see errors above.${NC}"
  echo ""
  echo "  Some secrets failed verification. Fix the issues above and re-run:"
  echo "    ./scripts/bootstrap-env.sh --env=${ENV}"
  echo ""
  exit 1
fi
