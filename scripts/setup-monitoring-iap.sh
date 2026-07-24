#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/deployment-target.sh"
source "$SCRIPT_DIR/lib/monitoring-platform-preflight.sh"

SELECTOR="--environment=prod"
SECRET_MODE=""
IAP_ADOPTION=false
for arg in "$@"; do
  case "$arg" in
    --env=*) SELECTOR="--environment=${arg#*=}" ;;
    --target=*) SELECTOR="$arg" ;;
    --bootstrap-secret|--adopt-existing-secret)
      [[ -z "$SECRET_MODE" ]] || { echo "Choose only one secret bootstrap mode" >&2; exit 2; }
      SECRET_MODE="$arg"
      ;;
    --adopt-existing-iap-secret) IAP_ADOPTION=true ;;
    --help|-h)
      echo "Usage: $0 [--env=prod|test|--target=TARGET] [--bootstrap-secret|--adopt-existing-secret] [--adopt-existing-iap-secret]"
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

octogee_load_deployment_target "$SELECTOR"
[[ "$TARGET_LIFECYCLE" == "active" ]] || {
  echo "Monitoring only supports active deployment targets; $TARGET_ID is $TARGET_LIFECYCLE" >&2
  exit 1
}

for command in gcloud kubectl helm; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

gcloud container clusters get-credentials "$TARGET_CLUSTER_NAME" \
  --region "$TARGET_REGION" --project "$TARGET_CLUSTER_PROJECT" >/dev/null
kubectl config use-context "$TARGET_KUBE_CONTEXT" >/dev/null
[[ "$(kubectl config current-context)" == "$TARGET_KUBE_CONTEXT" ]] || {
  echo "Wrong kubectl context" >&2
  exit 1
}

octogee_preflight_monitoring_platform_compute_class

iap_args=(--target="$TARGET_ID" --iap)
[[ -n "$SECRET_MODE" ]] && iap_args+=("$SECRET_MODE")
$IAP_ADOPTION && iap_args+=(--adopt-existing-iap-secret)
"$SCRIPT_DIR/setup-monitoring-secrets.sh" "${iap_args[@]}"

STATIC_IP_NAME="grafana-ip"
gcloud compute addresses describe "$STATIC_IP_NAME" --global --project="$TARGET_CLUSTER_PROJECT" >/dev/null \
  || { echo "Terraform-owned global address $STATIC_IP_NAME is absent" >&2; exit 1; }

setup_args=(--target="$TARGET_ID" --iap)
[[ -n "$SECRET_MODE" ]] && setup_args+=("$SECRET_MODE")
"$SCRIPT_DIR/setup-monitoring.sh" "${setup_args[@]}"
