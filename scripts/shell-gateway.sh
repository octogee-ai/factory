#!/bin/bash
# Shell into the Octogee gateway container
# Usage: ./scripts/shell-gateway.sh --env=prod|test

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"

ENV="prod"
for arg in "$@"; do
  case $arg in
    --env=*) ENV="${arg#*=}" ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

case "$ENV" in
  prod|test)
    octogee_load_deployment_target "--environment=$ENV"
    K8S_CONTEXT="$TARGET_KUBE_CONTEXT"
    NAMESPACE="$TARGET_NAMESPACE"
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
