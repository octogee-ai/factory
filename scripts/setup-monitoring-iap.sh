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

PROJECT="octogee"
REGION="us-central1"
CLUSTER="octogee-gateway"
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
kubectl config use-context "$(kubectl config get-contexts -o name | grep "$CLUSTER" | head -1)" 2>/dev/null || true
log "Project: $PROJECT | Cluster: $CLUSTER | Namespace: $NAMESPACE"

# ── Step 1: Deploy monitoring stack if not present ───────────────────────────
step 1 "Deploy Prometheus + Grafana (if needed)"

if ! helm status grafana -n "$NAMESPACE" &>/dev/null; then
  log "Grafana not deployed — running setup-monitoring.sh..."
  ./scripts/setup-monitoring.sh --env=prod
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
echo "  3. Application type: Web application"
echo "  4. Name: Grafana IAP"
echo "  5. Authorized redirect URIs: add BOTH of these:"
echo "     https://iap.googleapis.com/v1/oauth/clientIds/<YOUR_CLIENT_ID>:handleRedirect"
echo "     (GCP will tell you the client ID after creation)"
echo ""
echo "  ⚠️  After creating, note down:"
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
echo "  Runbook: docs/GKE-RUNBOOK.md"
echo ""
