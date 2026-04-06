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
#   3. Mattermost infra + bootstrap secret completeness
#   4. Gitea infra + token secret presence
#   5. Gateway
#   5b. Ingress / endpoint health
#   6. Firebase Hosting (site)
#   7. Cloud Functions / supporting services
#   8. chat-proxy deployment + route health
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
fail()  {
  local msg="$1"
  echo -e "  ${RED}❌ $msg${NC}"
  FAILURES+=("$msg")
  case "$CONTEXT_SECTION" in
    infra) INFRA_FAILS=$((INFRA_FAILS + 1)) ;;
    secrets) SECRET_FAILS=$((SECRET_FAILS + 1)) ;;
    bootstrap) BOOTSTRAP_FAILS=$((BOOTSTRAP_FAILS + 1)) ;;
  esac
}
warn()  { echo -e "  ${YELLOW}⚠️  $1${NC}"; WARNINGS+=("$1"); }
info()  { echo -e "  ${BLUE}ℹ️  $1${NC}"; }
header(){ echo -e "\n${CYAN}── $1 ──────────────────────────────────────────────${NC}"; }
status(){
  local okmsg="$1"; local badmsg="$2"; local value="$3"
  if [[ -n "$value" ]]; then
    pass "$okmsg"
  else
    fail "$badmsg"
  fi
}
set_section(){ CONTEXT_SECTION="$1"; }

FAILURES=()
WARNINGS=()
FIX=false
ENV=""
INFRA_FAILS=0
SECRET_FAILS=0
BOOTSTRAP_FAILS=0
CONTEXT_SECTION=""

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
    CF_SAMPLE="onSignup"
    ;;
  test)
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    CLUSTER_NAME="octogee-gateway"
    CLUSTER_PROJECT="octogee"
    NAMESPACE="octogee-test"
    GCP_PROJECT="octogee-test"
    FIREBASE_PROJECT="octogee-test"
    SITE_URL="https://octogee-test.web.app"
    ENV_LABEL="🟡 TEST"
    ENV_COLOR="$YELLOW"
    AR_IMAGE_BASE="us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway"
    CF_SAMPLE="onSignup"
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
set_section infra
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
set_section infra
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
    echo -e "  ${YELLOW}FIX:${NC} helm upgrade --install octogee helm/octogee -f helm/octogee/values.${ENV}.yaml -n ${NAMESPACE} --kube-context ${K8S_CONTEXT}"
  fi
fi

# ── 3. Mattermost ─────────────────────────────────────────────────────────────
set_section infra
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

  set_section secrets
  MM_ADMIN_USER=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.admin_user}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  MM_ADMIN_PASS=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.admin_pass}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  MM_ADMIN_TOKEN=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.admin_token}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  MM_ADMIN_USER_ID=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.admin_user_id}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  MM_BOT_TOKEN=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.bot_token}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  MM_BOT_USER_ID=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.bot_user_id}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  MM_TEAM_ID=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.team_id}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  INTERNAL_SERVICE_KEY=$(kubectl get secret internal-service-key -n "$NAMESPACE" -o jsonpath='{.data.key}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  GITEA_TOKEN=$(kubectl get secret gitea-token -n "$NAMESPACE" -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || echo "")

  status "mattermost-gateway admin_user present" "mattermost-gateway admin_user missing" "$MM_ADMIN_USER"
  status "mattermost-gateway admin_pass present" "mattermost-gateway admin_pass missing" "$MM_ADMIN_PASS"
  status "mattermost-gateway admin_token present" "mattermost-gateway admin_token missing (workspace-api /admin-token will fail)" "$MM_ADMIN_TOKEN"
  status "mattermost-gateway admin_user_id present" "mattermost-gateway admin_user_id missing" "$MM_ADMIN_USER_ID"
  status "mattermost-gateway bot_token present" "mattermost-gateway bot_token missing (chat-proxy will fail)" "$MM_BOT_TOKEN"
  status "mattermost-gateway bot_user_id present" "mattermost-gateway bot_user_id missing" "$MM_BOT_USER_ID"
  status "mattermost-gateway team_id present" "mattermost-gateway team_id missing" "$MM_TEAM_ID"
  status "internal-service-key present" "internal-service-key missing" "$INTERNAL_SERVICE_KEY"
  status "gitea-token present" "gitea-token missing" "$GITEA_TOKEN"
  set_section bootstrap
else
  fail "Mattermost not ready (readyReplicas=${MM_READY:-0})"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-mattermost.sh --env=$ENV $(if [[ "$ENV" == "test" ]]; then echo "--yes"; fi)"
  fi
fi

# ── 4. Gitea ──────────────────────────────────────────────────────────────────
set_section infra
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
  GITEA_TOKEN_B64=$(kubectl get secret gitea-token -n "$NAMESPACE" \
    -o jsonpath='{.data.token}' 2>/dev/null || echo "")
  if [[ -n "$GITEA_TOKEN_B64" ]]; then
    pass "API token secret present"

    set_section bootstrap
    GITEA_SVC=$(kubectl get svc -n "$NAMESPACE" -o name 2>/dev/null | grep gitea-http | head -1 | sed 's|service/||' || echo "octogee-gitea-http")
    GITEA_ORG_CHECK=$(kubectl exec deployment/octogee-gateway -n "$NAMESPACE" -c gateway -- \
      node -e "const h=require('http');const t=process.env.GIT_API_TOKEN||'';const o={hostname:'$GITEA_SVC.$NAMESPACE.svc.cluster.local',port:3000,path:'/api/v1/orgs/octogee',headers:{Authorization:'token '+t}};h.get(o,r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" \
      >/dev/null 2>&1 && echo ok || echo "")
    status "Gitea org/API trust check passed from gateway pod" "Gitea org/API trust check failed from gateway pod" "$GITEA_ORG_CHECK"
    set_section infra
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
set_section infra
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
    --tail=30 2>/dev/null | grep -i "config invalid\|additionalProperties\|openclaw.json" | \
    grep -v "onnxruntime\|pthread\|affinity" | head -1 || echo "")
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

# ── 5b. GKE Ingresses ─────────────────────────────────────────────────────────
set_section infra
header "5b. Ingresses"
INGRESSES=$(kubectl --context "$K8S_CONTEXT" get ingress -n "$NAMESPACE" -o json 2>/dev/null)
if [[ -z "$INGRESSES" || "$INGRESSES" == "null" ]]; then
  warn "No ingresses found"
else
  for ING_NAME in $(echo "$INGRESSES" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i['metadata']['name']) for i in d.get('items',[])]" 2>/dev/null); do
    ING_IP=$(echo "$INGRESSES" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i.get('status',{}).get('loadBalancer',{}).get('ingress',[{}])[0].get('ip','')) for i in d.get('items',[]) if i['metadata']['name']=='$ING_NAME']" 2>/dev/null)
    ING_HOST=$(echo "$INGRESSES" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i['spec']['rules'][0]['host']) for i in d.get('items',[]) if i['metadata']['name']=='$ING_NAME']" 2>/dev/null)
    if [[ -n "$ING_IP" && "$ING_IP" != "None" ]]; then
      pass "$ING_NAME → $ING_HOST ($ING_IP)"
    else
      fail "$ING_NAME → $ING_HOST has NO ADDRESS"
      if $FIX; then
        echo -e "  ${YELLOW}FIX:${NC} Verify annotation kubernetes.io/ingress.class: gce exists on ingress"
        echo -e "  ${YELLOW}     ${NC} kubectl annotate ingress $ING_NAME -n $NAMESPACE kubernetes.io/ingress.class=gce"
      fi
    fi
  done
fi

# ── 5c. Managed Certificates ─────────────────────────────────────────────────
set_section infra
header "5c. Managed Certificates"
CERTS=$(kubectl --context "$K8S_CONTEXT" get managedcertificate -n "$NAMESPACE" -o json 2>/dev/null)
if [[ -z "$CERTS" || "$CERTS" == "null" ]]; then
  warn "No managed certificates found"
else
  for CERT_NAME in $(echo "$CERTS" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i['metadata']['name']) for i in d.get('items',[])]" 2>/dev/null); do
    CERT_STATUS=$(echo "$CERTS" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i.get('status',{}).get('certificateStatus','Unknown')) for i in d.get('items',[]) if i['metadata']['name']=='$CERT_NAME']" 2>/dev/null)
    CERT_DOMAIN=$(echo "$CERTS" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i['spec']['domains'][0]) for i in d.get('items',[]) if i['metadata']['name']=='$CERT_NAME']" 2>/dev/null)
    if [[ "$CERT_STATUS" == "Active" ]]; then
      pass "$CERT_NAME ($CERT_DOMAIN): Active"
    elif [[ "$CERT_STATUS" == "Provisioning" ]]; then
      warn "$CERT_NAME ($CERT_DOMAIN): Provisioning (may take 15-30 min)"
    else
      fail "$CERT_NAME ($CERT_DOMAIN): $CERT_STATUS"
      if $FIX; then
        echo -e "  ${YELLOW}FIX:${NC} Delete and recreate: kubectl delete managedcertificate $CERT_NAME -n $NAMESPACE"
        echo -e "  ${YELLOW}     ${NC} Then: helm upgrade --install octogee helm/octogee -f helm/octogee/values.${ENV}.yaml -n $NAMESPACE"
      fi
    fi
  done
fi

# ── 5d. Endpoint Health (HTTPS) ──────────────────────────────────────────────
# Derive URLs from K8s Ingress resources — no hardcoded env-specific URLs.
set_section bootstrap
header "5d. Endpoint Health"
for INGRESS_NAME in workspace-api-ingress chat-proxy-ingress; do
  HOST=$(kubectl get ingress "$INGRESS_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || echo "")
  if [[ -z "$HOST" ]]; then
    warn "$INGRESS_NAME — no host found"
    continue
  fi
  # Read health path from the readinessProbe of the matching deployment
  DEPLOY_NAME="${INGRESS_NAME%-ingress}"
  HEALTH_PATH=$(kubectl get deployment "$DEPLOY_NAME" -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.httpGet.path}' 2>/dev/null || echo "/health")
  URL="https://${HOST}${HEALTH_PATH}"
  HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "$URL" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    pass "$URL → $HTTP_CODE"
  elif [[ "$HTTP_CODE" == "000" ]]; then
    warn "$URL → unreachable (TLS or DNS issue)"
  else
    warn "$URL → HTTP $HTTP_CODE"
  fi
done

# ── 6. Site (Firebase Hosting) ────────────────────────────────────────────────
set_section infra
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

# Check deployed functions count (post-CF migration: only Firestore triggers remain, ~15 expected)
set_section infra
header "7. Cloud Functions"
CF_COUNT=$(gcloud run services list --project="$GCP_PROJECT" \
  --region=us-central1 --format="value(name)" 2>/dev/null | wc -l | tr -d ' ' || echo "0")

if [[ "$CF_COUNT" -ge 10 ]]; then
  pass "$CF_COUNT Cloud Run services deployed"
else
  warn "Only $CF_COUNT Cloud Run services found (expected ~15 Firestore triggers)"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} cd functions && npm run build && firebase deploy --only functions --project=$FIREBASE_PROJECT"
  fi
fi

# ── 8. Chat Proxy ─────────────────────────────────────────────────────────────
set_section infra
header "8. chat-proxy"
CHAT_DEPLOY_READY=$(kubectl get deployment chat-proxy -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
CHAT_IMAGE=$(kubectl get deployment chat-proxy -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")
CHAT_ENDPOINTS=$(kubectl get endpoints chat-proxy -n "$NAMESPACE" -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null || echo "")

if [[ "${CHAT_DEPLOY_READY:-0}" -ge 1 ]]; then
  pass "chat-proxy deployment ready (image: $CHAT_IMAGE)"
  status "chat-proxy service has endpoints" "chat-proxy service has no ready endpoints" "$CHAT_ENDPOINTS"
else
  fail "chat-proxy deployment not ready (readyReplicas=${CHAT_DEPLOY_READY:-0})"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} helm upgrade --install octogee helm/octogee -f helm/octogee/values.${ENV}.yaml -n ${NAMESPACE} --kube-context ${K8S_CONTEXT}"
  fi
fi

# Derive chat-proxy health URL from Ingress host + readinessProbe path
CHAT_HOST=$(kubectl get ingress chat-proxy-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || echo "")
CHAT_HEALTH_PATH=$(kubectl get deployment chat-proxy -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.httpGet.path}' 2>/dev/null || echo "/healthz")
if [[ -n "$CHAT_HOST" ]]; then
  CHAT_HEALTH_URL="https://${CHAT_HOST}${CHAT_HEALTH_PATH}"
  CHAT_HEALTH_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "$CHAT_HEALTH_URL" 2>/dev/null || echo "000")
  if [[ "$CHAT_HEALTH_CODE" == "200" ]]; then
    pass "$CHAT_HEALTH_URL → $CHAT_HEALTH_CODE"
  else
    warn "$CHAT_HEALTH_URL → HTTP $CHAT_HEALTH_CODE"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} kubectl logs -n $NAMESPACE deployment/chat-proxy --since=30m | tail -100"
    fi
  fi
fi

set_section bootstrap
LEGACY_MM_TEAM=$(kubectl get deployment chat-proxy -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="MM_TEAM_ID")].value}' 2>/dev/null || echo "")
MM_COMMUNITY_TEAM=$(kubectl get deployment chat-proxy -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="MM_COMMUNITY_TEAM_ID")].value}' 2>/dev/null || echo "")
if [[ -n "$LEGACY_MM_TEAM" ]]; then
  warn "chat-proxy still carries dead MM_TEAM_ID env config. Remove it; MM_COMMUNITY_TEAM_ID is the only valid team env now."
fi
if [[ -n "$MM_COMMUNITY_TEAM" ]]; then
  pass "chat-proxy uses MM_COMMUNITY_TEAM_ID (expected)"
fi
set_section infra

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${ENV_COLOR}════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Summary — ${ENV_LABEL}${NC}"
echo -e "${ENV_COLOR}════════════════════════════════════════════════════════════${NC}"

echo ""
echo -e "  ${BOLD}State buckets:${NC}"
if [[ $INFRA_FAILS -eq 0 ]]; then
  echo -e "    ${GREEN}✓ Infra state healthy${NC}"
else
  echo -e "    ${RED}✗ Infra state has $INFRA_FAILS failure(s)${NC}"
fi
if [[ $SECRET_FAILS -eq 0 ]]; then
  echo -e "    ${GREEN}✓ Secret state healthy${NC}"
else
  echo -e "    ${RED}✗ Secret state has $SECRET_FAILS failure(s)${NC}"
fi
if [[ $BOOTSTRAP_FAILS -eq 0 ]]; then
  echo -e "    ${GREEN}✓ Bootstrap state healthy${NC}"
else
  echo -e "    ${RED}✗ Bootstrap state has $BOOTSTRAP_FAILS failure(s)${NC}"
fi

if [[ ${#FAILURES[@]} -eq 0 && ${#WARNINGS[@]} -eq 0 ]]; then
  echo -e "\n  ${GREEN}${BOLD}🎉 ALL GREEN — Environment is healthy${NC}"
  echo -e "  ${GREEN}Verdict: safe to deploy / promote.${NC}\n"
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
  if [[ $INFRA_FAILS -gt 0 ]]; then
    echo -e "  ${RED}Verdict: infra is not healthy. Repair before deploy/promotion.${NC}"
  elif [[ $SECRET_FAILS -gt 0 ]]; then
    echo -e "  ${YELLOW}Verdict: infra may be up, but secret state is broken. Repair secrets/bootstrap before trusting the environment.${NC}"
  elif [[ $BOOTSTRAP_FAILS -gt 0 ]]; then
    echo -e "  ${YELLOW}Verdict: infra/secrets may be mostly up, but app bootstrap state is not trustworthy. Repair before promotion.${NC}"
  fi

  if ! $FIX; then
    echo -e "  ${YELLOW}Run with --fix to see remediation commands.${NC}"
  fi
  echo ""
  exit 1
fi

echo -e "\n  ${YELLOW}Verdict: usable with warnings, but do not promote blindly.${NC}\n"
exit 0
