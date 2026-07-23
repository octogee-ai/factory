#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_SELECTOR=""
APPLY=false
POLICY_NAME="octogee-west-pvc-daily"
RECEIPT_BUCKET="gs://octogee-terraform-state/receipts/west-pvc-snapshots"
PVC_NAMES=("gitea-shared-storage" "mattermost-data")

for argument in "$@"; do
  case "${argument}" in
    --target=*) TARGET_SELECTOR="${argument}" ;;
    --apply) APPLY=true ;;
    *) echo "Unknown argument: ${argument}" >&2; exit 2 ;;
  esac
done

if [[ -z "${TARGET_SELECTOR}" ]]; then
  echo "A --target=test-west or --target=prod-west selector is required" >&2
  exit 2
fi

# shellcheck source=scripts/lib/deployment-target.sh
source "${REPO_ROOT}/scripts/lib/deployment-target.sh"
octogee_load_deployment_target "${TARGET_SELECTOR}"

if [[ "${TARGET_ID}" != "test-west" && "${TARGET_ID}" != "prod-west" ]]; then
  echo "WEST PVC snapshot reconciliation requires test-west or prod-west; received ${TARGET_ID}" >&2
  exit 2
fi
if [[ "${TARGET_REGION}" != "us-west1" || "${TARGET_CLUSTER_PROJECT}" != "octogee" ]]; then
  echo "Deployment target ${TARGET_ID} does not resolve to octogee/us-west1" >&2
  exit 2
fi

for command in gcloud git jq kubectl; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  fi
done

TEMP_DIR="$(mktemp -d -t octogee-west-pvc-snapshots.XXXXXX)"
cleanup() {
  find "${TEMP_DIR}" -type f -delete
  rmdir "${TEMP_DIR}"
}
trap cleanup EXIT
DISKS_JSON="${TEMP_DIR}/disks.json"
RECEIPT_FILE="${TEMP_DIR}/receipt.json"
printf '%s\n' '[]' >"${DISKS_JSON}"

EXPECTED_REGION_URI="https://www.googleapis.com/compute/v1/projects/${TARGET_CLUSTER_PROJECT}/regions/${TARGET_REGION}"
EXPECTED_POLICY_URI="${EXPECTED_REGION_URI}/resourcePolicies/${POLICY_NAME}"
if ! schedule_json="$(gcloud compute resource-policies describe "${POLICY_NAME}" \
  --project="${TARGET_CLUSTER_PROJECT}" \
  --region="${TARGET_REGION}" \
  --format=json)"; then
  echo "WEST snapshot schedule is unavailable: ${POLICY_NAME}" >&2
  exit 1
fi
if ! jq -e \
  --arg name "${POLICY_NAME}" \
  --arg region "${EXPECTED_REGION_URI}" \
  --arg storageRegion "${TARGET_REGION}" '
  .name == $name and
  .region == $region and
  .snapshotSchedulePolicy.schedule.dailySchedule.daysInCycle == 1 and
  .snapshotSchedulePolicy.schedule.dailySchedule.startTime == "08:00" and
  .snapshotSchedulePolicy.retentionPolicy.maxRetentionDays == 14 and
  .snapshotSchedulePolicy.retentionPolicy.onSourceDiskDelete == "APPLY_RETENTION_POLICY" and
  .snapshotSchedulePolicy.snapshotProperties.storageLocations == [$storageRegion]
  ' \
  <<<"${schedule_json}" >/dev/null; then
  echo "WEST snapshot schedule identity or configuration is invalid: ${POLICY_NAME}" >&2
  exit 1
fi

MODE="verify"
if [[ "${APPLY}" == "true" ]]; then
  MODE="apply"
fi

for pvc_name in "${PVC_NAMES[@]}"; do
  if ! pvc_json="$(kubectl \
    --context "${TARGET_KUBE_CONTEXT}" \
    --namespace "${TARGET_NAMESPACE}" \
    get pvc "${pvc_name}" \
    -o json)"; then
    echo "Durable PVC is unavailable: ${TARGET_NAMESPACE}/${pvc_name}" >&2
    exit 1
  fi

  if ! jq -e \
    --arg namespace "${TARGET_NAMESPACE}" \
    --arg name "${pvc_name}" \
    '.metadata.namespace == $namespace and .metadata.name == $name and .status.phase == "Bound" and (.spec.volumeName | type == "string" and length > 0)' \
    <<<"${pvc_json}" >/dev/null; then
    echo "Durable PVC is not exactly bound: ${TARGET_NAMESPACE}/${pvc_name}" >&2
    exit 1
  fi
  pv_name="$(jq -r '.spec.volumeName' <<<"${pvc_json}")"

  if ! pv_json="$(kubectl \
    --context "${TARGET_KUBE_CONTEXT}" \
    get pv "${pv_name}" \
    -o json)"; then
    echo "PersistentVolume is unavailable: ${pv_name}" >&2
    exit 1
  fi
  if ! jq -e \
    --arg pv "${pv_name}" \
    --arg namespace "${TARGET_NAMESPACE}" \
    --arg pvc "${pvc_name}" \
    '.metadata.name == $pv and .spec.claimRef.namespace == $namespace and .spec.claimRef.name == $pvc' \
    <<<"${pv_json}" >/dev/null; then
    echo "PersistentVolume ${pv_name} claimRef does not match ${TARGET_NAMESPACE}/${pvc_name}" >&2
    exit 1
  fi
  if ! jq -e \
    '.spec.csi.driver == "pd.csi.storage.gke.io" and (.spec.csi.volumeHandle | type == "string" and length > 0)' \
    <<<"${pv_json}" >/dev/null; then
    echo "PersistentVolume ${pv_name} is not a GCE PD CSI volume" >&2
    exit 1
  fi

  volume_handle="$(jq -r '.spec.csi.volumeHandle' <<<"${pv_json}")"
  if [[ ! "${volume_handle}" =~ ^projects/([^/]+)/(zones|regions)/([^/]+)/disks/([^/]+)$ ]]; then
    echo "PersistentVolume ${pv_name} has an invalid GCE disk handle: ${volume_handle}" >&2
    exit 1
  fi
  disk_project="${BASH_REMATCH[1]}"
  disk_scope="${BASH_REMATCH[2]}"
  disk_location="${BASH_REMATCH[3]}"
  disk_name="${BASH_REMATCH[4]}"
  if [[ "${disk_project}" != "${TARGET_CLUSTER_PROJECT}" ]]; then
    echo "PersistentVolume ${pv_name} belongs to unexpected project ${disk_project}" >&2
    exit 1
  fi
  if [[ "${disk_scope}" == "zones" ]]; then
    if [[ "${disk_location}" != "${TARGET_REGION}-"* ]]; then
      echo "PersistentVolume ${pv_name} is outside ${TARGET_REGION}: ${disk_location}" >&2
      exit 1
    fi
    location_argument="--zone=${disk_location}"
  elif [[ "${disk_location}" == "${TARGET_REGION}" ]]; then
    location_argument="--region=${disk_location}"
  else
    echo "PersistentVolume ${pv_name} is outside ${TARGET_REGION}: ${disk_location}" >&2
    exit 1
  fi

  if ! disk_json="$(gcloud compute disks describe "${disk_name}" \
    --project="${TARGET_CLUSTER_PROJECT}" \
    "${location_argument}" \
    --format=json)"; then
    echo "GCE disk is unavailable: ${disk_name}" >&2
    exit 1
  fi
  if ! jq -e '(.resourcePolicies // []) | type == "array"' <<<"${disk_json}" >/dev/null; then
    echo "GCE disk ${disk_name} returned an invalid resource policy inventory" >&2
    exit 1
  fi

  unexpected_policy="$(jq -r --arg expected "${EXPECTED_POLICY_URI}" '(.resourcePolicies // [])[] | select(. != $expected)' <<<"${disk_json}" | head -n 1)"
  if [[ -n "${unexpected_policy}" ]]; then
    echo "GCE disk ${disk_name} has unexpected resource policy: ${unexpected_policy}" >&2
    exit 1
  fi
  attached_this_run=false
  policy_count="$(jq '(.resourcePolicies // []) | length' <<<"${disk_json}")"
  if [[ "${policy_count}" -eq 0 ]]; then
    if [[ "${APPLY}" != "true" ]]; then
      echo "GCE disk ${disk_name} has no WEST snapshot schedule" >&2
      exit 1
    fi
    gcloud compute disks add-resource-policies "${disk_name}" \
      --project="${TARGET_CLUSTER_PROJECT}" \
      "${location_argument}" \
      --resource-policies="${POLICY_NAME}" \
      --quiet >/dev/null
    attached_this_run=true
    if ! disk_json="$(gcloud compute disks describe "${disk_name}" \
      --project="${TARGET_CLUSTER_PROJECT}" \
      "${location_argument}" \
      --format=json)"; then
      echo "GCE disk disappeared after snapshot schedule attachment: ${disk_name}" >&2
      exit 1
    fi
  fi
  if ! jq -e \
    --arg expected "${EXPECTED_POLICY_URI}" \
    '(.resourcePolicies // []) == [$expected]' \
    <<<"${disk_json}" >/dev/null; then
    echo "GCE disk ${disk_name} did not converge to the exact WEST snapshot schedule" >&2
    exit 1
  fi

  entry_file="${TEMP_DIR}/${pvc_name}.json"
  next_disks_json="${TEMP_DIR}/${pvc_name}-disks.json"
  jq -n \
    --arg pvc "${pvc_name}" \
    --arg pv "${pv_name}" \
    --arg disk "${disk_name}" \
    --arg scope "${disk_scope}" \
    --arg location "${disk_location}" \
    --arg policy "${EXPECTED_POLICY_URI}" \
    --argjson attachedThisRun "${attached_this_run}" \
    '{pvc: $pvc, pv: $pv, disk: $disk, scope: $scope, location: $location, policy: $policy, attachedThisRun: $attachedThisRun}' \
    >"${entry_file}"
  jq --slurpfile entry "${entry_file}" '. + [$entry[0]]' "${DISKS_JSON}" >"${next_disks_json}"
  mv "${next_disks_json}" "${DISKS_JSON}"
done

RUN_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
GIT_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg gitCommit "${GIT_COMMIT}" \
  --arg target "${TARGET_ID}" \
  --arg namespace "${TARGET_NAMESPACE}" \
  --arg mode "${MODE}" \
  --slurpfile disks "${DISKS_JSON}" \
  '{schemaVersion: 1, phase: "west-pvc-snapshot-schedules", generatedAt: $generatedAt, gitCommit: $gitCommit, target: $target, namespace: $namespace, mode: $mode, disks: $disks[0]}' \
  >"${RECEIPT_FILE}"

if [[ "${APPLY}" == "true" ]]; then
  gcloud storage cp \
    "${RECEIPT_FILE}" \
    "${RECEIPT_BUCKET}/${RUN_TIMESTAMP}-${TARGET_ID}-${GIT_COMMIT}.json" \
    --project="${TARGET_CLUSTER_PROJECT}" \
    --quiet \
    >/dev/null
fi
cat "${RECEIPT_FILE}"
