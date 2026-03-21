#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-gitea.sh — Deploy Gitea to GKE via Helm
#
# Usage:
#   ./scripts/setup-gitea.sh --env=prod
#   ./scripts/setup-gitea.sh --env=test
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT="octogee"          # GCP project for secrets + Cloud SQL (always octogee)
CLUSTER="octogee-gateway"  # overridden per-env below
REGION="us-central1"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${BLUE}[gitea]${NC} $*"; }
ok()   { echo -e "${GREEN}[gitea]${NC} ✅ $*"; }
warn() { echo -e "${YELLOW}[gitea]${NC} ⚠️  $*"; }
fail() { echo -e "\033[0;31m[gitea]${NC} ❌ $*"; exit 1; }

ENV=""
for arg in "$@"; do
  case $arg in
    --env=*) ENV="${arg#*=}" ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done
[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test"; exit 1; }

case "$ENV" in
  prod)
    NAMESPACE="octogee"
    VALUES_EXTRA=""
    GITEA_DOMAIN="git.octogee.com"
    DB_NAME="gitea_prod"
    CLUSTER_PROJECT="octogee"
    ;;
  test)
    NAMESPACE="octogee-test"
    VALUES_EXTRA="-f infra/helm/gitea-values.test.yaml"
    GITEA_DOMAIN="git-test.octogee.com"
    DB_NAME="gitea_test"
    CLUSTER="octogee-test"
    CLUSTER_PROJECT="octogee-test"
    ;;
  *) fail "Unknown environment: $ENV" ;;
esac

# ── Preflight ─────────────────────────────────────────────────────────────────
log "Preflight checks..."
command -v helm >/dev/null || fail "helm not found"
command -v kubectl >/dev/null || fail "kubectl not found"

gcloud container clusters get-credentials "$CLUSTER" --region "$REGION" --project "$CLUSTER_PROJECT"

# ── Helm repo ─────────────────────────────────────────────────────────────────
log "Adding Gitea Helm repo..."
helm repo add gitea-charts https://dl.gitea.com/charts/ 2>/dev/null || true
helm repo update gitea-charts
ok "Repo ready"

# ── Read secrets from Secret Manager ─────────────────────────────────────────
log "Reading credentials from Secret Manager..."
# Use separate secrets per env — prevents cross-env password clobbering
GITEA_DB_SECRET="gitea-db-password"
[[ "$ENV" == "test" ]] && GITEA_DB_SECRET="gitea-db-password-test"

GITEA_DB_PASS=$(gcloud secrets versions access latest \
  --secret="$GITEA_DB_SECRET" --project="$PROJECT" 2>/dev/null || echo "")
CLOUD_SQL_CONN=$(gcloud secrets versions access latest \
  --secret=cloud-sql-connection-name --project="$PROJECT" 2>/dev/null || echo "")

[[ -z "$GITEA_DB_PASS" ]] && fail "$GITEA_DB_SECRET secret not found. Run setup-cloud-sql.sh first."
[[ -z "$CLOUD_SQL_CONN" ]] && fail "cloud-sql-connection-name secret not found. Run setup-cloud-sql.sh first."

# ── Create k8s secrets ───────────────────────────────────────────────────────
log "Creating Kubernetes secrets..."
GITEA_ADMIN_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
GITEA_SECRET_KEY=$(openssl rand -hex 32)
GITEA_INTERNAL_TOKEN=$(openssl rand -hex 64)

kubectl create secret generic gitea-credentials \
  --namespace="$NAMESPACE" \
  --from-literal=admin-password="$GITEA_ADMIN_PASS" \
  --from-literal=db-password="$GITEA_DB_PASS" \
  --from-literal=secret-key="$GITEA_SECRET_KEY" \
  --from-literal=internal-token="$GITEA_INTERNAL_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -
ok "Secrets created/updated"

# Store admin password in Secret Manager too
echo -n "$GITEA_ADMIN_PASS" | gcloud secrets versions add "gitea-admin-password-${ENV}" \
  --data-file=- --project="$PROJECT" 2>/dev/null || \
echo -n "$GITEA_ADMIN_PASS" | gcloud secrets create "gitea-admin-password-${ENV}" \
  --data-file=- --project="$PROJECT" \
  --replication-policy=user-managed --locations="$REGION"
ok "Admin password stored in Secret Manager: gitea-admin-password-${ENV}"

# ── Deploy ───────────────────────────────────────────────────────────────────
log "Deploying Gitea to $NAMESPACE..."

# Patch values with actual secrets and connection name
helm upgrade --install gitea gitea-charts/gitea \
  -f infra/helm/gitea-values.yaml \
  $VALUES_EXTRA \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --set gitea.config.database.PASSWD="$GITEA_DB_PASS" \
  --set gitea.config.database.NAME="$DB_NAME" \
  --set gitea.config.security.SECRET_KEY="$GITEA_SECRET_KEY" \
  --set gitea.config.security.INTERNAL_TOKEN="$GITEA_INTERNAL_TOKEN" \
  --set gitea.admin.password="$GITEA_ADMIN_PASS" \
  --wait --timeout=5m

ok "Gitea deployed to $NAMESPACE"

# ── Create octogee org ───────────────────────────────────────────────────────
log "Setting up Gitea organization..."
GITEA_SVC="gitea-http.$NAMESPACE.svc.cluster.local:3000"

# Port-forward to call the API
kubectl port-forward svc/gitea-http -n "$NAMESPACE" 13000:3000 &
PF_PID=$!
sleep 3

ORG_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "octogee-admin:$GITEA_ADMIN_PASS" \
  "http://localhost:13000/api/v1/orgs/octogee")

if [[ "$ORG_STATUS" == "404" ]]; then
  curl -s -X POST \
    -u "octogee-admin:$GITEA_ADMIN_PASS" \
    -H "Content-Type: application/json" \
    "http://localhost:13000/api/v1/orgs" \
    -d '{"username":"octogee","visibility":"private","repo_admin_change_team_access":true}'
  ok "Created 'octogee' organization"
else
  ok "Organization 'octogee' already exists"
fi

kill $PF_PID 2>/dev/null || true

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}  Gitea deployed! ($ENV)${NC}"
echo ""
echo "  Namespace:  $NAMESPACE"
echo "  Domain:     https://$GITEA_DOMAIN (configure DNS)"
echo "  Database:   $DB_NAME on octogee-pg (Cloud SQL)"
echo "  Admin:      octogee-admin (password in Secret Manager: gitea-admin-password-${ENV})"
echo ""
echo "  Port-forward to admin UI:"
echo "  kubectl port-forward svc/gitea-http -n $NAMESPACE 13000:3000"
echo "  → http://localhost:13000"
echo ""
echo "  Next: Update GITHUB_BASE_URL in provisioner to use Gitea API"
echo ""
