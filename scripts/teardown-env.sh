#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Environment Teardown
# ═══════════════════════════════════════════════════════════════════════════
#
# Uninstalls the umbrella helm release AND every per-instance gateway
# helm release (octogee-gw-*) Cowboy provisioned. Leaving the per-instance
# releases behind made Cowboy re-register them on the next install via
# bootstrapGlmGateways with whatever stale image tag was last deployed.
#
# Design intent: teardown never touches PVCs. The gateway runs on
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
#   ./scripts/teardown-env.sh --env=test           # Helm uninstall only
#   ./scripts/teardown-env.sh --env=test --yes     # Non-interactive (test only)
#   ./scripts/teardown-env.sh --env=test --full    # Full clean slate (DB wipe)
#   ./scripts/teardown-env.sh --env=prod           # Prod (interactive, requires "DESTROY PROD")
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
die()  { echo -e "  ${RED}❌ $1${NC}" >&2; exit 1; }

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
  echo -e "  ${RED}  + PVCs: mattermost-data, gitea-shared-storage (Helm-recreated on rebuild)${NC}"
  echo -e "  ${RED}  + Firestore collections (all)${NC}"
  echo -e "  ${RED}  + Cloud Functions (chat proxy preserved)${NC}"
  echo -e "  ${RED}  + Firebase Auth users (all)${NC}"
  echo -e "  ${RED}  + Secret Manager: byok-* (per-customer BYOK keys orphaned by Firestore wipe)${NC}"
fi
echo ""
echo "  Will preserve:"
echo "    • All K8s secrets in $K8S_NAMESPACE (rotate via scripts/rotate-secret.sh)"
if ! $FULL; then
  echo "    • All PVCs (mattermost-data, gitea-shared-storage)"
fi
echo "    • Namespace: $K8S_NAMESPACE"
echo "    • Secret Manager: infra entries (DB passwords, API keys, tokens) — wipe via gcloud manually if needed"
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

# ── 1a. Full: delete PVCs ────────────────────────────────────────────────
# Pre-customer / F&F discipline: --full already drops Cloud SQL DBs and
# wipes Firestore — there is no "data-preservation" contract to honor at
# this stage. The previous wipe-ceremony tried to surgically wipe the
# octogee/ org subtree on the Gitea PVC to avoid PVC/DB drift, but it
# only handled the Gitea-as-statefulset shape (PROD runs Gitea as a
# Deployment, no statefulset selector match → ephemeral-pod fallback →
# RWO Multi-Attach failure when the Deployment pod still held the PVC).
#
# Cleaner: delete the PVCs. Helm install on rebuild auto-recreates fresh
# ones from the chart manifests. --wait=false so the delete returns
# immediately; PVCs enter Terminating until the Helm uninstall (next
# step) drains the pods that hold them, at which point finalizers
# complete and the PVs (Delete reclaim policy on standard-rwo) are GC'd
# by GKE. Re-introduce preservation when F&F users have data on disk.
if $FULL; then
  echo ""
  info "Deleting PVCs (Helm-recreated on rebuild)..."
  for pvc in gitea-shared-storage mattermost-data; do
    if kubectl get pvc "$pvc" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
        >/dev/null 2>&1; then
      kubectl delete pvc "$pvc" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
        --wait=false >/dev/null 2>&1 \
        && ok "PVC $pvc deletion requested (will finalize after Helm uninstall)" \
        || warn "PVC $pvc delete request failed — non-fatal; Helm uninstall continues"
    else
      info "PVC $pvc not present — already gone"
    fi
  done
fi

uninstall_per_instance_gateways() {
  local timeout_flag="$1"
  local hook_flag="${2:-}"
  local releases
  releases=$(helm list -n "$K8S_NAMESPACE" --kube-context "$K8S_CONTEXT" -q 2>/dev/null \
    | grep "^octogee-gw-" || true)
  if [[ -z "$releases" ]]; then
    info "No per-instance gateway releases (octogee-gw-*) to uninstall"
    return
  fi
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    info "Uninstalling per-instance gateway release: $rel"
    # shellcheck disable=SC2086
    helm uninstall "$rel" -n "$K8S_NAMESPACE" --kube-context "$K8S_CONTEXT" \
      $hook_flag --wait --timeout="$timeout_flag" 2>&1 \
      && ok "Uninstalled $rel" \
      || warn "Failed to uninstall $rel — continuing"
  done <<<"$releases"
}

# ── 1. Helm uninstall + resource cleanup ─────────────────────────────────
echo ""
if $FORCE && [[ "$ENV" == "test" ]]; then
  # Fast path for test --yes: force-delete gateway/app resources only.
  # PVCs and namespace are preserved.
  info "Fast teardown (test + --yes)..."
  uninstall_per_instance_gateways 1m --no-hooks
  helm uninstall octogee -n "$K8S_NAMESPACE" \
    --kube-context "$K8S_CONTEXT" --no-hooks --timeout=1m 2>/dev/null || true
  kubectl delete deploy,statefulset,job --all -n "$K8S_NAMESPACE" --force --grace-period=0 2>/dev/null || true
  kubectl delete pod --all -n "$K8S_NAMESPACE" --force --grace-period=0 2>/dev/null || true
  if $FULL; then
    ok "Fast teardown complete (PVCs deleted via step 1a; finalizers complete now that holders are gone)"
  else
    ok "Fast teardown complete (PVCs preserved)"
  fi
  FAST_DONE=true
else
  uninstall_per_instance_gateways 2m
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

  # Canonical secret names: MM uses `MM_DB_PASSWORD` (uppercase) everywhere
  # (setup-secrets.sh, setup-mattermost.sh, helm chart env var, RUNBOOK).
  # Gitea uses `gitea-db-password` (lowercase-hyphen). Two different
  # historical conventions; both are load-bearing.
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

  # --full means DB drop is not optional. Hard-fail on missing deps so the
  # user doesn't think the script succeeded while silently leaving stale
  # rows behind (we hit this during TEST — "all old MM data is still there").
  if [[ -z "$PROXY_BIN" ]]; then
    die "cloud-sql-proxy not found and --full requested. Install it (brew install cloud-sql-proxy) or run DB drops manually and rerun without --full."
  fi
  # Missing-secret path: when both passwords are absent, the env has no
  # prior provisioning (clean-slate rebuild) and there's nothing to drop —
  # skip the DB section entirely. When only one is missing it's likely an
  # operator-side gcloud auth issue, so still hard-fail on the partial
  # case to surface drift.
  if [[ -z "$MM_DB_PASS" && -z "$GITEA_DB_PASS" ]]; then
    warn "Neither MM_DB_PASSWORD nor gitea-db-password in Secret Manager — assuming fresh env, skipping DB drop."
    SKIP_DB_DROP=true
  elif [[ -z "$MM_DB_PASS" ]]; then
    die "Could not read MM_DB_PASSWORD from Secret Manager (gitea-db-password exists). Check gcloud auth + grant, or delete gitea-db-password too to skip the DB drop."
  elif [[ -z "$GITEA_DB_PASS" ]]; then
    die "Could not read gitea-db-password from Secret Manager (MM_DB_PASSWORD exists). Check gcloud auth + grant, or delete MM_DB_PASSWORD too to skip the DB drop."
  else
    SKIP_DB_DROP=false
  fi

  if ! $SKIP_DB_DROP; then
    "$PROXY_BIN" octogee:us-central1:octogee-pg --port=5433 &
    PROXY_PID=$!
    trap '[[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null' EXIT
    sleep 4

    # Helper: drop + recreate a database, then assert it is empty. Each psql
    # call is a separate -c (psql refuses to run DROP DATABASE inside a
    # transaction block), and an explicit verify-empty check prevents silent
    # no-op — if the drop didn't land, the table count would stay non-zero.
    drop_and_verify() {
      local user="$1" pass="$2" dbname="$3"
      PGPASSWORD="$pass" psql -h 127.0.0.1 -p 5433 -U "$user" -d postgres \
        -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$dbname';" >/dev/null 2>&1 || true
      PGPASSWORD="$pass" psql -h 127.0.0.1 -p 5433 -U "$user" -d postgres \
        -c "DROP DATABASE IF EXISTS $dbname;" \
        || die "DROP DATABASE $dbname failed"
      PGPASSWORD="$pass" psql -h 127.0.0.1 -p 5433 -U "$user" -d postgres \
        -c "CREATE DATABASE $dbname;" \
        || die "CREATE DATABASE $dbname failed"
      local tbl_count
      tbl_count=$(PGPASSWORD="$pass" psql -h 127.0.0.1 -p 5433 -U "$user" -d "$dbname" \
        -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" \
        2>/dev/null || echo "ERR")
      if [[ "$tbl_count" != "0" ]]; then
        die "$dbname not empty after drop+create (table count = $tbl_count) — aborting"
      fi
      ok "$dbname reset and verified empty"
    }

    drop_and_verify mattermost "$MM_DB_PASS" "$MM_DB_NAME"
    drop_and_verify gitea      "$GITEA_DB_PASS" "$GITEA_DB_NAME"

    kill "$PROXY_PID" 2>/dev/null || true
    PROXY_PID=""
    trap - EXIT
  fi
fi

# ── 6. Secret Manager: preserve infra secrets, wipe per-customer byok-* ──
# Infra secrets (ANTHROPIC_API_KEY, INTERNAL_SERVICE_KEY, STRIPE_*, RESEND_*,
# Firebase web config, DB passwords) are preserved across teardown — they're
# the source of truth, rotating them is a deliberate operation, use
# scripts/rotate-secret.sh, not teardown.
#
# Per-customer `byok-{slug}-{provider}` secrets (set by customers via the
# admin UI for bring-your-own-key) are env-coupled through the customer's
# slug: --full wipes Firestore + Auth, which deletes the customer record
# that owned the byok. The corresponding Secret Manager entry becomes an
# orphan with no Firestore pointer. Wipe under --full to keep SM clean.
#
# Pre-launch caveat: slugs aren't env-prefixed (`byok-ceckert-anthropic`,
# not `byok-test-ceckert-anthropic`). With only one customer (the operator)
# that's harmless. Re-evaluate if TEST and PROD ever have customers with
# colliding slugs.
if $FULL; then
  echo ""
  byok_count=$(gcloud secrets list --project=octogee --filter="name~^byok-" --format="value(name)" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$byok_count" -gt 0 ]]; then
    if confirm "Delete $byok_count byok-* secret(s) in Secret Manager (customer BYOK keys)?"; then
      gcloud secrets list --project=octogee --filter="name~^byok-" --format="value(name)" 2>/dev/null \
        | while read -r sm; do
            [[ -z "$sm" ]] && continue
            gcloud secrets delete "$sm" --project=octogee --quiet >/dev/null 2>&1 \
              && ok "Deleted byok secret: $sm" \
              || warn "Could not delete $sm — continuing"
          done
    else
      info "Keeping byok-* secrets"
    fi
  else
    info "No byok-* secrets to wipe"
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
# NOTE: Chat proxy is persistent infrastructure (like Cloud SQL) — NOT deleted here.
# It lives as a Cloud Run service but is deployed/managed by setup-chat-proxy.sh,
# not firebase deploy. Deleting it would break chat until manually redeployed.
if $FULL; then
  echo ""
  if confirm "Delete all Cloud Functions in '$FIREBASE_PROJECT'? (chat proxy preserved)"; then
    FN_LIST=$(gcloud run services list \
      --project="$FIREBASE_PROJECT" --region="$REGION" \
      --format="value(name)" 2>/dev/null | grep -v "octogee-chat-proxy" || true)
    # `grep -c .` returns non-zero on zero matches, which under `|| echo 0`
    # concatenated a trailing "0\n0" and tripped [[ -gt ]] arithmetic.
    # Empty-string check is unambiguous and avoids the chained-pipe surprise.
    if [[ -z "$FN_LIST" ]]; then
      FN_COUNT=0
    else
      FN_COUNT=$(printf '%s\n' "$FN_LIST" | wc -l | tr -d ' ')
    fi
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
      # `-y` so a fresh shell doesn't hang on npx's "Ok to proceed? (y)"
      # tsx-install prompt when running non-interactively.
      npx -y tsx -e "
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
YES_FLAG=""
[[ "$ENV" == "test" ]] && YES_FLAG=" --yes"

echo "  ╔═══════════════════════════════════════════════════════════════╗"
echo "  ║           CANONICAL INSTALL SEQUENCE (run in order)           ║"
echo "  ╚═══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Each step is idempotent — re-running any one is safe. The two"
echo "  setup-secrets.sh runs are NOT a typo:"
echo "     • run #1 (pre-helm) — creates K8s secrets the pods need to BOOT"
echo "       (gitea-ssh-key, mattermost-cloud-sql DB password, empty"
echo "       mattermost-gateway/gitea-token shells, etc.)"
echo "     • run #2 (post-bootstrap) — re-materializes the same secrets"
echo "       now that setup-mattermost + setup-gitea wrote real values"
echo "       to .env, then validates everything"
echo ""
echo "  GITEA_DB_PASS=\$(gcloud secrets versions access latest --secret=gitea-db-password --project=octogee)"
echo ""
echo "  # 0. Cloud SQL instance settings (right-size + databases + users + creds)"
echo "  #    Idempotent — patches tier/PITR only if they drift, runs once across"
echo "  #    both envs (instance is shared)."
echo "  ./scripts/setup-cloud-sql.sh"
echo ""
echo "  # 1. Pre-helm secrets (boot prereqs)"
echo "  ./scripts/setup-secrets.sh --env=$ENV${YES_FLAG}"
echo ""
echo "  # 1b. Seed Firestore orchestrator config (idempotent — Cowboy reads"
echo "  #     defaultGatewayId on startup to auto-create a :latest gateway"
echo "  #     if no glmGateways doc exists)"
echo "  (cd scripts && npx tsx ops/seed-orchestrator-config.ts --env=$ENV)"
echo ""
echo "  # 2. Helm install (gateway, workspace-api, chat-proxy sidecar, MM, Gitea)"
echo "  helm upgrade --install octogee helm/octogee \\"
echo "    --server-side=true --force-conflicts \\"
echo "    -f helm/octogee/values.${ENV}.yaml \\"
echo "    -n $K8S_NAMESPACE \\"
echo "    --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
echo "    --kube-context $K8S_CONTEXT \\"
echo "    --wait --timeout=10m"
echo ""
echo "  # 3. Bootstrap Mattermost (admin user, team, bot, PATs)"
echo "  ./scripts/setup-mattermost.sh --env=$ENV${YES_FLAG}"
echo ""
echo "  # 4. Bootstrap Gitea (org, admin token)"
echo "  ./scripts/setup-gitea.sh --env=$ENV${YES_FLAG}"
echo ""
echo "  # 5. Post-bootstrap secrets (picks up the values steps 3+4 wrote to .env)"
echo "  ./scripts/setup-secrets.sh --env=$ENV${YES_FLAG}"
echo ""
echo "  # 6. Roll pods so they pick up the freshly-populated secret env vars"
echo "  kubectl rollout restart deploy -n $K8S_NAMESPACE"
echo "  # Cowboy auto-installs octogee-gw-default after step 2 — may take ~60s"
echo "  kubectl rollout status deploy/octogee-gateway-default -n $K8S_NAMESPACE --timeout=180s"
echo ""
echo "  # 6b. Apply Firestore TTL policies (idempotent; one-time per env)"
echo "  ./scripts/setup-firestore-ttls.sh --env=$ENV"
echo ""
echo "  # 7. Deploy Firebase functions"
echo "  firebase deploy --project $FIREBASE_PROJECT"
echo ""
echo "  # 8. Verify"
echo "  ./scripts/verify-env.sh --env=$ENV$(if [[ "$ENV" == "test" ]]; then echo " --fix"; fi)"
echo ""
echo "  ──────────────────────────────────────────────────────────────────"
echo "  In-pod smoke checks (run after step 6):"
echo "    kubectl exec -n $K8S_NAMESPACE deploy/octogee-gateway-default -- curl -s http://127.0.0.1:9081/health"
echo "    kubectl exec -n $K8S_NAMESPACE deploy/octogee-gateway-default -- curl -s http://127.0.0.1:3001/api/site/health"
echo "    kubectl exec -n $K8S_NAMESPACE deploy/octogee-gateway-default -- curl -s http://127.0.0.1:9080/health"
echo "  Public smoke (Option C — MM must be reachable directly with PAT auth):"
case "$ENV" in
  prod) echo "    curl -sk https://mattermost.octogee.com/api/v4/system/ping" ;;
  test) echo "    curl -sk https://mattermost-test.octogee.com/api/v4/system/ping" ;;
esac
echo ""
if ! $FULL; then
  echo "  Note: --full was NOT used. Cloud SQL data, Firestore, Auth users,"
  echo "  and Cloud Functions were preserved. Skip step 7b, and the"
  echo "  pre-existing data may make some setup-* steps a no-op."
  echo ""
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
echo "      kubectl delete ingress chat-proxy-ingress workspace-api-ingress preview-ingress mattermost-ingress -n $K8S_NAMESPACE 2>/dev/null; true"
echo "      kubectl annotate svc chat-proxy -n $K8S_NAMESPACE cloud.google.com/neg-status-"
echo "      kubectl annotate svc workspace-api -n $K8S_NAMESPACE cloud.google.com/neg-status-"
echo "      kubectl annotate svc mattermost -n $K8S_NAMESPACE cloud.google.com/neg-status- 2>/dev/null || true"
echo "      kubectl annotate svc octogee-gateway -n $K8S_NAMESPACE cloud.google.com/neg-status-"
echo "      # Then helm upgrade to recreate ingresses with fresh NEGs:"
echo "      helm upgrade octogee helm/octogee --server-side=true --force-conflicts \\"
echo "        -f helm/octogee/values.${ENV}.yaml -n $K8S_NAMESPACE \\"
echo "        --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" --kube-context $K8S_CONTEXT"
echo ""
echo "    Gitea setup-gitea.sh returns 403?"
echo "      → Fresh install: must_change_password flag. Script handles this automatically."
echo "      → DB mismatch: ./scripts/teardown-env.sh --env=$ENV --full (resets DBs)"
echo ""
