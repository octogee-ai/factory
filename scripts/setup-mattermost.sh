#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Mattermost Setup — Bootstrap credentials + K8s secrets
# ═══════════════════════════════════════════════════════════════════════════
#
# NOTE: Mattermost is deployed by Helm (umbrella chart), NOT by this script.
# This script's job is:
#   1. Collect/generate credentials (admin pass, DB pass)
#   2. Sync DB password to Cloud SQL
#   3. Create K8s secrets consumed by Helm
#   4. Bootstrap admin user, team, bot + token on a fresh MM instance
#   5. Save everything to .env.test / .env
#
# Run this BEFORE `helm upgrade --install` on a fresh environment.
# On an existing environment: re-run to refresh K8s secrets or re-bootstrap.
#
# Usage:
#   ./scripts/setup-mattermost.sh --env=test [--yes]
#   ./scripts/setup-mattermost.sh --env=prod
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
    MM_DB_NAME="mattermost_prod"
    MM_DB_USER="mattermost"
    ;;
  test)
    K8S_NAMESPACE="octogee-test"
    GCP_PROJECT="octogee-test"
    CLUSTER_PROJECT="octogee"
    CLUSTER_NAME="octogee-gateway"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    ENV_FILE="$REPO_DIR/.env.test"
    ENV_LABEL="🟡 TEST"
    MM_DB_NAME="mattermost_test"
    MM_DB_USER="mattermost"
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
    MM_DB_NAME="mattermost_${CUSTOM_NS//-/_}"
    MM_DB_USER="mattermost"
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

confirm() {
  $YES && return 0
  echo -ne "  ${YELLOW}$1 [Y/n]:${NC} "
  read -r yn
  [[ ! "$yn" =~ ^[Nn]$ ]]
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

# Read a key from a K8s secret (empty string if secret or key is missing).
ksecret_key() {
  kubectl get secret "$1" -n "$K8S_NAMESPACE" \
    -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d 2>/dev/null || echo ""
}

# Test an MM PAT by calling /api/v4/users/me and checking the returned user
# ID matches the expected one. Returns 0 on match, 1 otherwise.
mm_pat_is_valid() {
  local pat="$1" expected_uid="$2"
  [[ -z "$pat" || -z "$expected_uid" ]] && return 1
  local actual_uid
  actual_uid=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s "http://localhost:8065/api/v4/users/me" \
    -H "Authorization: Bearer $pat" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  [[ "$actual_uid" == "$expected_uid" ]]
}

load_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  set +u
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    export "$key=$val"
  done < "$ENV_FILE"
  set -u
}

load_env

if [[ "$ENV" == "prod" ]] && $YES; then
  fail "--yes cannot be used with prod."
fi

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Mattermost Setup — ${ENV_LABEL}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ── 0. kubectl context ────────────────────────────────────────────────────
info "Setting kubectl context: $K8S_CONTEXT"
gcloud container clusters get-credentials "$CLUSTER_NAME" --region us-central1 --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT"
CURRENT_CTX=$(kubectl config current-context)
[[ "$CURRENT_CTX" == "$K8S_CONTEXT" ]] || fail "kubectl context is '$CURRENT_CTX', expected '$K8S_CONTEXT'."
ok "kubectl context: $CURRENT_CTX"
info "This script owns Mattermost bootstrap/app state: admin user, admin PAT, bot token, team, and the mattermost-gateway secret inputs."

# Ensure namespace exists
kubectl get namespace "$K8S_NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$K8S_NAMESPACE"

# ── 1. Credentials ────────────────────────────────────────────────────────
set +u

MM_URL_DEFAULT="http://mattermost.${K8S_NAMESPACE}.svc.cluster.local:8065"
MM_URL="${MM_URL:-$MM_URL_DEFAULT}"
save_env "MM_URL" "$MM_URL"
info "MM URL: $MM_URL"

[[ -z "${MM_ADMIN_USER:-}" ]] && MM_ADMIN_USER="octogee-admin"
save_env "MM_ADMIN_USER" "$MM_ADMIN_USER"
info "Admin user: $MM_ADMIN_USER"

if [[ -z "${MM_ADMIN_PASS:-}" ]]; then
  MM_ADMIN_PASS="Octogee$(openssl rand -hex 4)!"
  info "Generated admin password"
fi
save_env "MM_ADMIN_PASS" "$MM_ADMIN_PASS"

# DB password always comes from Secret Manager (octogee project owns Cloud SQL)
SM_PASS=$(gcloud secrets versions access latest --secret=MM_DB_PASSWORD --project=octogee 2>/dev/null || echo "")
if [[ -n "$SM_PASS" ]]; then
  MM_DB_PASSWORD="$SM_PASS"
  info "MM_DB_PASSWORD from Secret Manager (octogee project)"
elif [[ -n "${MM_DB_PASSWORD:-}" ]]; then
  info "MM_DB_PASSWORD from env file"
else
  MM_DB_PASSWORD=$(openssl rand -hex 24)
  warn "MM_DB_PASSWORD not in Secret Manager — generated new. Store it: printf '%s' \"\$MM_DB_PASSWORD\" | gcloud secrets create MM_DB_PASSWORD --data-file=- --project=octogee"
fi
save_env "MM_DB_PASSWORD" "$MM_DB_PASSWORD"
set -u

# ── 2. Sync DB password to Cloud SQL ─────────────────────────────────────
info "Syncing DB password to Cloud SQL user '$MM_DB_USER'..."
if gcloud sql users set-password "$MM_DB_USER" \
    --instance=octogee-pg \
    --project=octogee \
    --password="$MM_DB_PASSWORD" 2>&1; then
  ok "Cloud SQL user '$MM_DB_USER' password synced"
else
  warn "Could not sync Cloud SQL password — check IAM"
fi

# ── 3. Create K8s secrets ─────────────────────────────────────────────────
info "Creating K8s secrets..."
kubectl delete secret mattermost-cloud-sql -n "$K8S_NAMESPACE" 2>/dev/null || true
kubectl create secret generic mattermost-cloud-sql -n "$K8S_NAMESPACE" \
  --from-literal=password="$MM_DB_PASSWORD"
ok "mattermost-cloud-sql secret created"

# ── 4. Wait for Mattermost (Helm must already be deployed or running) ─────
info "Checking if Mattermost is deployed..."
if ! kubectl get deployment mattermost -n "$K8S_NAMESPACE" >/dev/null 2>&1; then
  info "Mattermost not deployed yet — Helm owns infra state, this script owns bootstrap state."
  echo ""
  echo "  Next step: deploy Helm first, then re-run this script"
  echo ""
  echo "  helm upgrade --install octogee helm/octogee \\"
  echo "    -f helm/octogee/values.${ENV}.yaml \\"
  echo "    -n $K8S_NAMESPACE --create-namespace \\"
  echo "    --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
  echo "    --kube-context $K8S_CONTEXT"
  echo ""
  ok "K8s secrets ready. Deploy Helm then re-run to complete Mattermost bootstrap."
  exit 0
fi

info "Waiting for Mattermost (up to 120s)..."
kubectl wait --for=condition=available deployment/mattermost \
  -n "$K8S_NAMESPACE" --timeout=120s 2>/dev/null || fail "Mattermost not ready after 120s"
ok "Mattermost deployment ready"

# ── 5. Wait for HTTP ──────────────────────────────────────────────────────
info "Waiting for Mattermost HTTP..."
MM_READY=false
for attempt in $(seq 1 24); do
  PING=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -o /dev/null -w "%{http_code}" http://localhost:8065/api/v4/system/ping 2>/dev/null || echo "000")
  [[ "$PING" == "200" ]] && { MM_READY=true; break; }
  sleep 5
  info "  Waiting (attempt $attempt/24, status=$PING)..."
done
$MM_READY || fail "Mattermost HTTP not responding after 120s"
ok "Mattermost HTTP ready"

# ── 6. Bootstrap or refresh credentials ──────────────────────────────────
ADMIN_CHECK=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
  curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://localhost:8065/api/v4/users/login" \
  -H "Content-Type: application/json" \
  -d "{\"login_id\":\"$MM_ADMIN_USER\",\"password\":\"$MM_ADMIN_PASS\"}" 2>/dev/null || echo "000")

if [[ "$ADMIN_CHECK" == "200" ]]; then
  info "Admin already exists — refreshing token only"
  LOGIN_RAW=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -i -X POST "http://localhost:8065/api/v4/users/login" \
    -H "Content-Type: application/json" \
    -d "{\"login_id\":\"$MM_ADMIN_USER\",\"password\":\"$MM_ADMIN_PASS\"}" 2>/dev/null)
  MM_ADMIN_TOKEN=$(echo "$LOGIN_RAW" | grep -i "^token:" | awk '{print $2}' | tr -d '\r')
  [[ -n "$MM_ADMIN_TOKEN" ]] && save_env "MM_ADMIN_TOKEN" "$MM_ADMIN_TOKEN" && ok "Admin session token refreshed"

  # Get real admin user ID from /me (stored IDs can drift after DB rebuilds)
  MM_ADMIN_USER_ID=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s "http://localhost:8065/api/v4/users/me" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
  [[ -n "$MM_ADMIN_USER_ID" ]] && save_env "MM_ADMIN_USER_ID" "$MM_ADMIN_USER_ID" && ok "Admin user ID: $MM_ADMIN_USER_ID"

  # ── Admin PAT: test cached value first, only rotate if it's broken ──────
  CACHED_ADMIN_PAT=$(ksecret_key mattermost-gateway admin_token)
  if mm_pat_is_valid "$CACHED_ADMIN_PAT" "$MM_ADMIN_USER_ID"; then
    ok "Cached admin PAT still valid — skipping rotation"
    MM_ADMIN_PAT="$CACHED_ADMIN_PAT"
    save_env "MM_ADMIN_PAT" "$MM_ADMIN_PAT"
  else
    info "Cached admin PAT missing or invalid — rotating"
    # Revoke any stale workspace-api-tagged PATs before minting a new one
    EXISTING_PATS=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
      curl -s "http://localhost:8065/api/v4/users/$MM_ADMIN_USER_ID/tokens" \
      -H "Authorization: Bearer $MM_ADMIN_TOKEN" 2>/dev/null)
    OLD_PAT_IDS=$(echo "$EXISTING_PATS" | python3 -c "
import sys, json
tokens = json.load(sys.stdin)
for t in tokens:
    if 'workspace-api' in t.get('description', ''):
        print(t['id'])
" 2>/dev/null || echo "")
    REVOKED=0
    for pat_id in $OLD_PAT_IDS; do
      kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
        curl -s -X POST "http://localhost:8065/api/v4/users/$MM_ADMIN_USER_ID/tokens/revoke" \
        -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"token_id\":\"$pat_id\"}" >/dev/null 2>&1
      REVOKED=$((REVOKED + 1))
    done
    [[ $REVOKED -gt 0 ]] && ok "Revoked $REVOKED stale admin PAT(s)"

    PAT_RESP=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
      curl -s -X POST "http://localhost:8065/api/v4/users/$MM_ADMIN_USER_ID/tokens" \
      -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"description":"workspace-api admin token"}' 2>/dev/null)
    MM_ADMIN_PAT=$(echo "$PAT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
    if [[ -n "$MM_ADMIN_PAT" ]]; then
      save_env "MM_ADMIN_PAT" "$MM_ADMIN_PAT"
      ok "Admin PAT created"
    else
      warn "Failed to create admin PAT: $PAT_RESP"
      warn "workspace-api /admin-token route will return 503 without this!"
    fi
  fi

  # ── Discover existing team + bot (may be missing from env/secret) ────────
  info "Discovering team + bot state..."
  TEAM_ID_FROM_API=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s "http://localhost:8065/api/v4/teams/name/octogee" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  if [[ -n "$TEAM_ID_FROM_API" ]]; then
    MM_TEAM_ID="$TEAM_ID_FROM_API"
    save_env "MM_TEAM_ID" "$MM_TEAM_ID"
    ok "Team discovered: $MM_TEAM_ID"
  else
    warn "Could not discover Octogee team — MM_TEAM_ID will be empty"
  fi

  BOT_USER_ID_FROM_API=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s "http://localhost:8065/api/v4/bots" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" 2>/dev/null \
    | python3 -c "
import sys, json
bots = json.load(sys.stdin)
for b in bots:
    if b.get('username') == 'octogee-bot':
        print(b['user_id'])
        break
" 2>/dev/null || echo "")
  if [[ -n "$BOT_USER_ID_FROM_API" ]]; then
    MM_BOT_USER_ID="$BOT_USER_ID_FROM_API"
    save_env "MM_BOT_USER_ID" "$MM_BOT_USER_ID"
    ok "Bot discovered: $MM_BOT_USER_ID"

    # ── Bot token: test cached value first, only rotate if broken ────────
    CACHED_BOT_TOKEN=$(ksecret_key mattermost-gateway bot_token)
    if mm_pat_is_valid "$CACHED_BOT_TOKEN" "$MM_BOT_USER_ID"; then
      ok "Cached bot token still valid — skipping rotation"
      MM_BOT_TOKEN="$CACHED_BOT_TOKEN"
      save_env "MM_BOT_TOKEN" "$MM_BOT_TOKEN"
    else
      info "Cached bot token missing or invalid — rotating"
      EXISTING_BOT_TOKENS=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
        curl -s "http://localhost:8065/api/v4/users/$MM_BOT_USER_ID/tokens" \
        -H "Authorization: Bearer $MM_ADMIN_TOKEN" 2>/dev/null)
      OLD_BOT_IDS=$(echo "$EXISTING_BOT_TOKENS" | python3 -c "
import sys, json
for t in json.load(sys.stdin):
    print(t['id'])
" 2>/dev/null || echo "")
      BOT_REVOKED=0
      for tok_id in $OLD_BOT_IDS; do
        kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
          curl -s -X POST "http://localhost:8065/api/v4/users/$MM_BOT_USER_ID/tokens/revoke" \
          -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
          -H "Content-Type: application/json" \
          -d "{\"token_id\":\"$tok_id\"}" >/dev/null 2>&1
        BOT_REVOKED=$((BOT_REVOKED + 1))
      done
      [[ $BOT_REVOKED -gt 0 ]] && ok "Revoked $BOT_REVOKED stale bot token(s)"

      TOKEN_RESP=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
        curl -s -X POST "http://localhost:8065/api/v4/users/$MM_BOT_USER_ID/tokens" \
        -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"description":"Gateway token"}' 2>/dev/null)
      MM_BOT_TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
      if [[ -n "$MM_BOT_TOKEN" ]]; then
        save_env "MM_BOT_TOKEN" "$MM_BOT_TOKEN"
        ok "Bot token created"
      else
        warn "Failed to create bot token: $TOKEN_RESP"
      fi
    fi
  else
    warn "Could not discover octogee-bot — MM_BOT_USER_ID and MM_BOT_TOKEN will be empty"
  fi
else
  info "Fresh Mattermost — bootstrapping admin, team, bot..."

  # Admin user
  ADMIN_RESP=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/users" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"admin@octogee.com\",\"username\":\"$MM_ADMIN_USER\",\"password\":\"$MM_ADMIN_PASS\",\"first_name\":\"Octogee\",\"last_name\":\"Admin\",\"nickname\":\"Octogee Admin\"}" 2>/dev/null)
  MM_ADMIN_USER_ID=$(echo "$ADMIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  [[ -n "$MM_ADMIN_USER_ID" ]] || fail "Failed to create admin user: $ADMIN_RESP"
  save_env "MM_ADMIN_USER_ID" "$MM_ADMIN_USER_ID"
  ok "Admin created: $MM_ADMIN_USER_ID"

  # Login
  LOGIN_RAW=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -i -X POST "http://localhost:8065/api/v4/users/login" \
    -H "Content-Type: application/json" \
    -d "{\"login_id\":\"$MM_ADMIN_USER\",\"password\":\"$MM_ADMIN_PASS\"}" 2>/dev/null)
  MM_ADMIN_TOKEN=$(echo "$LOGIN_RAW" | grep -i "^token:" | awk '{print $2}' | tr -d '\r')
  [[ -n "$MM_ADMIN_TOKEN" ]] || fail "Failed to get admin token"
  save_env "MM_ADMIN_TOKEN" "$MM_ADMIN_TOKEN"
  ok "Admin login OK"

  # Team
  TEAM_RESP=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/teams" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name":"octogee","display_name":"Octogee","type":"I"}' 2>/dev/null)
  MM_TEAM_ID=$(echo "$TEAM_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  [[ -n "$MM_TEAM_ID" ]] || fail "Failed to create team: $TEAM_RESP"
  save_env "MM_TEAM_ID" "$MM_TEAM_ID"
  ok "Team created: $MM_TEAM_ID"

  # Enable bots + personal access tokens
  kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X PUT "http://localhost:8065/api/v4/config/patch" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"ServiceSettings":{"EnableBotAccountCreation":true,"EnableUserAccessTokens":true}}' >/dev/null 2>&1
  ok "Bot accounts + PATs enabled"

  # Add admin to team
  kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/teams/$MM_TEAM_ID/members" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"team_id\":\"$MM_TEAM_ID\",\"user_id\":\"$MM_ADMIN_USER_ID\"}" >/dev/null 2>&1
  ok "Admin added to team"

  # Admin personal access token (PAT) for workspace-api
  # Session tokens expire; PATs don't — workspace-api needs MM_ADMIN_TOKEN env var
  info "Creating admin personal access token (PAT) for workspace-api..."
  PAT_RESP=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/users/$MM_ADMIN_USER_ID/tokens" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"description":"workspace-api admin token"}' 2>/dev/null)
  MM_ADMIN_PAT=$(echo "$PAT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
  if [[ -n "$MM_ADMIN_PAT" ]]; then
    save_env "MM_ADMIN_PAT" "$MM_ADMIN_PAT"
    ok "Admin PAT created"
  else
    warn "Failed to create admin PAT — workspace-api /admin-token will 503!"
  fi

  # Bot
  BOT_RESP=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/bots" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"username":"octogee-bot","display_name":"Octo","description":"Octogee AI Agent"}' 2>/dev/null)
  MM_BOT_USER_ID=$(echo "$BOT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_id',''))" 2>/dev/null || echo "")
  [[ -n "$MM_BOT_USER_ID" ]] || fail "Failed to create bot: $BOT_RESP"
  save_env "MM_BOT_USER_ID" "$MM_BOT_USER_ID"
  ok "Bot created: $MM_BOT_USER_ID"

  # Add bot to team
  kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/teams/$MM_TEAM_ID/members" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"team_id\":\"$MM_TEAM_ID\",\"user_id\":\"$MM_BOT_USER_ID\"}" >/dev/null 2>&1
  ok "Bot added to team"

  # Bot token
  TOKEN_RESP=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/users/$MM_BOT_USER_ID/tokens" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"description":"Gateway token"}' 2>/dev/null)
  MM_BOT_TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
  [[ -n "$MM_BOT_TOKEN" ]] || fail "Failed to create bot token: $TOKEN_RESP"
  save_env "MM_BOT_TOKEN" "$MM_BOT_TOKEN"
  ok "Bot token created"

  info "All credentials saved to $ENV_FILE"
fi

# ── 7. Validate all values before writing K8s secret ─────────────────────
set +u
info "Validating secret values before write..."

WRITE_ERRORS=0
for var_name in MM_ADMIN_USER MM_ADMIN_PASS MM_ADMIN_USER_ID MM_ADMIN_PAT MM_TEAM_ID MM_BOT_USER_ID MM_BOT_TOKEN; do
  val="${!var_name:-}"
  if [[ -z "$val" ]]; then
    warn "$var_name is empty — secret will be incomplete!"
    WRITE_ERRORS=$((WRITE_ERRORS + 1))
  fi
done

if [[ "$WRITE_ERRORS" -gt 0 ]]; then
  warn "$WRITE_ERRORS value(s) missing — writing partial secret"
  warn "chat-proxy and workspace-api may fail to start (MM_ADMIN_TOKEN is required)"
fi

# ── 8. Atomic K8s secret write (dry-run + apply) ────────────────────────
# Uses dry-run + apply instead of delete + create to avoid a window where
# the secret doesn't exist (which would crash pods on restart).
info "Writing mattermost-gateway K8s secret..."
kubectl create secret generic mattermost-gateway \
  -n "$K8S_NAMESPACE" \
  --from-literal=admin_user="${MM_ADMIN_USER:-}" \
  --from-literal=admin_pass="${MM_ADMIN_PASS:-}" \
  --from-literal=admin_token="${MM_ADMIN_PAT:-}" \
  --from-literal=admin_user_id="${MM_ADMIN_USER_ID:-}" \
  --from-literal=bot_token="${MM_BOT_TOKEN:-}" \
  --from-literal=bot_user_id="${MM_BOT_USER_ID:-}" \
  --from-literal=team_id="${MM_TEAM_ID:-}" \
  --dry-run=client -o yaml | kubectl apply -f -
ok "mattermost-gateway K8s secret written (atomic apply)"

# ── 9. Post-write verification ──────────────────────────────────────────
info "Verifying written secret..."
VERIFY_ERRORS=0
for key in admin_user admin_pass admin_token admin_user_id bot_token bot_user_id team_id; do
  VAL=$(kubectl get secret mattermost-gateway -n "$K8S_NAMESPACE" \
    -o jsonpath="{.data.$key}" 2>/dev/null | base64 -d 2>/dev/null || echo "")
  if [[ -z "$VAL" ]]; then
    echo -e "  ${RED}✗${NC} $key — EMPTY"
    VERIFY_ERRORS=$((VERIFY_ERRORS + 1))
  else
    echo -e "  ${GREEN}✓${NC} $key (${#VAL} chars)"
  fi
done

if [[ "$VERIFY_ERRORS" -gt 0 ]]; then
  warn "$VERIFY_ERRORS key(s) empty after write — investigate above warnings"
else
  ok "All 7 keys verified non-empty"
fi
set -u

echo ""
echo -e "${CYAN}Mattermost bootstrap summary${NC}"
status "MM_ADMIN_USER set" "${MM_ADMIN_USER:-}"
status "MM_ADMIN_PASS set" "${MM_ADMIN_PASS:-}"
status "MM_ADMIN_USER_ID set" "${MM_ADMIN_USER_ID:-}"
status "MM_ADMIN_PAT set (required for workspace-api /admin-token)" "${MM_ADMIN_PAT:-}"
status "MM_TEAM_ID set" "${MM_TEAM_ID:-}"
status "MM_BOT_USER_ID set" "${MM_BOT_USER_ID:-}"
status "MM_BOT_TOKEN set (required for chat-proxy)" "${MM_BOT_TOKEN:-}"

echo ""
if [[ -n "${MM_ADMIN_PAT:-}" && -n "${MM_TEAM_ID:-}" && -n "${MM_BOT_USER_ID:-}" && -n "${MM_BOT_TOKEN:-}" && -n "${MM_ADMIN_USER_ID:-}" ]]; then
  ok "mattermost-gateway inputs are complete"
  echo ""
  echo "  Next steps:"
  echo "    1. If Helm is not deployed yet, run setup-gateway / helm upgrade"
  echo "    2. If this was a repair on an existing env, restart dependent workloads:"
  echo "       kubectl rollout restart deployment/chat-proxy -n $K8S_NAMESPACE"
  echo "       kubectl rollout restart deployment/workspace-api -n $K8S_NAMESPACE"
  echo "    3. Re-test admin chat / Mattermost-backed routes"
else
  warn "Mattermost bootstrap is still incomplete"
  echo ""
  echo "  Expected healthy state includes:"
  echo "    - admin PAT for workspace-api"
  echo "    - bot token + bot user id + team id for chat-proxy"
  echo ""
  echo "  Next steps:"
  echo "    1. Review warnings above"
  echo "    2. Re-run ./scripts/setup-mattermost.sh --env=$ENV"
  echo "    3. Do NOT trust admin chat until the missing values are fixed"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Mattermost setup complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Next: ./scripts/setup-gitea.sh --env=$ENV"
echo ""
