#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Pre-deploy secret verification
# ═══════════════════════════════════════════════════════════════════════════
#
# Checks that all required K8s secrets exist before helm upgrade.
# Run this in CI before deploy, or locally before manual helm commands.
#
# Required secrets are derived from the Helm chart:
#   - gateway/templates/deployment.yaml  (secretKeyRef without optional: true)
#   - workspace-api/values.yaml          (optional: false)
#   - workspace-api/templates/cronjob-*  (secretKeyRef)
#
# Usage:
#   ./scripts/verify-secrets.sh --env=prod [--context=gke_octogee_us-central1_octogee-gateway]
#   ./scripts/verify-secrets.sh --env=test
#
# Exit codes:
#   0 — all required secrets present
#   1 — missing secrets (prints which ones)
# ═══════════════════════════════════════════════════════════════════════════

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BOLD='\033[1m'; NC='\033[0m'

ENV=""
KUBE_CTX=""

for arg in "$@"; do
  case $arg in
    --env=*)     ENV="${arg#*=}" ;;
    --context=*) KUBE_CTX="${arg#*=}" ;;
    --help|-h)   echo "Usage: $0 --env=prod|test [--context=<kube-context>]"; exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test"; exit 1; }

case "$ENV" in
  prod)
    NS="octogee"
    [[ -z "$KUBE_CTX" ]] && KUBE_CTX="gke_octogee_us-central1_octogee-gateway"
    ;;
  test)
    NS="octogee-test"
    [[ -z "$KUBE_CTX" ]] && KUBE_CTX="gke_octogee-test_us-central1_octogee-test"
    ;;
  *) echo "Unknown environment: $ENV"; exit 1 ;;
esac

# ── Required secrets ────────────────────────────────────────────────────────
# These cause CreateContainerConfigError if missing (not marked optional).
# Keep in sync with:
#   helm/octogee/charts/gateway/templates/deployment.yaml
#   helm/octogee/charts/workspace-api/values.yaml
#   helm/octogee/charts/workspace-api/templates/cronjob-trial-expiry.yaml
REQUIRED_SECRETS=(
  "octogee-anthropic"       # gateway: ANTHROPIC_API_KEY
  "internal-service-key"    # gateway + workspace-api + trial-expiry CronJob
  "stripe-secrets"          # workspace-api: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
  "gitea-token"             # workspace-api: GITEA_TOKEN (not optional in deployment template)
)

echo ""
echo -e "${BOLD}Pre-deploy secret check — ${ENV}${NC}"
echo -e "Namespace: ${NS} | Context: ${KUBE_CTX}"
echo ""

MISSING=()
for secret in "${REQUIRED_SECRETS[@]}"; do
  if kubectl get secret "$secret" -n "$NS" --context "$KUBE_CTX" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} $secret"
  else
    echo -e "  ${RED}✗${NC} $secret — ${RED}MISSING${NC}"
    MISSING+=("$secret")
  fi
done

# Also check optional-but-important secrets (warn only, don't fail)
OPTIONAL_SECRETS=(
  "mattermost-gateway"
  "mattermost-cloud-sql"
  "octogee-brave"
  "octogee-github"
  "gitea-admin"
  "gitea-credentials"
)

echo ""
echo -e "${BOLD}Optional secrets:${NC}"
for secret in "${OPTIONAL_SECRETS[@]}"; do
  if kubectl get secret "$secret" -n "$NS" --context "$KUBE_CTX" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} $secret"
  else
    echo -e "  ${YELLOW}⚠${NC} $secret — missing (optional, won't block deploy)"
  fi
done

echo ""

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo -e "${RED}${BOLD}❌ ${#MISSING[@]} required secret(s) missing — deploy will fail!${NC}"
  echo ""
  echo "  Fix: ./scripts/setup-secrets.sh --env=${ENV}"
  echo ""
  exit 1
else
  echo -e "${GREEN}${BOLD}✅ All required secrets present — safe to deploy${NC}"
  echo ""
  exit 0
fi
