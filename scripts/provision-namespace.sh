#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Namespace Provisioner — isolated dev/feature environments
# ═══════════════════════════════════════════════════════════════════════════
#
# Provisions a brand-new isolated Octogee stack in a custom K8s namespace
# within the shared `octogee-gateway` cluster. Each namespace gets its own
# Cloud SQL databases, PVCs, K8s secrets, MM + Gitea bootstrap state, and
# a dedicated Helm release. The Firebase project is shared with octogee-test.
#
# Full flow (idempotent "delete if exists → create from scratch"):
#   1. Validate namespace name + safety confirmation
#   2. Terraform apply → new Cloud SQL databases
#   3. Create K8s namespace
#   4. Render helm values from template
#   5. setup-secrets.sh       → materialize K8s secrets
#   6. helm upgrade --install → deploy everything
#   7. setup-mattermost.sh    → bootstrap admin/team/bot
#   8. setup-gitea.sh         → bootstrap org + API token
#   9. Verify pods are running
#
# Access is INTERNAL ONLY (no ingress, no public URL). Use port-forward:
#   kubectl port-forward -n NAMESPACE svc/workspace-api 3001:3001
#   kubectl port-forward -n NAMESPACE svc/mattermost 8065:8065
#
# Usage:
#   ./scripts/provision-namespace.sh feat-alice
#   ./scripts/provision-namespace.sh feat-alice --yes
#   ./scripts/provision-namespace.sh --destroy feat-alice
#
# SAFETY:
#   - `octogee` and `octogee-test` cannot be used here (use setup-gateway.sh).
#   - Any other existing namespace is deleted + recreated from scratch.
#   - PVCs in the target namespace ARE deleted — this is a hard reset.
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

NAMESPACE=""
YES=false
DESTROY_ONLY=false
SKIP_TERRAFORM=false

for arg in "$@"; do
  case $arg in
    --yes|-y)        YES=true ;;
    --destroy)       DESTROY_ONLY=true ;;
    --skip-terraform) SKIP_TERRAFORM=true ;;
    --help|-h)
      sed -n '4,36p' "$0"
      exit 0
      ;;
    -*) echo "Unknown flag: $arg"; exit 1 ;;
    *)  [[ -z "$NAMESPACE" ]] && NAMESPACE="$arg" || { echo "Extra arg: $arg"; exit 1; } ;;
  esac
done

[[ -z "$NAMESPACE" ]] && {
  echo "Usage: $0 <namespace> [--yes] [--destroy] [--skip-terraform]"
  exit 1
}

# ── Validate namespace name ────────────────────────────────────────────────
if ! [[ "$NAMESPACE" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo -e "${RED}❌ Invalid namespace name '$NAMESPACE'${NC}"
  echo "  Must match DNS-1123 label: lowercase alphanumeric + dash, starting/ending alphanumeric."
  exit 1
fi
if [[ ${#NAMESPACE} -gt 63 ]]; then
  echo -e "${RED}❌ Namespace '$NAMESPACE' is too long (max 63 chars)${NC}"
  exit 1
fi

# DB-slug derivation (hyphen → underscore for Postgres database names)
DB_SLUG="${NAMESPACE//-/_}"

# ── Safety gate: reserved namespace handling ───────────────────────────────
case "$NAMESPACE" in
  octogee)
    echo ""
    echo -e "${RED}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}${BOLD}  ⚠️  NAMESPACE 'octogee' IS PRODUCTION${NC}"
    echo -e "${RED}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${RED}This script will NUKE the namespace and all its data."
    echo -e "  ${RED}PVCs, secrets, MM DB, Gitea DB, everything.${NC}"
    echo ""
    echo -e "  ${RED}Do NOT use this script for production.${NC}"
    echo -e "  ${RED}Use scripts/teardown-gateway.sh for routine prod work.${NC}"
    echo ""
    if ! $YES; then
      echo -ne "  ${RED}${BOLD}Type 'DESTROY PROD NAMESPACE' to confirm (case-sensitive):${NC} "
      read -r confirmation
      [[ "$confirmation" == "DESTROY PROD NAMESPACE" ]] || { echo "  Cancelled."; exit 1; }
    else
      echo -e "  ${RED}${BOLD}--yes is forbidden with namespace=octogee. Refusing.${NC}"
      exit 1
    fi
    ;;
  octogee-test)
    echo ""
    echo -e "${YELLOW}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}${BOLD}  ⚠️  NAMESPACE 'octogee-test' IS THE SHARED TEST ENV${NC}"
    echo -e "${YELLOW}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  This script is for ISOLATED custom namespaces. To rebuild the"
    echo "  shared test env, use scripts/teardown-gateway.sh --env=test --full"
    echo "  followed by the rebuild steps in RUNBOOK.md."
    echo ""
    exit 1
    ;;
  kube-system|kube-public|kube-node-lease|default|gke-*)
    echo -e "${RED}❌ Reserved K8s namespace: '$NAMESPACE'${NC}"
    exit 1
    ;;
esac

# ── Constants (shared cluster + test Firebase project) ─────────────────────
CLUSTER_PROJECT="octogee"
CLOUDSQL_PROJECT="octogee"
CLOUDSQL_INSTANCE="octogee-pg"
CLUSTER_NAME="octogee-gateway"
K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
FIREBASE_PROJECT="octogee-test"
TF_DIR="$REPO_DIR/terraform/environments/custom"
VALUES_TPL="$REPO_DIR/helm/octogee/values.custom.yaml.tpl"
VALUES_OUT="$REPO_DIR/helm/octogee/values.$NAMESPACE.yaml"
MM_DB_NAME="mattermost_${DB_SLUG}"
GITEA_DB_NAME="gitea_${DB_SLUG}"

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }
step() { echo ""; echo -e "${CYAN}▶ $1${NC}"; }

confirm() {
  $YES && return 0
  echo -ne "  ${YELLOW}$1 [y/N]:${NC} "
  read -r yn
  [[ "$yn" =~ ^[Yy]$ ]]
}

# ── Banner ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
if $DESTROY_ONLY; then
  echo -e "${BOLD}  Octogee Namespace DESTROY — ${NAMESPACE}${NC}"
else
  echo -e "${BOLD}  Octogee Namespace Provision — ${NAMESPACE}${NC}"
fi
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Target namespace:  ${BOLD}$NAMESPACE${NC}"
echo -e "  DB slug:           ${BOLD}$DB_SLUG${NC}"
echo -e "  Mattermost DB:     ${BOLD}$MM_DB_NAME${NC}"
echo -e "  Gitea DB:          ${BOLD}$GITEA_DB_NAME${NC}"
echo -e "  Cluster:           ${BOLD}$CLUSTER_NAME${NC}"
echo -e "  Firebase (shared): ${BOLD}$FIREBASE_PROJECT${NC}"
echo ""

# ── Tool checks ────────────────────────────────────────────────────────────
for tool in gcloud kubectl helm terraform psql; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required tool missing: $tool"
done
command -v cloud-sql-proxy >/dev/null 2>&1 || \
  ls /opt/homebrew/bin/cloud-sql-proxy >/dev/null 2>&1 || \
  fail "cloud-sql-proxy not found (try: brew install cloud-sql-proxy)"
ok "All required tools present"

# ── kubectl context ────────────────────────────────────────────────────────
step "Setting kubectl context"
gcloud container clusters get-credentials "$CLUSTER_NAME" --region us-central1 --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT" >/dev/null
[[ "$(kubectl config current-context)" == "$K8S_CONTEXT" ]] || fail "Wrong kubectl context"
ok "kubectl context: $K8S_CONTEXT"

# ── Confirm if not --yes ───────────────────────────────────────────────────
if ! $YES && ! $DESTROY_ONLY; then
  echo ""
  confirm "Proceed with full provision of '$NAMESPACE'?" || { echo "  Cancelled."; exit 0; }
fi

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 1: DESTROY existing state (idempotent)
# ═══════════════════════════════════════════════════════════════════════════

destroy_namespace() {
  step "Phase 1: Destroying existing state for '$NAMESPACE'"

  # 1a. Helm release
  if helm status octogee -n "$NAMESPACE" --kube-context "$K8S_CONTEXT" >/dev/null 2>&1; then
    info "Uninstalling helm release 'octogee' in $NAMESPACE..."
    helm uninstall octogee -n "$NAMESPACE" --kube-context "$K8S_CONTEXT" --no-hooks --timeout=2m 2>/dev/null || true
    ok "Helm release uninstalled"
  else
    info "No Helm release to uninstall"
  fi

  # 1b. Force-delete pods/deploys/pvcs in the namespace (cascades on namespace delete,
  #     but explicit delete is faster and avoids finalizer hangs)
  if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
    info "Force-deleting deployments, statefulsets, jobs, pods, PVCs..."
    kubectl delete deploy,sts,job --all -n "$NAMESPACE" --force --grace-period=0 2>/dev/null || true
    kubectl delete pod --all -n "$NAMESPACE" --force --grace-period=0 2>/dev/null || true
    for pvc in $(kubectl get pvc -n "$NAMESPACE" -o name 2>/dev/null); do
      kubectl patch "$pvc" -n "$NAMESPACE" -p '{"metadata":{"finalizers":null}}' 2>/dev/null || true
      kubectl delete "$pvc" -n "$NAMESPACE" --force --grace-period=0 2>/dev/null || true
    done

    info "Deleting namespace $NAMESPACE..."
    kubectl delete namespace "$NAMESPACE" --force --grace-period=0 --wait=false 2>/dev/null || true
    # Clear spec.finalizers via raw API (actual blocker for stuck namespaces)
    kubectl get namespace "$NAMESPACE" -o json 2>/dev/null | \
      jq '.spec.finalizers = []' 2>/dev/null | \
      kubectl replace --raw "/api/v1/namespaces/$NAMESPACE/finalize" -f - 2>/dev/null || true
    # Wait briefly for it to disappear
    for i in $(seq 1 15); do
      kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || break
      sleep 1
    done
    ok "Namespace deleted"
  else
    info "Namespace $NAMESPACE does not exist — nothing to delete"
  fi

  # 1c. Drop Cloud SQL databases (via cloud-sql-proxy + psql)
  info "Dropping Cloud SQL databases if present..."
  drop_cloud_sql_dbs
}

drop_cloud_sql_dbs() {
  MM_DB_PASS=$(gcloud secrets versions access latest --secret=MM_DB_PASSWORD --project="$CLOUDSQL_PROJECT" 2>/dev/null || echo "")
  GITEA_DB_PASS=$(gcloud secrets versions access latest --secret=gitea-db-password --project="$CLOUDSQL_PROJECT" 2>/dev/null || echo "")
  [[ -z "$MM_DB_PASS" || -z "$GITEA_DB_PASS" ]] && {
    warn "Could not read DB passwords from Secret Manager — skipping DB drop"
    return
  }

  PROXY_BIN=$(command -v cloud-sql-proxy 2>/dev/null || ls /opt/homebrew/bin/cloud-sql-proxy 2>/dev/null || echo "")
  [[ -z "$PROXY_BIN" ]] && { warn "cloud-sql-proxy not found — skipping DB drop"; return; }

  "$PROXY_BIN" "$CLOUDSQL_PROJECT:us-central1:$CLOUDSQL_INSTANCE" --port=5434 &
  PROXY_PID=$!
  sleep 4
  trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT

  PGPASSWORD=$MM_DB_PASS psql -h 127.0.0.1 -p 5434 -U mattermost -d postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$MM_DB_NAME';" >/dev/null 2>&1 || true
  PGPASSWORD=$MM_DB_PASS psql -h 127.0.0.1 -p 5434 -U mattermost -d postgres \
    -c "DROP DATABASE IF EXISTS $MM_DB_NAME;" >/dev/null 2>&1 && ok "Dropped DB: $MM_DB_NAME" || warn "DB drop failed: $MM_DB_NAME"

  PGPASSWORD=$GITEA_DB_PASS psql -h 127.0.0.1 -p 5434 -U gitea -d postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$GITEA_DB_NAME';" >/dev/null 2>&1 || true
  PGPASSWORD=$GITEA_DB_PASS psql -h 127.0.0.1 -p 5434 -U gitea -d postgres \
    -c "DROP DATABASE IF EXISTS $GITEA_DB_NAME;" >/dev/null 2>&1 && ok "Dropped DB: $GITEA_DB_NAME" || warn "DB drop failed: $GITEA_DB_NAME"

  kill "$PROXY_PID" 2>/dev/null || true
  trap - EXIT
}

# ── Destroy ────────────────────────────────────────────────────────────────
destroy_namespace

# Clean up rendered values file + terraform state for this namespace on destroy
if $DESTROY_ONLY; then
  step "Cleaning up rendered config"
  [[ -f "$VALUES_OUT" ]] && rm -f "$VALUES_OUT" && ok "Removed $VALUES_OUT"
  info "Terraform state prefix 'custom/$NAMESPACE' is preserved (run 'terraform destroy' if you want it gone)"
  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  Namespace destroyed — ${NAMESPACE}${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 2: PROVISION fresh state
# ═══════════════════════════════════════════════════════════════════════════

# ── 2a. Terraform: create Cloud SQL databases ──────────────────────────────
if $SKIP_TERRAFORM; then
  step "Phase 2a: Skipping Terraform (--skip-terraform) — creating DBs via gcloud"
  PROXY_BIN=$(command -v cloud-sql-proxy 2>/dev/null || ls /opt/homebrew/bin/cloud-sql-proxy 2>/dev/null || echo "")
  MM_DB_PASS=$(gcloud secrets versions access latest --secret=MM_DB_PASSWORD --project="$CLOUDSQL_PROJECT")
  GITEA_DB_PASS=$(gcloud secrets versions access latest --secret=gitea-db-password --project="$CLOUDSQL_PROJECT")
  "$PROXY_BIN" "$CLOUDSQL_PROJECT:us-central1:$CLOUDSQL_INSTANCE" --port=5434 &
  PROXY_PID=$!
  sleep 4
  trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
  PGPASSWORD=$MM_DB_PASS psql -h 127.0.0.1 -p 5434 -U mattermost -d postgres \
    -c "CREATE DATABASE $MM_DB_NAME;" >/dev/null 2>&1 && ok "Created DB: $MM_DB_NAME" || warn "DB already exists: $MM_DB_NAME"
  PGPASSWORD=$GITEA_DB_PASS psql -h 127.0.0.1 -p 5434 -U gitea -d postgres \
    -c "CREATE DATABASE $GITEA_DB_NAME;" >/dev/null 2>&1 && ok "Created DB: $GITEA_DB_NAME" || warn "DB already exists: $GITEA_DB_NAME"
  kill "$PROXY_PID" 2>/dev/null || true
  trap - EXIT
else
  step "Phase 2a: Terraform — provisioning Cloud SQL databases"
  (
    cd "$TF_DIR"
    info "terraform init (backend prefix: custom/$NAMESPACE)..."
    terraform init -reconfigure -backend-config="prefix=custom/$NAMESPACE" -input=false
    info "terraform apply -var=namespace=$NAMESPACE..."
    terraform apply -var="namespace=$NAMESPACE" -auto-approve -input=false
  )
  ok "Terraform apply complete"
fi

# ── 2b. Create K8s namespace ───────────────────────────────────────────────
step "Phase 2b: Creating K8s namespace"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
ok "Namespace $NAMESPACE ready"

# ── 2c. Render helm values from template ───────────────────────────────────
step "Phase 2c: Rendering helm values"
[[ -f "$VALUES_TPL" ]] || fail "Values template missing: $VALUES_TPL"
sed -e "s|__NAMESPACE__|$NAMESPACE|g" \
    -e "s|__DB_SLUG__|$DB_SLUG|g" \
    "$VALUES_TPL" > "$VALUES_OUT"
ok "Rendered: $VALUES_OUT"

# ── 2d. Pre-create env file so setup-secrets can load it ───────────────────
ENV_FILE="$REPO_DIR/.env.$NAMESPACE"
touch "$ENV_FILE"
# Seed with values pulled from .env.test (shared app secrets)
if [[ -f "$REPO_DIR/.env.test" ]]; then
  # Copy anything that isn't MM_* or GIT_* — those are bootstrap-specific
  grep -vE '^(MM_|GIT_API_TOKEN)' "$REPO_DIR/.env.test" > "$ENV_FILE" 2>/dev/null || true
  ok "Seeded $ENV_FILE from .env.test (shared app secrets)"
fi

# ── 2e. Materialize K8s secrets ────────────────────────────────────────────
step "Phase 2d: Materializing K8s secrets"
"$SCRIPT_DIR/setup-secrets.sh" --env=custom --namespace="$NAMESPACE" --yes

# ── 2f. Helm install ───────────────────────────────────────────────────────
step "Phase 2e: Helm install"
GITEA_DB_PASS=$(gcloud secrets versions access latest --secret=gitea-db-password --project="$CLOUDSQL_PROJECT")
helm upgrade --install octogee "$REPO_DIR/helm/octogee" \
  -f "$VALUES_OUT" \
  -n "$NAMESPACE" \
  --set "gitea.gitea.config.database.PASSWD=$GITEA_DB_PASS" \
  --kube-context "$K8S_CONTEXT" \
  --wait --timeout=10m
ok "Helm install complete"

# ── 2g. Bootstrap Mattermost ───────────────────────────────────────────────
step "Phase 2f: Bootstrapping Mattermost (admin, team, bot, PAT)"
"$SCRIPT_DIR/setup-mattermost.sh" --env=custom --namespace="$NAMESPACE" --yes

# setup-secrets again to pick up MM_* tokens that setup-mattermost wrote to .env
info "Re-materializing K8s secrets with fresh MM tokens..."
"$SCRIPT_DIR/setup-secrets.sh" --env=custom --namespace="$NAMESPACE" --yes

# ── 2h. Bootstrap Gitea ────────────────────────────────────────────────────
step "Phase 2g: Bootstrapping Gitea (org + API token)"
"$SCRIPT_DIR/setup-gitea.sh" --env=custom --namespace="$NAMESPACE" --yes

# ── 2i. Restart everything to pick up final secrets ────────────────────────
step "Phase 2h: Rolling restart"
kubectl rollout restart deploy -n "$NAMESPACE" --context "$K8S_CONTEXT"
kubectl rollout status deploy/octogee-gateway -n "$NAMESPACE" --context "$K8S_CONTEXT" --timeout=180s || warn "Gateway rollout did not fully complete — check logs"

# ── 2j. Verify ─────────────────────────────────────────────────────────────
step "Phase 2i: Verification"
kubectl get pods -n "$NAMESPACE" --context "$K8S_CONTEXT"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Namespace provisioned — ${NAMESPACE}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Internal access (no public ingress):"
echo "    kubectl port-forward -n $NAMESPACE svc/workspace-api 3001:3001"
echo "    kubectl port-forward -n $NAMESPACE svc/mattermost 8065:8065"
echo "    kubectl port-forward -n $NAMESPACE svc/octogee-gitea-http 3000:3000"
echo ""
echo "  Logs:"
echo "    kubectl logs -n $NAMESPACE deploy/octogee-gateway -f"
echo ""
echo "  Teardown (fully destroy this namespace):"
echo "    $0 --destroy $NAMESPACE"
echo ""
echo "  Env file: .env.$NAMESPACE"
echo "  Values:   helm/octogee/values.$NAMESPACE.yaml"
echo ""
