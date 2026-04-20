#!/usr/bin/env bash
# Open a local port-forward to the OpenClaw Control UI on the gateway.
#
# Access model (per RFC/decision "gateway-ops access — Option A"):
#   - Gateway Service is ClusterIP-only (port 18789); no public ingress.
#   - This script runs `kubectl port-forward` against the Service by its
#     K8s DNS name — no static DNS record, no Ingress, no IAP.
#   - Auth gate is GKE IAM: whoever can `kubectl` the cluster can port-
#     forward. RBAC + IAP-for-GKE (on the control plane) is the
#     perimeter. Keep cluster-admin / port-forward permissions tight.
#
# Usage:
#   ./scripts/shell-gateway-ui.sh                        # default: test
#   ./scripts/shell-gateway-ui.sh --env=prod
#   ./scripts/shell-gateway-ui.sh --env=test --port=8789 # local port override
#   ./scripts/shell-gateway-ui.sh --env=test --open      # also open browser
#
# Known endpoints once port-forward is up:
#   http://localhost:{PORT}/                  — gateway root
#   http://localhost:{PORT}/__openclaw__/health
#   http://localhost:{PORT}/__openclaw__/metrics
#   http://localhost:{PORT}/__openclaw__/canvas/
#
# Ctrl+C tears down the tunnel cleanly.

set -euo pipefail

ENV="test"
LOCAL_PORT=18789
OPEN_BROWSER=false

for arg in "$@"; do
  case $arg in
    --env=*)  ENV="${arg#*=}" ;;
    --port=*) LOCAL_PORT="${arg#*=}" ;;
    --open)   OPEN_BROWSER=true ;;
    --help|-h)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; echo "Try --help"; exit 1 ;;
  esac
done

case "$ENV" in
  prod)
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    NAMESPACE="octogee"
    ;;
  test)
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    NAMESPACE="octogee-test"
    ;;
  *)
    echo "Usage: $0 --env=prod|test [--port=LOCAL_PORT] [--open]"
    exit 1
    ;;
esac

export USE_GKE_GCLOUD_AUTH_PLUGIN=True

# Fail fast if gcloud credentials aren't fresh (kubectl-gke-gcloud-auth-plugin
# silently fails the same way, but with a confusing error much later).
if ! kubectl --context="$K8S_CONTEXT" get svc octogee-gateway -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "❌ Can't reach octogee-gateway in namespace=$NAMESPACE (context=$K8S_CONTEXT)" >&2
  echo "   Try: gcloud auth login && gcloud container clusters get-credentials octogee-gateway --region us-central1 --project octogee" >&2
  exit 1
fi

URL="http://localhost:${LOCAL_PORT}"

echo "→ Port-forwarding octogee-gateway:18789 → ${URL} (env=${ENV}, namespace=${NAMESPACE})"
echo "  Canvas:   ${URL}/__openclaw__/canvas/"
echo "  Health:   ${URL}/__openclaw__/health"
echo "  Metrics:  ${URL}/__openclaw__/metrics"
echo "  (Ctrl+C to tear down)"

if $OPEN_BROWSER; then
  # Open in background so the port-forward command is the foreground process
  # that owns the TTY and responds to Ctrl+C.
  (
    # Poll the local port until kubectl port-forward finishes binding,
    # THEN open the browser. A fixed sleep races: port-forward takes
    # 2-4s to auth via gke-gcloud-auth-plugin + establish the SPDY tunnel,
    # and macOS's `open` at T+1s hits ECONNREFUSED, caches the error,
    # and never auto-recovers when the forward finishes. Poll for up
    # to 6s (12 × 500ms) which covers cold gcloud sessions.
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      sleep 0.5
      if (exec 3<>/dev/tcp/127.0.0.1/"${LOCAL_PORT}") 2>/dev/null; then
        exec 3>&-
        if command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true
        elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
        fi
        exit 0
      fi
    done
  ) &
fi

exec kubectl --context="$K8S_CONTEXT" port-forward \
  svc/octogee-gateway "${LOCAL_PORT}:18789" -n "$NAMESPACE"
