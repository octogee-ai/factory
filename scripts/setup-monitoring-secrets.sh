#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/deployment-target.sh"
source "$SCRIPT_DIR/lib/shell-env.sh"

SELECTOR="--environment=prod"
MODE=""
IAP=false
ADOPT_IAP=false
for arg in "$@"; do
  case "$arg" in
    --env=*) SELECTOR="--environment=${arg#*=}" ;;
    --target=*) SELECTOR="$arg" ;;
    --bootstrap-secret|--adopt-existing-secret)
      [[ -z "$MODE" ]] || { echo "Choose only one secret bootstrap mode" >&2; exit 2; }
      MODE="$arg"
      ;;
    --iap) IAP=true ;;
    --adopt-existing-iap-secret) ADOPT_IAP=true ;;
    --help|-h)
      echo "Usage: $0 [--env=prod|test|--target=TARGET] [--bootstrap-secret|--adopt-existing-secret] [--iap --adopt-existing-iap-secret]"
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

for command in gcloud kubectl openssl; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

SECRET_MANAGER_PROJECT="$TARGET_CLUSTER_PROJECT"
SECRET_MANAGER_NAME="GRAFANA_ADMIN_PASSWORD-${TARGET_CLUSTER_NAME}-${TARGET_REGION}"
IAP_CLIENT_ID_SECRET="GRAFANA_IAP_CLIENT_ID-${TARGET_CLUSTER_NAME}-${TARGET_REGION}"
IAP_CLIENT_SECRET_SECRET="GRAFANA_IAP_CLIENT_SECRET-${TARGET_CLUSTER_NAME}-${TARGET_REGION}"
NAMESPACE="monitoring"
K8S_SECRET="grafana-admin"
GRAFANA_ADMIN_USER="admin"

gcloud container clusters get-credentials "$TARGET_CLUSTER_NAME" \
  --region "$TARGET_REGION" --project "$TARGET_CLUSTER_PROJECT" >/dev/null
kubectl config use-context "$TARGET_KUBE_CONTEXT" >/dev/null
[[ "$(kubectl config current-context)" == "$TARGET_KUBE_CONTEXT" ]] || {
  echo "Wrong kubectl context" >&2
  exit 1
}

state="$(secret_manager_secret_state "$SECRET_MANAGER_NAME" "$SECRET_MANAGER_PROJECT")"
case "$state" in
  present)
    password="$(gcloud secrets versions access latest --secret="$SECRET_MANAGER_NAME" --project="$SECRET_MANAGER_PROJECT")" \
      || { echo "Could not read $SECRET_MANAGER_NAME" >&2; exit 1; }
    ;;
  absent)
    case "$MODE" in
      --adopt-existing-secret)
        source_secret="$K8S_SECRET"
        if ! kubectl get secret "$source_secret" --namespace "$NAMESPACE" --context "$TARGET_KUBE_CONTEXT" >/dev/null 2>&1; then
          source_secret="grafana"
        fi
        password="$(kubectl get secret "$source_secret" --namespace "$NAMESPACE" --context "$TARGET_KUBE_CONTEXT" \
          -o jsonpath='{.data.admin-password}' | base64 --decode)" \
          || { echo "Cannot adopt missing $NAMESPACE/$source_secret admin-password" >&2; exit 1; }
        ;;
      --bootstrap-secret)
        password="$(openssl rand -hex 16)"
        ;;
      *)
        echo "$SECRET_MANAGER_NAME is absent; rerun with --adopt-existing-secret or --bootstrap-secret" >&2
        exit 1
        ;;
    esac
    [[ -n "$password" ]] || { echo "Refusing to persist an empty Grafana password" >&2; exit 1; }
    printf '%s' "$password" | gcloud secrets create "$SECRET_MANAGER_NAME" \
      --project="$SECRET_MANAGER_PROJECT" \
      --replication-policy=user-managed \
      --locations="$TARGET_REGION" \
      --data-file=- --quiet >/dev/null
    ;;
  *) echo "Could not establish Secret Manager state for $SECRET_MANAGER_NAME" >&2; exit 1 ;;
esac

[[ -n "$password" ]] || { echo "Refusing to materialize an empty Grafana password" >&2; exit 1; }
kubectl create namespace "$NAMESPACE" --context "$TARGET_KUBE_CONTEXT" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl create secret generic "$K8S_SECRET" --namespace "$NAMESPACE" --context "$TARGET_KUBE_CONTEXT" \
  --from-literal=admin-user="$GRAFANA_ADMIN_USER" \
  --from-literal=admin-password="$password" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

materialized_user="$(kubectl get secret "$K8S_SECRET" --namespace "$NAMESPACE" --context "$TARGET_KUBE_CONTEXT" \
  -o jsonpath='{.data.admin-user}' | base64 --decode)" \
  || { echo "Could not verify $NAMESPACE/$K8S_SECRET admin user" >&2; exit 1; }
materialized="$(kubectl get secret "$K8S_SECRET" --namespace "$NAMESPACE" --context "$TARGET_KUBE_CONTEXT" \
  -o jsonpath='{.data.admin-password}' | base64 --decode)" \
  || { echo "Could not verify $NAMESPACE/$K8S_SECRET" >&2; exit 1; }
[[ "$materialized_user" == "$GRAFANA_ADMIN_USER" && "$materialized" == "$password" ]] || {
  echo "Grafana secret materialization drifted" >&2
  exit 1
}

if $IAP; then
  iap_id_state="$(secret_manager_secret_state "$IAP_CLIENT_ID_SECRET" "$SECRET_MANAGER_PROJECT")"
  iap_secret_state="$(secret_manager_secret_state "$IAP_CLIENT_SECRET_SECRET" "$SECRET_MANAGER_PROJECT")"
  if [[ "$iap_id_state" == "present" && "$iap_secret_state" == "present" ]]; then
    iap_client_id="$(gcloud secrets versions access latest --secret="$IAP_CLIENT_ID_SECRET" --project="$SECRET_MANAGER_PROJECT")"
    iap_client_secret="$(gcloud secrets versions access latest --secret="$IAP_CLIENT_SECRET_SECRET" --project="$SECRET_MANAGER_PROJECT")"
  elif $ADOPT_IAP && [[ "$iap_id_state" == "absent" && "$iap_secret_state" == "absent" ]]; then
    iap_client_id="$(kubectl get secret grafana-iap-oauth --namespace "$NAMESPACE" --context "$TARGET_KUBE_CONTEXT" -o jsonpath='{.data.client_id}' | base64 --decode)" \
      || { echo "Cannot adopt missing $NAMESPACE/grafana-iap-oauth client_id" >&2; exit 1; }
    iap_client_secret="$(kubectl get secret grafana-iap-oauth --namespace "$NAMESPACE" --context "$TARGET_KUBE_CONTEXT" -o jsonpath='{.data.client_secret}' | base64 --decode)" \
      || { echo "Cannot adopt missing $NAMESPACE/grafana-iap-oauth client_secret" >&2; exit 1; }
    [[ -n "$iap_client_id" && -n "$iap_client_secret" ]] || { echo "Refusing to adopt empty IAP credentials" >&2; exit 1; }
    printf '%s' "$iap_client_id" | gcloud secrets create "$IAP_CLIENT_ID_SECRET" --project="$SECRET_MANAGER_PROJECT" --replication-policy=user-managed --locations="$TARGET_REGION" --data-file=- --quiet >/dev/null
    printf '%s' "$iap_client_secret" | gcloud secrets create "$IAP_CLIENT_SECRET_SECRET" --project="$SECRET_MANAGER_PROJECT" --replication-policy=user-managed --locations="$TARGET_REGION" --data-file=- --quiet >/dev/null
  else
    echo "IAP credentials are incomplete; create both Secret Manager values or adopt the existing Kubernetes secret" >&2
    exit 1
  fi
  [[ -n "$iap_client_id" && -n "$iap_client_secret" ]] || { echo "Refusing to materialize empty IAP credentials" >&2; exit 1; }
  kubectl create secret generic grafana-iap-oauth --namespace "$NAMESPACE" --context "$TARGET_KUBE_CONTEXT" \
    --from-literal=client_id="$iap_client_id" --from-literal=client_secret="$iap_client_secret" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  materialized_iap_client_id="$(kubectl get secret grafana-iap-oauth --namespace "$NAMESPACE" --context "$TARGET_KUBE_CONTEXT" -o jsonpath='{.data.client_id}' | base64 --decode)" \
    || { echo "Could not verify IAP client id" >&2; exit 1; }
  materialized_iap_client_secret="$(kubectl get secret grafana-iap-oauth --namespace "$NAMESPACE" --context "$TARGET_KUBE_CONTEXT" -o jsonpath='{.data.client_secret}' | base64 --decode)" \
    || { echo "Could not verify IAP client secret" >&2; exit 1; }
  [[ "$materialized_iap_client_id" == "$iap_client_id" && "$materialized_iap_client_secret" == "$iap_client_secret" ]] || {
    echo "IAP secret materialization drifted" >&2
    exit 1
  }
fi
echo "Grafana admin secret materialized from Secret Manager for $TARGET_ID"
