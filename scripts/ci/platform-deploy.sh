#!/usr/bin/env bash
set -euo pipefail
source platform/scripts/lib/deployment-target.sh
octogee_load_deployment_target "--environment=$RELEASE_ENVIRONMENT"
test "$TARGET_LIFECYCLE" = active
cluster_name=$TARGET_CLUSTER_NAME
region=$TARGET_REGION
cluster_project_id=$TARGET_CLUSTER_PROJECT
target_id=$TARGET_ID
kube_context=$TARGET_KUBE_CONTEXT
namespace=$TARGET_NAMESPACE
cloud_sql_gitea_password_secret_name=$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET
cloud_sql_project_id=$TARGET_CLOUD_SQL_PROJECT
case "$(helm version --template '{{ .Version }}')" in v4.*) ;; *) echo 'Deployment requires Helm 4' >&2; exit 1 ;; esac
gcloud container clusters get-credentials "$cluster_name" --region "$region" --project "$cluster_project_id"
platform/scripts/verify-secrets.sh --env="$RELEASE_ENVIRONMENT" --deployment-target="$target_id"
node platform/core/dist/render-deployment-target-helm-values.js --target="$target_id" > "$RUNNER_TEMP/target-values.yaml"
platform/scripts/node_modules/.bin/tsx platform/scripts/ops/render-release-helm-values.ts "$SOURCE_SHA" > "$RUNNER_TEMP/release-values.json"
api_ips="$(kubectl --context "$kube_context" get endpoints kubernetes -n default -o jsonpath='{.subsets[*].addresses[*].ip}') $(kubectl --context "$kube_context" get service kubernetes -n default -o jsonpath='{.spec.clusterIP}')"
jq -n --arg raw "$api_ips" '
  [$raw | splits("\\s+") | select(length > 0)] as $ips |
  if ($ips | length) == 0 or any($ips[]; split(".") as $parts | ($parts | length) != 4 or any($parts[]; (test("^[0-9]+$") | not) or (tonumber > 255)))
  then error("invalid Kubernetes API addresses")
  else {projectRunner: {apiServerEgressCidrs: [$ips[] + "/32"] | unique}} end
' > "$RUNNER_TEMP/api-values.json"
gcloud secrets versions access latest --secret="$cloud_sql_gitea_password_secret_name" --project="$cloud_sql_project_id" > "$RUNNER_TEMP/gitea-password"
python3 - "$RUNNER_TEMP/gitea-password" "$RUNNER_TEMP/database-values.json" <<'PY'
import json,sys
with open(sys.argv[2], "w") as target:
    json.dump({"gitea":{"gitea":{"config":{"database":{"PASSWD":open(sys.argv[1]).read().strip()}}}}},target)
PY
chart="$(platform/scripts/package-umbrella-chart.sh --output-dir "$RUNNER_TEMP/chart")"
chart="$(node platform/scripts/ci/platform-chart.mjs prepare "$chart")"
render=(template octogee "$chart" --namespace "$namespace")
if helm list -q --namespace "$namespace" --kube-context "$kube_context" | grep -qx octogee; then
  helm get values octogee --namespace "$namespace" --kube-context "$kube_context" -o json > "$RUNNER_TEMP/existing-values.json"
  render+=(--is-upgrade -f "$RUNNER_TEMP/existing-values.json")
fi
render+=(-f "platform/helm/octogee/values.${RELEASE_ENVIRONMENT}.yaml" -f "$RUNNER_TEMP/target-values.yaml"
  -f "$RUNNER_TEMP/release-values.json" -f "$RUNNER_TEMP/api-values.json" -f "$RUNNER_TEMP/database-values.json")
if [ "$RELEASE_LOG_LEVEL" != chart-default ]; then render+=(--set "global.logLevel=$RELEASE_LOG_LEVEL"); fi
export CI_KUBE_CONTEXT="$kube_context" CI_RELEASE_NAMESPACE="$namespace" CI_SOURCE_CHART="$chart"
namespace_chart="$(helm "${render[@]}" | node platform/scripts/ci/platform-chart.mjs)"
args=(upgrade --install octogee "$namespace_chart" --server-side=true --force-conflicts
  --namespace "$namespace" --kube-context "$kube_context" --wait --timeout=10m)
helm "${args[@]}"
if [ "$RELEASE_POST_CHECKS" = true ]; then
  platform/scripts/verify-secrets.sh --env="$RELEASE_ENVIRONMENT" --deployment-target="$target_id"
  platform/scripts/ops/reconcile-pvc-snapshot-schedules.sh --target="$target_id"
  helm test octogee --namespace "$namespace" --kube-context "$kube_context" --timeout=60s
fi
