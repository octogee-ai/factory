#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Gitea Setup — Bootstrap org, API token + K8s secrets
# ═══════════════════════════════════════════════════════════════════════════
#
# NOTE: Gitea is deployed by Helm (umbrella chart), NOT by this script.
# This script's job is:
#   1. Wait for Gitea to be ready (Helm must be deployed first)
#   2. Create the 'octogee' org if it doesn't exist
#   3. Create an admin API token (scoped)
#   4. Create K8s secrets consumed by the gateway
#   5. Save token to .env file and Secret Manager
#
# Usage:
#   ./scripts/setup-gitea.sh --env=test [--yes]
#   ./scripts/setup-gitea.sh --env=prod
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ENV=""
YES=false

for arg in "$@"; do
  case $arg in
    --env=*) ENV="${arg#*=}" ;;
    --yes|-y) YES=true ;;
    --help|-h)
      echo "Usage: $0 --env=prod|test [--yes]"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test [--yes]"; exit 1; }

case "$ENV" in
  prod)
    K8S_NAMESPACE="octogee"
    GCP_PROJECT="octogee"
    CLUSTER_PROJECT="octogee"
    CLUSTER_NAME="octogee-gateway"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    ENV_FILE="$REPO_DIR/.env"
    ENV_LABEL="🔴 PRODUCTION"
    GITEA_SVC="octogee-gitea-http"
    ;;
  test)
    K8S_NAMESPACE="octogee-test"
    GCP_PROJECT="octogee-test"
    CLUSTER_PROJECT="octogee"
    CLUSTER_NAME="octogee-gateway"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    ENV_FILE="$REPO_DIR/.env.test"
    ENV_LABEL="🟡 TEST"
    GITEA_SVC="octogee-gitea-http"
    ;;
  *) echo "Unknown environment: $ENV"; exit 1 ;;
esac

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }
status() {
  local label="$1" value="$2"
  if [[ -n "$value" ]]; then
    echo -e "  ${GREEN}✓${NC} $label"
  else
    echo -e "  ${RED}✗${NC} $label"
  fi
}

save_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    local tmpfile; tmpfile=$(mktemp)
    grep -v "^${key}=" "$ENV_FILE" > "$tmpfile"
    echo "${key}=${val}" >> "$tmpfile"
    mv "$tmpfile" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Gitea Setup — ${ENV_LABEL}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ── 0. kubectl context ────────────────────────────────────────────────────
info "Setting kubectl context: $K8S_CONTEXT"
gcloud container clusters get-credentials "$CLUSTER_NAME" --region us-central1 --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT"
CURRENT_CTX=$(kubectl config current-context)
[[ "$CURRENT_CTX" == "$K8S_CONTEXT" ]] || fail "kubectl context mismatch: '$CURRENT_CTX'"
ok "kubectl context: $CURRENT_CTX"
info "This script owns Gitea bootstrap/app state: admin token, org existence, and the gitea-token secret consumed by gateway workflows."

# ── 1. Get Gitea admin password ───────────────────────────────────────────
info "Reading Gitea admin password from Secret Manager..."
GITEA_ADMIN_PASS=$(gcloud secrets versions access latest \
  --secret="gitea-admin-password-${ENV}" --project=octogee 2>/dev/null || echo "")

if [[ -z "$GITEA_ADMIN_PASS" ]]; then
  # Fall back to the secret embedded in the K8s secret
  GITEA_ADMIN_PASS=$(kubectl get secret gitea-admin -n "$K8S_NAMESPACE" \
    -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
fi

[[ -n "$GITEA_ADMIN_PASS" ]] || fail "Could not find Gitea admin password. Check Secret Manager: gitea-admin-password-${ENV}"
ok "Admin password retrieved"

# ── 2. Wait for Gitea ────────────────────────────────────────────────────
info "Checking if Gitea is deployed..."
kubectl get deployment -n "$K8S_NAMESPACE" -l "app.kubernetes.io/name=gitea" >/dev/null 2>&1 || \
  fail "Gitea not deployed. Helm owns infra state; run helm upgrade/install first, then re-run this script for bootstrap state."

info "Waiting for Gitea (up to 120s)..."
kubectl wait --for=condition=available \
  deployment -l "app.kubernetes.io/name=gitea" \
  -n "$K8S_NAMESPACE" --timeout=120s 2>/dev/null || fail "Gitea not ready after 120s"
ok "Gitea ready"

# ── 3. Port-forward + API calls ──────────────────────────────────────────
info "Port-forwarding Gitea (localhost:13000)..."
pkill -f "port-forward svc/$GITEA_SVC" 2>/dev/null || true
sleep 1
kubectl port-forward "svc/$GITEA_SVC" -n "$K8S_NAMESPACE" 13000:3000 &
PF_PID=$!
trap "kill $PF_PID 2>/dev/null || true" EXIT

# Wait for Gitea HTTP
GITEA_READY=false
for attempt in $(seq 1 20); do
  # Use basic auth — Gitea may have REQUIRE_SIGNIN_VIEW=true which blocks unauthenticated API calls
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -u "octogee-admin:$GITEA_ADMIN_PASS" \
    "http://localhost:13000/api/v1/version" 2>/dev/null || echo "000")
  [[ "$STATUS" == "200" ]] && { GITEA_READY=true; break; }
  sleep 3
  info "  Waiting for Gitea HTTP (attempt $attempt/20, status=$STATUS)..."
done
$GITEA_READY || fail "Gitea HTTP not responding after 60s"
ok "Gitea HTTP ready"

# Fix must_change_password (fresh installs set this by default)
info "Ensuring admin account is accessible..."
MUST_CHANGE=$(kubectl exec -n "$K8S_NAMESPACE" \
  "$(kubectl get pod -n "$K8S_NAMESPACE" -l "app.kubernetes.io/name=gitea" -o jsonpath='{.items[0].metadata.name}')" \
  -- /bin/sh -c "gitea admin user list 2>/dev/null | grep octogee-admin | awk '{print \$5}'" 2>/dev/null || echo "")

# Reset must_change_password via API config (tolerant — if it fails we continue)
curl -s -X PATCH "http://localhost:13000/api/v1/admin/users/octogee-admin" \
  -u "octogee-admin:$GITEA_ADMIN_PASS" \
  -H "Content-Type: application/json" \
  -d '{"login_name":"octogee-admin","source_id":0,"must_change_password":false}' >/dev/null 2>&1 || true

# ── 4. Create org ─────────────────────────────────────────────────────────
info "Checking 'octogee' org..."
ORG_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "octogee-admin:$GITEA_ADMIN_PASS" \
  "http://localhost:13000/api/v1/orgs/octogee" 2>/dev/null || echo "000")

if [[ "$ORG_STATUS" == "200" ]]; then
  ok "Org 'octogee' already exists"
else
  ORG_RESP=$(curl -s -w "\n%{http_code}" -X POST \
    -u "octogee-admin:$GITEA_ADMIN_PASS" \
    -H "Content-Type: application/json" \
    "http://localhost:13000/api/v1/orgs" \
    -d '{"username":"octogee","visibility":"private","repo_admin_change_team_access":true}' 2>/dev/null)
  ORG_CODE=$(echo "$ORG_RESP" | tail -1)
  [[ "$ORG_CODE" == "201" ]] || fail "Failed to create org (HTTP $ORG_CODE): $ORG_RESP"
  ok "Org 'octogee' created"
fi

# ── 5. Create API token ───────────────────────────────────────────────────
info "Creating Gitea API token..."
# Delete existing token with same name (idempotent)
curl -s -X DELETE \
  -u "octogee-admin:$GITEA_ADMIN_PASS" \
  "http://localhost:13000/api/v1/users/octogee-admin/tokens/octogee-gateway-token" >/dev/null 2>&1 || true

TOKEN_RESP=$(curl -s -w "\n%{http_code}" -X POST \
  -u "octogee-admin:$GITEA_ADMIN_PASS" \
  -H "Content-Type: application/json" \
  "http://localhost:13000/api/v1/users/octogee-admin/tokens" \
  -d '{"name":"octogee-gateway-token","scopes":["write:repository","write:organization","write:user"]}' 2>/dev/null)
TOKEN_CODE=$(echo "$TOKEN_RESP" | tail -1)
TOKEN_BODY=$(echo "$TOKEN_RESP" | head -1)

[[ "$TOKEN_CODE" == "201" ]] || fail "Failed to create token (HTTP $TOKEN_CODE): $TOKEN_BODY"
GIT_API_TOKEN=$(echo "$TOKEN_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sha1',''))" 2>/dev/null || echo "")
[[ -n "$GIT_API_TOKEN" ]] || fail "Token created but sha1 missing: $TOKEN_BODY"
ok "API token created"

# ── 6. Save token ─────────────────────────────────────────────────────────
save_env "GIT_API_TOKEN" "$GIT_API_TOKEN"
ok "Token saved to $ENV_FILE"

# Store in Secret Manager
echo -n "$GIT_API_TOKEN" | gcloud secrets versions add "gitea-api-token-${ENV}" \
  --data-file=- --project=octogee 2>/dev/null || \
echo -n "$GIT_API_TOKEN" | gcloud secrets create "gitea-api-token-${ENV}" \
  --data-file=- --project=octogee \
  --replication-policy=user-managed --locations=us-central1 2>/dev/null || \
warn "Could not save token to Secret Manager — it's in .env file"
ok "Token saved to Secret Manager: gitea-api-token-${ENV}"

# ── 7. Create K8s secret ──────────────────────────────────────────────────
info "Creating gitea-token K8s secret..."
kubectl delete secret gitea-token -n "$K8S_NAMESPACE" 2>/dev/null || true
kubectl create secret generic gitea-token -n "$K8S_NAMESPACE" \
  --from-literal=token="$GIT_API_TOKEN"
ok "gitea-token K8s secret created"

# Kill port-forward
kill $PF_PID 2>/dev/null || true
trap - EXIT

echo ""
echo -e "${CYAN}Gitea bootstrap summary${NC}"
status "Gitea admin password present" "$GITEA_ADMIN_PASS"
status "Org 'octogee' reachable" "$(curl -s -u "octogee-admin:$GITEA_ADMIN_PASS" http://localhost:13000/api/v1/orgs/octogee 2>/dev/null | grep -o '"username":"octogee"' || true)"
status "GIT_API_TOKEN created" "$GIT_API_TOKEN"
status "gitea-token secret materialized" "$(kubectl get secret gitea-token -n "$K8S_NAMESPACE" -o jsonpath='{.metadata.name}' 2>/dev/null || true)"

echo ""
if [[ -n "$GIT_API_TOKEN" ]]; then
  ok "Gitea bootstrap state looks healthy"
  echo ""
  echo "  Next steps:"
  echo "    1. Run ./scripts/setup-gateway.sh --env=$ENV if gateway deploy/update is next"
  echo "    2. If gateway/workspace features were already deployed, restart workloads that read gitea-token"
  echo "    3. Re-test workspace repo/file flows"
else
  warn "Gitea bootstrap is incomplete"
  echo ""
  echo "  Next steps:"
  echo "    1. Review the token/org warnings above"
  echo "    2. Re-run ./scripts/setup-gitea.sh --env=$ENV"
  echo "    3. Do not trust repo provisioning until gitea-token is present"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Gitea setup complete! (${ENV_LABEL})${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Org:    octogee"
echo "  Token:  saved to $ENV_FILE + Secret Manager"
echo ""
echo "  Next: ./scripts/setup-gateway.sh --env=$ENV"
echo ""
