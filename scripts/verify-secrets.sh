#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Pre-deploy secret verification
# ═══════════════════════════════════════════════════════════════════════════
#
# Checks that all required K8s secrets exist AND that critical keys within
# them are non-empty. Run this in CI before deploy, or locally before manual
# helm commands.
#
# Required secrets include Helm startup dependencies and product integrations
# that must fail closed before a release is considered operational:
#   - gateway/templates/deployment.yaml  (secretKeyRef without optional: true)
#   - gateway-edge/values.yaml          (optional: false)
#   - chat-proxy/values.yaml             (optional: false)
#   - gateway-edge/templates/cronjob-*  (secretKeyRef)
#
# Usage:
#   ./scripts/verify-secrets.sh --env=prod [--context=<kube-context>]
#   ./scripts/verify-secrets.sh --env=test
#   ./scripts/verify-secrets.sh --env=custom --namespace=feat-alice
#
# Exit codes:
#   0 — all required secrets present with non-empty critical keys
#   1 — missing secrets or empty required keys
# ═══════════════════════════════════════════════════════════════════════════

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BOLD='\033[1m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/shell-env.sh
source "$SCRIPT_DIR/lib/shell-env.sh"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"

ENV=""
KUBE_CTX=""
CUSTOM_NS=""

for arg in "$@"; do
  case $arg in
    --env=*)       ENV="${arg#*=}" ;;
    --namespace=*) CUSTOM_NS="${arg#*=}" ;;
    --context=*)   KUBE_CTX="${arg#*=}" ;;
    --help|-h)     echo "Usage: $0 --env=prod|test|build-week|custom [--namespace=NAME] [--context=<kube-context>]"; exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test|build-week|custom [--namespace=NAME]"; exit 1; }

TARGET_ENV="$ENV"
[[ "$TARGET_ENV" == "custom" ]] && TARGET_ENV="test"
octogee_load_deployment_target "--environment=$TARGET_ENV"
NS="$TARGET_NAMESPACE"
[[ -z "$KUBE_CTX" ]] && KUBE_CTX="$TARGET_KUBE_CONTEXT"

case "$ENV" in
  prod|test|build-week) ;;
  custom)
    [[ -z "$CUSTOM_NS" ]] && { echo "--env=custom requires --namespace=NAME"; exit 1; }
    [[ "$CUSTOM_NS" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "Invalid namespace '$CUSTOM_NS'"; exit 1; }
    NS="$CUSTOM_NS"
    ;;
  *) echo "Unknown environment: $ENV"; exit 1 ;;
esac

# ── Required secrets ────────────────────────────────────────────────────────
# These cause CreateContainerConfigError if missing (not marked optional).
# Keep in sync with:
#   helm/octogee/charts/gateway/templates/deployment.yaml
#   helm/octogee/charts/gateway-edge/values.yaml
#   helm/octogee/charts/chat-proxy/values.yaml
#   helm/octogee/charts/gateway-edge/templates/cronjob-trial-expiry.yaml
REQUIRED_SECRETS=(
  "octogee-anthropic"       # setup/legacy only; gateway pods do not mount it
  "octogee-openrouter"      # llm-broker + dedicated Ops Agent
  "gateway-model-key-issuer" # glm-controller ↔ octogee-api model broker token issuer
  "ops-agent-bearer"        # octogee-api → octogee-ops-agent
  "social-notification-bearer"  # octogee-api /social + Cloud Functions social producer
  "mattermost-gateway"      # octogee-api + glm-controller; gateway pods do not mount admin_token
  "stripe-secrets"          # octogee-api: Stripe API, webhook, and per-environment price map
  "google-oauth"             # octogee-api: Google OAuth + Drive picker
  "connect-state-secret"     # octogee-api: OAuth state HMAC
  "gitea-token"             # octogee-api + glm-controller
  "approval-signing"        # gateway-edge activity bridge callback HMAC
  "agent-control-signing"        # chat-proxy: OCTOGEE_AGENT_CONTROL_SIGNING_SECRET (HMAC for controls)
  "agent-control-router"    # private Mattermost callback-router → gateway-edge HMAC
  "byot-sync-internal"      # octogee-api → gateway-edge BYOT sync HMAC
)

# ── Critical keys within secrets ────────────────────────────────────────────
# These are the most common source of "secret exists but value is empty" drift.
# Format: "secret_name:key_name:fix_script"
# Suffix passed to fix-script hints — includes --namespace for custom env.
FIX_SUFFIX="--env=${ENV}"
[[ "$ENV" == "custom" ]] && FIX_SUFFIX="--env=custom --namespace=${CUSTOM_NS}"

REQUIRED_KEYS=(
  "mattermost-gateway:admin_token:./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  "mattermost-gateway:team_id:./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  "mattermost-gateway:admin_user:./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  "mattermost-gateway:admin_pass:./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  "mattermost-gateway:admin_user_id:./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  "gateway-model-key-issuer:bearer_token:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "ops-agent-bearer:bearer_token:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "social-notification-bearer:bearer-token:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "octogee-anthropic:api_key:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "octogee-openrouter:api_key:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "approval-signing:secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "agent-control-signing:secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "agent-control-router:secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "byot-sync-internal:secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "stripe-secrets:secret_key:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "stripe-secrets:webhook_secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "stripe-secrets:price_ids:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "google-oauth:client_id:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "google-oauth:client_secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "google-oauth:picker_api_key:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "google-oauth:picker_app_id:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "connect-state-secret:secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
)

echo ""
echo -e "${BOLD}Pre-deploy secret check — ${ENV}${NC}"
echo -e "Namespace: ${NS} | Context: ${KUBE_CTX}"
echo ""

FAILURES=0

# ── Check secret existence ──────────────────────────────────────────────────
echo -e "${BOLD}Required secrets:${NC}"
for secret in "${REQUIRED_SECRETS[@]}"; do
  if kubectl get secret "$secret" -n "$NS" --context "$KUBE_CTX" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} $secret"
  else
    echo -e "  ${RED}✗${NC} $secret — ${RED}MISSING${NC}"
    FAILURES=$((FAILURES + 1))
  fi
done

# ── Check critical key values ───────────────────────────────────────────────
echo ""
echo -e "${BOLD}Required keys (non-empty):${NC}"
for entry in "${REQUIRED_KEYS[@]}"; do
  IFS=':' read -r secret key fix <<< "$entry"

  # Skip key check if the secret itself is missing (already reported above)
  if ! kubectl get secret "$secret" -n "$NS" --context "$KUBE_CTX" >/dev/null 2>&1; then
    continue
  fi

  VAL_B64=$(kubectl get secret "$secret" -n "$NS" --context "$KUBE_CTX" \
    -o jsonpath="{.data.${key}}" 2>/dev/null || echo "")

  VALUE=""
  [[ -n "$VAL_B64" ]] && VALUE="$(printf '%s' "$VAL_B64" | base64 -d 2>/dev/null || true)"

  if [[ -z "$(configured_secret_value "$VALUE")" ]]; then
    echo -e "  ${RED}✗${NC} ${secret}/${key} — ${RED}EMPTY${NC}"
    echo -e "    Fix: ${fix}"
    FAILURES=$((FAILURES + 1))
  elif [[ "$secret:$key" == "stripe-secrets:secret_key" ]] \
    && ! validate_stripe_secret_key_mode "$ENV" "$VALUE"; then
    echo -e "  ${RED}✗${NC} ${secret}/${key} — ${RED}INVALID MODE${NC}"
    echo -e "    Fix: ${fix}"
    FAILURES=$((FAILURES + 1))
  elif [[ "$secret:$key" == "stripe-secrets:webhook_secret" ]] \
    && ! validate_stripe_webhook_secret "$VALUE"; then
    echo -e "  ${RED}✗${NC} ${secret}/${key} — ${RED}INVALID${NC}"
    echo -e "    Fix: ${fix}"
    FAILURES=$((FAILURES + 1))
  elif [[ "$secret:$key" == "stripe-secrets:price_ids" ]] \
    && ! validate_stripe_price_ids_json "$VALUE"; then
    echo -e "  ${RED}✗${NC} ${secret}/${key} — ${RED}INVALID${NC}"
    echo -e "    Fix: ${fix}"
    FAILURES=$((FAILURES + 1))
  else
    echo -e "  ${GREEN}✓${NC} ${secret}/${key}"
  fi
done

# ── Optional-but-important secrets (warn only) ──────────────────────────────
OPTIONAL_SECRETS=(
  "mattermost-cloud-sql"
  "octogee-brave"
  "octogee-tavily"
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

if [[ "$FAILURES" -gt 0 ]]; then
  echo -e "${RED}${BOLD}❌ ${FAILURES} issue(s) found — deploy will fail!${NC}"
  echo ""
  if [[ "$ENV" == "custom" ]]; then
    echo "  Quick fix: ./scripts/provision-namespace.sh ${CUSTOM_NS} --yes"
  else
    echo "  Quick fix: ./scripts/setup-secrets.sh --env=${ENV}"
  fi
  echo ""
  exit 1
else
  echo -e "${GREEN}${BOLD}✅ All required secrets and keys present — safe to deploy${NC}"
  echo ""
  exit 0
fi
