#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Environment Teardown — Clean Slate
# ═══════════════════════════════════════════════════════════════════════════
#
# Tears down an environment so setup-gateway.sh can rebuild from scratch.
# Does NOT delete: GCP projects, GKE clusters, AR repos, Firebase projects,
# GCP Service Accounts, IAM bindings (Workload Identity).
#
# Usage:
#   ./scripts/teardown-gateway.sh --env=test       # Test environment
#   ./scripts/teardown-gateway.sh --env=test --yes # Non-interactive (test only)
#   ./scripts/teardown-gateway.sh --env=prod       # Prod (interactive, requires DESTROY PROD)
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

K8S_DEPLOYMENT="octogee-gateway"
REGION="us-central1"

ENV="prod"
FORCE=false

for arg in "$@"; do
  case $arg in
    --env=*)  ENV="${arg#*=}" ;;
    --force|--yes|-y) FORCE=true ;;
    --help|-h)
      echo "Usage: $0 [--env=prod|test] [--force|--yes]"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

case "$ENV" in
  prod)
    GCP_PROJECT="octogee"
    FIREBASE_PROJECT="octogee"
    K8S_NAMESPACE="octogee"
    ENV_FILE="$REPO_DIR/.env"
    SA_KEY_DEFAULT="$HOME/.openclaw/secrets/octogee-sa-key.json"
    ENV_LABEL="🔴 PRODUCTION"
    CHAT_PROXY_SERVICE="octogee-chat-proxy"
    ;;
  test)
    GCP_PROJECT="octogee-test"
    FIREBASE_PROJECT="octogee-test"
    K8S_NAMESPACE="octogee-test"
    ENV_FILE="$REPO_DIR/.env.test"
    SA_KEY_DEFAULT="$HOME/.openclaw/secrets/octogee-test-sa-key.json"
    ENV_LABEL="🟡 TEST"
    CHAT_PROXY_SERVICE="octogee-chat-proxy-test"
    ;;
  *)
    echo "Unknown environment: $ENV (use prod or test)"
    exit 1
    ;;
esac

confirm() {
  if $FORCE; then return 0; fi
  if [[ "$ENV" == "test" ]]; then
    echo -ne "  ${YELLOW}$1 [Y/n]:${NC} "
    read -r yn
    [[ ! "$yn" =~ ^[Nn]$ ]]  # Default yes for test
  else
    echo -ne "  ${YELLOW}$1 [y/N]:${NC} "
    read -r yn
    [[ "$yn" =~ ^[Yy]$ ]]  # Default no for prod
  fi
}

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }

echo ""
echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  ⚠️  Octogee Teardown — ${ENV_LABEL}${NC}"
echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Environment:    ${BOLD}$ENV${NC}"
echo -e "  K8s Namespace:  ${BOLD}$K8S_NAMESPACE${NC}"
echo -e "  Env File:       ${BOLD}$ENV_FILE${NC}"
echo ""
echo "  This will:"
echo "    • Delete gateway deployment, service, PVC"
echo "    • Delete Mattermost deployment, postgres, PVCs"
echo "    • Delete all K8s secrets + ServiceAccount + network policies"
echo "    • Uninstall monitoring stack (Prometheus + Grafana)"
echo "    • Delete Chat Proxy (Cloud Run)"
echo "    • Destroy GCP Secret Manager secret versions"
echo "    • Wipe Firestore, Cloud Functions, Auth users"
echo ""
echo "  This will NOT delete:"
echo "    • GCP projects, GKE clusters, AR repos"
echo "    • Firebase projects"
echo "    • GCP Service Accounts or IAM bindings"
echo ""

if [[ "$ENV" == "prod" ]] && $FORCE; then
  echo -e "  ${RED}${BOLD}--force/--yes cannot be used with prod. Refusing.${NC}"
  exit 1
fi

if [[ "$ENV" == "prod" ]]; then
  echo -e "  ${RED}${BOLD}⚠️  YOU ARE ABOUT TO TEAR DOWN PRODUCTION${NC}"
  echo ""
  echo -ne "  ${RED}${BOLD}Type 'DESTROY PROD' to confirm:${NC} "
  read -r confirmation
  if [[ "$confirmation" != "DESTROY PROD" ]]; then
    echo ""
    echo "  Cancelled. (You typed: '$confirmation')"
    exit 1
  fi
elif ! confirm "Proceed with $ENV teardown?"; then
  echo "  Cancelled."
  exit 0
fi

# ── 1. Delete Gateway Deployment ──────────────────────────────────────────

echo ""
info "Deleting gateway deployment..."
kubectl delete deployment "$K8S_DEPLOYMENT" -n "$K8S_NAMESPACE" 2>/dev/null && ok "Deployment deleted" || warn "No deployment found"
kubectl delete service octogee-gateway -n "$K8S_NAMESPACE" 2>/dev/null && ok "Service deleted" || warn "No service found"

# PVC name matches deployment manifest
if [[ "$ENV" == "test" ]]; then
  PVC_NAME="octogee-test-data"
else
  PVC_NAME="octogee-data"
fi

if confirm "Delete PVC '$PVC_NAME'? (all customer workspaces will be lost)"; then
  # Wait for pods to terminate before PVC deletion
  info "Waiting for gateway pod to terminate..."
  kubectl wait --for=delete pod -l app=octogee-gateway -n "$K8S_NAMESPACE" --timeout=60s 2>/dev/null || true
  kubectl delete pvc "$PVC_NAME" -n "$K8S_NAMESPACE" 2>/dev/null && ok "PVC deleted" || warn "No PVC found"
else
  info "Keeping PVC"
fi

# ── 2. Delete Mattermost ─────────────────────────────────────────────────

echo ""
info "Deleting Mattermost..."
kubectl delete deployment mattermost -n "$K8S_NAMESPACE" 2>/dev/null && ok "Mattermost deployment deleted" || warn "No Mattermost deployment found"
kubectl delete deployment mattermost-postgres -n "$K8S_NAMESPACE" 2>/dev/null && ok "Mattermost Postgres deleted" || warn "No Postgres deployment found"
kubectl delete service mattermost -n "$K8S_NAMESPACE" 2>/dev/null && ok "Mattermost service deleted" || true
kubectl delete service mattermost-postgres -n "$K8S_NAMESPACE" 2>/dev/null && ok "Postgres service deleted" || true

if confirm "Delete Mattermost PVCs? (chat history + DB will be lost)"; then
  info "Waiting for MM pods to terminate..."
  kubectl wait --for=delete pod -l app=mattermost -n "$K8S_NAMESPACE" --timeout=60s 2>/dev/null || true
  kubectl wait --for=delete pod -l app=mattermost-postgres -n "$K8S_NAMESPACE" --timeout=60s 2>/dev/null || true
  kubectl delete pvc mattermost-data -n "$K8S_NAMESPACE" 2>/dev/null && ok "Deleted mattermost-data" || true
  kubectl delete pvc mattermost-postgres-data -n "$K8S_NAMESPACE" 2>/dev/null && ok "Deleted mattermost-postgres-data" || true
else
  info "Keeping Mattermost PVCs"
fi

# ── 3. Delete K8s Secrets ─────────────────────────────────────────────────

echo ""
info "Deleting K8s secrets..."
for secret in mattermost-gateway mattermost-db octogee-anthropic octogee-github octogee-brave octogee-sa-key octogee-discord; do
  kubectl delete secret "$secret" -n "$K8S_NAMESPACE" 2>/dev/null && ok "Deleted $secret" || true
done

# ── 4. Delete Network Policies + ServiceAccount ──────────────────────────

echo ""
info "Deleting network policies..."
kubectl delete networkpolicy gateway-egress -n "$K8S_NAMESPACE" 2>/dev/null && ok "Network policy deleted" || warn "No network policy found"
info "Deleting K8s ServiceAccount..."
kubectl delete sa octogee-gateway -n "$K8S_NAMESPACE" 2>/dev/null && ok "ServiceAccount deleted" || warn "No ServiceAccount found"

# ── 5. Uninstall Monitoring ───────────────────────────────────────────────

echo ""
if confirm "Uninstall monitoring stack (Prometheus + Grafana)?"; then
  info "Uninstalling monitoring..."
  helm uninstall prometheus -n monitoring 2>/dev/null && ok "Prometheus uninstalled" || warn "Prometheus not found"
  helm uninstall grafana -n monitoring 2>/dev/null && ok "Grafana uninstalled" || warn "Grafana not found"
  kubectl delete -f k8s/monitoring/service-monitors.yaml 2>/dev/null || true
  kubectl delete pvc --all -n monitoring 2>/dev/null && ok "Monitoring PVCs deleted" || true
else
  info "Keeping monitoring stack"
fi

# ── 6. Delete Chat Proxy (Cloud Run) ─────────────────────────────────────

echo ""
if confirm "Delete Chat Proxy (Cloud Run service)?"; then
  info "Deleting Chat Proxy..."
  gcloud run services delete "$CHAT_PROXY_SERVICE" \
    --region="$REGION" --project="$GCP_PROJECT" --quiet 2>/dev/null \
    && ok "Chat Proxy deleted" || warn "Chat Proxy not found"
else
  info "Keeping Chat Proxy"
fi

# ── 7. Destroy GCP Secret Manager Versions ────────────────────────────────

echo ""
info "Deleting Secret Manager secrets..."
SECRETS=$(gcloud secrets list --project="$FIREBASE_PROJECT" --format="value(name)" 2>/dev/null || true)
for secret in $SECRETS; do
  gcloud secrets delete "$secret" --project="$FIREBASE_PROJECT" --quiet 2>/dev/null \
    && ok "Deleted $secret" || true
done

# ── 8. Clean Firestore ───────────────────────────────────────────────────

echo ""
if confirm "Wipe ALL Firestore collections? (users, invites, everything)"; then
  info "Deleting all Firestore collections in '$FIREBASE_PROJECT'..."
  firebase firestore:delete --all-collections --project "$FIREBASE_PROJECT" --force
  ok "Firestore wiped clean"
else
  info "Keeping Firestore data"
fi

# ── 9. Delete Cloud Functions ─────────────────────────────────────────────

echo ""
if confirm "Delete all Cloud Functions?"; then
  FN_LIST=$(gcloud functions list --project="$FIREBASE_PROJECT" --region="$REGION" --format="value(name)" 2>/dev/null || true)
  FN_COUNT=$(echo "$FN_LIST" | grep -c . || true)

  if [[ "$FN_COUNT" -gt 0 ]]; then
    info "Deleting $FN_COUNT Cloud Functions in '$FIREBASE_PROJECT'..."
    echo "$FN_LIST" | while read -r fn; do
      gcloud functions delete "$fn" --project="$FIREBASE_PROJECT" --region="$REGION" --quiet --gen2 2>&1 &
    done
    wait
    ok "All Cloud Functions deleted"
  else
    info "No Cloud Functions found"
  fi
else
  info "Keeping Cloud Functions"
fi

# ── 10. Clean Firebase Auth ───────────────────────────────────────────────

echo ""
if confirm "Delete all Firebase Auth users?"; then
  SA_KEY="${SA_KEY_PATH:-$SA_KEY_DEFAULT}"
  if [[ -f "$SA_KEY" ]]; then
    cd "$REPO_DIR/functions"
    node -e "
const admin = require('firebase-admin');
const sa = require('$SA_KEY');
admin.initializeApp({ credential: admin.credential.cert(sa) });

(async () => {
  const list = await admin.auth().listUsers(1000);
  for (const u of list.users) {
    await admin.auth().deleteUser(u.uid);
  }
  console.log('Deleted ' + list.users.length + ' auth users');
  process.exit(0);
})();
"
    ok "Auth users deleted"
  else
    warn "SA key not found — skip Auth cleanup"
  fi
else
  info "Keeping Auth users"
fi

# ── Done ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Teardown complete${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Next steps:"
echo "    1. Run: ./scripts/setup-mattermost.sh --env=$ENV"
echo "    2. Run: ./scripts/setup-gateway.sh --env=$ENV"
echo "    3. Run: ./scripts/setup-monitoring.sh --env=$ENV (optional)"
echo "    4. Run: ./scripts/setup-chat-proxy.sh --env=$ENV (optional)"
echo ""
