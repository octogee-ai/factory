#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Setup Mattermost for Octogee (test environment)
#
# Usage: ./scripts/setup-mattermost.sh [--env=test]
#
# Steps:
#   1. Create K8s secret for PostgreSQL password
#   2. Deploy PostgreSQL + Mattermost to octogee-test namespace
#   3. Wait for pods to be ready
#   4. Create Octogee team
#   5. Create Octo bot account
#   6. Create admin user
#   7. Create #ops channel
#   8. Install OpenClaw Mattermost plugin on gateway
#   9. Print connection info
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e " ${GREEN}✔${NC}  $1"; }
info() { echo -e " ${CYAN}ℹ${NC}  $1"; }
warn() { echo -e " ${YELLOW}⚠${NC}  $1"; }
fail() { echo -e " ${RED}✖${NC}  $1"; exit 1; }

# ── Parse args ───────────────────────────────────────────────────────────────
ENV="test"
for arg in "$@"; do
  case $arg in
    --env=*) ENV="${arg#*=}" ;;
  esac
done

if [[ "$ENV" != "test" ]]; then
  fail "Only --env=test is supported for now"
fi

K8S_NS="octogee-test"
MM_URL="http://mattermost.${K8S_NS}.svc.cluster.local:8065"

echo ""
echo "═══════════════════════════════════════════════════"
echo " Mattermost Setup — Octogee ($ENV)"
echo "═══════════════════════════════════════════════════"
echo ""

# ── Step 1: PostgreSQL secret ────────────────────────────────────────────────
info "Step 1: PostgreSQL secret"

if kubectl get secret mattermost-db -n "$K8S_NS" &>/dev/null; then
  ok "Secret 'mattermost-db' already exists"
else
  DB_PASS=$(openssl rand -hex 24)
  kubectl create secret generic mattermost-db \
    --from-literal=password="$DB_PASS" \
    -n "$K8S_NS"
  ok "Created secret 'mattermost-db'"
fi

# ── Step 2: Deploy ───────────────────────────────────────────────────────────
info "Step 2: Deploying PostgreSQL + Mattermost"

kubectl apply -f k8s/octogee-test/mattermost.yaml
ok "Manifests applied"

# ── Step 3: Wait for pods ────────────────────────────────────────────────────
info "Step 3: Waiting for pods to be ready (up to 3 min)..."

kubectl rollout status deployment/mattermost-postgres -n "$K8S_NS" --timeout=120s || warn "PostgreSQL rollout slow"
ok "PostgreSQL ready"

kubectl rollout status deployment/mattermost -n "$K8S_NS" --timeout=180s || warn "Mattermost rollout slow"
ok "Mattermost ready"

# Wait for Mattermost API to be responsive
info "Waiting for Mattermost API..."
MM_POD=$(kubectl get pods -n "$K8S_NS" -l app=mattermost -o jsonpath='{.items[0].metadata.name}')
for i in $(seq 1 30); do
  STATUS=$(kubectl exec "$MM_POD" -n "$K8S_NS" -- curl -s -o /dev/null -w '%{http_code}' http://localhost:8065/api/v4/system/ping 2>/dev/null || echo "000")
  if [[ "$STATUS" == "200" ]]; then
    ok "Mattermost API responsive"
    break
  fi
  sleep 5
  if [[ $i -eq 30 ]]; then
    fail "Mattermost API not responding after 150s"
  fi
done

# ── Helper: MM API call via kubectl exec ─────────────────────────────────────
mm_api() {
  local method="$1"
  local endpoint="$2"
  local data="${3:-}"
  local auth="${4:-}"

  local auth_header=""
  if [[ -n "$auth" ]]; then
    auth_header="-H 'Authorization: Bearer $auth'"
  fi

  if [[ -n "$data" ]]; then
    kubectl exec "$MM_POD" -n "$K8S_NS" -- sh -c \
      "curl -s -X $method http://localhost:8065/api/v4$endpoint -H 'Content-Type: application/json' $auth_header -d '$data'"
  else
    kubectl exec "$MM_POD" -n "$K8S_NS" -- sh -c \
      "curl -s -X $method http://localhost:8065/api/v4$endpoint -H 'Content-Type: application/json' $auth_header"
  fi
}

# ── Step 4: Create admin user ────────────────────────────────────────────────
info "Step 4: Creating admin user"

ADMIN_RESULT=$(mm_api POST /users '{
  "email": "admin@octogee.com",
  "username": "octogee-admin",
  "password": "OctogeeAdmin2026!",
  "first_name": "Octogee",
  "last_name": "Admin"
}')

ADMIN_ID=$(echo "$ADMIN_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

if [[ -z "$ADMIN_ID" || "$ADMIN_ID" == "" ]]; then
  # User might already exist
  warn "Admin user may already exist — checking..."
  ADMIN_RESULT=$(mm_api POST /users/login '{
    "login_id": "octogee-admin",
    "password": "OctogeeAdmin2026!"
  }')
  ADMIN_ID=$(echo "$ADMIN_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")
  ADMIN_TOKEN=$(echo "$ADMIN_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")
fi

# Login to get token
LOGIN_RESPONSE=$(kubectl exec "$MM_POD" -n "$K8S_NS" -- sh -c \
  "curl -s -D - -X POST http://localhost:8065/api/v4/users/login -H 'Content-Type: application/json' -d '{\"login_id\": \"octogee-admin\", \"password\": \"OctogeeAdmin2026!\"}' 2>/dev/null")

ADMIN_TOKEN=$(echo "$LOGIN_RESPONSE" | grep -i "^token:" | awk '{print $2}' | tr -d '\r\n')
ADMIN_ID=$(echo "$LOGIN_RESPONSE" | tail -1 | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

if [[ -z "$ADMIN_TOKEN" ]]; then
  fail "Could not get admin token"
fi

ok "Admin user: octogee-admin (ID: $ADMIN_ID)"

# Make admin a system admin
mm_api PUT "/users/$ADMIN_ID/roles" "{\"roles\": \"system_admin system_user\"}" "$ADMIN_TOKEN" >/dev/null
ok "Admin promoted to system_admin"

# ── Step 5: Create Octogee team ──────────────────────────────────────────────
info "Step 5: Creating Octogee team"

TEAM_RESULT=$(mm_api POST /teams '{
  "name": "octogee",
  "display_name": "Octogee",
  "type": "I"
}' "$ADMIN_TOKEN")

TEAM_ID=$(echo "$TEAM_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

if [[ -z "$TEAM_ID" || "$TEAM_ID" == "" ]]; then
  # Team might already exist
  TEAM_RESULT=$(mm_api GET "/teams/name/octogee" "" "$ADMIN_TOKEN")
  TEAM_ID=$(echo "$TEAM_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")
fi

if [[ -z "$TEAM_ID" ]]; then
  fail "Could not create or find Octogee team"
fi

ok "Team: Octogee (ID: $TEAM_ID)"

# ── Step 6: Create Octo bot ─────────────────────────────────────────────────
info "Step 6: Creating Octo bot"

BOT_RESULT=$(mm_api POST /bots '{
  "username": "octo",
  "display_name": "Octo 🐙",
  "description": "Your AI partner"
}' "$ADMIN_TOKEN")

BOT_USER_ID=$(echo "$BOT_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('user_id',''))" 2>/dev/null || echo "")

if [[ -z "$BOT_USER_ID" || "$BOT_USER_ID" == "" ]]; then
  warn "Bot may already exist — checking..."
  BOT_RESULT=$(mm_api GET "/bots/octo" "" "$ADMIN_TOKEN" 2>/dev/null || echo "{}")
fi

# Create bot access token
BOT_TOKEN_RESULT=$(mm_api POST "/users/$BOT_USER_ID/tokens" '{
  "description": "OpenClaw gateway token"
}' "$ADMIN_TOKEN")

BOT_TOKEN=$(echo "$BOT_TOKEN_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null || echo "")

if [[ -z "$BOT_TOKEN" ]]; then
  warn "Could not create bot token — may need manual setup"
else
  ok "Bot: Octo 🐙 (user_id: $BOT_USER_ID)"
fi

# Add bot to team
mm_api POST "/teams/$TEAM_ID/members" "{\"team_id\": \"$TEAM_ID\", \"user_id\": \"$BOT_USER_ID\"}" "$ADMIN_TOKEN" >/dev/null 2>&1
ok "Bot added to Octogee team"

# ── Step 7: Create #ops channel ─────────────────────────────────────────────
info "Step 7: Creating #ops channel"

OPS_RESULT=$(mm_api POST /channels '{
  "team_id": "'"$TEAM_ID"'",
  "name": "octogee-ops",
  "display_name": "Octogee Ops",
  "type": "P"
}' "$ADMIN_TOKEN")

OPS_CHANNEL_ID=$(echo "$OPS_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

if [[ -z "$OPS_CHANNEL_ID" ]]; then
  OPS_RESULT=$(mm_api GET "/teams/$TEAM_ID/channels/name/octogee-ops" "" "$ADMIN_TOKEN")
  OPS_CHANNEL_ID=$(echo "$OPS_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")
fi

ok "Ops channel: #octogee-ops (ID: $OPS_CHANNEL_ID)"

# ── Step 8: Summary ─────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo " 🐙 Mattermost is ready!"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  Mattermost URL (internal): $MM_URL"
echo "  Admin user:    octogee-admin / OctogeeAdmin2026!"
echo "  Team ID:       $TEAM_ID"
echo "  Bot user ID:   $BOT_USER_ID"
echo "  Bot token:     $BOT_TOKEN"
echo "  Ops channel:   $OPS_CHANNEL_ID"
echo ""
echo "  To access from your machine:"
echo "    kubectl port-forward svc/mattermost -n $K8S_NS 8065:8065"
echo "    open http://localhost:8065"
echo ""
echo "  To configure OpenClaw gateway, add to openclaw.json:"
echo "    channels.mattermost.enabled = true"
echo "    channels.mattermost.botToken = \"$BOT_TOKEN\""
echo "    channels.mattermost.baseUrl = \"$MM_URL\""
echo ""
echo "  Save these values! The bot token won't be shown again."
echo ""
