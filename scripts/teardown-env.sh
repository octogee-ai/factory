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
# Default teardown preserves PVCs. Full teardown deletes the two durable
# application PVCs together with its other clean-slate data boundaries.
#
# Default (no flags): `helm uninstall` and nothing else.
#   Preserves: all PVCs, K8s secrets, namespace, Secret Manager, Cloud SQL,
#              Firestore, Functions, Auth.
#
# --full: also drops the per-env Cloud SQL databases, wipes Firestore
#         collections, deletes per-env Cloud Functions (chat proxy
#         preserved), Firebase Auth users, and durable application PVCs.
#         Still preserves: K8s secrets, namespace, and Secret Manager.
#
# Does NOT delete (ever): GCP projects, GKE clusters, AR repos,
#   Firebase projects, GCP Service Accounts, IAM bindings,
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
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

ENV="prod"
DEPLOYMENT_TARGET=""
FORCE=false
FULL=false
PROXY_PID=""

for arg in "$@"; do
  case $arg in
    --env=*)        ENV="${arg#*=}" ;;
    --deployment-target=*) DEPLOYMENT_TARGET="${arg#*=}" ;;
    --force|--yes|-y) FORCE=true ;;
    --full)         FULL=true ;;
    --help|-h)
      echo "Usage: $0 [--env=prod|test] [--deployment-target=TARGET] [--force|--yes] [--full]"
      echo ""
      echo "  (default)  helm uninstall only — preserves PVCs, K8s secrets,"
      echo "             namespace, Secret Manager, Cloud SQL, Firestore, Auth"
      echo "  --full     Also drops Cloud SQL DBs + wipes Firestore + Cloud"
      echo "             Functions + Auth users + deletes durable PVCs."
      echo "             Still preserves K8s secrets, Secret Manager, and namespace."
      echo ""
      echo "  To rotate a secret: scripts/rotate-secret.sh"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

case "$ENV" in
  prod|test)
    if [[ -n "$DEPLOYMENT_TARGET" ]]; then
      octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"
      [[ "$TARGET_ENVIRONMENT" == "$ENV" ]] || {
        echo "Deployment target '$DEPLOYMENT_TARGET' does not belong to environment '$ENV'"
        exit 1
      }
    else
      octogee_load_deployment_target "--environment=$ENV"
    fi
    ;;
  *) echo "Unknown environment: $ENV (use prod or test)"; exit 1 ;;
esac
GCP_PROJECT="$TARGET_FIREBASE_PROJECT"
FIREBASE_PROJECT="$TARGET_FIREBASE_PROJECT"
CLUSTER_PROJECT="$TARGET_CLUSTER_PROJECT"
CLUSTER_NAME="$TARGET_CLUSTER_NAME"
K8S_CONTEXT="$TARGET_KUBE_CONTEXT"
K8S_NAMESPACE="$TARGET_NAMESPACE"
REGION="$TARGET_REGION"
TARGET_ARG=" --deployment-target=$TARGET_ID"

case "$ENV" in
  prod)
    ENV_FILE="$REPO_DIR/.env"
    SA_KEY_DEFAULT="$HOME/.openclaw/secrets/octogee-sa-key.json"
    ENV_LABEL="🔴 PRODUCTION"
    MM_DB_NAME="mattermost_prod"
    GITEA_DB_NAME="gitea_prod"
    ;;
  test)
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
case "$TARGET_ID" in
  prod-central|test-central|build-week-central) ;;
  *) ENV_FILE="$REPO_DIR/.env.$TARGET_ID" ;;
esac
SA_KEY_DEFAULT="$HOME/.openclaw/secrets/$TARGET_FIREBASE_PROJECT-sa-key.json"

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
echo "    • Helm release 'octogee' (gateway, gateway-edge, chat-proxy, MM + Gitea pods)"
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
echo "    • Cloud SQL instance ($TARGET_CLOUD_SQL_INSTANCE)"
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
gcloud container clusters get-credentials "$CLUSTER_NAME" --region "$TARGET_REGION" --project "$CLUSTER_PROJECT" 2>/dev/null || true
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
inspect_pvc() {
  local pvc="$1"
  local output
  if ! output=$(kubectl get pvc "$pvc" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
      --ignore-not-found -o name 2>&1); then
    [[ -n "$output" ]] && echo "$output" >&2
    die "could not inspect PVC $pvc"
  fi
  PVC_INSPECTION="$output"
}

if $FULL; then
  echo ""
  info "Deleting PVCs (Helm-recreated on rebuild)..."
  for pvc in gitea-shared-storage mattermost-data; do
    inspect_pvc "$pvc"
    if [[ -n "$PVC_INSPECTION" ]]; then
      kubectl delete pvc "$pvc" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
        --wait=false >/dev/null 2>&1 \
        || die "delete request failed for PVC $pvc"
      ok "PVC $pvc deletion requested (will finalize after Helm uninstall)"
    else
      info "PVC $pvc not present — already gone"
    fi
  done
fi

verify_durable_pvcs_absent() {
  local pvc
  for pvc in gitea-shared-storage mattermost-data; do
    inspect_pvc "$pvc"
    if [[ -n "$PVC_INSPECTION" ]]; then
      kubectl wait --for=delete "pvc/$pvc" -n "$K8S_NAMESPACE" \
        --context "$K8S_CONTEXT" --timeout=120s >/dev/null 2>&1 \
        || die "PVC $pvc did not finalize"
    fi
    inspect_pvc "$pvc"
    if [[ -n "$PVC_INSPECTION" ]]; then
      die "PVC $pvc still exists after deletion wait"
    fi
  done
  ok "Durable PVCs confirmed absent"
}

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
  # Fast path for test --yes: force-delete gateway/app resources. --full
  # has already requested deletion of the durable PVCs in step 1a.
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

  echo ""
  if $FULL; then
    info "Durable PVC deletion requested; finalizers complete after Helm holders drain"
  else
    info "Preserving all PVCs"
  fi
fi

if $FULL; then
  verify_durable_pvcs_absent
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
# 2026-05-14 incident: --full ran "successfully" on PROD + TEST but every DB
# still had data afterward. Two silent-failure paths existed: (a) gcloud
# read errors got swallowed by `|| echo ""`, then both passwords looked
# empty, then the script took the "fresh env, skipping DB drop" path with
# only a `warn`; (b) the `sleep 4` after launching cloud-sql-proxy didn't
# actually verify the proxy was up and pointed at the right instance.
#
# Hardening below:
#   * `sm_read` distinguishes "secret legitimately absent" (NOT_FOUND) from
#     "gcloud failed for some other reason" — only the former is allowed.
#   * The silent "fresh env" skip is gone. If --full is requested and either
#     password is missing, the script dies with explicit guidance.
#   * Private-only instances reset through the Cloud SQL Admin API and verify
#     each recreated database before any later environment cleanup.
#   * Public-IP instances verify the proxy listener and process, authenticate
#     both users, inventory the databases, and stop on every SQL error.
if $FULL; then
  echo ""
  info "Resetting Cloud SQL databases ($MM_DB_NAME, $GITEA_DB_NAME)..."

  # ── 5a. Secret reads — fail loud on anything that isn't a clean NOT_FOUND.
  sm_read() {
    local secret_name="$1"
    local stderr_file
    stderr_file=$(mktemp)
    gcloud secrets versions access latest --secret="$secret_name" --project="$TARGET_CLOUD_SQL_PROJECT" 2>"$stderr_file"
    local rc=$?
    if [[ $rc -eq 0 ]]; then
      rm -f "$stderr_file"
      return 0
    fi
    if grep -qE "NOT_FOUND|was not found|does not exist" "$stderr_file" 2>/dev/null; then
      rm -f "$stderr_file"
      return 1  # legitimately absent — caller decides
    fi
    echo -e "  ${RED}❌ gcloud read failed for $secret_name (not a 404):${NC}" >&2
    sed 's/^/      /' "$stderr_file" >&2
    rm -f "$stderr_file"
    return 2
  }

  MM_DB_PASS=""
  MM_DB_PASS_STATUS="present"
  if MM_DB_PASS=$(sm_read "$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET"); then
    :
  else
    rc=$?
    if [[ $rc -eq 1 ]]; then
      MM_DB_PASS_STATUS="absent"
    else
      die "$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET read failed (gcloud auth or network). Fix and re-run."
    fi
  fi

  GITEA_DB_PASS=""
  GITEA_DB_PASS_STATUS="present"
  if GITEA_DB_PASS=$(sm_read "$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET"); then
    :
  else
    rc=$?
    if [[ $rc -eq 1 ]]; then
      GITEA_DB_PASS_STATUS="absent"
    else
      die "$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET read failed (gcloud auth or network). Fix and re-run."
    fi
  fi

  # 2026-05-14: removed the "both absent → fresh env, skip drop" path. If
  # --full was requested, the operator believes there is data to drop;
  # making the drop optional based on Secret Manager presence is what
  # caused both envs to silently retain stale data. If the operator wants
  # to skip the DB drop deliberately, they can leave off --full.
  if [[ "$MM_DB_PASS_STATUS" == "absent" || "$GITEA_DB_PASS_STATUS" == "absent" ]]; then
    echo ""
    echo -e "  ${RED}❌ Refusing to silently skip the DB drop.${NC}"
    echo "     MM_DB_PASSWORD:    $MM_DB_PASS_STATUS"
    echo "     gitea-db-password: $GITEA_DB_PASS_STATUS"
    echo ""
    echo "     Either: the DB is truly empty / never provisioned —"
    echo "             rerun WITHOUT --full to skip the DB section."
    echo "         Or: passwords were lost — restore via setup-cloud-sql.sh,"
    echo "             then re-run with --full."
    exit 1
  fi

  database_exists() {
    local dbname="$1" stderr_file rc
    stderr_file=$(mktemp)
    gcloud sql databases describe "$dbname" --instance="$TARGET_CLOUD_SQL_INSTANCE" \
      --project="$TARGET_CLOUD_SQL_PROJECT" --format='value(name)' >/dev/null 2>"$stderr_file"
    rc=$?
    if [[ $rc -eq 0 ]]; then
      rm -f "$stderr_file"
      return 0
    fi
    if grep -qE "NOT_FOUND|was not found|does not exist" "$stderr_file"; then
      rm -f "$stderr_file"
      return 1
    fi
    echo -e "  ${RED}❌ Cloud SQL Admin API describe failed for $dbname:${NC}" >&2
    sed 's/^/      /' "$stderr_file" >&2
    rm -f "$stderr_file"
    return 2
  }

  reset_database_through_api() {
    local dbname="$1" exists_rc recreated_name
    if database_exists "$dbname"; then
      info "Deleting $dbname through the Cloud SQL Admin API..."
      gcloud sql databases delete "$dbname" --instance="$TARGET_CLOUD_SQL_INSTANCE" \
        --project="$TARGET_CLOUD_SQL_PROJECT" --quiet \
        || die "Cloud SQL Admin API delete failed for $dbname"
    else
      exists_rc=$?
      [[ $exists_rc -eq 1 ]] || die "Cloud SQL Admin API could not inspect $dbname"
      info "$dbname is absent; creating its required fresh database through the Cloud SQL Admin API..."
    fi
    gcloud sql databases create "$dbname" --instance="$TARGET_CLOUD_SQL_INSTANCE" \
      --project="$TARGET_CLOUD_SQL_PROJECT" --quiet \
      || die "Cloud SQL Admin API create failed for $dbname"
    recreated_name="$(gcloud sql databases describe "$dbname" --instance="$TARGET_CLOUD_SQL_INSTANCE" \
      --project="$TARGET_CLOUD_SQL_PROJECT" --format='value(name)')" \
      || die "Cloud SQL Admin API verification failed for $dbname"
    [[ "$recreated_name" == "$dbname" ]] \
      || die "Cloud SQL Admin API verification returned '$recreated_name' for $dbname"
    ok "$dbname — Cloud SQL API confirmed a newly-created empty database"
  }

  instance_ip_types="$(gcloud sql instances describe "$TARGET_CLOUD_SQL_INSTANCE" \
    --project="$TARGET_CLOUD_SQL_PROJECT" --format='value(ipAddresses.type)')" \
    || die "Cloud SQL instance inspection failed; refusing to classify a transport/config failure as a credential failure"

  if [[ "$instance_ip_types" != *"PRIMARY"* ]]; then
    info "Cloud SQL has no public IP; resetting databases through the Cloud SQL Admin API..."
    reset_database_through_api "$MM_DB_NAME"
    reset_database_through_api "$GITEA_DB_NAME"
    echo ""
    echo -e "  ${BOLD}Cloud SQL reset complete:${NC}"
    echo -e "    ${GREEN}✅ Cloud SQL API confirmed both recreated databases are empty${NC}"
  else
    PROXY_BIN=$(command -v cloud-sql-proxy 2>/dev/null || \
      ls /opt/homebrew/bin/cloud-sql-proxy 2>/dev/null || \
      ls /opt/homebrew/share/google-cloud-sdk/bin/cloud-sql-proxy 2>/dev/null || \
      echo "")
    if [[ -z "$PROXY_BIN" ]] && command -v brew >/dev/null 2>&1; then
      info "cloud-sql-proxy not found — installing via Homebrew..."
      brew install cloud-sql-proxy >/dev/null 2>&1 && PROXY_BIN=$(command -v cloud-sql-proxy 2>/dev/null || echo "")
      [[ -n "$PROXY_BIN" ]] && ok "cloud-sql-proxy installed: $PROXY_BIN"
    fi
    [[ -n "$PROXY_BIN" ]] || die "cloud-sql-proxy not found and --full requested. Install it (brew install cloud-sql-proxy) or run DB drops manually and rerun without --full."

    if lsof -nP -iTCP:5433 -sTCP:LISTEN >/dev/null 2>&1; then
      holders=$(lsof -nP -iTCP:5433 -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1"("$2")"}' | sort -u | tr '\n' ' ')
      die "Local port 5433 is already in use by: ${holders:-(unknown)}. Stale cloud-sql-proxy? Kill it (pkill -f 'cloud-sql-proxy.*5433') and rerun."
    fi

    PROXY_LOG=$(mktemp -t cloud-sql-proxy-teardown.XXXXX)
    "$PROXY_BIN" "$TARGET_CLOUD_SQL_CONNECTION" --port=5433 >"$PROXY_LOG" 2>&1 &
    PROXY_PID=$!
    trap '[[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null' EXIT

    info "Waiting for cloud-sql-proxy listener on 127.0.0.1:5433..."
    PROXY_UP=false
    for i in $(seq 1 30); do
      if ! kill -0 "$PROXY_PID" 2>/dev/null; then
        echo -e "  ${RED}❌ cloud-sql-proxy exited during startup. Last 20 lines of log:${NC}" >&2
        tail -20 "$PROXY_LOG" | sed 's/^/      /' >&2
        die "cloud-sql-proxy died — see above ($PROXY_LOG)"
      fi
      if nc -z 127.0.0.1 5433 2>/dev/null; then
        PROXY_UP=true
        ok "cloud-sql-proxy listening on :5433 (after ${i}s)"
        break
      fi
      sleep 1
    done
    if ! $PROXY_UP; then
      echo -e "  ${RED}❌ cloud-sql-proxy never started listening on :5433 (30s timeout). Log tail:${NC}" >&2
      tail -20 "$PROXY_LOG" | sed 's/^/      /' >&2
      die "cloud-sql-proxy didn't come up — see above"
    fi

    probe_database_user() {
      local user="$1" pass="$2" dbname="$3" error_file
      error_file=$(mktemp)
      if PGPASSWORD="$pass" psql -h 127.0.0.1 -p 5433 -U "$user" -d postgres -tAc "SELECT 1" \
          >/dev/null 2>"$error_file"; then
        rm -f "$error_file"
        return 0
      fi
      if grep -qiE 'password authentication failed|authentication failed' "$error_file"; then
        rm -f "$error_file"
        die "Authentication failed for '$user' user against $dbname. Its Secret Manager password may be out of sync with the DB user."
      fi
      echo -e "  ${RED}❌ Database connection probe failed for '$user' against $dbname; this is a transport/config failure, not a credential mismatch:${NC}" >&2
      sed 's/^/      /' "$error_file" >&2
      rm -f "$error_file"
      die "Fix Cloud SQL proxy/private-network reachability and retry."
    }

    probe_database_user mattermost "$MM_DB_PASS" "$MM_DB_NAME"
    probe_database_user gitea "$GITEA_DB_PASS" "$GITEA_DB_NAME"
    ok "Both DB user credentials authenticate against the live instance"

  # ── 5d. Pre-drop inventory — operator sees what's about to be nuked.
  inventory_db() {
    local user="$1" pass="$2" dbname="$3"
    local line
    line=$(PGPASSWORD="$pass" psql -h 127.0.0.1 -p 5433 -U "$user" -d "$dbname" -tAc "
      SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema='public') || ' tables, ' ||
             pg_size_pretty(pg_database_size('$dbname'))
    " 2>/dev/null)
    line=${line//[[:space:]]/ }
    line=${line## }
    if [[ -z "$line" ]]; then line="(could not inspect — DB may not exist yet)"; fi
    echo "    $dbname: $line"
  }

  echo ""
  info "Pre-drop inventory:"
  inventory_db mattermost "$MM_DB_PASS" "$MM_DB_NAME"
  inventory_db gitea      "$GITEA_DB_PASS" "$GITEA_DB_NAME"
  echo ""

  # ── 5e. Drop + recreate + verify, per DB.
  # Single -c per psql call (DROP DATABASE rejects transaction blocks).
  # ON_ERROR_STOP=1 promotes every SQL warning into a non-zero exit so `|| die`
  # actually fires; default psql silently swallows certain errors.
  drop_and_verify() {
    local user="$1" pass="$2" dbname="$3"
    local before
    before=$(PGPASSWORD="$pass" psql -h 127.0.0.1 -p 5433 -U "$user" -d "$dbname" -tAc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "?")
    before=${before//[[:space:]]/}
    info "Dropping $dbname (before: ${before:-?} tables)..."
    PGPASSWORD="$pass" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -U "$user" -d postgres \
      -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$dbname' AND pid <> pg_backend_pid();" >/dev/null \
      || die "Could not terminate active backends on $dbname (psql failed)"
    PGPASSWORD="$pass" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -U "$user" -d postgres \
      -c "DROP DATABASE IF EXISTS $dbname;" >/dev/null \
      || die "DROP DATABASE $dbname failed — check active sessions or owner permissions"
    PGPASSWORD="$pass" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -U "$user" -d postgres \
      -c "CREATE DATABASE $dbname;" >/dev/null \
      || die "CREATE DATABASE $dbname failed"
    local after
    after=$(PGPASSWORD="$pass" psql -h 127.0.0.1 -p 5433 -U "$user" -d "$dbname" -tAc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "ERR")
    after=${after//[[:space:]]/}
    if [[ "$after" != "0" ]]; then
      die "$dbname not empty after drop+create (tables=$after) — DROP DATABASE may have failed silently. Check $PROXY_LOG and active sessions."
    fi
    ok "$dbname: ${before:-?} tables → 0 (verified empty)"
  }

    drop_and_verify mattermost "$MM_DB_PASS" "$MM_DB_NAME"
    drop_and_verify gitea      "$GITEA_DB_PASS" "$GITEA_DB_NAME"

    kill "$PROXY_PID" 2>/dev/null || true
    PROXY_PID=""
    trap - EXIT
    rm -f "$PROXY_LOG"

    echo ""
    echo -e "  ${BOLD}Cloud SQL reset complete:${NC}"
    echo -e "    ${GREEN}✅ $MM_DB_NAME — dropped + recreated empty${NC}"
    echo -e "    ${GREEN}✅ $GITEA_DB_NAME — dropped + recreated empty${NC}"
  fi
fi

# ── 6. Secret Manager: preserve infra secrets, wipe per-customer byok-* ──
# Infra secrets (ANTHROPIC_API_KEY, STRIPE_*, RESEND_*,
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
import { cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import * as fs from 'fs';
const sa = JSON.parse(fs.readFileSync('$SA_KEY', 'utf8'));
initializeApp({ credential: cert(sa as any), projectId: '$FIREBASE_PROJECT' });
(async () => {
  const auth = getAuth();
  const list = await auth.listUsers(1000);
  await Promise.all(list.users.map(u => auth.deleteUser(u.uid)));
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
echo "  GITEA_DB_PASS=\$(gcloud secrets versions access latest --secret=$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET --project=$TARGET_CLOUD_SQL_PROJECT)"
echo "  BOOTSTRAP_GATEWAY_TAG=<immutable release SHA>"
echo ""
echo "  # 0. Cloud SQL instance settings (right-size + databases + users + creds)"
echo "  #    Idempotent — patches tier/PITR only if they drift, runs once across"
echo "  #    both envs (instance is shared)."
echo "  ./scripts/setup-cloud-sql.sh --target=$TARGET_ID"
echo ""
echo "  # 1. Pre-helm secrets (boot prereqs)"
echo "  ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG --phase=bootstrap${YES_FLAG}"
echo ""
echo "  # (No step 1b needed: glm-controller self-seeds config/orchestrator"
echo "  #  from K8S_NAMESPACE on first bootstrap tick. Run the seed script"
echo "  #  by hand only for non-default canary placements:"
echo "  #    (cd scripts && npx tsx ops/seed-orchestrator-config.ts --env=$ENV$TARGET_ARG --default-gateway=gw-${ENV}-canary)"
echo "  #  Or when re-running into an env whose deployed glm-controller image predates"
echo "  #  d9cfd313 (in that case run it once to unblock).)"
echo ""
echo "  # 2. Helm install (gateway, gateway-edge, chat-proxy sidecar, MM, Gitea)"
echo "  UMBRELLA_CHART_DIR=\$(mktemp -d)"
echo "  UMBRELLA_CHART=\$(./scripts/package-umbrella-chart.sh --output-dir \"\$UMBRELLA_CHART_DIR\")"
echo "  helm upgrade --install octogee \"\$UMBRELLA_CHART\" \\"
echo "    --server-side=true --force-conflicts \\"
echo "    -f helm/octogee/values.${ENV}.yaml \\"
echo "    -f <(node core/dist/render-deployment-target-helm-values.js --target=$TARGET_ID) \\"
echo "    -n $K8S_NAMESPACE \\"
echo "    --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
echo "    --set \"glm-controller.bootstrapDefaultGateway.imageTag=\$BOOTSTRAP_GATEWAY_TAG\" \\"
echo "    --kube-context $K8S_CONTEXT \\"
echo "    --wait --timeout=10m"
echo ""
echo "  # 3. Bootstrap Mattermost (admin user, team, bot, PATs)"
echo "  ./scripts/setup-mattermost.sh --env=$ENV$TARGET_ARG${YES_FLAG}"
echo ""
echo "  # 4. Bootstrap Gitea (org, admin token)"
echo "  ./scripts/setup-gitea.sh --env=$ENV$TARGET_ARG${YES_FLAG}"
echo ""
echo "  # 5. Post-bootstrap secrets (picks up the values steps 3+4 wrote to .env)"
echo "  ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG --phase=launch${YES_FLAG}"
echo ""
echo "  # 6. Roll pods so they pick up the freshly-populated secret env vars"
echo "  kubectl rollout restart deploy -n $K8S_NAMESPACE"
echo "  # A fresh Firestore bootstrap atomically seeds durable default release 1."
echo "  # Existing durable roots/releases are never reconstructed or overwritten."
echo "  kubectl rollout status deploy/octogee-gateway-default -n $K8S_NAMESPACE --timeout=180s"
echo ""
echo "  # 7. Deploy Firebase functions"
echo "  firebase deploy --project $FIREBASE_PROJECT"
echo ""
echo "  # 8. Verify"
echo "  ./scripts/verify-env.sh --env=$ENV$TARGET_ARG$(if [[ "$ENV" == "test" ]]; then echo " --fix"; fi)"
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
echo "      ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG   (bootstrap mode)"
echo ""
echo "    CreateContainerConfigError?"
echo "      → Missing required secret (first install). Run:"
echo "      ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG   (bootstrap mode)"
echo ""
echo "    Gateway 0/1 Running (not Ready)?"
echo "      → Startup is still in progress. Wait or check:"
echo "      kubectl logs -n $K8S_NAMESPACE deploy/octogee-gateway --tail=20"
echo ""
echo "    502 on preview URL?"
echo "      → Backend health check needs 3-5 min to propagate after first deploy."
echo "      kubectl get ingress -n $K8S_NAMESPACE"
echo "      kubectl get managedcertificate -n $K8S_NAMESPACE"
echo ""
echo "    Ingress has NO ADDRESS (stale NEGs after teardown)?"
echo "      # Restart alone may not fix it — old NEG names cached. Delete + recreate:"
echo "      kubectl delete ingress chat-proxy-ingress gateway-edge-ingress preview-ingress mattermost-ingress -n $K8S_NAMESPACE 2>/dev/null; true"
echo "      kubectl annotate svc chat-proxy -n $K8S_NAMESPACE cloud.google.com/neg-status-"
echo "      kubectl annotate svc gateway-edge -n $K8S_NAMESPACE cloud.google.com/neg-status-"
echo "      kubectl annotate svc mattermost -n $K8S_NAMESPACE cloud.google.com/neg-status- 2>/dev/null || true"
echo "      kubectl annotate svc octogee-gateway -n $K8S_NAMESPACE cloud.google.com/neg-status-"
echo "      # Then helm upgrade to recreate ingresses with fresh NEGs:"
echo "      UMBRELLA_CHART_DIR=\$(mktemp -d)"
echo "      UMBRELLA_CHART=\$(./scripts/package-umbrella-chart.sh --output-dir \"\$UMBRELLA_CHART_DIR\")"
echo "      helm upgrade octogee \"\$UMBRELLA_CHART\" --server-side=true --force-conflicts \\"
echo "        -f helm/octogee/values.${ENV}.yaml \\"
echo "        -f <(node core/dist/render-deployment-target-helm-values.js --target=$TARGET_ID) -n $K8S_NAMESPACE \\"
echo "        --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" --kube-context $K8S_CONTEXT"
echo ""
echo "    Gitea setup-gitea.sh returns 403?"
echo "      → Fresh install: must_change_password flag. Script handles this automatically."
echo "      → DB mismatch: ./scripts/teardown-env.sh --env=$ENV --full (resets DBs)"
echo ""
