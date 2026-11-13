#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOYMENT_TARGETS="${OCTOGEE_DEPLOYMENT_TARGETS:-${REPO_ROOT}/core/src/deployment-targets.json}"
PROJECT_ID="octogee"
REGION="us-west1"
CLUSTER_NAME="octogee-gateway"
NETWORK_NAME="octogee-west"
ROUTER_NAME="octogee-west"
NAT_NAME="octogee-west"
SQL_INSTANCE="octogee-pg-west"
SMOKE_POD="octogee-west-foundation-smoke"
SMOKE_IMAGE="registry.k8s.io/e2e-test-images/busybox@sha256:2e0f836850e09b8b7cc937681d6194537a09fbd5f6b9e08f4d646a85128e8937"
WEST_SMOKE_EXEC_MAX_ATTEMPTS="${WEST_SMOKE_EXEC_MAX_ATTEMPTS:-30}"
WEST_SMOKE_EXEC_RETRY_SECONDS="${WEST_SMOKE_EXEC_RETRY_SECONDS:-10}"
KUBE_CONTEXT="gke_${PROJECT_ID}_${REGION}_${CLUSTER_NAME}"
SMOKE_CREATED=false
READ_ONLY=false

usage() {
  cat <<'EOF'
Usage: verify-west-foundation.sh [--read-only|--plan]

  --read-only, --plan  Verify GCP foundation and alert-policy invariants without
                       obtaining cluster credentials or creating a smoke pod.
EOF
}

for argument in "$@"; do
  case "$argument" in
    --read-only|--plan) READ_ONLY=true ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $argument" >&2
      usage >&2
      exit 2
      ;;
  esac
done

TEMP_DIR="$(mktemp -d -t octogee-west-foundation-verify.XXXXXX)"
export KUBECONFIG="${TEMP_DIR}/kubeconfig"

cleanup() {
  if [[ "${SMOKE_CREATED}" == "true" ]]; then
    if ! kubectl delete pod "${SMOKE_POD}" \
      --context="${KUBE_CONTEXT}" \
      --ignore-not-found \
      --wait=false \
      >/dev/null; then
      echo "Failed to delete WEST foundation smoke Pod" >&2
    fi
  fi
  find "${TEMP_DIR}" -type f -delete
  rmdir "${TEMP_DIR}"
}
trap cleanup EXIT

for command in gcloud jq kubectl; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  fi
done
if [[ ! "${WEST_SMOKE_EXEC_MAX_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "WEST_SMOKE_EXEC_MAX_ATTEMPTS must be a positive integer" >&2
  exit 2
fi
if [[ ! "${WEST_SMOKE_EXEC_RETRY_SECONDS}" =~ ^[0-9]+$ ]]; then
  echo "WEST_SMOKE_EXEC_RETRY_SECONDS must be a non-negative integer" >&2
  exit 2
fi

CLUSTER_JSON="${TEMP_DIR}/cluster.json"
NAT_JSON="${TEMP_DIR}/nat.json"
SQL_JSON="${TEMP_DIR}/sql.json"
NODE_JSON="${TEMP_DIR}/node.json"
EMAIL_CHANNEL_JSON="${TEMP_DIR}/email-notification-channel.json"
SMS_CHANNEL_JSON="${TEMP_DIR}/sms-notification-channel.json"
DISCORD_CHANNEL_JSON="${TEMP_DIR}/discord-notification-channel.json"
SERVICE_HEALTH_API_JSON="${TEMP_DIR}/service-health-api.json"
ALERT_POLICIES_JSON="${TEMP_DIR}/alert-policies.json"

gcloud container clusters describe "${CLUSTER_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format=json >"${CLUSTER_JSON}"

if ! jq -e \
  --arg network "${NETWORK_NAME}" \
  --arg resourceName "projects/${PROJECT_ID}/global/networks/${NETWORK_NAME}" \
  --arg selfLink "https://www.googleapis.com/compute/v1/projects/${PROJECT_ID}/global/networks/${NETWORK_NAME}" '
  .controlPlaneEndpointsConfig.dnsEndpointConfig.allowExternalTraffic == true and
  (.controlPlaneEndpointsConfig.dnsEndpointConfig.enableK8sCertsViaDns // false) == false and
  (.controlPlaneEndpointsConfig.dnsEndpointConfig.enableK8sTokensViaDns // false) == false and
  (.controlPlaneEndpointsConfig.ipEndpointsConfig.enabled // false) == false and
  .privateClusterConfig.enablePrivateNodes == true and
  (.network == $network or .network == $resourceName or .network == $selfLink) and
  (.networkConfig.network == $resourceName or .networkConfig.network == $selfLink)
' "${CLUSTER_JSON}" >/dev/null; then
  echo "GKE cluster foundation invariants failed" >&2
  exit 1
fi

gcloud compute routers nats describe "${NAT_NAME}" \
  --router="${ROUTER_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format=json >"${NAT_JSON}"

if ! jq -e '
  .enableDynamicPortAllocation == true and
  .enableEndpointIndependentMapping == false and
  .minPortsPerVm == 64 and
  .maxPortsPerVm == 2048 and
  .natIpAllocateOption == "AUTO_ONLY" and
  .sourceSubnetworkIpRangesToNat == "LIST_OF_SUBNETWORKS" and
  (.subnetworks | length) == 2
' "${NAT_JSON}" >/dev/null; then
  echo "Cloud NAT foundation invariants failed" >&2
  exit 1
fi

gcloud sql instances describe "${SQL_INSTANCE}" \
  --project="${PROJECT_ID}" \
  --format=json >"${SQL_JSON}"

if ! jq -e \
  --arg region "${REGION}" \
  --arg resourceName "projects/${PROJECT_ID}/global/networks/${NETWORK_NAME}" \
  --arg selfLink "https://www.googleapis.com/compute/v1/projects/${PROJECT_ID}/global/networks/${NETWORK_NAME}" '
  .region == $region and
  .settings.backupConfiguration.enabled == true and
  .settings.backupConfiguration.pointInTimeRecoveryEnabled == true and
  .settings.backupConfiguration.transactionLogRetentionDays >= 7 and
  .settings.backupConfiguration.backupRetentionSettings.retainedBackups >= 7 and
  .settings.retainBackupsOnDelete == true and
  .settings.deletionProtectionEnabled == true and
  .settings.ipConfiguration.ipv4Enabled == false and
  (.settings.ipConfiguration.privateNetwork == $resourceName or .settings.ipConfiguration.privateNetwork == $selfLink) and
  ([.ipAddresses[] | select(.type != "PRIVATE")] | length) == 0
' "${SQL_JSON}" >/dev/null; then
  echo "Cloud SQL foundation invariants failed" >&2
  exit 1
fi

gcloud beta monitoring channels list \
  --project="${PROJECT_ID}" \
  --filter='type="email" AND labels.email_address="ops@octogee.com"' \
  --format=json >"${EMAIL_CHANNEL_JSON}"
if ! jq -e '
  length == 1 and
  .[0].type == "email" and
  .[0].enabled == true and
  .[0].verificationStatus == "VERIFIED"
' "${EMAIL_CHANNEL_JSON}" >/dev/null; then
  echo "Verify the ops@octogee.com Cloud Monitoring notification channel, then rerun bootstrap-west-platform.sh --verify-only" >&2
  exit 1
fi
EMAIL_CHANNEL_NAME="$(jq -er '.[0].name' "${EMAIL_CHANNEL_JSON}")"

gcloud beta monitoring channels list \
  --project="${PROJECT_ID}" \
  --filter='type="sms"' \
  --format=json >"${SMS_CHANNEL_JSON}"
if ! jq -e '
  map(select(
    .displayName == "Octogee Ops" and
    .type == "sms" and
    .enabled == true and
    .verificationStatus == "VERIFIED"
  )) | length == 1
' "${SMS_CHANNEL_JSON}" >/dev/null; then
  echo "Verify the Octogee Ops SMS Cloud Monitoring notification channel, then rerun bootstrap-west-platform.sh --verify-only" >&2
  exit 1
fi
SMS_CHANNEL_NAME="$(
  jq -er '
    map(select(
      .displayName == "Octogee Ops" and
      .type == "sms" and
      .enabled == true and
      .verificationStatus == "VERIFIED"
    ))[0].name
  ' "${SMS_CHANNEL_JSON}"
)"

gcloud beta monitoring channels list \
  --project="${PROJECT_ID}" \
  --filter='type="pubsub" AND displayName="Octogee Ops Discord (secondary)"' \
  --format=json >"${DISCORD_CHANNEL_JSON}"
if ! jq -e '
  length == 1 and
  .[0].type == "pubsub" and
  .[0].enabled == true and
  .[0].displayName == "Octogee Ops Discord (secondary)"
' "${DISCORD_CHANNEL_JSON}" >/dev/null; then
  echo "Verify the Octogee Ops Discord Cloud Monitoring notification channel, then rerun bootstrap-west-platform.sh --verify-only" >&2
  exit 1
fi
DISCORD_CHANNEL_NAME="$(jq -er '.[0].name' "${DISCORD_CHANNEL_JSON}")"

gcloud services list \
  --enabled \
  --project="${PROJECT_ID}" \
  --filter='config.name="servicehealth.googleapis.com"' \
  --format=json >"${SERVICE_HEALTH_API_JSON}"
if ! jq -e '
  length == 1 and
  .[0].config.name == "servicehealth.googleapis.com" and
  .[0].state == "ENABLED"
' "${SERVICE_HEALTH_API_JSON}" >/dev/null; then
  echo "Personalized Service Health alert invariants failed: servicehealth.googleapis.com is not enabled" >&2
  exit 1
fi

if [[ ! -f "${DEPLOYMENT_TARGETS}" ]]; then
  echo "Deployment target contract is unavailable: ${DEPLOYMENT_TARGETS}" >&2
  exit 1
fi
PAGED_LOCATIONS="$(jq -r '
  [.activeTargets.prod, .activeTargets.test] as $targetIds |
  [$targetIds[] as $targetId | .targets[$targetId].region] | unique | join("|")
' "${DEPLOYMENT_TARGETS}")"
PAGED_CLUSTERS="$(jq -r '
  [.activeTargets.prod, .activeTargets.test] as $targetIds |
  [$targetIds[] as $targetId | .targets[$targetId].clusterName] | unique | join("|")
' "${DEPLOYMENT_TARGETS}")"
UNPAGED_NAMESPACES="$(jq -r '[.targets[] | select(.lifecycle == "frozen") | .namespace] | unique | join("|")' "${DEPLOYMENT_TARGETS}")"
if [[ -z "${PAGED_LOCATIONS}" || -z "${PAGED_CLUSTERS}" ]]; then
  echo "No active PROD/TEST deployment target to page for; refusing to verify an empty alert scope" >&2
  exit 1
fi
UNPAGED_NAMESPACE_MATCHER=""
if [[ -n "${UNPAGED_NAMESPACES}" ]]; then
  UNPAGED_NAMESPACE_MATCHER=", namespace!~\"${UNPAGED_NAMESPACES}\""
fi

gcloud monitoring policies list \
  --project="${PROJECT_ID}" \
  --filter='userLabels.deployment-target="west-platform"' \
  --format=json >"${ALERT_POLICIES_JSON}"
if ! jq -e \
  --arg email "${EMAIL_CHANNEL_NAME}" \
  --arg sms "${SMS_CHANNEL_NAME}" \
  --arg project "${PROJECT_ID}" \
  --arg locations "${PAGED_LOCATIONS}" \
  --arg clusters "${PAGED_CLUSTERS}" \
  --arg unpagedMatcher "${UNPAGED_NAMESPACE_MATCHER}" '
  def routed_to_both:
    .notificationChannels as $channels |
    ($channels | length) == 2 and
    ($channels | index($email)) != null and
    ($channels | index($sms)) != null;
  def enabled_policy($display_name):
    map(select(
      .displayName == $display_name and
      .enabled == true and
      routed_to_both
    )) | length == 1;
  def workload_policy($display_name; $severity):
    map(select(
      .displayName == $display_name and
      .enabled == true and
      routed_to_both and
      (.conditions[0].conditionPrometheusQueryLanguage.query | rtrimstr("\n")) ==
        "max by (alertname, severity, location, namespace, gateway_id) (ALERTS{project_id=\"\($project)\", location=~\"\($locations)\", cluster=~\"\($clusters)\", alertstate=\"firing\", severity=\"\($severity)\"\($unpagedMatcher)})" and
      (.conditions[0].conditionPrometheusQueryLanguage.duration // "0s") == "0s" and
      .conditions[0].conditionPrometheusQueryLanguage.evaluationInterval == "30s"
    )) | length == 1;
  enabled_policy("Octogee WEST GKE notifications") and
  workload_policy("Octogee workload critical"; "critical") and
  workload_policy("Octogee workload warning"; "warning")
' "${ALERT_POLICIES_JSON}" >/dev/null; then
  echo "WEST workload alert-policy invariants failed" >&2
  exit 1
fi

if ! jq -e \
  --arg email "${EMAIL_CHANNEL_NAME}" \
  --arg sms "${SMS_CHANNEL_NAME}" '
  def routed_to_both:
    .notificationChannels as $channels |
    ($channels | length) == 2 and
    ($channels | index($email)) != null and
    ($channels | index($sms)) != null;
  map(select(
    .displayName == "Octogee WEST Google Service Health incidents" and
    .enabled == true and
    routed_to_both and
    (.conditions | length) == 1 and
    ((.conditions[0].conditionMatchedLog.filter // "") as $filter |
      ($filter | contains("resource.type=\"servicehealth.googleapis.com/Event\"")) and
      ($filter | contains("jsonPayload.@type=\"type.googleapis.com/google.cloud.servicehealth.logging.v1.EventLog\"")) and
      ($filter | contains("jsonPayload.category=\"INCIDENT\"")) and
      ($filter | contains("jsonPayload.state=\"ACTIVE\"")) and
      ($filter | contains("jsonPayload.detailedCategory=\"EMERGING_INCIDENT\"")) and
      ($filter | contains("jsonPayload.detailedCategory=\"CONFIRMED_INCIDENT\"")) and
      .conditions[0].conditionMatchedLog.labelExtractors == {
        description: "EXTRACT(jsonPayload.description)",
        detailed_state: "EXTRACT(jsonPayload.detailedState)",
        impacted_locations: "EXTRACT(jsonPayload.impactedLocations)",
        impacted_products: "EXTRACT(jsonPayload.impactedProducts)",
        start_time: "EXTRACT(jsonPayload.startTime)",
        state: "EXTRACT(jsonPayload.state)",
        title: "EXTRACT(jsonPayload.title)"
      } and
      .alertStrategy.autoClose == "1800s" and
      .alertStrategy.notificationRateLimit.period == "300s" and
      ((.documentation.content // "") | contains("https://console.cloud.google.com/servicehealth/incidentDetails/")))
  )) | length == 1
' "${ALERT_POLICIES_JSON}" >/dev/null; then
  echo "Personalized Service Health alert invariants failed: policy, EventLog v1 filter, extractors, channels, rate limit, auto-close, or dashboard link drifted" >&2
  exit 1
fi

if ! jq -e \
  --arg email "${EMAIL_CHANNEL_NAME}" \
  --arg sms "${SMS_CHANNEL_NAME}" \
  --arg discord "${DISCORD_CHANNEL_NAME}" '
  def routed_to_all:
    .notificationChannels as $channels |
    ($channels | length) == 3 and
    ($channels | index($email)) != null and
    ($channels | index($sms)) != null and
    ($channels | index($discord)) != null;
  map(select(
    .displayName == "Octogee GKE Spot preemption observed" and
    .enabled == true and
    routed_to_all and
    (.conditions | length) == 1 and
    ((.conditions[0].conditionMatchedLog.filter // "") as $filter |
      ($filter | contains("resource.type=\"gce_instance\"")) and
      ($filter | contains("log_id(\"cloudaudit.googleapis.com/system_event\")")) and
      ($filter | contains("protoPayload.methodName=\"compute.instances.preempted\"")) and
      ($filter | contains("/instances/gk3-octogee-gateway-")) and
      .conditions[0].conditionMatchedLog.labelExtractors == {
        instance_id: "EXTRACT(resource.labels.instance_id)",
        zone: "EXTRACT(resource.labels.zone)"
      } and
      .alertStrategy.autoClose == "3600s" and
      .alertStrategy.notificationRateLimit.period == "300s" and
      ((.documentation.content // "") | contains("octogee-spot-disruptions"))
    )
  )) | length == 1
' "${ALERT_POLICIES_JSON}" >/dev/null; then
  echo "GKE Spot preemption alert-policy invariants failed: authoritative filter, extractors, channels, rate limit, auto-close, or dashboard link drifted" >&2
  exit 1
fi

if [[ "${READ_ONLY}" == "true" ]]; then
  echo "WEST foundation read-only verification passed: cloud foundation and alert-policy invariants are healthy; cluster connectivity, smoke egress, and node external-IP checks were skipped."
  exit 0
fi

gcloud container clusters get-credentials "${CLUSTER_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --dns-endpoint
kubectl cluster-info --context="${KUBE_CONTEXT}" >/dev/null

kubectl delete pod "${SMOKE_POD}" \
  --context="${KUBE_CONTEXT}" \
  --ignore-not-found \
  --wait=true \
  >/dev/null
SMOKE_CREATED=true
kubectl run octogee-west-foundation-smoke \
  --context="${KUBE_CONTEXT}" \
  --image="${SMOKE_IMAGE}" \
  --restart=Never \
  --command -- /bin/sh -c "sleep 3600"
kubectl wait \
  --context="${KUBE_CONTEXT}" \
  --for=condition=Ready \
  pod/octogee-west-foundation-smoke \
  --timeout=15m
smoke_exec_attempt=1
while ! kubectl exec "${SMOKE_POD}" \
  --context="${KUBE_CONTEXT}" \
  --request-timeout=45s \
  -- wget -qO- -T 30 http://connectivitycheck.gstatic.com/generate_204 \
  >/dev/null; do
  if [[ "${smoke_exec_attempt}" -ge "${WEST_SMOKE_EXEC_MAX_ATTEMPTS}" ]]; then
    echo "WEST foundation smoke egress failed after ${WEST_SMOKE_EXEC_MAX_ATTEMPTS} attempts" >&2
    exit 1
  fi
  echo "WEST smoke exec attempt ${smoke_exec_attempt} of ${WEST_SMOKE_EXEC_MAX_ATTEMPTS} failed; retrying" >&2
  smoke_exec_attempt=$((smoke_exec_attempt + 1))
  sleep "${WEST_SMOKE_EXEC_RETRY_SECONDS}"
done

NODE_NAME="$(kubectl get pod "${SMOKE_POD}" --context="${KUBE_CONTEXT}" -o jsonpath='{.spec.nodeName}')"
if [[ -z "${NODE_NAME}" ]]; then
  echo "Smoke pod has no assigned node" >&2
  exit 1
fi
kubectl get node "${NODE_NAME}" --context="${KUBE_CONTEXT}" -o json >"${NODE_JSON}"
if ! jq -e '[.status.addresses[] | select(.type == "ExternalIP")] | length == 0' "${NODE_JSON}" >/dev/null; then
  echo "GKE smoke node has an external IP address" >&2
  exit 1
fi

echo "WEST foundation verified: DNS-only control plane, private node, scoped NAT, protected Cloud SQL, backups, PITR, and GKE/Service Health email/SMS paging."
