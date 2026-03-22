#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# ⚠️  INCOMPLETE — k8s/monitoring/ Helm values were deleted in the k8s→Helm
# migration. This script references missing files and will fail.
# TODO: Move monitoring config into helm/octogee or a dedicated monitoring
# Helm chart. Tracked in TECH-DEBT.md.
# ═══════════════════════════════════════════════════════════════════════════
#
# Octogee Monitoring Setup — Prometheus + Grafana
# ═══════════════════════════════════════════════════════════════════════════
#
# Deploys Prometheus and Grafana via Helm to the monitoring namespace.
# Run independently of setup-gateway.sh.
#
# Usage:
#   ./scripts/setup-monitoring.sh --env=test
#   ./scripts/setup-monitoring.sh --env=prod
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ENV=""

for arg in "$@"; do
  case $arg in
    --env=*) ENV="${arg#*=}" ;;
    --help|-h) echo "Usage: $0 --env=prod|test"; exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

if [[ -z "$ENV" ]]; then
  echo "Usage: $0 --env=prod|test"
  exit 1
fi

case "$ENV" in
  prod) PROMETHEUS_VALUES="k8s/monitoring/prometheus-values-autopilot.yaml"; ENV_FILE="$REPO_DIR/.env" ;;
  test) PROMETHEUS_VALUES="k8s/monitoring/prometheus-values-autopilot.yaml"; ENV_FILE="$REPO_DIR/.env.test" ;;
  *) echo "Unknown environment: $ENV"; exit 1 ;;
esac

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }

save_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    local tmpfile; tmpfile=$(mktemp)
    grep -v "^${key}=" "$ENV_FILE" > "$tmpfile"
    echo "${key}=${val}" >> "$tmpfile"
    mv "$tmpfile" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

# Load existing env for GRAFANA_ADMIN_PASSWORD
if [[ -f "$ENV_FILE" ]]; then
  set +u
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    export "$key=$val"
  done < "$ENV_FILE"
  set -u
fi

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Monitoring Setup — $ENV${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

cd "$REPO_DIR"

info "Adding Helm repositories..."
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
helm repo add grafana https://grafana.github.io/helm-charts 2>/dev/null || true
helm repo update > /dev/null 2>&1

info "Creating monitoring namespace..."
kubectl apply -f k8s/monitoring/namespace.yaml

info "Using Prometheus values: $PROMETHEUS_VALUES"
info "Deploying Prometheus stack..."
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  -f "$PROMETHEUS_VALUES" \
  -n monitoring \
  --wait --timeout 5m0s
ok "Prometheus deployed"

# Generate Grafana password if not set
set +u
if [[ -z "${GRAFANA_ADMIN_PASSWORD:-}" ]]; then
  GRAFANA_ADMIN_PASSWORD=$(openssl rand -base64 16)
  save_env "GRAFANA_ADMIN_PASSWORD" "$GRAFANA_ADMIN_PASSWORD"
  info "Generated Grafana admin password (saved to $ENV_FILE)"
else
  info "Using existing Grafana admin password"
fi
set -u

info "Deploying Grafana..."
helm upgrade --install grafana grafana/grafana \
  -f k8s/monitoring/grafana-values.yaml \
  --set "adminPassword=$GRAFANA_ADMIN_PASSWORD" \
  -n monitoring \
  --wait --timeout 3m0s
ok "Grafana deployed"

info "Applying ServiceMonitors..."
kubectl apply -f k8s/monitoring/service-monitors.yaml
ok "ServiceMonitors applied"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Monitoring setup complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Access Grafana:"
echo "    kubectl port-forward -n monitoring svc/grafana 3000:80"
echo "    Open http://localhost:3000 (admin / \$GRAFANA_ADMIN_PASSWORD)"
echo ""
