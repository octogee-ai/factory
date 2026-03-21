#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Environment Teardown — Per-Deploy Resources
# ═══════════════════════════════════════════════════════════════════════════
#
# Tears down PER-DEPLOY resources so setup-gateway.sh can rebuild from scratch.
# Persistent services (Cloud SQL, Mattermost, Gitea, Chat Proxy) are preserved.
#
# Use --full to also tear down persistent infrastructure (clean-slate rebuild).
#
# Does NOT delete (ever): GCP projects, GKE clusters, AR repos, Firebase projects,
# GCP Service Accounts, IAM bindings (Workload Identity).
#
# Usage:
#   ./scripts/teardown-gateway.sh --env=test       # Per-deploy teardown
#   ./scripts/teardown-gateway.sh --env=test --yes # Non-interactive (test only)
#   ./scripts/teardown-gateway.sh --env=test --full # Full teardown (persistent infra too)
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
FULL=false

for arg in "$@"; do
  case $arg in
    --env=*)  ENV="${arg#*=}" ;;
    --force|--yes|-y) FORCE=true ;;
    --full) FULL=true ;;
    --help|-h)
      echo "Usage: $0 [--env=prod|test] [--force|--yes] [--full]"
      echo ""
      echo "  --full    Also tear down persistent infra (Mattermost, Gitea, Cloud SQL Proxy)"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

case "$ENV" in
  prod)
    GCP_PROJECT="octogee"
    FIREBASE_PROJECT="octogee"
    CLUSTER_PROJECT="octogee"
    CLUSTER_NAME="octogee-gateway"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    K8S_NAMESPACE="octogee"
    ENV_FILE="$REPO_DIR/.env"
    SA_KEY_DEFAULT="$HOME/.openclaw/secrets/octogee-sa-key.json"
    ENV_LABEL="🔴 PRODUCTION"
    ;;
  test)
    GCP_PROJECT="octogee-test"
    FIREBASE_PROJECT="octogee-test"
    CLUSTER_PROJECT="octogee-test"
    CLUSTER_NAME="octogee-test"
    K8S_CONTEXT="gke_octogee-test_us-central1_octogee-test"
    K8S_NAMESPACE="octogee-test"
    ENV_FILE="$REPO_DIR/.env.test"
    SA_KEY_DEFAULT="$HOME/.openclaw/secrets/octogee-test-sa-key.json"
    ENV_LABEL="🟡 TEST"
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

# ── Context guard ─────────────────────────────────────────────────────────
gcloud container clusters get-credentials "$CLUSTER_NAME" --region us-central1 --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT" >/dev/null
CURRENT_CTX=$(kubectl config current-context)
if [[ "$CURRENT_CTX" != "$K8S_CONTEXT" ]]; then
  echo -e "  ${RED}❌ kubectl context is '$CURRENT_CTX', expected '$K8S_CONTEXT'. Aborting.${NC}"
  exit 1
fi
echo -e "  ✅ kubectl context: $CURRENT_CTX"

echo -e "  Environment:    ${BOLD}$ENV${NC}"
echo -e "  K8s Namespace:  ${BOLD}$K8S_NAMESPACE${NC}"
echo -e "  K8s Context:    ${BOLD}$K8S_CONTEXT${NC}"
echo -e "  Env File:       ${BOLD}$ENV_FILE${NC}"
if $FULL; then
  echo -e "  Mode:           ${RED}${BOLD}FULL (persistent infra included)${NC}"
else
  echo -e "  Mode:           ${BOLD}Per-deploy only${NC}"
fi
echo ""
echo "  This will DELETE (per-deploy resources):"
echo "    • Gateway deployment, service, PVC (customer workspaces)"
echo "    • K8s secrets (gitea-token, mattermost-gateway, octogee-anthropic, etc.)"
echo "    • K8s ServiceAccount + network policies"
echo "    • GCP Secret Manager secret versions"
echo "    • Firestore data, Cloud Functions, Auth users"
echo ""
if $FULL; then
  echo -e "  ${RED}--full mode: ALSO deleting persistent infrastructure:${NC}"
  echo "    • Mattermost deployment + PVC (chat history)"
  echo "    • cloud-sql-proxy deployment"
  echo "    • Monitoring stack (Prometheus + Grafana)"
  echo ""
fi
echo "  This will PRESERVE (persistent services):"
if ! $FULL; then
  echo "    • Cloud SQL instance (octogee-pg) + databases"
  echo "    • cloud-sql-proxy deployment + service"
  echo "    • Mattermost deployment + PVC (chat history)"
  echo "    • Gitea deployment + PVC (git repos)"
  echo "    • Chat Proxy (Cloud Run at chat.octogee.com)"
  echo "    • Monitoring namespace (Prometheus + Grafana)"
fi
echo "    • GCP projects, GKE clusters, AR repos"
echo "    • Firebase projects"
echo "    • GCP Service Accounts, IAM bindings"
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

# ── 2. Delete Mattermost (--full only) ───────────────────────────────────

if $FULL; then
  echo ""
  info "Deleting Mattermost (--full mode)..."
  kubectl delete deployment mattermost -n "$K8S_NAMESPACE" 2>/dev/null && ok "Mattermost deployment deleted" || warn "No Mattermost deployment found"
  kubectl delete service mattermost -n "$K8S_NAMESPACE" 2>/dev/null && ok "Mattermost service deleted" || true
  kubectl delete service mattermost-ilb -n "$K8S_NAMESPACE" 2>/dev/null && ok "Mattermost ILB deleted" || true

  if confirm "Delete Mattermost PVC? (chat history + file uploads will be lost)"; then
    info "Waiting for MM pod to terminate..."
    kubectl wait --for=delete pod -l app=mattermost -n "$K8S_NAMESPACE" --timeout=60s 2>/dev/null || true
    kubectl delete pvc mattermost-data -n "$K8S_NAMESPACE" 2>/dev/null && ok "Deleted mattermost-data" || true
  else
    info "Keeping Mattermost PVC"
  fi

  info "Deleting cloud-sql-proxy..."
  kubectl delete deployment cloud-sql-proxy -n "$K8S_NAMESPACE" 2>/dev/null && ok "cloud-sql-proxy deleted" || warn "No cloud-sql-proxy found"
  kubectl delete service cloud-sql-proxy -n "$K8S_NAMESPACE" 2>/dev/null && ok "cloud-sql-proxy service deleted" || true
else
  echo ""
  info "Skipping Mattermost (persistent — use --full to include)"
fi

# ── 3. Delete K8s Secrets (per-deploy) ────────────────────────────────────

echo ""
info "Deleting K8s secrets (per-deploy)..."
# Per-deploy secrets: gateway creds, API keys, tokens
# Note: mattermost-cloud-sql is persistent (Cloud SQL password) — only delete with --full
for secret in mattermost-gateway gitea-token octogee-anthropic octogee-brave octogee-sa-key octogee-discord; do
  kubectl delete secret "$secret" -n "$K8S_NAMESPACE" 2>/dev/null && ok "Deleted $secret" || true
done

if $FULL; then
  info "Deleting persistent secrets (--full mode)..."
  kubectl delete secret mattermost-cloud-sql -n "$K8S_NAMESPACE" 2>/dev/null && ok "Deleted mattermost-cloud-sql" || true
  kubectl delete secret mattermost-db -n "$K8S_NAMESPACE" 2>/dev/null && ok "Deleted mattermost-db" || true
fi

# ── 4. Delete Network Policies + ServiceAccount ──────────────────────────

echo ""
info "Deleting network policies..."
kubectl delete networkpolicy gateway-egress -n "$K8S_NAMESPACE" 2>/dev/null && ok "Network policy deleted" || warn "No network policy found"
info "Deleting K8s ServiceAccount..."
kubectl delete sa octogee-gateway -n "$K8S_NAMESPACE" 2>/dev/null && ok "ServiceAccount deleted" || warn "No ServiceAccount found"

# ── 5. Uninstall Monitoring (--full only) ─────────────────────────────────

if $FULL; then
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
else
  echo ""
  info "Skipping monitoring (persistent — use --full to include)"
fi

# ── 6. Chat Proxy — Skipped (persistent) ─────────────────────────────────

echo ""
info "Skipping Chat Proxy (persistent Cloud Run service at chat.octogee.com)"

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
if $FULL; then
  echo "  Full teardown completed. Persistent infrastructure was removed."
  echo ""
  echo "  To rebuild from scratch:"
  echo "    1. ./scripts/setup-mattermost.sh --env=$ENV    # Mattermost + bootstrap"
  echo "    2. ./scripts/setup-gitea.sh --env=$ENV         # Gitea (if needed)"
  echo "    3. ./scripts/setup-gateway.sh --env=$ENV       # Gateway + Site + Functions"
  echo "    4. ./scripts/setup-monitoring.sh --env=$ENV    # Prometheus + Grafana"
else
  echo "  Per-deploy resources removed. Persistent services preserved:"
  echo "    • Cloud SQL (octogee-pg), cloud-sql-proxy"
  echo "    • Mattermost (chat history intact)"
  echo "    • Gitea (git repos intact)"
  echo "    • Chat Proxy (chat.octogee.com)"
  echo "    • Monitoring (Prometheus + Grafana)"
  echo ""
  echo "  To redeploy gateway:"
  echo "    ./scripts/setup-gateway.sh --env=$ENV"
fi
echo ""
