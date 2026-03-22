#!/usr/bin/env bash
# =============================================================================
# verify-env.sh — Octogee Environment Health Check
#
# Usage:
#   ./scripts/verify-env.sh --env=test
#   ./scripts/verify-env.sh --env=prod
#   ./scripts/verify-env.sh --env=test --fix   # print fix commands for failures
#
# Checks (in order):
#   1. kubectl context
#   2. Cloud SQL proxy
#   3. Mattermost
#   4. Gitea
#   5. Gateway
#   6. Firebase Hosting (site)
#   7. Cloud Functions (sample)
#   8. Chat Proxy (Cloud Run)
#
# Exit codes:
#   0 — all green
#   1 — one or more checks failed
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

pass()  { echo -e "  ${GREEN}✅ $1${NC}"; }
fail()  { echo -e "  ${RED}❌ $1${NC}"; FAILURES+=("$1"); }
warn()  { echo -e "  ${YELLOW}⚠️  $1${NC}"; WARNINGS+=("$1"); }
info()  { echo -e "  ${BLUE}ℹ️  $1${NC}"; }
header(){ echo -e "\n${CYAN}── $1 ──────────────────────────────────────────────${NC}"; }

FAILURES=()
WARNINGS=()
FIX=false
ENV=""

for arg in "$@"; do
  case $arg in
    --env=*) ENV="${arg#*=}" ;;
    --fix)   FIX=true ;;
    --help|-h)
      echo "Usage: $0 --env=prod|test [--fix]"
      exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

if [[ -z "$ENV" ]]; then
  echo "Usage: $0 --env=prod|test [--fix]"
  exit 1
fi

# ── Per-env config ────────────────────────────────────────────────────────────
case "$ENV" in
  prod)
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    CLUSTER_NAME="octogee-gateway"
    CLUSTER_PROJECT="octogee"
    NAMESPACE="octogee"
    GCP_PROJECT="octogee"
    FIREBASE_PROJECT="octogee"
    SITE_URL="https://octogee.web.app"
    ENV_LABEL="🔴 PRODUCTION"
    ENV_COLOR="$RED"
    AR_IMAGE_BASE="us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway"
    CF_SAMPLE="admingetdashboard"
    CHAT_PROXY_SERVICE="octogee-chat-proxy"
    ;;
  test)
    K8S_CONTEXT="gke_octogee-test_us-central1_octogee-test"
    CLUSTER_NAME="octogee-test"
    CLUSTER_PROJECT="octogee-test"
    NAMESPACE="octogee-test"
    GCP_PROJECT="octogee-test"
    FIREBASE_PROJECT="octogee-test"
    SITE_URL="https://octogee-test.web.app"
    ENV_LABEL="🟡 TEST"
    ENV_COLOR="$YELLOW"
    AR_IMAGE_BASE="us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway"
    CF_SAMPLE="admingetdashboard"
    CHAT_PROXY_SERVICE="octogee-chat-proxy-test"
    ;;
  *)
    echo "Unknown environment: $ENV (use prod or test)"
    exit 1 ;;
esac

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${ENV_COLOR}════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Octogee Environment Verify — ${ENV_LABEL}${NC}"
echo -e "${ENV_COLOR}════════════════════════════════════════════════════════════${NC}"
echo -e "  Cluster:   ${BOLD}${CLUSTER_NAME}${NC} (${CLUSTER_PROJECT})"
echo -e "  Namespace: ${BOLD}${NAMESPACE}${NC}"
echo -e "  Firebase:  ${BOLD}${FIREBASE_PROJECT}${NC}"
echo -e "  Site:      ${BOLD}${SITE_URL}${NC}"
echo -e "  Time:      $(date '+%Y-%m-%d %H:%M:%S %Z')"

# ── 1. kubectl context ────────────────────────────────────────────────────────
header "1. kubectl Context"
gcloud container clusters get-credentials "$CLUSTER_NAME" \
  --region us-central1 --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT" >/dev/null 2>&1 || true

CURRENT_CTX=$(kubectl config current-context 2>/dev/null || echo "NONE")
if [[ "$CURRENT_CTX" == "$K8S_CONTEXT" ]]; then
  pass "Context: $CURRENT_CTX"
else
  fail "Context mismatch: got '$CURRENT_CTX', expected '$K8S_CONTEXT'"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} kubectl config use-context $K8S_CONTEXT"
  fi
fi

# ── 2. Cloud SQL Proxy ────────────────────────────────────────────────────────
header "2. Cloud SQL Proxy"
PROXY_READY=$(kubectl get deployment cloud-sql-proxy -n "$NAMESPACE" \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
PROXY_IMAGE=$(kubectl get deployment cloud-sql-proxy -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")

if [[ "${PROXY_READY:-0}" -ge 1 ]]; then
  pass "Running (image: $PROXY_IMAGE)"
else
  fail "cloud-sql-proxy not ready (readyReplicas=${PROXY_READY:-0})"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} kubectl apply -f k8s/${NAMESPACE}/cloud-sql-proxy.yaml"
  fi
fi

# ── 3. Mattermost ─────────────────────────────────────────────────────────────
header "3. Mattermost"
MM_READY=$(kubectl get deployment mattermost -n "$NAMESPACE" \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
MM_IMAGE=$(kubectl get deployment mattermost -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")
MM_DATASOURCE=$(kubectl get deployment mattermost -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].args[0]}' 2>/dev/null \
  | grep -o 'cloud-sql-proxy:[0-9]*/[a-z_]*' | head -1 || echo "unknown")

if [[ "${MM_READY:-0}" -ge 1 ]]; then
  pass "Running (image: $MM_IMAGE)"
  info "DB target: $MM_DATASOURCE"
  # Check it's pointing at cloud-sql-proxy, not old in-cluster postgres
  if echo "$MM_DATASOURCE" | grep -q "cloud-sql-proxy"; then
    pass "DB: Cloud SQL ✓"
  else
    warn "DB may not be Cloud SQL — check datasource"
  fi
else
  fail "Mattermost not ready (readyReplicas=${MM_READY:-0})"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-mattermost.sh --env=$ENV --yes"
  fi
fi

# ── 4. Gitea ──────────────────────────────────────────────────────────────────
header "4. Gitea"
# Gitea deployment name varies: "gitea" (standalone) or "octogee-gitea" (Helm umbrella)
GITEA_DEPLOY=$(kubectl get deployment -n "$NAMESPACE" -o name 2>/dev/null | grep gitea | head -1 | sed 's|deployment.apps/||' || echo "")
GITEA_READY=$(kubectl get deployment "$GITEA_DEPLOY" -n "$NAMESPACE" \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
GITEA_IMAGE=$(kubectl get deployment "$GITEA_DEPLOY" -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")
GITEA_CHART=$(helm list -n "$NAMESPACE" -o json 2>/dev/null \
  | python3 -c "import json,sys; charts=[r for r in json.load(sys.stdin) if 'gitea' in r['name']]; print(charts[0]['chart'] if charts else 'not installed')" 2>/dev/null || echo "unknown")

if [[ "${GITEA_READY:-0}" -ge 1 ]]; then
  pass "Running (image: $GITEA_IMAGE, chart: $GITEA_CHART)"
  # Check org exists
  GITEA_TOKEN_B64=$(kubectl get secret gitea-token -n "$NAMESPACE" \
    -o jsonpath='{.data.token}' 2>/dev/null || echo "")
  if [[ -n "$GITEA_TOKEN_B64" ]]; then
    pass "API token secret present"
  else
    warn "gitea-token secret missing — provisioner cannot create repos"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-gitea.sh --env=$ENV"
    fi
  fi
else
  fail "Gitea not ready (readyReplicas=${GITEA_READY:-0})"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-gitea.sh --env=$ENV"
  fi
fi

# ── 5. Gateway ────────────────────────────────────────────────────────────────
header "5. Gateway"
GW_DESIRED=$(kubectl get deployment octogee-gateway -n "$NAMESPACE" \
  -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")
GW_READY=$(kubectl get deployment octogee-gateway -n "$NAMESPACE" \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
GW_IMAGE=$(kubectl get deployment octogee-gateway -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="gateway")].image}' 2>/dev/null || echo "unknown")

# Extract git SHA from image tag if present
GW_SHA=$(echo "$GW_IMAGE" | grep -o ':[a-f0-9]*$' | tr -d ':' || echo "")
LATEST_SHA=$(cd "$REPO_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")

if [[ "${GW_DESIRED:-0}" -eq 0 ]]; then
  fail "Gateway scaled to 0 replicas — not deployed"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-gateway.sh --env=$ENV $(if [[ "$ENV" == "test" ]]; then echo "--yes"; fi)"
  fi
elif [[ "${GW_READY:-0}" -ge 1 ]]; then
  pass "Running ($GW_READY/$GW_DESIRED replicas)"
  info "Image: $GW_IMAGE"
  if [[ -n "$GW_SHA" && "$GW_SHA" == "$LATEST_SHA" ]]; then
    pass "Build: $GW_SHA (matches HEAD ✓)"
  elif [[ -n "$GW_SHA" ]]; then
    warn "Build: $GW_SHA (HEAD is $LATEST_SHA — image may be stale)"
  fi
  # Check for crash loop
  GW_RESTARTS=$(kubectl get pods -n "$NAMESPACE" -l app=octogee-gateway \
    -o jsonpath='{.items[0].status.containerStatuses[?(@.name=="gateway")].restartCount}' \
    2>/dev/null || echo "0")
  if [[ "${GW_RESTARTS:-0}" -gt 5 ]]; then
    warn "Gateway has restarted ${GW_RESTARTS} times — possible crash loop"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} kubectl logs deployment/octogee-gateway -n $NAMESPACE -c gateway --tail=50"
    fi
  else
    pass "Restarts: ${GW_RESTARTS:-0}"
  fi
  # Check openclaw config valid
  CONFIG_ERROR=$(kubectl logs deployment/octogee-gateway -n "$NAMESPACE" -c gateway \
    --tail=30 2>/dev/null | grep -i "invalid\|config invalid\|additionalProperties" | head -1 || echo "")
  if [[ -n "$CONFIG_ERROR" ]]; then
    warn "Config issue detected in logs: $CONFIG_ERROR"
  else
    pass "Config: no errors in recent logs"
  fi
else
  fail "Gateway not ready (readyReplicas=${GW_READY:-0}, desired=${GW_DESIRED:-0})"
  GW_POD_STATUS=$(kubectl get pods -n "$NAMESPACE" -l app=octogee-gateway \
    -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "unknown")
  info "Pod status: $GW_POD_STATUS"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} kubectl logs deployment/octogee-gateway -n $NAMESPACE -c gateway --tail=50"
    echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-gateway.sh --env=$ENV $(if [[ "$ENV" == "test" ]]; then echo "--yes"; fi)"
  fi
fi

# ── 6. Site (Firebase Hosting) ────────────────────────────────────────────────
header "6. Site (Firebase Hosting)"
SITE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$SITE_URL" 2>/dev/null || echo "000")
if [[ "$SITE_STATUS" == "200" ]]; then
  pass "$SITE_URL → HTTP $SITE_STATUS"
else
  fail "$SITE_URL → HTTP $SITE_STATUS (expected 200)"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} cd site && npm run build && firebase deploy --only hosting --project=$FIREBASE_PROJECT"
  fi
fi

# Check deployed functions count
header "7. Cloud Functions"
CF_COUNT=$(gcloud run services list --project="$GCP_PROJECT" \
  --region=us-central1 --format="value(name)" 2>/dev/null | wc -l | tr -d ' ' || echo "0")
CF_SAMPLE_STATUS=$(gcloud run services describe "$CF_SAMPLE" \
  --project="$GCP_PROJECT" --region=us-central1 \
  --format="value(status.conditions[0].status)" 2>/dev/null || echo "Unknown")

if [[ "$CF_COUNT" -ge 30 ]]; then
  pass "$CF_COUNT Cloud Run services deployed"
else
  warn "Only $CF_COUNT Cloud Run services found (expected ~43)"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} cd functions && npm run build && firebase deploy --only functions --project=$FIREBASE_PROJECT"
  fi
fi

if [[ "$CF_SAMPLE_STATUS" == "True" ]]; then
  pass "$CF_SAMPLE: ready"
else
  warn "$CF_SAMPLE: status=$CF_SAMPLE_STATUS"
fi

# ── 8. Chat Proxy ─────────────────────────────────────────────────────────────
header "8. Chat Proxy (Cloud Run)"
PROXY_STATUS=$(gcloud run services describe "$CHAT_PROXY_SERVICE" \
  --project="$GCP_PROJECT" --region=us-central1 \
  --format="value(status.conditions[0].status)" 2>/dev/null || echo "NotFound")
PROXY_URL=$(gcloud run services describe "$CHAT_PROXY_SERVICE" \
  --project="$GCP_PROJECT" --region=us-central1 \
  --format="value(status.url)" 2>/dev/null || echo "")
PROXY_IMAGE_TAG=$(gcloud run services describe "$CHAT_PROXY_SERVICE" \
  --project="$GCP_PROJECT" --region=us-central1 \
  --format="value(spec.template.spec.containers[0].image)" 2>/dev/null \
  | grep -o ':[^:]*$' | tr -d ':' || echo "unknown")

if [[ "$PROXY_STATUS" == "True" ]]; then
  pass "$CHAT_PROXY_SERVICE: ready"
  info "URL: $PROXY_URL"
  info "Image: $PROXY_IMAGE_TAG"
else
  fail "$CHAT_PROXY_SERVICE: status=$PROXY_STATUS"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-chat-proxy.sh --env=$ENV"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${ENV_COLOR}════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Summary — ${ENV_LABEL}${NC}"
echo -e "${ENV_COLOR}════════════════════════════════════════════════════════════${NC}"

if [[ ${#FAILURES[@]} -eq 0 && ${#WARNINGS[@]} -eq 0 ]]; then
  echo -e "\n  ${GREEN}${BOLD}🎉 ALL GREEN — Environment is healthy${NC}\n"
  exit 0
fi

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  echo -e "\n  ${YELLOW}⚠️  Warnings (${#WARNINGS[@]}):${NC}"
  for w in "${WARNINGS[@]}"; do
    echo -e "    - $w"
  done
fi

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo -e "\n  ${RED}❌ Failures (${#FAILURES[@]}):${NC}"
  for f in "${FAILURES[@]}"; do
    echo -e "    - $f"
  done
  echo ""
  if ! $FIX; then
    echo -e "  ${YELLOW}Run with --fix to see remediation commands.${NC}"
  fi
  echo ""
  exit 1
fi

echo ""
exit 0
