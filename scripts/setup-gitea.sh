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
CUSTOM_NS=""

for arg in "$@"; do
  case $arg in
    --env=*)       ENV="${arg#*=}" ;;
    --namespace=*) CUSTOM_NS="${arg#*=}" ;;
    --yes|-y)      YES=true ;;
    --help|-h)
      echo "Usage: $0 --env=prod|test|custom [--namespace=NAME] [--yes]"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test|custom [--namespace=NAME] [--yes]"; exit 1; }

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
  custom)
    [[ -z "$CUSTOM_NS" ]] && { echo "--env=custom requires --namespace=NAME"; exit 1; }
    [[ "$CUSTOM_NS" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "Invalid namespace '$CUSTOM_NS'"; exit 1; }
    K8S_NAMESPACE="$CUSTOM_NS"
    GCP_PROJECT="octogee-test"
    CLUSTER_PROJECT="octogee"
    CLUSTER_NAME="octogee-gateway"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    ENV_FILE="$REPO_DIR/.env.$CUSTOM_NS"
    ENV_LABEL="🟣 CUSTOM ($CUSTOM_NS)"
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

# Wait for Gitea HTTP — check if the server is responding at all.
# Accept 200 (public) or 403 (REQUIRE_SIGNIN_VIEW=true) as "Gitea is up".
# Auth will be verified in subsequent API calls.
GITEA_READY=false
for attempt in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    "http://localhost:13000/api/v1/settings/api" 2>/dev/null || echo "000")
  [[ "$STATUS" == "200" || "$STATUS" == "403" ]] && { GITEA_READY=true; break; }
  sleep 3
  info "  Waiting for Gitea HTTP (attempt $attempt/20, status=$STATUS)..."
done
$GITEA_READY || fail "Gitea HTTP not responding after 60s"
ok "Gitea HTTP ready (status=$STATUS)"

# Fix must_change_password (fresh installs set this by default).
# The API returns 403 when must_change_password is true, so we MUST use the
# Gitea CLI inside the pod to reset the password and clear the flag first.
info "Ensuring admin account is accessible..."
GITEA_POD=$(kubectl get pod -n "$K8S_NAMESPACE" -l "app.kubernetes.io/name=gitea" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [[ -n "$GITEA_POD" ]]; then
  # Reset password + clear must_change_password in one CLI call
  kubectl exec -n "$K8S_NAMESPACE" "$GITEA_POD" -- \
    gitea admin user change-password \
      --username octogee-admin \
      --password "$GITEA_ADMIN_PASS" \
      --must-change-password=false 2>/dev/null && \
    ok "Admin password reset + must_change_password cleared" || \
    warn "CLI password reset failed (may already be correct)"
fi

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

# ── 5. Gitea API token: test cached first, only rotate if broken ─────────
info "Checking Gitea API token state..."

# Read cached token from K8s secret (empty if missing)
CACHED_TOKEN=$(kubectl get secret gitea-token -n "$K8S_NAMESPACE" \
  -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || echo "")

token_is_valid() {
  local tok="$1"
  [[ -z "$tok" ]] && return 1
  local who
  who=$(curl -s -H "Authorization: token $tok" \
    "http://localhost:13000/api/v1/user" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('login',''))" 2>/dev/null || echo "")
  [[ "$who" == "octogee-admin" ]]
}

if token_is_valid "$CACHED_TOKEN"; then
  ok "Cached Gitea API token still valid — skipping rotation"
  GIT_API_TOKEN="$CACHED_TOKEN"
else
  info "Cached Gitea API token missing or invalid — rotating"
  # Delete existing token with same name (idempotent)
  curl -s -X DELETE \
    -u "octogee-admin:$GITEA_ADMIN_PASS" \
    "http://localhost:13000/api/v1/users/octogee-admin/tokens/octogee-gateway-token" >/dev/null 2>&1 || true

  TOKEN_RESP=$(curl -s -w "\n%{http_code}" -X POST \
    -u "octogee-admin:$GITEA_ADMIN_PASS" \
    -H "Content-Type: application/json" \
    "http://localhost:13000/api/v1/users/octogee-admin/tokens" \
    -d '{"name":"octogee-gateway-token","scopes":["write:repository","write:organization","write:user","write:admin"]}' 2>/dev/null)
  TOKEN_CODE=$(echo "$TOKEN_RESP" | tail -1)
  TOKEN_BODY=$(echo "$TOKEN_RESP" | head -1)

  [[ "$TOKEN_CODE" == "201" ]] || fail "Failed to create token (HTTP $TOKEN_CODE): $TOKEN_BODY"
  GIT_API_TOKEN=$(echo "$TOKEN_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sha1',''))" 2>/dev/null || echo "")
  [[ -n "$GIT_API_TOKEN" ]] || fail "Token created but sha1 missing: $TOKEN_BODY"
  ok "API token created"
fi

# ── 6. Save token ─────────────────────────────────────────────────────────
save_env "GIT_API_TOKEN" "$GIT_API_TOKEN"
ok "Token saved to $ENV_FILE"

# Store in Secret Manager (safe to re-add same version)
echo -n "$GIT_API_TOKEN" | gcloud secrets versions add "gitea-api-token-${ENV}" \
  --data-file=- --project=octogee 2>/dev/null || \
echo -n "$GIT_API_TOKEN" | gcloud secrets create "gitea-api-token-${ENV}" \
  --data-file=- --project=octogee \
  --replication-policy=user-managed --locations=us-central1 2>/dev/null || \
warn "Could not save token to Secret Manager — it's in .env file"
ok "Token saved to Secret Manager: gitea-api-token-${ENV}"

# ── 7. Apply K8s secret (atomic) ─────────────────────────────────────────
info "Applying gitea-token K8s secret..."
kubectl create secret generic gitea-token -n "$K8S_NAMESPACE" \
  --from-literal=token="$GIT_API_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
ok "gitea-token K8s secret applied"

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
  echo "  Next (canonical sequence — see teardown-gateway.sh --env=$ENV for the full 9 steps):"
  echo "    5. ./scripts/setup-secrets.sh --env=$ENV   # Phase 2 — re-materialize gitea-token + mattermost-gateway"
  echo "    6. kubectl rollout restart deploy -n $K8S_NAMESPACE"
  echo "    7. firebase deploy --project $GCP_PROJECT"
  echo "    8. (cd scripts && npx tsx ops/seed-orchestrator-config.ts --env=$ENV)"
  echo "    9. ./scripts/verify-env.sh --env=$ENV"
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
echo "  Next (canonical step 5): ./scripts/setup-secrets.sh --env=$ENV"
echo ""
