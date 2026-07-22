#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Gitea Reconcile — env/creds runner for ops/reconcile-gitea-org.ts
# ═══════════════════════════════════════════════════════════════════════════
#
# The PLANNING is in the tested TypeScript tool — this script owns ONLY the
# cluster wiring it needs:
#
#   • kubectl context + Gitea readiness        (same idioms as setup-gitea.sh)
#   • port-forward Gitea → localhost:13000
#   • GITEA_ADMIN_TOKEN  ← existing `gitea-token` K8s secret (NOT minted here;
#                           run ./scripts/setup-gitea.sh --env=$ENV if absent)
#   • Firestore ADC for the env's Firebase project
#   • invoke `npx tsx ops/reconcile-gitea-org.ts --env=$ENV --slug=$SLUG …`
#
# It does NOT bootstrap Gitea, rotate tokens, or create orgs (that is
# setup-gitea.sh's job) and it does NOT restart gateways (you drive that —
# the tool prints the exact command on success).
#
# Lossless + non-destructive + idempotent + resumable: the tool only
# ensure-org / transfer-repo / rename-repo / firestore-repoint, Firestore
# LAST, and self-verifies (re-plan must be empty). Re-runnable any time.
# Spec: docs/specs/GITEA-PER-WORKSPACE-ORGS-SPEC.md (AD6).
#
# Usage:
#   # TEST dress rehearsal (Bender-cutover proof) — dry-run first, ALWAYS:
#   ./scripts/ops/reconcile-gitea-org.sh --env=test --slug=tester90
#   ./scripts/ops/reconcile-gitea-org.sh --env=test --slug=tester90 --apply
#
#   # PROD cutover for the two F&F/legacy users (dry-run, review, then apply):
#   ./scripts/ops/reconcile-gitea-org.sh --env=prod --slug=bender,<other>
#   ./scripts/ops/reconcile-gitea-org.sh --env=prod --slug=bender,<other> --apply
#
#   --slug accepts a comma-list or repeated --slug=… (each reconciled in turn;
#   a failure stops the run — no half-migrating the next customer).
#   --apply on PROD requires a typed confirmation unless --yes is given.
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"          # …/scripts/ops
SCRIPTS_DIR="$(dirname "$SCRIPT_DIR")"               # …/scripts
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPTS_DIR/lib/deployment-target.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }

SELECTOR=""; SLUGS_RAW=""; APPLY=false; YES=false
for arg in "$@"; do
  case $arg in
    --env=*)  SELECTOR="--environment=${arg#*=}" ;;
    --target=*) SELECTOR="$arg" ;;
    --slug=*) SLUGS_RAW="${SLUGS_RAW:+$SLUGS_RAW,}${arg#*=}" ;;
    --apply)  APPLY=true ;;
    --yes|-y) YES=true ;;
    --help|-h)
      echo "Usage: $0 (--env=prod|test | --target=TARGET_ID) --slug=a[,b] [--apply] [--yes]"
      exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done
[[ -n "$SELECTOR"  ]] || fail "Usage: $0 (--env=prod|test | --target=TARGET_ID) --slug=a[,b] [--apply] [--yes]"
[[ -n "$SLUGS_RAW" ]] || fail "Usage: $0 --env=prod|test --slug=a[,b] [--apply] [--yes]"

octogee_load_deployment_target "$SELECTOR"
ENV="$TARGET_ENVIRONMENT"
K8S_NAMESPACE="$TARGET_NAMESPACE"
FIREBASE_PROJECT="$TARGET_FIREBASE_PROJECT"
CLUSTER_PROJECT="$TARGET_CLUSTER_PROJECT"
CLUSTER_NAME="$TARGET_CLUSTER_NAME"
K8S_CONTEXT="$TARGET_KUBE_CONTEXT"
REGION="$TARGET_REGION"
case "$ENV" in
  prod) ENV_LABEL="🔴 PRODUCTION" ;;
  test) ENV_LABEL="🟡 TEST" ;;
  *) fail "reconcile-gitea-org supports prod and test targets" ;;
esac
GITEA_SVC="octogee-gitea-http"

IFS=',' read -r -a SLUGS <<< "$SLUGS_RAW"

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Gitea Reconcile — ${ENV_LABEL}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "  slugs: ${BOLD}${SLUGS[*]}${NC}   mode: $([[ "$APPLY" == true ]] && echo -e "${RED}--apply${NC}" || echo -e "${GREEN}dry-run${NC}")"
echo ""

# ── PROD --apply safety gate ──────────────────────────────────────────────
if [[ "$ENV" == "prod" && "$APPLY" == true && "$YES" != true ]]; then
  warn "About to MUTATE production Gitea + Firestore for: ${SLUGS[*]}"
  warn "Run a dry-run first and confirm the plan. The reconcile is lossless,"
  warn "but this is the real cutover."
  read -r -p "  Type 'reconcile prod' to proceed: " CONFIRM
  [[ "$CONFIRM" == "reconcile prod" ]] || fail "Aborted (no confirmation)."
fi

# ── 0. kubectl context ────────────────────────────────────────────────────
info "Setting kubectl context: $K8S_CONTEXT"
gcloud container clusters get-credentials "$CLUSTER_NAME" \
  --region "$REGION" --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT" >/dev/null
CURRENT_CTX=$(kubectl config current-context)
[[ "$CURRENT_CTX" == "$K8S_CONTEXT" ]] || fail "kubectl context mismatch: '$CURRENT_CTX'"
ok "kubectl context: $CURRENT_CTX  (ns: $K8S_NAMESPACE)"

# ── 1. Firestore ADC for this env's Firebase project ──────────────────────
info "Ensuring Firestore Application Default Credentials ($FIREBASE_PROJECT)..."
gcloud auth application-default print-access-token >/dev/null 2>&1 \
  || gcloud auth application-default login
gcloud auth application-default set-quota-project "$FIREBASE_PROJECT" >/dev/null 2>&1 || true
ok "ADC present (quota project: $FIREBASE_PROJECT)"

# ── 2. Gitea ready ────────────────────────────────────────────────────────
kubectl get deployment -n "$K8S_NAMESPACE" -l "app.kubernetes.io/name=gitea" >/dev/null 2>&1 \
  || fail "Gitea not deployed in $K8S_NAMESPACE (Helm owns infra; deploy first)."
kubectl wait --for=condition=available deployment -l "app.kubernetes.io/name=gitea" \
  -n "$K8S_NAMESPACE" --timeout=120s >/dev/null 2>&1 || fail "Gitea not ready after 120s"
ok "Gitea deployment ready"

# ── 3. Port-forward Gitea → localhost:13000 ───────────────────────────────
info "Port-forwarding Gitea (localhost:13000)..."
pkill -f "port-forward svc/$GITEA_SVC" 2>/dev/null || true
sleep 1
kubectl port-forward "svc/$GITEA_SVC" -n "$K8S_NAMESPACE" 13000:3000 >/tmp/gitea-pf.log 2>&1 &
PF_PID=$!
trap 'kill $PF_PID 2>/dev/null || true' EXIT
GITEA_READY=false
for attempt in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    "http://localhost:13000/api/v1/settings/api" 2>/dev/null || echo "000")
  [[ "$STATUS" == "200" || "$STATUS" == "403" ]] && { GITEA_READY=true; break; }
  sleep 3
  info "  Waiting for Gitea HTTP (attempt $attempt/20, status=$STATUS)..."
done
$GITEA_READY || fail "Gitea HTTP not responding after 60s (see /tmp/gitea-pf.log)"
ok "Gitea HTTP ready (status=$STATUS)"

# ── 4. GITEA_ADMIN_TOKEN ← existing gitea-token secret (not minted here) ──
GITEA_ADMIN_TOKEN=$(kubectl get secret gitea-token -n "$K8S_NAMESPACE" \
  -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
[[ -n "$GITEA_ADMIN_TOKEN" ]] \
  || fail "gitea-token/token absent in $K8S_NAMESPACE — run ./scripts/setup-gitea.sh --env=$ENV first."
WHO=$(curl -s -H "Authorization: token $GITEA_ADMIN_TOKEN" \
  "http://localhost:13000/api/v1/user" 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('login',''))" 2>/dev/null || echo "")
[[ "$WHO" == "octogee-admin" ]] \
  || fail "gitea-token invalid (login='$WHO') — rotate via ./scripts/setup-gitea.sh --env=$ENV."
ok "Gitea admin token valid (octogee-admin)"

export GITEA_API_URL="http://localhost:13000/api/v1"
export GITEA_ADMIN_TOKEN
export K8S_NAMESPACE
export DEPLOYMENT_TARGET_ID="$TARGET_ID"

# ── 5. Run the tested reconcile tool, per slug ────────────────────────────
TOOL_ARGS=""
[[ "$APPLY" == true ]] && TOOL_ARGS="--apply"
cd "$SCRIPTS_DIR"
for slug in "${SLUGS[@]}"; do
  echo ""
  echo -e "${CYAN}── reconcile: $slug ($ENV) ──────────────────────────────${NC}"
  # The tool prints the ordered plan, refuses --apply if problems[], applies
  # in fixed order (Firestore LAST), then self-verifies (re-plan == empty).
  npx tsx ops/reconcile-gitea-org.ts --env="$ENV" --slug="$slug" $TOOL_ARGS
done

echo ""
if [[ "$APPLY" == true ]]; then
  echo -e "${GREEN}${BOLD}✓ Reconcile applied + self-verified for: ${SLUGS[*]}${NC}"
  echo "  Next (you drive — don't let automation race kubectl):"
  echo "   1) restart each customer's gateway so #970 self-heals ws-<slug>/team/membership:"
  echo "        kubectl --context $K8S_CONTEXT -n $K8S_NAMESPACE rollout restart deploy/octogee-gateway-default"
  echo "      (dedicated-gateway customers: restart octogee-gateway-<instance> instead —"
  echo "       check provisioning.openclaw.gatewayId for the slug)"
  echo "   2) re-run this script in dry-run mode → expect 'already reconciled — no actions' (idempotent proof)"
  echo "   3) smoke each workspace (repo now at <slug>/workspace; project repos at <slug>/<projectSlug>)"
else
  echo -e "${YELLOW}DRY RUN only — nothing mutated.${NC} Review the plan(s) above."
  echo "  To execute:  $0 --env=$ENV --slug=$SLUGS_RAW --apply"
fi
echo ""
