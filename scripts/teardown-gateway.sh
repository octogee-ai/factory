#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Environment Teardown — Clean Slate
# ═══════════════════════════════════════════════════════════════════════════
#
# Tears down an environment so setup-gateway.sh can rebuild from scratch.
# Does NOT delete: GCP project, GKE cluster, AR repo, Firebase projects,
# Discord bots (you reuse those — just rotate secrets).
#
# Usage:
#   ./scripts/teardown-prod.sh                  # Prod (default)
#   ./scripts/teardown-prod.sh --env=test       # Test environment
#   ./scripts/teardown-prod.sh --env=prod       # Explicit prod
#   ./scripts/teardown-prod.sh --force          # Skip confirmations
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

GCP_PROJECT="octogee"
K8S_DEPLOYMENT="octogee-gateway"
REGION="us-central1"

ENV="prod"
FORCE=false

for arg in "$@"; do
  case $arg in
    --env=*)  ENV="${arg#*=}" ;;
    --force)  FORCE=true ;;
    --help|-h)
      echo "Usage: $0 [--env=prod|test] [--force]"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

case "$ENV" in
  prod)
    K8S_NAMESPACE="octogee"
    ENV_FILE="$REPO_DIR/.env"
    SA_KEY_DEFAULT="$HOME/.openclaw/secrets/octogee-sa-key.json"
    ENV_LABEL="🔴 PRODUCTION"
    ;;
  test)
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
echo -e "  Environment:    ${BOLD}$ENV${NC}"
echo -e "  K8s Namespace:  ${BOLD}$K8S_NAMESPACE${NC}"
echo -e "  Env File:       ${BOLD}$ENV_FILE${NC}"
echo ""
echo "  This will:"
echo "    • Delete all K8s secrets in namespace '$K8S_NAMESPACE'"
echo "    • Delete the gateway deployment + PVC"
echo "    • Destroy all GCP Secret Manager versions"
echo "    • Clean Firestore user docs (provisioned users)"
echo ""
echo "  This will NOT delete:"
echo "    • GCP project, GKE cluster, AR repo"
echo "    • Firebase projects"
echo "    • Discord bots (reuse them — rotate secrets in setup)"
echo "    • Discord guild (you keep the server)"
echo ""

if [[ "$ENV" == "prod" ]] && ! $FORCE; then
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
  kubectl delete pvc "$PVC_NAME" -n "$K8S_NAMESPACE" 2>/dev/null && ok "PVC deleted" || warn "No PVC found"
else
  info "Keeping PVC"
fi

# ── 2. Delete K8s Secrets ─────────────────────────────────────────────────

echo ""
info "Deleting K8s secrets..."
for secret in octogee-discord octogee-anthropic octogee-github octogee-sa-key octogee-brave; do
  kubectl delete secret "$secret" -n "$K8S_NAMESPACE" 2>/dev/null && ok "Deleted $secret" || true
done

# ── 3. Destroy GCP Secret Manager Versions ────────────────────────────────

echo ""
info "Destroying Secret Manager secret versions..."
SECRETS=$(gcloud secrets list --project="$GCP_PROJECT" --format="value(name)" 2>/dev/null || true)
for secret in $SECRETS; do
  # Destroy all versions (not delete the secret — setup-prod will create new versions)
  VERSIONS=$(gcloud secrets versions list "$secret" --project="$GCP_PROJECT" --format="value(name)" --filter="state=enabled OR state=disabled" 2>/dev/null || true)
  for ver in $VERSIONS; do
    gcloud secrets versions destroy "$ver" --secret="$secret" --project="$GCP_PROJECT" --quiet 2>/dev/null || true
  done
  ok "$secret — all versions destroyed"
done

# ── 4. Clean Firestore ────────────────────────────────────────────────────

echo ""
if confirm "Wipe ALL Firestore collections? (users, invites, everything)"; then
  FIREBASE_TARGET=""
  case "$ENV" in
    prod) FIREBASE_TARGET="octogee" ;;
    test) FIREBASE_TARGET="octogee-test" ;;
  esac

  info "Deleting all Firestore collections in '$FIREBASE_TARGET'..."
  firebase firestore:delete --all-collections --project "$FIREBASE_TARGET" --force
  ok "Firestore wiped clean"
else
  info "Keeping Firestore data"
fi

# ── 5. Delete Cloud Functions ─────────────────────────────────────────────

echo ""
if confirm "Delete all Cloud Functions?"; then
  FIREBASE_TARGET=""
  case "$ENV" in
    prod) FIREBASE_TARGET="octogee" ;;
    test) FIREBASE_TARGET="octogee-test" ;;
  esac

  FN_LIST=$(gcloud functions list --project="$FIREBASE_TARGET" --region="$REGION" --format="value(name)" 2>/dev/null || true)
  FN_COUNT=$(echo "$FN_LIST" | grep -c . || true)

  if [[ "$FN_COUNT" -gt 0 ]]; then
    info "Deleting $FN_COUNT Cloud Functions in '$FIREBASE_TARGET'..."
    echo "$FN_LIST" | while read -r fn; do
      gcloud functions delete "$fn" --project="$FIREBASE_TARGET" --region="$REGION" --quiet --gen2 2>&1 &
    done
    wait
    ok "All Cloud Functions deleted"
  else
    info "No Cloud Functions found"
  fi
else
  info "Keeping Cloud Functions"
fi

# ── 6. Clean Firebase Auth ────────────────────────────────────────────────

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
echo "    1. Rotate bot tokens in Discord Developer Portal (optional)"
echo "    2. Run: ./scripts/setup-gateway.sh --env=$ENV"
echo ""
