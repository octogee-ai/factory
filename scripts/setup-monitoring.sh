#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Monitoring Setup — Prometheus + Grafana
# ═══════════════════════════════════════════════════════════════════════════
#
# Deploys Prometheus (kube-prometheus-stack) + Grafana via Helm to the
# shared 'monitoring' namespace. Shared across prod and test namespaces.
#
# Helm values live in helm/monitoring/ (Autopilot-compatible).
#
# Usage:
#   ./scripts/setup-monitoring.sh              # deploy/upgrade
#   ./scripts/setup-monitoring.sh --uninstall  # tear down
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

UNINSTALL=false
ENV_FILE="$REPO_DIR/.env"  # monitoring is shared — use prod env for passwords

for arg in "$@"; do
  case $arg in
    --uninstall) UNINSTALL=true ;;
    --help|-h) echo "Usage: $0 [--uninstall]"; exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  \033[0;31m❌ $1${NC}"; exit 1; }

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

# Use prod cluster (monitoring is shared infra)
K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Monitoring Setup — Prometheus + Grafana${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ── kubectl context ───────────────────────────────────────────────────────
info "Setting kubectl context: $K8S_CONTEXT"
gcloud container clusters get-credentials octogee-gateway --region us-central1 --project octogee 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT" >/dev/null
[[ "$(kubectl config current-context)" == "$K8S_CONTEXT" ]] || fail "Wrong kubectl context"
ok "kubectl context: $K8S_CONTEXT"

# ── Uninstall ─────────────────────────────────────────────────────────────
if $UNINSTALL; then
  info "Uninstalling Prometheus..."
  helm uninstall prometheus -n monitoring 2>/dev/null && ok "Prometheus uninstalled" || warn "Not found"
  info "Uninstalling Grafana..."
  helm uninstall grafana -n monitoring 2>/dev/null && ok "Grafana uninstalled" || warn "Not found"
  info "Deleting ServiceMonitors + alert rules..."
  kubectl delete -f "$REPO_DIR/helm/monitoring/service-monitors.yaml" 2>/dev/null || true
  kubectl delete -f "$REPO_DIR/helm/monitoring/alert-rules.yaml" 2>/dev/null || true
  kubectl delete -f "$REPO_DIR/helm/monitoring/alertmanager-config.yaml" 2>/dev/null || true
  info "Deleting monitoring namespace..."
  kubectl delete namespace monitoring 2>/dev/null && ok "Namespace deleted" || warn "Not found"
  echo ""
  ok "Monitoring uninstalled"
  exit 0
fi

# ── Helm repos ────────────────────────────────────────────────────────────
info "Adding Helm repos..."
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
helm repo add grafana https://grafana.github.io/helm-charts 2>/dev/null || true
helm repo update >/dev/null 2>&1
ok "Repos ready"

# ── Namespace ─────────────────────────────────────────────────────────────
info "Ensuring monitoring namespace..."
kubectl get namespace monitoring >/dev/null 2>&1 || kubectl create namespace monitoring
ok "Namespace: monitoring"

# ── Grafana password ──────────────────────────────────────────────────────
set +u
if [[ -f "$ENV_FILE" ]]; then
  source <(grep -v '^#' "$ENV_FILE" | grep '=' | grep -v '^$')
fi
if [[ -z "${GRAFANA_ADMIN_PASSWORD:-}" ]]; then
  GRAFANA_ADMIN_PASSWORD=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 20)
  save_env "GRAFANA_ADMIN_PASSWORD" "$GRAFANA_ADMIN_PASSWORD"
  info "Generated Grafana admin password (saved to $ENV_FILE)"
else
  info "Using existing Grafana admin password"
fi
set -u

# ── Alertmanager webhook secret (must exist BEFORE the AM pod mounts it) ──
# prometheus-values enables Alertmanager with alertmanagerSpec.secrets:
# [discord-ops-webhook]; the operator adds a secret volume, so the AM pod is
# stuck ContainerCreating (and `helm --wait` times out) if the secret is
# absent. Seed it with the real webhook if the env file provided one, else a
# placeholder so the pod starts — delivery no-ops until the real URL lands via
# `setup-secrets.sh` / `rotate-secret.sh discord-ops-webhook`.
info "Ensuring discord-ops-webhook secret (Alertmanager mount)..."
set +u
AM_DISCORD_URL="${DISCORD_OPS_WEBHOOK_URL:-}"
set -u
[[ "$AM_DISCORD_URL" == https://discord*/api/webhooks/* ]] || AM_DISCORD_URL="https://discord.invalid/not-configured"
kubectl create secret generic discord-ops-webhook -n monitoring \
  --from-literal=url="$AM_DISCORD_URL" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
ok "discord-ops-webhook present in monitoring"

# ── Prometheus ────────────────────────────────────────────────────────────
info "Deploying Prometheus (kube-prometheus-stack)..."
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  -f "$REPO_DIR/helm/monitoring/prometheus-values.yaml" \
  -n monitoring \
  --wait --timeout=5m
ok "Prometheus deployed"

# ── Grafana ───────────────────────────────────────────────────────────────
info "Deploying Grafana..."
helm upgrade --install grafana grafana/grafana \
  -f "$REPO_DIR/helm/monitoring/grafana-values.yaml" \
  --set "adminPassword=$GRAFANA_ADMIN_PASSWORD" \
  -n monitoring \
  --wait --timeout=3m
ok "Grafana deployed"

# ── ServiceMonitors ───────────────────────────────────────────────────────
info "Applying ServiceMonitors..."
kubectl apply -f "$REPO_DIR/helm/monitoring/service-monitors.yaml"
ok "ServiceMonitors applied"

# ── Alert Rules ───────────────────────────────────────────────────────────
info "Applying alert rules..."
kubectl apply -f "$REPO_DIR/helm/monitoring/alert-rules.yaml"
ok "Alert rules applied"

# ── Alertmanager routing (Discord) ────────────────────────────────────────
info "Applying AlertmanagerConfig (Discord ops routing)..."
kubectl apply -f "$REPO_DIR/helm/monitoring/alertmanager-config.yaml"
ok "AlertmanagerConfig applied"

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Monitoring setup complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Access Grafana locally:"
echo "    kubectl port-forward -n monitoring svc/grafana 3000:80"
echo "    open http://localhost:3000  (admin / \$GRAFANA_ADMIN_PASSWORD)"
echo ""
echo "  For public access via IAP:"
echo "    ./scripts/setup-monitoring-iap.sh"
echo ""
