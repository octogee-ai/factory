#!/usr/bin/env bash
# Reconcile agents/{uid}.name in Firestore with the live Mattermost coach name.
#
# Wires up local credentials the same way setup-mattermost.sh does:
#   - selects the kubectl context + namespace for the env
#   - pulls the MM admin PAT from the mattermost-gateway K8s secret
#   - port-forwards svc/mattermost to localhost:8065
#   - uses gcloud application-default credentials for Firestore
# then runs ops/reconcile-coach-names.ts (dry-run unless you pass --apply).
#
# Usage:
#   scripts/ops/reconcile-coach-names.sh --env=prod|test [--apply] [slug ...]
#   scripts/ops/reconcile-coach-names.sh --env=prod --list
#   scripts/ops/reconcile-coach-names.sh --env=prod --clear-onboarding-name --apply jack michael
set -euo pipefail

ENV=""
PASSTHRU=()
for arg in "$@"; do
  case "$arg" in
    --env=*) ENV="${arg#*=}" ;;
    *) PASSTHRU+=("$arg") ;;
  esac
done

case "$ENV" in
  prod)
    K8S_NAMESPACE="octogee"
    GCP_PROJECT="octogee"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    ;;
  test)
    K8S_NAMESPACE="octogee-test"
    GCP_PROJECT="octogee-test"
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    ;;
  *)
    echo "Usage: $0 --env=prod|test [--apply] [slug ...]" >&2
    exit 1
    ;;
esac

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> kubectl context: $K8S_CONTEXT (namespace $K8S_NAMESPACE)"
kubectl config use-context "$K8S_CONTEXT" >/dev/null
CURRENT_CTX="$(kubectl config current-context)"
[[ "$CURRENT_CTX" == "$K8S_CONTEXT" ]] || { echo "context is '$CURRENT_CTX', expected '$K8S_CONTEXT'" >&2; exit 1; }

echo "==> Reading MM admin PAT from secret mattermost-gateway"
MM_ADMIN_TOKEN="$(kubectl get secret mattermost-gateway -n "$K8S_NAMESPACE" -o jsonpath='{.data.admin_token}' 2>/dev/null | base64 -d 2>/dev/null || echo "")"
[[ -n "$MM_ADMIN_TOKEN" ]] || { echo "mattermost-gateway/admin_token is missing or empty" >&2; exit 1; }

PF_PID=""
cleanup() {
  if [[ -n "$PF_PID" ]] && kill -0 "$PF_PID" 2>/dev/null; then
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if lsof -ti :8065 >/dev/null 2>&1; then
  echo "==> Killing stale process on localhost:8065"
  lsof -ti :8065 | xargs kill -9 2>/dev/null || true
fi

echo "==> Port-forwarding svc/mattermost → localhost:8065"
kubectl port-forward -n "$K8S_NAMESPACE" svc/mattermost 8065:8065 >/dev/null 2>&1 &
PF_PID=$!

PF_READY=false
for _ in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:8065 2>/dev/null | grep -qE "^[0-9]"; then
    PF_READY=true
    break
  fi
  sleep 1
done
$PF_READY || { echo "port-forward did not establish on localhost:8065" >&2; exit 1; }

export MM_URL="http://localhost:8065"
export MM_ADMIN_TOKEN
export GOOGLE_CLOUD_PROJECT="$GCP_PROJECT"
unset GOOGLE_APPLICATION_CREDENTIALS  # use gcloud application-default credentials

echo "==> Running reconcile (env=$ENV)"
cd "$SCRIPTS_DIR"
npx tsx ops/reconcile-coach-names.ts "${PASSTHRU[@]+"${PASSTHRU[@]}"}"
