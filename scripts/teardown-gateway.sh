#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Environment Teardown
# ═══════════════════════════════════════════════════════════════════════════
#
# Default (no flags): tears down the Helm release only.
#   helm uninstall + PVC delete + K8s secrets delete
#   Preserves: Cloud SQL data, Secret Manager secrets, Firestore, Functions, Auth
#
# --full: also wipes Cloud SQL DBs, Firestore, Cloud Functions, Firebase Auth,
#         and Secret Manager secrets. Full clean-slate rebuild.
#
# Does NOT delete (ever): GCP projects, GKE clusters, AR repos,
#   Firebase projects, GCP Service Accounts, IAM bindings.
#
# Usage:
#   ./scripts/teardown-gateway.sh --env=test           # Helm uninstall only
#   ./scripts/teardown-gateway.sh --env=test --yes     # Non-interactive (test only)
#   ./scripts/teardown-gateway.sh --env=test --full    # Full clean slate
#   ./scripts/teardown-gateway.sh --env=prod           # Prod (interactive, requires "DESTROY PROD")
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

ENV="prod"
FORCE=false
FULL=false
PROXY_PID=""

for arg in "$@"; do
  case $arg in
    --env=*)        ENV="${arg#*=}" ;;
    --force|--yes|-y) FORCE=true ;;
    --full)         FULL=true ;;
    --help|-h)
      echo "Usage: $0 [--env=prod|test] [--force|--yes] [--full]"
      echo ""
      echo "  (default)  Helm uninstall + PVCs + K8s secrets"
      echo "  --full     Also wipe Cloud SQL DBs, Firestore, Functions, Auth, Secret Manager"
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
    MM_DB_NAME="mattermost_prod"
    GITEA_DB_NAME="gitea_prod"
    GATEWAY_PVC="octogee-data"
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
    MM_DB_NAME="mattermost_test"
    GITEA_DB_NAME="gitea_test"
    GATEWAY_PVC="octogee-test-data"
    ;;
  *)
    echo "Unknown environment: $ENV (use prod or test)"
    exit 1
    ;;
esac

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }

confirm() {
  $FORCE && return 0
  if [[ "$ENV" == "test" ]]; then
    echo -ne "  ${YELLOW}$1 [Y/n]:${NC} "
    read -r yn
    [[ ! "$yn" =~ ^[Nn]$ ]]
  else
    echo -ne "  ${YELLOW}$1 [y/N]:${NC} "
    read -r yn
    [[ "$yn" =~ ^[Yy]$ ]]
  fi
}

cleanup_proxy() {
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null || true
}
trap cleanup_proxy EXIT

# ── Banner ────────────────────────────────────────────────────────────────
echo ""
echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  ⚠️  Octogee Teardown — ${ENV_LABEL}${NC}"
echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Mode: ${BOLD}$(if $FULL; then echo "FULL (clean slate)"; else echo "Helm release only"; fi)${NC}"
echo ""
echo "  Will remove:"
echo "    • Helm release 'octogee' (all managed resources)"
echo "    • PVCs: $GATEWAY_PVC, mattermost-data, gitea-shared-storage"
echo "    • K8s secrets in namespace $K8S_NAMESPACE"
if $FULL; then
  echo -e "  ${RED}  + Cloud SQL DBs: $MM_DB_NAME, $GITEA_DB_NAME (data wiped)${NC}"
  echo -e "  ${RED}  + Firestore collections${NC}"
  echo -e "  ${RED}  + Cloud Functions${NC}"
  echo -e "  ${RED}  + Firebase Auth users${NC}"
  echo -e "  ${RED}  + Secret Manager secrets (in $FIREBASE_PROJECT project)${NC}"
fi
echo ""
echo "  Will preserve:"
echo "    • Cloud SQL instance (octogee-pg)"
echo "    • GCP projects, GKE cluster, AR repo"
echo "    • Firebase project, IAM, Service Accounts"
if ! $FULL; then
  echo "    • Cloud SQL data, Firestore, Functions, Auth, Secret Manager"
fi
echo ""

# ── Prod safety ───────────────────────────────────────────────────────────
if [[ "$ENV" == "prod" ]] && $FORCE; then
  echo -e "  ${RED}${BOLD}--force/--yes cannot be used with prod. Refusing.${NC}"
  exit 1
fi

if [[ "$ENV" == "prod" ]]; then
  echo -e "  ${RED}${BOLD}⚠️  YOU ARE ABOUT TO TEAR DOWN PRODUCTION${NC}"
  echo ""
  echo -ne "  ${RED}${BOLD}Type 'DESTROY PROD' to confirm:${NC} "
  read -r confirmation
  [[ "$confirmation" == "DESTROY PROD" ]] || { echo "  Cancelled."; exit 1; }
elif ! confirm "Proceed with $ENV teardown?"; then
  echo "  Cancelled."
  exit 0
fi

# ── Context guard ─────────────────────────────────────────────────────────
echo ""
info "Setting kubectl context..."
gcloud container clusters get-credentials "$CLUSTER_NAME" --region us-central1 --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT" >/dev/null
CURRENT_CTX=$(kubectl config current-context)
[[ "$CURRENT_CTX" == "$K8S_CONTEXT" ]] || { echo -e "  ${RED}❌ Wrong context: $CURRENT_CTX${NC}"; exit 1; }
ok "kubectl context: $CURRENT_CTX"

# ── 1. Helm uninstall ─────────────────────────────────────────────────────
echo ""
info "Uninstalling Helm release 'octogee'..."
if helm status octogee -n "$K8S_NAMESPACE" \
    --kube-context "$K8S_CONTEXT" >/dev/null 2>&1; then
  helm uninstall octogee -n "$K8S_NAMESPACE" \
    --kube-context "$K8S_CONTEXT" \
    --wait --timeout=3m 2>&1
  ok "Helm release uninstalled"
else
  warn "No Helm release found — skipping"
fi

# Wait for pods to terminate (PVCs can't delete while pods are running)
info "Waiting for pods to terminate..."
kubectl wait --for=delete pod --all -n "$K8S_NAMESPACE" \
  --timeout=90s 2>/dev/null || true
ok "Pods terminated"

# ── 2. Delete PVCs ────────────────────────────────────────────────────────
# Helm leaves PVCs intentionally (data safety). We delete them explicitly.
echo ""
info "Deleting PVCs..."
for pvc in "$GATEWAY_PVC" mattermost-data gitea-shared-storage; do
  if kubectl get pvc "$pvc" -n "$K8S_NAMESPACE" >/dev/null 2>&1; then
    kubectl delete pvc "$pvc" -n "$K8S_NAMESPACE" 2>/dev/null && ok "PVC deleted: $pvc" || warn "Could not delete: $pvc"
  else
    info "PVC not found (already gone): $pvc"
  fi
done

# ── 3. Delete K8s secrets ─────────────────────────────────────────────────
echo ""
info "Deleting K8s secrets..."
for secret in \
  mattermost-gateway mattermost-cloud-sql mattermost-db \
  gitea-token gitea-admin gitea-credentials \
  octogee-anthropic octogee-brave octogee-sa-key octogee-discord octogee-github \
  cloud-sql-sa; do
  kubectl delete secret "$secret" -n "$K8S_NAMESPACE" 2>/dev/null && ok "Deleted: $secret" || true
done

# Delete any remaining secrets in namespace
REMAINING=$(kubectl get secrets -n "$K8S_NAMESPACE" \
  --field-selector type!=kubernetes.io/service-account-token \
  -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || echo "")
for s in $REMAINING; do
  [[ "$s" == "sh.helm.release"* ]] && continue  # skip helm history
  kubectl delete secret "$s" -n "$K8S_NAMESPACE" 2>/dev/null || true
done
ok "K8s secrets cleared"

# ── 4. Delete namespace ───────────────────────────────────────────────────
echo ""
info "Deleting namespace $K8S_NAMESPACE..."
kubectl delete namespace "$K8S_NAMESPACE" --timeout=60s 2>/dev/null && ok "Namespace deleted" || warn "Namespace not found"

# ── 5. Full: Cloud SQL DBs ────────────────────────────────────────────────
if $FULL; then
  echo ""
  info "Resetting Cloud SQL databases ($MM_DB_NAME, $GITEA_DB_NAME)..."

  MM_DB_PASS=$(gcloud secrets versions access latest --secret=MM_DB_PASSWORD --project=octogee 2>/dev/null || echo "")
  GITEA_DB_PASS=$(gcloud secrets versions access latest --secret=gitea-db-password --project=octogee 2>/dev/null || echo "")

  PROXY_BIN=$(command -v cloud-sql-proxy 2>/dev/null || \
    ls ~/Downloads/google-cloud-sdk/bin/cloud-sql-proxy 2>/dev/null || \
    ls /opt/homebrew/share/google-cloud-sdk/bin/cloud-sql-proxy 2>/dev/null || \
    echo "")

  if [[ -z "$PROXY_BIN" ]]; then
    warn "cloud-sql-proxy not found — skipping DB reset. Run manually:"
    warn "  PGPASSWORD=\$MM_DB_PASS psql -h 127.0.0.1 -p 5433 -U mattermost -d postgres -c 'DROP DATABASE IF EXISTS $MM_DB_NAME; CREATE DATABASE $MM_DB_NAME;'"
    warn "  PGPASSWORD=\$GITEA_DB_PASS psql -h 127.0.0.1 -p 5433 -U gitea -d postgres -c 'DROP DATABASE IF EXISTS $GITEA_DB_NAME; CREATE DATABASE $GITEA_DB_NAME;'"
  elif [[ -z "$MM_DB_PASS" || -z "$GITEA_DB_PASS" ]]; then
    warn "Could not read DB passwords from Secret Manager — skipping DB reset"
  else
    "$PROXY_BIN" octogee:us-central1:octogee-pg --port=5433 &
    PROXY_PID=$!
    sleep 4

    # Terminate active connections then drop/create
    for attempt in 1 2 3; do
      PGPASSWORD=$MM_DB_PASS psql -h 127.0.0.1 -p 5433 -U mattermost -d postgres \
        -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$MM_DB_NAME';" >/dev/null 2>&1 && break
      sleep 2
    done
    PGPASSWORD=$MM_DB_PASS psql -h 127.0.0.1 -p 5433 -U mattermost -d postgres \
      -c "DROP DATABASE IF EXISTS $MM_DB_NAME;" 2>&1
    PGPASSWORD=$MM_DB_PASS psql -h 127.0.0.1 -p 5433 -U mattermost -d postgres \
      -c "CREATE DATABASE $MM_DB_NAME;" 2>&1
    ok "Mattermost DB reset: $MM_DB_NAME"

    PGPASSWORD=$GITEA_DB_PASS psql -h 127.0.0.1 -p 5433 -U gitea -d postgres \
      -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$GITEA_DB_NAME';" >/dev/null 2>&1 || true
    PGPASSWORD=$GITEA_DB_PASS psql -h 127.0.0.1 -p 5433 -U gitea -d postgres \
      -c "DROP DATABASE IF EXISTS $GITEA_DB_NAME;" 2>&1
    PGPASSWORD=$GITEA_DB_PASS psql -h 127.0.0.1 -p 5433 -U gitea -d postgres \
      -c "CREATE DATABASE $GITEA_DB_NAME;" 2>&1
    ok "Gitea DB reset: $GITEA_DB_NAME"

    kill "$PROXY_PID" 2>/dev/null || true
    PROXY_PID=""
  fi
fi

# ── 6. Full: Secret Manager ───────────────────────────────────────────────
if $FULL; then
  echo ""
  if confirm "Delete all Secret Manager secrets in project '$FIREBASE_PROJECT'?"; then
    SECRETS=$(gcloud secrets list --project="$FIREBASE_PROJECT" \
      --format="value(name)" 2>/dev/null || true)
    for secret in $SECRETS; do
      gcloud secrets delete "$secret" --project="$FIREBASE_PROJECT" --quiet 2>/dev/null \
        && ok "Deleted SM secret: $secret" || true
    done
    ok "Secret Manager cleared"
  else
    info "Keeping Secret Manager secrets"
  fi
fi

# ── 7. Full: Firestore ────────────────────────────────────────────────────
if $FULL; then
  echo ""
  if confirm "Wipe ALL Firestore collections in '$FIREBASE_PROJECT'?"; then
    firebase firestore:delete --all-collections --project "$FIREBASE_PROJECT" --force
    ok "Firestore wiped"
  else
    info "Keeping Firestore data"
  fi
fi

# ── 8. Full: Cloud Functions ──────────────────────────────────────────────
if $FULL; then
  echo ""
  if confirm "Delete all Cloud Functions in '$FIREBASE_PROJECT'?"; then
    FN_LIST=$(gcloud run services list \
      --project="$FIREBASE_PROJECT" --region="$REGION" \
      --format="value(name)" 2>/dev/null || true)
    FN_COUNT=$(echo "$FN_LIST" | grep -c . 2>/dev/null || echo 0)
    if [[ "$FN_COUNT" -gt 0 ]]; then
      info "Deleting $FN_COUNT Cloud Run services..."
      echo "$FN_LIST" | while read -r fn; do
        [[ -z "$fn" ]] && continue
        gcloud run services delete "$fn" \
          --project="$FIREBASE_PROJECT" --region="$REGION" --quiet 2>/dev/null &
      done
      wait
      ok "Cloud Functions deleted"
    else
      info "No Cloud Functions found"
    fi
  else
    info "Keeping Cloud Functions"
  fi
fi

# ── 9. Full: Firebase Auth ────────────────────────────────────────────────
if $FULL; then
  echo ""
  if confirm "Delete all Firebase Auth users in '$FIREBASE_PROJECT'?"; then
    SA_KEY="${SA_KEY_PATH:-$SA_KEY_DEFAULT}"
    if [[ -f "$SA_KEY" ]]; then
      cd "$REPO_DIR/functions"
      npx tsx -e "
import * as admin from 'firebase-admin';
import * as fs from 'fs';
const sa = JSON.parse(fs.readFileSync('$SA_KEY', 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa as any), projectId: '$FIREBASE_PROJECT' });
(async () => {
  const list = await admin.auth().listUsers(1000);
  await Promise.all(list.users.map(u => admin.auth().deleteUser(u.uid)));
  console.log('Deleted ' + list.users.length + ' auth users');
  process.exit(0);
})();
" 2>&1 | grep -v "DeprecationWarning\|punycode"
      ok "Auth users deleted"
      cd "$REPO_DIR"
    else
      warn "SA key not found at $SA_KEY — skipping Auth cleanup"
    fi
  else
    info "Keeping Auth users"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────
REGION="us-central1"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Teardown complete — ${ENV_LABEL}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
if $FULL; then
  echo "  Clean slate. To rebuild:"
  echo ""
  echo "  1. ./scripts/setup-mattermost.sh --env=$ENV --yes   # creds + K8s secrets"
  echo "  2. helm upgrade --install octogee helm/octogee \\   # deploy everything"
  echo "       -f helm/octogee/values.${ENV}.yaml \\"
  echo "       -n $K8S_NAMESPACE --create-namespace \\"
  echo "       --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
  echo "       --kube-context $K8S_CONTEXT \\"
  echo "       --wait --timeout=10m"
  echo "  3. ./scripts/setup-mattermost.sh --env=$ENV --yes   # bootstrap MM"
  echo "  4. ./scripts/setup-gitea.sh --env=$ENV --yes        # org + token"
  echo "  5. ./scripts/setup-gateway.sh --env=$ENV --yes      # deploy gateway"
  echo "  6. firebase deploy --project $FIREBASE_PROJECT      # functions + hosting"
  echo "  7. ./scripts/verify-env.sh --env=$ENV               # verify"
else
  echo "  Helm release uninstalled. To redeploy:"
  echo ""
  echo "  helm upgrade --install octogee helm/octogee \\"
  echo "    -f helm/octogee/values.${ENV}.yaml \\"
  echo "    -n $K8S_NAMESPACE --create-namespace \\"
  echo "    --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
  echo "    --kube-context $K8S_CONTEXT"
fi
echo ""
