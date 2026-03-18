#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Mattermost Setup — Deploy + Bootstrap
# ═══════════════════════════════════════════════════════════════════════════
#
# Deploys Mattermost (postgres + server) and bootstraps admin/team/bot
# if this is a fresh instance. Saves all credentials to the env file.
#
# Run this BEFORE setup-gateway.sh. The gateway needs MM credentials
# in .env to create K8s secrets and connect.
#
# Usage:
#   ./scripts/setup-mattermost.sh --env=test       # Test environment
#   ./scripts/setup-mattermost.sh --env=test --yes  # Non-interactive
#   ./scripts/setup-mattermost.sh --env=prod        # Prod (interactive)
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
    --env=*)  ENV="${arg#*=}" ;;
    --yes|-y) YES=true ;;
    --help|-h)
      echo "Usage: $0 --env=prod|test [--yes]"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

if [[ -z "$ENV" ]]; then
  echo "Usage: $0 --env=prod|test [--yes]"
  exit 1
fi

case "$ENV" in
  prod)
    K8S_NAMESPACE="octogee"
    ENV_FILE="$REPO_DIR/.env"
    ENV_LABEL="🔴 PRODUCTION"
    ;;
  test)
    K8S_NAMESPACE="octogee-test"
    ENV_FILE="$REPO_DIR/.env.test"
    ENV_LABEL="🟡 TEST"
    ;;
  *) echo "Unknown environment: $ENV"; exit 1 ;;
esac

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }

confirm() {
  if $YES; then return 0; fi
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

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    set +u
    while IFS='=' read -r key val; do
      [[ -z "$key" || "$key" == \#* ]] && continue
      export "$key=$val"
    done < "$ENV_FILE"
    set -u
  fi
}

load_env

if [[ "$ENV" == "prod" ]] && $YES; then
  echo -e "  ${RED}${BOLD}--yes cannot be used with prod. Refusing.${NC}"
  exit 1
fi

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Mattermost Setup — ${ENV_LABEL}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ── 1. Collect MM admin credentials ──────────────────────────────────────

set +u
MM_URL_DEFAULT="http://mattermost.${K8S_NAMESPACE}.svc.cluster.local:8065"
MM_URL="${MM_URL:-$MM_URL_DEFAULT}"
save_env "MM_URL" "$MM_URL"
info "MM URL: $MM_URL"

if [[ -z "${MM_ADMIN_USER:-}" ]]; then
  MM_ADMIN_USER="octogee-admin"
fi
save_env "MM_ADMIN_USER" "$MM_ADMIN_USER"
info "Admin user: $MM_ADMIN_USER"

if [[ -z "${MM_ADMIN_PASS:-}" ]]; then
  MM_ADMIN_PASS="Octogee$(openssl rand -hex 4)!"
  info "Generated admin password"
fi
save_env "MM_ADMIN_PASS" "$MM_ADMIN_PASS"

if [[ -z "${MM_DB_PASSWORD:-}" ]]; then
  MM_DB_PASSWORD=$(openssl rand -hex 24)
  info "Generated URL-safe DB password"
fi
save_env "MM_DB_PASSWORD" "$MM_DB_PASSWORD"
set -u

# ── 2. Create mattermost-db K8s secret ──────────────────────────────────

info "Creating mattermost-db K8s secret..."
kubectl delete secret mattermost-db -n "$K8S_NAMESPACE" 2>/dev/null || true
kubectl create secret generic mattermost-db -n "$K8S_NAMESPACE" \
  --from-literal=password="$MM_DB_PASSWORD"
ok "mattermost-db secret created"

# ── 3. Deploy Mattermost ────────────────────────────────────────────────

info "Deploying Mattermost (postgres + server)..."
kubectl apply -f "k8s/$K8S_NAMESPACE/mattermost.yaml"

info "Waiting for PostgreSQL (up to 120s)..."
if kubectl wait --for=condition=available deployment/mattermost-postgres \
    -n "$K8S_NAMESPACE" --timeout=120s 2>/dev/null; then
  ok "PostgreSQL ready"
else
  fail "PostgreSQL not ready after 120s"
  kubectl get pods -n "$K8S_NAMESPACE" -l app=mattermost-postgres
  exit 1
fi

info "Waiting for Mattermost (up to 120s)..."
if kubectl wait --for=condition=available deployment/mattermost \
    -n "$K8S_NAMESPACE" --timeout=120s 2>/dev/null; then
  ok "Mattermost ready"
else
  fail "Mattermost not ready after 120s"
  kubectl get pods -n "$K8S_NAMESPACE" -l app=mattermost
  exit 1
fi

# ── 4. Bootstrap (via kubectl exec — no port-forward needed) ─────────────

# Wait for MM to be serving HTTP (pod is "available" before HTTP is ready)
info "Waiting for Mattermost HTTP to be ready..."
MM_READY=false
for attempt in $(seq 1 24); do
  PING=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -o /dev/null -w "%{http_code}" http://localhost:8065/api/v4/system/ping 2>/dev/null || echo "000")
  if [[ "$PING" == "200" ]]; then
    MM_READY=true
    break
  fi
  sleep 5
  info "  Waiting for Mattermost HTTP (attempt $attempt/24)..."
done

if ! $MM_READY; then
  fail "Mattermost HTTP not responding after 120s"
  exit 1
fi
ok "Mattermost HTTP is ready"

# Check if admin user already exists (try login)
ADMIN_CHECK=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
  curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://localhost:8065/api/v4/users/login" \
  -H "Content-Type: application/json" \
  -d "{\"login_id\":\"$MM_ADMIN_USER\",\"password\":\"$MM_ADMIN_PASS\"}" 2>/dev/null || echo "000")

if [[ "$ADMIN_CHECK" == "200" ]]; then
  info "Mattermost admin already exists — skipping bootstrap"

  # Extract admin token via curl -i (headers + body in one output)
  LOGIN_RAW=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -i -X POST "http://localhost:8065/api/v4/users/login" \
    -H "Content-Type: application/json" \
    -d "{\"login_id\":\"$MM_ADMIN_USER\",\"password\":\"$MM_ADMIN_PASS\"}" 2>/dev/null)
  MM_ADMIN_TOKEN=$(echo "$LOGIN_RAW" | grep -i "^token:" | awk '{print $2}' | tr -d '\r')
  if [[ -n "$MM_ADMIN_TOKEN" ]]; then
    save_env "MM_ADMIN_TOKEN" "$MM_ADMIN_TOKEN"
    ok "Admin token saved"
  fi
else
  info "Fresh Mattermost detected — bootstrapping admin, team, and bot..."

  # Create admin user
  ADMIN_RESP=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/users" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"admin@octogee.com\",\"username\":\"$MM_ADMIN_USER\",\"password\":\"$MM_ADMIN_PASS\"}" 2>/dev/null)
  MM_ADMIN_USER_ID=$(echo "$ADMIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  if [[ -n "$MM_ADMIN_USER_ID" ]]; then
    ok "Admin user created: $MM_ADMIN_USER_ID"
    save_env "MM_ADMIN_USER_ID" "$MM_ADMIN_USER_ID"
  else
    fail "Failed to create admin user"
    echo "  Response: $ADMIN_RESP"
    exit 1
  fi

  # Login as admin (use curl -i to capture token header)
  LOGIN_RAW=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -i -X POST "http://localhost:8065/api/v4/users/login" \
    -H "Content-Type: application/json" \
    -d "{\"login_id\":\"$MM_ADMIN_USER\",\"password\":\"$MM_ADMIN_PASS\"}" 2>/dev/null)
  MM_ADMIN_TOKEN=$(echo "$LOGIN_RAW" | grep -i "^token:" | awk '{print $2}' | tr -d '\r')
  if [[ -n "$MM_ADMIN_TOKEN" ]]; then
    ok "Admin login successful"
    save_env "MM_ADMIN_TOKEN" "$MM_ADMIN_TOKEN"
  else
    fail "Failed to login as admin"
    exit 1
  fi

  # Create team
  TEAM_RESP=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/teams" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name":"octogee","display_name":"Octogee","type":"I"}' 2>/dev/null)
  MM_TEAM_ID=$(echo "$TEAM_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  if [[ -n "$MM_TEAM_ID" ]]; then
    ok "Team created: $MM_TEAM_ID"
    save_env "MM_TEAM_ID" "$MM_TEAM_ID"
  else
    fail "Failed to create team"
    exit 1
  fi

  # Enable bot accounts + personal access tokens
  kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X PUT "http://localhost:8065/api/v4/config/patch" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"ServiceSettings":{"EnableBotAccountCreation":true,"EnableUserAccessTokens":true}}' > /dev/null 2>&1
  ok "Bot accounts enabled"

  # Add admin to team (needed for channel management)
  kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/teams/$MM_TEAM_ID/members" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"team_id\":\"$MM_TEAM_ID\",\"user_id\":\"$MM_ADMIN_USER_ID\"}" > /dev/null 2>&1
  ok "Admin added to team"

  # Create bot
  BOT_RESP=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/bots" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"username":"octogee-bot","display_name":"Octo","description":"Octogee AI Agent"}' 2>/dev/null)
  MM_BOT_USER_ID=$(echo "$BOT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_id',''))" 2>/dev/null || echo "")
  if [[ -n "$MM_BOT_USER_ID" ]]; then
    ok "Bot created: $MM_BOT_USER_ID"
    save_env "MM_BOT_USER_ID" "$MM_BOT_USER_ID"
  else
    fail "Failed to create bot"
    exit 1
  fi

  # Add bot to team (required for WebSocket to receive channel events)
  kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/teams/$MM_TEAM_ID/members" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"team_id\":\"$MM_TEAM_ID\",\"user_id\":\"$MM_BOT_USER_ID\"}" > /dev/null 2>&1
  ok "Bot added to team"

  # Create bot token
  TOKEN_RESP=$(kubectl exec deployment/mattermost -n "$K8S_NAMESPACE" -- \
    curl -s -X POST "http://localhost:8065/api/v4/users/$MM_BOT_USER_ID/tokens" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"description":"Gateway token"}' 2>/dev/null)
  MM_BOT_TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
  if [[ -n "$MM_BOT_TOKEN" ]]; then
    ok "Bot token created"
    save_env "MM_BOT_TOKEN" "$MM_BOT_TOKEN"
  else
    fail "Failed to create bot token"
    exit 1
  fi

  echo ""
  info "All credentials saved to $ENV_FILE"
fi

# ── Done ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Mattermost setup complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Next: ./scripts/setup-gateway.sh --env=$ENV"
echo ""
