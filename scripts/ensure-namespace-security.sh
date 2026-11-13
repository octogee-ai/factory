#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/deployment-target.sh"

TARGET_ID=""
MODE=""

for argument in "$@"; do
  case "$argument" in
    --deployment-target=*) TARGET_ID="${argument#*=}" ;;
    --mode=*) MODE="${argument#*=}" ;;
    --help|-h)
      echo "Usage: $0 --deployment-target=TARGET --mode=warn-audit|enforce"
      exit 0
      ;;
    *)
      echo "Unknown argument: $argument" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$TARGET_ID" || -z "$MODE" ]]; then
  echo "Usage: $0 --deployment-target=TARGET --mode=warn-audit|enforce" >&2
  exit 2
fi

octogee_load_deployment_target "--target=$TARGET_ID"

if [[ "$TARGET_NETWORK_POLICY_ENFORCE_DEFAULT_DENY" != "true" ]]; then
  echo "Deployment target $TARGET_ID does not define a WEST namespace security boundary; no labels applied." >&2
  exit 0
fi

case "$MODE" in
  warn-audit|enforce) ;;
  *)
    echo "Unknown mode: $MODE" >&2
    exit 2
    ;;
esac

kubectl_target=(kubectl --context "$TARGET_KUBE_CONTEXT")
"${kubectl_target[@]}" get namespace "$TARGET_NAMESPACE" >/dev/null 2>&1 ||
  "${kubectl_target[@]}" create namespace "$TARGET_NAMESPACE"

labels=(
  pod-security.kubernetes.io/audit=restricted
  pod-security.kubernetes.io/audit-version=latest
  pod-security.kubernetes.io/warn=restricted
  pod-security.kubernetes.io/warn-version=latest
)

if [[ "$MODE" == "enforce" ]]; then
  labels+=(
    pod-security.kubernetes.io/enforce=restricted
    pod-security.kubernetes.io/enforce-version=latest
  )
else
  current_enforce="$("${kubectl_target[@]}" get namespace "$TARGET_NAMESPACE" -o jsonpath='{.metadata.labels.pod-security\\.kubernetes\\.io/enforce}')"
  if [[ -n "$current_enforce" ]]; then
    "${kubectl_target[@]}" label namespace "$TARGET_NAMESPACE" \
      pod-security.kubernetes.io/enforce- \
      pod-security.kubernetes.io/enforce-version-
  fi
fi

"${kubectl_target[@]}" label namespace "$TARGET_NAMESPACE" --overwrite "${labels[@]}"
echo "Namespace $TARGET_NAMESPACE Pod Security Admission mode $MODE is converged."
