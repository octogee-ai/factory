#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Environment Teardown
# ═══════════════════════════════════════════════════════════════════════════
#
# Design intent: teardown never touches PVCs. The test gateway runs on
# emptyDir (cattle); Mattermost and Gitea are install-once pets backed by
# PVCs that persist across teardown/setup cycles. If you ever need to wipe
# a PVC deliberately, snapshot the disk first and delete it manually — see
# RUNBOOK.md → Known-Good Reset.
#
# Default (no flags): `helm uninstall` and nothing else.
#   Preserves: all PVCs, K8s secrets, namespace, Secret Manager, Cloud SQL,
#              Firestore, Functions, Auth.
#
# --full: also drops the per-env Cloud SQL databases, wipes Firestore
#         collections, deletes per-env Cloud Functions (chat proxy
#         preserved), and deletes Firebase Auth users.
#         Still preserves: all PVCs, all K8s secrets, namespace, Secret
#         Manager. Secret rotation is never part of teardown.
#
# Does NOT delete (ever): GCP projects, GKE clusters, AR repos,
#   Firebase projects, GCP Service Accounts, IAM bindings, any PVC,
#   any K8s secret, any Secret Manager entry, the namespace itself.
# To rotate a secret, use scripts/rotate-secret.sh.
#
# Usage:
#   ./scripts/teardown-gateway.sh --env=test           # Helm uninstall only
#   ./scripts/teardown-gateway.sh --env=test --yes     # Non-interactive (test only)
#   ./scripts/teardown-gateway.sh --env=test --full    # Full clean slate (DB wipe)
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
REGION="us-central1"

for arg in "$@"; do
  case $arg in
    --env=*)        ENV="${arg#*=}" ;;
    --force|--yes|-y) FORCE=true ;;
    --full)         FULL=true ;;
    --help|-h)
      echo "Usage: $0 [--env=prod|test] [--force|--yes] [--full]"
      echo ""
      echo "  (default)  helm uninstall only — preserves PVCs, K8s secrets,"
      echo "             namespace, Secret Manager, Cloud SQL, Firestore, Auth"
      echo "  --full     Also drops Cloud SQL DBs + wipes Firestore + Cloud"
      echo "             Functions + Auth users. Still preserves PVCs, K8s"
      echo "             secrets, Secret Manager, and the namespace."
      echo ""
      echo "  To rotate a secret: scripts/rotate-secret.sh"
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
    ;;
  test)
    GCP_PROJECT="octogee-test"
    FIREBASE_PROJECT="octogee-test"
    CLUSTER_PROJECT="octogee"
    CLUSTER_NAME="octogee-gateway"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    K8S_NAMESPACE="octogee-test"
    ENV_FILE="$REPO_DIR/.env.test"
    SA_KEY_DEFAULT="$HOME/.openclaw/secrets/octogee-test-sa-key.json"
    ENV_LABEL="🟡 TEST"
    MM_DB_NAME="mattermost_test"
    GITEA_DB_NAME="gitea_test"
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
echo "    • Helm release 'octogee' (gateway, workspace-api, chat-proxy, MM + Gitea pods)"
if $FULL; then
  echo -e "  ${RED}  + Cloud SQL DBs: $MM_DB_NAME, $GITEA_DB_NAME (DROP DATABASE)${NC}"
  echo -e "  ${RED}  + Firestore collections (all)${NC}"
  echo -e "  ${RED}  + Cloud Functions (chat proxy preserved)${NC}"
  echo -e "  ${RED}  + Firebase Auth users (all)${NC}"
fi
echo ""
echo "  Will preserve:"
echo "    • All K8s secrets in $K8S_NAMESPACE (rotate via scripts/rotate-secret.sh)"
echo "    • All PVCs (mattermost-data, gitea-shared-storage, gateway PVC if any)"
echo "    • Namespace: $K8S_NAMESPACE"
echo "    • Secret Manager (every entry — never touched, even with --full)"
echo "    • Cloud SQL instance (octogee-pg)"
echo "    • GCP projects, GKE cluster, AR repo"
echo "    • Firebase project, IAM, Service Accounts"
if ! $FULL; then
  echo "    • Cloud SQL data, Firestore, Functions (excl. chat proxy), Auth"
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

# ── 1. Helm uninstall + resource cleanup ─────────────────────────────────
echo ""
if $FORCE && [[ "$ENV" == "test" ]]; then
  # Fast path for test --yes: force-delete gateway/app resources only.
  # PVCs and namespace are preserved.
  info "Fast teardown (test + --yes)..."
  helm uninstall octogee -n "$K8S_NAMESPACE" \
    --kube-context "$K8S_CONTEXT" --no-hooks --timeout=1m 2>/dev/null || true
  kubectl delete deploy,statefulset,job --all -n "$K8S_NAMESPACE" --force --grace-period=0 2>/dev/null || true
  kubectl delete pod --all -n "$K8S_NAMESPACE" --force --grace-period=0 2>/dev/null || true
  ok "Fast teardown complete (all PVCs preserved)"
  FAST_DONE=true
else
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

  # ── 2. PVCs preserved ───────────────────────────────────────────────────
  # Helm leaves PVCs intentionally (data safety) and we don't override that.
  # Test gateway runs on emptyDir (cattle), MM + Gitea PVCs are install-once
  # pets. If you need to wipe any PVC deliberately, snapshot the disk first
  # and delete it manually — see RUNBOOK.md → Known-Good Reset.
  echo ""
  info "Preserving all PVCs"
fi

if [[ "${FAST_DONE:-}" != "true" ]]; then
  # ── 3. Secrets preserved ────────────────────────────────────────────────
  # Teardown never deletes K8s secrets. The cache in the namespace is still
  # valid after a helm uninstall + reinstall; helm reuses what's there. If
  # you need to rotate a specific secret, use scripts/rotate-secret.sh.
  echo ""
  info "Preserving all K8s secrets"

  # ── 4. Namespace preserved ──────────────────────────────────────────────
  info "Preserving namespace: $K8S_NAMESPACE"
fi

# ── 5. Full: Cloud SQL DBs ────────────────────────────────────────────────
if $FULL; then
  echo ""
  info "Resetting Cloud SQL databases ($MM_DB_NAME, $GITEA_DB_NAME)..."

  MM_DB_PASS=$(gcloud secrets versions access latest --secret=MM_DB_PASSWORD --project=octogee 2>/dev/null || echo "")
  GITEA_DB_PASS=$(gcloud secrets versions access latest --secret=gitea-db-password --project=octogee 2>/dev/null || echo "")

  PROXY_BIN=$(command -v cloud-sql-proxy 2>/dev/null || \
    ls /opt/homebrew/bin/cloud-sql-proxy 2>/dev/null || \
    ls /opt/homebrew/share/google-cloud-sdk/bin/cloud-sql-proxy 2>/dev/null || \
    echo "")

  # Auto-install if missing (macOS + Homebrew)
  if [[ -z "$PROXY_BIN" ]] && command -v brew >/dev/null 2>&1; then
    info "cloud-sql-proxy not found — installing via Homebrew..."
    brew install cloud-sql-proxy >/dev/null 2>&1 && PROXY_BIN=$(command -v cloud-sql-proxy 2>/dev/null || echo "")
    [[ -n "$PROXY_BIN" ]] && ok "cloud-sql-proxy installed: $PROXY_BIN"
  fi

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

# ── 6. Secret Manager preserved ───────────────────────────────────────────
# Even --full never deletes Secret Manager entries. SM is the source of truth
# for ANTHROPIC_API_KEY, INTERNAL_SERVICE_KEY, STRIPE_*, RESEND_*, Firebase
# web config, and DB passwords. Rotating those is a deliberate operation —
# use scripts/rotate-secret.sh, not teardown.

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
# NOTE: Chat proxy is persistent infrastructure (like Cloud SQL) — NOT deleted here.
# It lives as a Cloud Run service but is deployed/managed by setup-chat-proxy.sh,
# not firebase deploy. Deleting it would break chat until manually redeployed.
if $FULL; then
  echo ""
  if confirm "Delete all Cloud Functions in '$FIREBASE_PROJECT'? (chat proxy preserved)"; then
    FN_LIST=$(gcloud run services list \
      --project="$FIREBASE_PROJECT" --region="$REGION" \
      --format="value(name)" 2>/dev/null | grep -v "octogee-chat-proxy" || true)
    FN_COUNT=$(echo "$FN_LIST" | grep -c . 2>/dev/null || echo 0)
    if [[ "$FN_COUNT" -gt 0 ]]; then
      info "Deleting $FN_COUNT Cloud Run services (preserving chat proxy)..."
      echo "$FN_LIST" | while read -r fn; do
        [[ -z "$fn" ]] && continue
        gcloud run services delete "$fn" \
          --project="$FIREBASE_PROJECT" --region="$REGION" --quiet 2>/dev/null &
      done
      wait
      ok "Cloud Functions deleted (chat proxy preserved)"
      warn "After 'firebase deploy --only functions', run scripts/fix-functions-iam.sh to restore allUsers invoker binding (firebase deploy doesn't restore IAM)"
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
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Teardown complete — ${ENV_LABEL}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
if $FULL; then
  echo "  Clean slate (DBs dropped, Firestore/Auth/Functions wiped)."
  echo "  K8s + Secret Manager secrets are untouched. To rebuild:"
  echo ""
  echo "  # ── Helm install (secrets still cached from previous install) ──"
  echo "  GITEA_DB_PASS=\$(gcloud secrets versions access latest --secret=gitea-db-password --project=octogee)"
  echo "  helm upgrade --install octogee helm/octogee \\"
  echo "    -f helm/octogee/values.${ENV}.yaml \\"
  echo "    -n $K8S_NAMESPACE \\"
  echo "    --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
  echo "    --kube-context $K8S_CONTEXT \\"
  echo "    --wait --timeout=10m"
  echo ""
  echo "  # ── Re-bootstrap MM + Gitea (DBs were dropped, need fresh admin/team/org) ──"
  echo "  ./scripts/setup-mattermost.sh --env=$ENV $(if [[ "$ENV" == "test" ]]; then echo "--yes"; fi)"
  echo "  ./scripts/setup-gitea.sh --env=$ENV $(if [[ "$ENV" == "test" ]]; then echo "--yes"; fi)"
  echo "  kubectl rollout restart deploy -n $K8S_NAMESPACE"
  echo "  kubectl rollout status deploy/octogee-gateway -n $K8S_NAMESPACE --timeout=120s"
  echo "  firebase deploy --project $FIREBASE_PROJECT"
  echo "  ./scripts/verify-env.sh --env=$ENV $(if [[ "$ENV" == "test" ]]; then echo "--fix"; fi)"
  echo ""
  echo "  # ── Verify ──"
  echo "  kubectl exec -n $K8S_NAMESPACE deploy/octogee-gateway -- curl -s http://127.0.0.1:9081/health"
  echo "  kubectl exec -n $K8S_NAMESPACE deploy/octogee-gateway -- curl -s http://127.0.0.1:3001/api/site/health"
  echo "  kubectl exec -n $K8S_NAMESPACE deploy/octogee-gateway -- curl -s http://127.0.0.1:9080/health"
else
  echo "  Helm release uninstalled. All secrets, PVCs, and DBs preserved."
  echo "  To redeploy (single command — no secret dance):"
  echo ""
  echo "  GITEA_DB_PASS=\$(gcloud secrets versions access latest --secret=gitea-db-password --project=octogee)"
  echo "  helm upgrade --install octogee helm/octogee \\"
  echo "    -f helm/octogee/values.${ENV}.yaml \\"
  echo "    -n $K8S_NAMESPACE \\"
  echo "    --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
  echo "    --kube-context $K8S_CONTEXT \\"
  echo "    --wait --timeout=10m"
  echo "  kubectl rollout restart deploy -n $K8S_NAMESPACE"
  echo "  kubectl rollout status deploy/octogee-gateway -n $K8S_NAMESPACE --timeout=120s"
  echo ""
  echo "  # ── Verify ──"
  echo "  kubectl exec -n $K8S_NAMESPACE deploy/octogee-gateway -- curl -s http://127.0.0.1:9081/health"
  echo "  kubectl exec -n $K8S_NAMESPACE deploy/octogee-gateway -- curl -s http://127.0.0.1:3001/api/site/health"
  echo "  kubectl exec -n $K8S_NAMESPACE deploy/octogee-gateway -- curl -s http://127.0.0.1:9080/health"
  echo "  curl -s https://$(echo $K8S_NAMESPACE | sed 's/octogee$/preview.octogee.com/;s/octogee-test$/preview-test.octogee.com/')/health"
  echo ""
  echo "  # ── Rotate a secret (on-demand, not part of rebuild) ──"
  echo "  ./scripts/rotate-secret.sh --env=$ENV <secret-name>"
fi
echo ""
echo "  Monitoring:"
echo "    kubectl get pods -n $K8S_NAMESPACE -w              # watch pod status"
echo "    kubectl logs -n $K8S_NAMESPACE deploy/octogee-gateway -f  # tail gateway logs"
echo ""
echo "  Troubleshooting:"
echo ""
echo "    Pod stuck in Init:0/1?"
echo "      kubectl describe pod -n $K8S_NAMESPACE -l app=octogee-gateway"
echo "      → Usually missing gitea-ssh-key secret. First-install only:"
echo "      ./scripts/setup-secrets.sh --env=$ENV   (bootstrap mode)"
echo ""
echo "    CreateContainerConfigError?"
echo "      → Missing required secret (first install). Run:"
echo "      ./scripts/setup-secrets.sh --env=$ENV   (bootstrap mode)"
echo ""
echo "    Gateway 0/1 Running (not Ready)?"
echo "      → Startup takes ~90s (classifier model load). Wait or check:"
echo "      kubectl logs -n $K8S_NAMESPACE deploy/octogee-gateway --tail=20"
echo ""
echo "    502 on preview URL?"
echo "      → Backend health check needs 3-5 min to propagate after first deploy."
echo "      kubectl get ingress -n $K8S_NAMESPACE"
echo "      kubectl get managedcertificate -n $K8S_NAMESPACE"
echo ""
echo "    Ingress has NO ADDRESS (stale NEGs after teardown)?"
echo "      # Restart alone may not fix it — old NEG names cached. Delete + recreate:"
echo "      kubectl delete ingress chat-proxy-ingress workspace-api-ingress preview-ingress -n $K8S_NAMESPACE 2>/dev/null; true"
echo "      kubectl annotate svc chat-proxy -n $K8S_NAMESPACE cloud.google.com/neg-status-"
echo "      kubectl annotate svc workspace-api -n $K8S_NAMESPACE cloud.google.com/neg-status-"
echo "      kubectl annotate svc octogee-gateway -n $K8S_NAMESPACE cloud.google.com/neg-status-"
echo "      # Then helm upgrade to recreate ingresses with fresh NEGs:"
echo "      helm upgrade octogee helm/octogee -f helm/octogee/values.${ENV}.yaml -n $K8S_NAMESPACE \\"
echo "        --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" --kube-context $K8S_CONTEXT"
echo ""
echo "    Gitea setup-gitea.sh returns 403?"
echo "      → Fresh install: must_change_password flag. Script handles this automatically."
echo "      → DB mismatch: ./scripts/teardown-gateway.sh --env=$ENV --full (resets DBs)"
echo ""
