#!/usr/bin/env bash
set -euo pipefail

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
CHANNEL_JSON="${TEMP_DIR}/notification-channel.json"

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

gcloud container clusters get-credentials "${CLUSTER_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --dns-endpoint
kubectl cluster-info --context="${KUBE_CONTEXT}" >/dev/null

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
  --format=json >"${CHANNEL_JSON}"
if ! jq -e '
  length == 1 and
  .[0].enabled == true and
  .[0].verificationStatus == "VERIFIED"
' "${CHANNEL_JSON}" >/dev/null; then
  echo "Verify the ops@octogee.com Cloud Monitoring notification channel, then rerun bootstrap-west-platform.sh --verify-only" >&2
  exit 1
fi

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

echo "WEST foundation verified: DNS-only control plane, private node, scoped NAT, protected Cloud SQL, backups, and PITR."
