#!/usr/bin/env bash
# k8s/monitoring/ files. Fix setup-monitoring.sh first.
# ─────────────────────────────────────────────────────────────────────────────
# setup-monitoring-iap.sh — Expose Grafana at https://monitoring.octogee.com
#                            behind Google IAP
#
# Run once. Safe to re-run (idempotent where possible).
#
# What this does:
#   1. Deploy Prometheus + Grafana (if not already deployed)
#   2. Reserve a static global IP
#   3. Create an OAuth 2.0 client for IAP (manual step — prompts you)
#   4. Create the k8s secret for IAP OAuth credentials
#   5. Apply the Ingress, BackendConfig, ManagedCertificate
#   6. Print the IP to add as a DNS A record in Cloudflare
#   7. Print how to enable IAP + grant access in GCP Console
#
# Usage:
#   ./scripts/setup-monitoring-iap.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Repo root, for referencing helm/monitoring/* manifests (Step 5). Was used
# (line for grafana-ingress.yaml) but never defined → `unbound variable` under
# `set -u`. Same derivation as setup-monitoring.sh.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"

SELECTOR="--environment=prod"
FORWARD_SELECTOR="--env=prod"
for arg in "$@"; do
  case "$arg" in
    --env=*) SELECTOR="--environment=${arg#*=}"; FORWARD_SELECTOR="$arg" ;;
    --target=*) SELECTOR="$arg"; FORWARD_SELECTOR="$arg" ;;
    --help|-h) echo "Usage: $0 [--env=prod|test|build-week | --target=TARGET_ID]"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done
octogee_load_deployment_target "$SELECTOR"

PROJECT="$TARGET_CLUSTER_PROJECT"
REGION="$TARGET_REGION"
CLUSTER="$TARGET_CLUSTER_NAME"
K8S_CONTEXT="$TARGET_KUBE_CONTEXT"
NAMESPACE="monitoring"
DOMAIN="monitoring.octogee.com"
STATIC_IP_NAME="grafana-ip"
SECRET_NAME="grafana-iap-oauth"
ADMIN_EMAIL="cke@spc.com"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${BLUE}[iap-setup]${NC} $*"; }
ok()   { echo -e "${GREEN}[iap-setup]${NC} ✅ $*"; }
warn() { echo -e "${YELLOW}[iap-setup]${NC} ⚠️  $*"; }
fail() { echo -e "${RED}[iap-setup]${NC} ❌ $*"; exit 1; }
step() { echo -e "\n${BOLD}${CYAN}── Step $1: $2${NC}"; }

# ── Preflight ─────────────────────────────────────────────────────────────────
step 0 "Preflight checks"
command -v gcloud >/dev/null || fail "gcloud not found"
command -v kubectl >/dev/null || fail "kubectl not found"
command -v helm >/dev/null || fail "helm not found"

gcloud config set project "$PROJECT" --quiet
gcloud container clusters get-credentials "$CLUSTER" --region "$REGION" --project "$PROJECT" >/dev/null
kubectl config use-context "$K8S_CONTEXT" >/dev/null
[[ "$(kubectl config current-context)" == "$K8S_CONTEXT" ]] || fail "Wrong kubectl context"
log "Project: $PROJECT | Cluster: $CLUSTER | Namespace: $NAMESPACE"

# ── Step 1: Deploy monitoring stack if not present ───────────────────────────
step 1 "Deploy Prometheus + Grafana (if needed)"

if ! helm status grafana -n "$NAMESPACE" &>/dev/null; then
  log "Grafana not deployed — running setup-monitoring.sh..."
  ./scripts/setup-monitoring.sh "$FORWARD_SELECTOR"
  ok "Monitoring stack deployed"
else
  ok "Grafana already deployed — skipping"
fi

# ── Step 2: Reserve static global IP ─────────────────────────────────────────
step 2 "Reserve static global IP"

if gcloud compute addresses describe "$STATIC_IP_NAME" --global --project="$PROJECT" &>/dev/null; then
  ok "Static IP '$STATIC_IP_NAME' already exists"
else
  gcloud compute addresses create "$STATIC_IP_NAME" --global --project="$PROJECT"
  ok "Static IP '$STATIC_IP_NAME' reserved"
fi

STATIC_IP=$(gcloud compute addresses describe "$STATIC_IP_NAME" --global --project="$PROJECT" --format="value(address)")
ok "IP address: ${BOLD}${STATIC_IP}${NC}"

# ── Step 3: OAuth client (manual) ────────────────────────────────────────────
step 3 "Create OAuth 2.0 client for IAP"

echo ""
warn "This step requires manual action in GCP Console."
echo ""
echo "  1. Go to: https://console.cloud.google.com/apis/credentials?project=${PROJECT}"
echo "  2. Click '+ CREATE CREDENTIALS' → 'OAuth client ID'"
echo "  3. Application type: Web application   ·   Name: Grafana IAP"
echo "  4. Click CREATE — leave 'Authorized redirect URIs' EMPTY for now."
echo "       (The IAP redirect URI must contain the client's OWN id, which"
echo "        doesn't exist until the client is created — so add it in step 6.)"
echo "  5. Copy the Client ID + Client Secret from the 'OAuth client created' dialog."
echo "  6. Re-open the client (Edit / pencil) and add exactly ONE Authorized"
echo "     redirect URI, pasting in the Client ID from step 5, then SAVE:"
echo "       https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect"
echo ""
echo "  ⚠️  Have these ready to paste below (from step 5):"
echo "     Client ID:     ___________________________"
echo "     Client Secret: ___________________________"
echo ""
read -r -p "  Enter Client ID: " OAUTH_CLIENT_ID
read -r -p "  Enter Client Secret: " OAUTH_CLIENT_SECRET
echo ""

# ── Step 4: Create k8s secret for IAP OAuth ──────────────────────────────────
step 4 "Create IAP OAuth k8s secret"

kubectl create secret generic "$SECRET_NAME" \
  --namespace="$NAMESPACE" \
  --from-literal=client_id="$OAUTH_CLIENT_ID" \
  --from-literal=client_secret="$OAUTH_CLIENT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

ok "Secret '${SECRET_NAME}' created in namespace '${NAMESPACE}'"

# ── Step 5: Apply Ingress manifests ──────────────────────────────────────────
step 5 "Apply Ingress, BackendConfig, ManagedCertificate"

kubectl apply -f "$REPO_DIR/helm/monitoring/grafana-ingress.yaml"
ok "Ingress manifests applied"

# ── Step 6: DNS instruction ───────────────────────────────────────────────────
step 6 "Configure DNS in Cloudflare"

echo ""
echo "  Add this A record in Cloudflare for octogee.com:"
echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │  Type:    A                                     │"
echo "  │  Name:    monitoring                            │"
echo "  │  Value:   ${STATIC_IP}                          │"
echo "  │  Proxy:   DNS only (grey cloud — NOT proxied)   │"
echo "  │  TTL:     Auto                                  │"
echo "  └─────────────────────────────────────────────────┘"
echo ""
warn "Cloudflare proxy (orange cloud) MUST be disabled for GKE ManagedCertificate to work."
echo ""
read -r -p "  Press Enter once you've added the DNS record..."

# ── Step 7: Enable IAP in GCP Console ────────────────────────────────────────
step 7 "Enable IAP + grant access"

echo ""
warn "Two more manual steps in GCP Console:"
echo ""
echo "  1. Enable IAP on the backend:"
echo "     https://console.cloud.google.com/security/iap?project=${PROJECT}"
echo "     → Find the 'grafana-nodeport' backend (may take 5-10 min to appear after ingress creation)"
echo "     → Toggle IAP ON"
echo "     → Set the OAuth client you just created"
echo ""
echo "  2. Grant access to ${ADMIN_EMAIL}:"
echo "     → Click the 'grafana-nodeport' backend → 'Add Principal'"
echo "     → Principal: ${ADMIN_EMAIL}"
echo "     → Role: IAP-secured Web App User"
echo ""
echo "  Or via gcloud (run after IAP is enabled):"
echo "  gcloud iap web add-iam-policy-binding \\"
echo "    --project=${PROJECT} \\"
echo "    --resource-type=backend-services \\"
echo "    --service=<backend-service-name> \\"
echo "    --member=user:${ADMIN_EMAIL} \\"
echo "    --role=roles/iap.httpsResourceAccessor"
echo ""

# ── Step 8: Wait for cert provisioning ───────────────────────────────────────
step 8 "Monitor certificate provisioning"

echo ""
log "Certificate provisioning takes 10-60 minutes after DNS propagates."
echo ""
echo "  Watch cert status:"
echo "  kubectl get managedcertificate grafana-cert -n ${NAMESPACE} -w"
echo ""
echo "  Watch ingress:"
echo "  kubectl get ingress grafana -n ${NAMESPACE} -w"
echo ""
echo "  Full status check:"
echo "  kubectl describe ingress grafana -n ${NAMESPACE}"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}  Setup complete! Summary:${NC}"
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo "  Static IP:   ${STATIC_IP}"
echo "  Domain:      https://${DOMAIN}"
echo "  Auth:        Google IAP (${ADMIN_EMAIL})"
echo ""
echo "  ⏳ Once DNS propagates + cert provisions (~30 min):"
echo "     https://${DOMAIN} → Google login → Grafana"
echo ""
echo "  Runbook: docs/RUNBOOK.md"
echo ""
