#!/bin/bash
# Shell into the Octogee gateway container
# Usage: ./scripts/shell-gateway.sh --env=prod|test

set -euo pipefail

ENV="prod"
for arg in "$@"; do
  case $arg in
    --env=*) ENV="${arg#*=}" ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

case "$ENV" in
  prod)
    K8S_CONTEXT="gke_octogee_us-central1_octogee-gateway"
    NAMESPACE="octogee"
    ;;
  test)
    K8S_CONTEXT="gke_octogee-test_us-central1_octogee-test"
    NAMESPACE="octogee-test"
    ;;
  *)
    echo "Usage: $0 --env=prod|test"
    exit 1
    ;;
esac

export USE_GKE_GCLOUD_AUTH_PLUGIN=True
kubectl config use-context "$K8S_CONTEXT"
echo "Shelling into octogee-gateway ($ENV)..."
kubectl exec -it deployment/octogee-gateway -n "$NAMESPACE" -c gateway -- \
  bash -c 'cd /home/node/.openclaw && exec bash'
