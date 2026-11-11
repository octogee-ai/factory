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
#   4. Create the K8s secret consumed by platform services
#   5. Save token to .env file and Secret Manager
#
# Usage:
#   ./scripts/setup-gitea.sh --env=test [--yes]
#   ./scripts/setup-gitea.sh --env=prod
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"
# shellcheck source=scripts/lib/gitea-token-convergence.sh
source "$SCRIPT_DIR/lib/gitea-token-convergence.sh"

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
DEPLOYMENT_TARGET=""
MIGRATION_QUIESCED=false
CONFIRM_PLATFORM_MIGRATION=""

for arg in "$@"; do
  case $arg in
    --env=*)       ENV="${arg#*=}" ;;
    --deployment-target=*) DEPLOYMENT_TARGET="${arg#*=}" ;;
    --namespace=*) CUSTOM_NS="${arg#*=}" ;;
    --migration-quiesced) MIGRATION_QUIESCED=true ;;
    --confirm-platform-migration=*) CONFIRM_PLATFORM_MIGRATION="${arg#*=}" ;;
    --yes|-y)      YES=true ;;
    --help|-h)
      echo "Usage: $0 --env=prod|test|custom [--deployment-target=TARGET] [--namespace=NAME] [--migration-quiesced --confirm-platform-migration=TARGET] [--yes]"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test|custom [--deployment-target=TARGET] [--namespace=NAME] [--yes]"; exit 1; }

TARGET_ENV="$ENV"
[[ "$TARGET_ENV" == "custom" ]] && TARGET_ENV="test"
if [[ -n "$DEPLOYMENT_TARGET" ]]; then
  octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"
  [[ "$TARGET_ENVIRONMENT" != "$TARGET_ENV" ]] && {
    echo "Deployment target '$DEPLOYMENT_TARGET' does not belong to environment '$TARGET_ENV'"
    exit 1
  }
else
  octogee_load_deployment_target "--environment=$TARGET_ENV"
fi
K8S_NAMESPACE="$TARGET_NAMESPACE"
GCP_PROJECT="$TARGET_FIREBASE_PROJECT"
CLUSTER_PROJECT="$TARGET_CLUSTER_PROJECT"
CLUSTER_NAME="$TARGET_CLUSTER_NAME"
K8S_CONTEXT="$TARGET_KUBE_CONTEXT"
INTERNAL_SECRET_SUFFIX="$TARGET_SECRET_NAME_SUFFIX"
TARGET_ARG=" --deployment-target=$TARGET_ID"

case "$ENV" in
  prod)
    ENV_FILE="$REPO_DIR/.env"
    ENV_LABEL="🔴 PRODUCTION"
    GITEA_SVC="octogee-gitea-http"
    ;;
  test)
    ENV_FILE="$REPO_DIR/.env.test"
    ENV_LABEL="🟡 TEST"
    GITEA_SVC="octogee-gitea-http"
    ;;
  custom)
    [[ -z "$CUSTOM_NS" ]] && { echo "--env=custom requires --namespace=NAME"; exit 1; }
    [[ "$CUSTOM_NS" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "Invalid namespace '$CUSTOM_NS'"; exit 1; }
    K8S_NAMESPACE="$CUSTOM_NS"
    ENV_FILE="$REPO_DIR/.env.$CUSTOM_NS"
    ENV_LABEL="🟣 CUSTOM ($CUSTOM_NS)"
    GITEA_SVC="octogee-gitea-http"
    INTERNAL_SECRET_SUFFIX="custom"
    TARGET_ARG=""
    ;;
  *) echo "Unknown environment: $ENV"; exit 1 ;;
esac
if [[ "$ENV" != "custom" ]]; then
  case "$TARGET_ID" in
    prod-central|test-central) ;;
    *) ENV_FILE="$REPO_DIR/.env.$TARGET_ID" ;;
  esac
fi

if $MIGRATION_QUIESCED; then
  case "$TARGET_ID" in
    test-west|prod-west) ;;
    *) echo "Migration-quiesced Gitea setup is restricted to WEST platform migration targets" >&2; exit 1 ;;
  esac
  [[ "$CONFIRM_PLATFORM_MIGRATION" == "$TARGET_ID" ]] || {
    echo "Migration-quiesced Gitea setup requires --confirm-platform-migration=$TARGET_ID" >&2
    exit 1
  }
fi

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

secret_manager_destroy_superseded_versions() {
  local name="$1" project="$2"
  local listing version state newest=0 newest_state="" failures=0
  listing="$(mktemp)"
  if ! gcloud secrets versions list "$name" --project="$project" --format='value(name,state)' >"$listing"; then
    rm -f "$listing"
    printf 'Could not list Secret Manager versions for %s/%s\n' "$project" "$name" >&2
    return 1
  fi
  while IFS=$'\t' read -r version state || [[ -n "$version" ]]; do
    version="${version##*/}"
    if [[ ! "$version" =~ ^[0-9]+$ || "$state" == "DESTROYED" ]]; then
      continue
    fi
    if (( version > newest )); then
      newest="$version"
      newest_state="$state"
    fi
  done <"$listing"
  if [[ "$newest_state" != "ENABLED" ]]; then
    rm -f "$listing"
    printf 'Refusing to prune %s/%s: newest live version is %s\n' "$project" "$name" "${newest_state:-absent}" >&2
    return 1
  fi
  while IFS=$'\t' read -r version state || [[ -n "$version" ]]; do
    version="${version##*/}"
    if [[ ! "$version" =~ ^[0-9]+$ || "$state" == "DESTROYED" ]]; then
      continue
    fi
    if (( version >= newest )); then
      continue
    fi
    if ! gcloud secrets versions destroy "$version" --secret="$name" --project="$project" --quiet >/dev/null; then
      printf 'Failed to destroy superseded Secret Manager version %s/%s/%s\n' "$project" "$name" "$version" >&2
      failures=$((failures + 1))
    fi
  done <"$listing"
  rm -f "$listing"
  if (( failures > 0 )); then
    return 1
  fi
  return 0
}

secret_manager_persist_version_file() {
  local name="$1" file="$2" project="$3"
  local current
  if ! gcloud secrets describe "$name" --project="$project" >/dev/null 2>&1; then
    if ! gcloud secrets create "$name" --data-file="$file" --project="$project" \
      --replication-policy=user-managed --locations="$TARGET_REGION" --quiet >/dev/null; then
      printf 'Could not create Secret Manager secret %s/%s\n' "$project" "$name" >&2
      return 1
    fi
    return 0
  fi
  current="$(mktemp)"
  chmod 600 "$current"
  if gcloud secrets versions access latest --secret="$name" --project="$project" >"$current" 2>/dev/null \
    && cmp -s "$current" "$file"; then
    rm -f "$current"
    return 0
  fi
  rm -f "$current"
  if ! gcloud secrets versions add "$name" --data-file="$file" --project="$project" --quiet >/dev/null; then
    printf 'Could not add Secret Manager version for %s/%s\n' "$project" "$name" >&2
    return 1
  fi
  if ! secret_manager_destroy_superseded_versions "$name" "$project"; then
    printf 'Superseded Secret Manager versions remain for %s/%s\n' "$project" "$name" >&2
  fi
  return 0
}

secret_manager_persist_value() {
  local name="$1" value="$2" project="$3"
  local payload status=0
  payload="$(mktemp)"
  chmod 600 "$payload"
  printf '%s' "$value" >"$payload"
  secret_manager_persist_version_file "$name" "$payload" "$project" || status=$?
  rm -f "$payload"
  return "$status"
}

gitea_field() {
  local response="$1" field="$2" json_file value
  json_file=$(mktemp)
  chmod 600 "$json_file"
  printf '%s' "$response" > "$json_file"
  if ! value=$(python3 -c '
import json, sys
with open(sys.argv[2], encoding="utf-8") as source:
    payload = json.load(source)
print(payload.get(sys.argv[1], "") if isinstance(payload, dict) else "")
' "$field" "$json_file" 2>/dev/null); then
    rm -f "$json_file"
    return 1
  fi
  rm -f "$json_file"
  printf '%s\n' "$value"
}

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Gitea Setup — ${ENV_LABEL}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ── 0. kubectl context ────────────────────────────────────────────────────
info "Setting kubectl context: $K8S_CONTEXT"
gcloud container clusters get-credentials "$CLUSTER_NAME" --region "$TARGET_REGION" --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT"
CURRENT_CTX=$(kubectl config current-context)
[[ "$CURRENT_CTX" == "$K8S_CONTEXT" ]] || fail "kubectl context mismatch: '$CURRENT_CTX'"
ok "kubectl context: $CURRENT_CTX"
info "This script owns Gitea bootstrap/app state: admin token, org existence, and the gitea-token secret consumed by platform workflows."

# ── 1. Get Gitea admin password ───────────────────────────────────────────
info "Reading Gitea admin password from Secret Manager..."
GITEA_ADMIN_PASSWORD_SM_KEY="gitea-admin-password-${TARGET_SECRET_NAME_SUFFIX}"
GITEA_API_TOKEN_SM_KEY="gitea-api-token-${TARGET_SECRET_NAME_SUFFIX}"
if [[ "$ENV" == "custom" ]]; then
  GITEA_ADMIN_PASSWORD_SM_KEY="gitea-admin-password-${INTERNAL_SECRET_SUFFIX}"
  GITEA_API_TOKEN_SM_KEY="gitea-api-token-${INTERNAL_SECRET_SUFFIX}"
fi
GITEA_ADMIN_PASS=$(gcloud secrets versions access latest \
  --secret="$GITEA_ADMIN_PASSWORD_SM_KEY" --project="$TARGET_CLOUD_SQL_PROJECT" 2>/dev/null || echo "")

if [[ -z "$GITEA_ADMIN_PASS" ]]; then
  # Fall back to the secret embedded in the K8s secret
  GITEA_ADMIN_PASS=$(kubectl get secret gitea-admin -n "$K8S_NAMESPACE" \
    -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
fi

[[ -n "$GITEA_ADMIN_PASS" ]] || fail "Could not find Gitea admin password. Check Secret Manager: $GITEA_ADMIN_PASSWORD_SM_KEY"
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
ORG_REACHABLE=""

if [[ "$ORG_STATUS" == "200" ]]; then
  ORG_REACHABLE="octogee"
  ok "Org 'octogee' already exists"
else
  ORG_RESP=$(curl -s -w "\n%{http_code}" -X POST \
    -u "octogee-admin:$GITEA_ADMIN_PASS" \
    -H "Content-Type: application/json" \
    "http://localhost:13000/api/v1/orgs" \
    -d '{"username":"octogee","visibility":"private","repo_admin_change_team_access":true}' 2>/dev/null)
  ORG_CODE=$(echo "$ORG_RESP" | tail -1)
  [[ "$ORG_CODE" == "201" ]] || fail "Failed to create org (HTTP $ORG_CODE): $ORG_RESP"
  ORG_REACHABLE="octogee"
  ok "Org 'octogee' created"
fi

# ── 5. Gitea API token: test cached first, only rotate if broken ─────────
info "Checking Gitea API token state..."

# Read cached token from K8s secret (empty if missing)
CACHED_TOKEN=$(kubectl get secret gitea-token -n "$K8S_NAMESPACE" \
  -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
$MIGRATION_QUIESCED && CACHED_TOKEN=""

token_is_valid() {
  local tok="$1"
  [[ -z "$tok" ]] && return 1
  local who who_response issue_status
  who_response=$(curl -s -H "Authorization: token $tok" \
    "http://localhost:13000/api/v1/user" 2>/dev/null || true)
  who=$(gitea_field "$who_response" login 2>/dev/null || echo "")
  issue_status=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: token $tok" \
    "http://localhost:13000/api/v1/repos/issues/search?limit=1" 2>/dev/null || echo "000")
  [[ "$who" == "octogee-admin" && "$issue_status" == "200" ]]
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
    -d '{"name":"octogee-gateway-token","scopes":["write:repository","write:issue","write:organization","write:user","write:admin"]}' 2>/dev/null)
  TOKEN_CODE=$(echo "$TOKEN_RESP" | tail -1)
  TOKEN_BODY=$(echo "$TOKEN_RESP" | head -1)

  [[ "$TOKEN_CODE" == "201" ]] || fail "Failed to create token (HTTP $TOKEN_CODE)"
  GIT_API_TOKEN=$(gitea_field "$TOKEN_BODY" sha1 2>/dev/null || echo "")
  [[ -n "$GIT_API_TOKEN" ]] || fail "Token created but sha1 missing"
  ok "API token created"
fi

# ── 6. Save token ─────────────────────────────────────────────────────────
save_env "GIT_API_TOKEN" "$GIT_API_TOKEN"
ok "Token saved to $ENV_FILE"

SM_TOKEN_PERSIST_STATUS=0
secret_manager_persist_value "$GITEA_API_TOKEN_SM_KEY" "$GIT_API_TOKEN" "$TARGET_CLOUD_SQL_PROJECT" || SM_TOKEN_PERSIST_STATUS=$?
if [[ "$SM_TOKEN_PERSIST_STATUS" -eq 0 ]]; then
  ok "Token saved to Secret Manager: $GITEA_API_TOKEN_SM_KEY"
else
  warn "Could not save token to Secret Manager — it's in $ENV_FILE"
fi

# ── 7. Apply K8s secret (atomic) ─────────────────────────────────────────
info "Applying gitea-token K8s secret..."
kubectl create secret generic gitea-token -n "$K8S_NAMESPACE" \
  --from-literal=token="$GIT_API_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
ok "gitea-token K8s secret applied"

if $MIGRATION_QUIESCED; then
  info "Leaving Gitea token consumers quiesced for receipt-gated writer restore"
else
  restart_gitea_token_consumers
fi

# Kill port-forward
kill $PF_PID 2>/dev/null || true
trap - EXIT

echo ""
echo -e "${CYAN}Gitea bootstrap summary${NC}"
status "Gitea admin password present" "$GITEA_ADMIN_PASS"
status "Org 'octogee' reachable" "$ORG_REACHABLE"
status "GIT_API_TOKEN created" "$GIT_API_TOKEN"
status "gitea-token secret materialized" "$(kubectl get secret gitea-token -n "$K8S_NAMESPACE" -o jsonpath='{.metadata.name}' 2>/dev/null || true)"

echo ""
if [[ -n "$GIT_API_TOKEN" ]]; then
  ok "Gitea bootstrap state looks healthy"
  echo ""
  echo "  Next (canonical sequence — see teardown-env.sh --env=$ENV$TARGET_ARG for the full 9 steps):"
  echo "    5. ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG --phase=launch"
  echo "    6. firebase deploy --project $GCP_PROJECT"
  echo "    7. npm run --prefix scripts with-platform-state -- --env=$ENV -- npx tsx ops/seed-orchestrator-config.ts --env=$ENV$TARGET_ARG"
  echo "    8. ./scripts/verify-env.sh --env=$ENV$TARGET_ARG"
else
  warn "Gitea bootstrap is incomplete"
  echo ""
  echo "  Next steps:"
  echo "    1. Review the token/org warnings above"
  echo "    2. Re-run ./scripts/setup-gitea.sh --env=$ENV$TARGET_ARG"
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
echo "  Next (canonical step 5): ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG --phase=launch"
echo ""
