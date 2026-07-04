#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Monitoring Setup — Managed Prometheus (GMP) + Grafana
# ═══════════════════════════════════════════════════════════════════════════
#
# GKE-native monitoring. On Autopilot the self-managed kube-prometheus-stack
# can't scrape the kubelet, so we use Google Managed Service for Prometheus:
#   • System metrics (cAdvisor/kubelet) — collected by GMP managed collection.
#   • kube-state-metrics — standalone KSM scraped via ClusterPodMonitoring.
#   • App metrics (octogee_*) — ClusterPodMonitoring per target.
#   • Alerting — ClusterRules → managed rule-evaluator → managed Alertmanager.
#   • Grafana reads it all through the gmp-frontend ("Managed Prometheus" ds).
#
# Helm values + manifests live in helm/monitoring/. Shared across prod + test.
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
echo -e "${BOLD}  Monitoring Setup — Managed Prometheus (GMP) + Grafana${NC}"
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
  info "Uninstalling Grafana..."
  helm uninstall grafana -n monitoring 2>/dev/null && ok "Grafana uninstalled" || warn "Not found"
  info "Removing GMP collection + rules..."
  for f in gmp-rules gmp-podmonitorings gmp-kube-state-metrics gmp-frontend; do
    kubectl delete -f "$REPO_DIR/helm/monitoring/$f.yaml" --ignore-not-found 2>/dev/null || true
  done
  kubectl delete secret alertmanager -n gmp-public --ignore-not-found 2>/dev/null || true
  info "Deleting monitoring namespace..."
  kubectl delete namespace monitoring 2>/dev/null && ok "Namespace deleted" || warn "Not found"
  echo ""
  ok "Monitoring uninstalled (GMP managed collection + gmp-public left intact — they're GKE-managed)"
  exit 0
fi

# ── Helm repos ────────────────────────────────────────────────────────────
info "Adding Helm repos..."
helm repo add grafana https://grafana.github.io/helm-charts 2>/dev/null || true
helm repo update grafana >/dev/null 2>&1 || true
ok "Repos ready"

# ── Namespace ─────────────────────────────────────────────────────────────
info "Ensuring monitoring namespace..."
kubectl get namespace monitoring >/dev/null 2>&1 || kubectl create namespace monitoring
ok "Namespace: monitoring"

# ── Env (Grafana password + Discord webhook) ──────────────────────────────
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

# ── GMP collection: KSM + app PodMonitorings + frontend + alert rules ──────
# System metrics (cAdvisor/kubelet) are already collected by GMP managed
# collection on this cluster; these add kube-state, app metrics, the Grafana
# query proxy, and the alert rules. (CRDs are owned by the gmp-operator.)
info "Applying GMP query frontend..."
kubectl apply -f "$REPO_DIR/helm/monitoring/gmp-frontend.yaml" >/dev/null
info "Applying standalone kube-state-metrics + ClusterPodMonitoring..."
kubectl apply -f "$REPO_DIR/helm/monitoring/gmp-kube-state-metrics.yaml" >/dev/null
info "Applying app ClusterPodMonitorings..."
kubectl apply -f "$REPO_DIR/helm/monitoring/gmp-podmonitorings.yaml" >/dev/null
info "Applying alert ClusterRules..."
kubectl apply -f "$REPO_DIR/helm/monitoring/gmp-rules.yaml" >/dev/null
ok "GMP collection + rules applied"

# ── GMP ingestion cost filter ───────────────────────────────────────────────
# gmp-public/config is a GKE-managed singleton (mode=EnsureExists — created
# once, not continuously reconciled like the ClusterNodeMonitoring CRs, so a
# merge patch here is stable). A merge patch (not `apply`) so this only ever
# touches spec.collection.filter, leaving managedAlertmanager.configSecret
# (set separately, below) untouched.
info "Applying GMP collection filter (cost)..."
kubectl patch operatorconfig config -n gmp-public --type=merge \
  --patch-file="$REPO_DIR/helm/monitoring/gmp-collection-filter.yaml" >/dev/null
ok "GMP collection filter applied"

# ── Managed Alertmanager (Discord) ─────────────────────────────────────────
# The gmp-public OperatorConfig points managedAlertmanager.configSecret at
# name=alertmanager,key=alertmanager.yaml. Substitute the Discord webhook and
# create that secret; the managed rule-evaluator routes firing alerts there.
# Delivery no-ops on the placeholder until a real DISCORD_OPS_WEBHOOK_URL lands.
info "Configuring managed Alertmanager (Discord)..."
set +u; AM_DISCORD_URL="${DISCORD_OPS_WEBHOOK_URL:-}"; set -u
[[ "$AM_DISCORD_URL" == https://discord*/api/webhooks/* ]] || AM_DISCORD_URL="https://discord.invalid/not-configured"
am_tmp="$(mktemp)"
sed "s#__DISCORD_OPS_WEBHOOK_URL__#${AM_DISCORD_URL}#" \
  "$REPO_DIR/helm/monitoring/gmp-alertmanager.yaml" > "$am_tmp"
kubectl create secret generic alertmanager -n gmp-public \
  --from-file=alertmanager.yaml="$am_tmp" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
rm -f "$am_tmp"
ok "Managed Alertmanager configured"

# ── Grafana ───────────────────────────────────────────────────────────────
info "Deploying Grafana..."
helm upgrade --install grafana grafana/grafana \
  -f "$REPO_DIR/helm/monitoring/grafana-values.yaml" \
  --set "adminPassword=$GRAFANA_ADMIN_PASSWORD" \
  -n monitoring \
  --wait --timeout=4m
ok "Grafana deployed"

# ── Dashboards (sidecar ConfigMaps) ─────────────────────────────────────────
# Each JSON under helm/monitoring/dashboards/<group>/ becomes a ConfigMap that
# the Grafana dashboard sidecar loads into the folder named after <group>.
# platform/gateways/tracing are generated by dashboards/build.py; kubernetes/
# are vendored best-in-class community boards (dotdc k8s-views) on GMP.
info "Applying Grafana dashboards..."
desired=""
for sub in platform gateways tracing kubernetes; do
  case "$sub" in
    platform)   folder="Platform" ;;
    gateways)   folder="Gateways" ;;
    tracing)    folder="Tracing" ;;
    kubernetes) folder="Kubernetes" ;;
  esac
  for json in "$REPO_DIR/helm/monitoring/dashboards/$sub"/*.json; do
    [ -e "$json" ] || continue
    base="$(basename "$json")"
    name="grafana-dash-${base%.json}"
    desired="$desired $name"
    kubectl create configmap "$name" -n monitoring \
      --from-file="$base=$json" --dry-run=client -o yaml \
      | kubectl label  --local -f - grafana_dashboard=1 -o yaml \
      | kubectl annotate --local -f - "grafana_folder=$folder" -o yaml \
      | kubectl apply -f - >/dev/null
  done
done
# Prune dashboards removed from the repo: delete any grafana-dash-* ConfigMap we
# manage that's no longer in the desired set, so live Grafana never drifts ahead
# of the repo (the prefix scopes the prune to our generated boards only).
for cm in $(kubectl get configmap -n monitoring -l grafana_dashboard=1 \
              -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
  case "$cm" in grafana-dash-*) ;; *) continue ;; esac
  case " $desired " in *" $cm "*) ;; *) kubectl delete configmap "$cm" -n monitoring >/dev/null && info "pruned stale dashboard $cm" ;; esac
done
ok "Dashboards applied"

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
