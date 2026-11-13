#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGETS_FILE="${OCTOGEE_DEPLOYMENT_TARGETS:-${REPO_ROOT}/core/src/deployment-targets.json}"
PVC_NAMES=("gitea-shared-storage" "mattermost-data")

for argument in "$@"; do
  case "${argument}" in
    --targets-file=*) TARGETS_FILE="${argument#--targets-file=}" ;;
    --help|-h)
      echo "Usage: $0 [--targets-file=PATH]"
      exit 0
      ;;
    *) echo "Unknown argument: ${argument}" >&2; exit 2 ;;
  esac
done

for command in gcloud jq kubectl; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  fi
done
if [[ ! -f "${TARGETS_FILE}" ]]; then
  echo "Deployment target contract is unavailable: ${TARGETS_FILE}" >&2
  exit 1
fi

ACTIVE_TARGETS_JSON="$(jq -ce '
  def required_active_target($environment):
    (.activeTargets[$environment] // error("activeTargets.\($environment) is required")) as $targetId |
    (.targets[$targetId] // error("activeTargets.\($environment) target is missing: \($targetId)")) as $target |
    if $target.lifecycle != "active" then
      error("activeTargets.\($environment) must map to a lifecycle active target")
    else
      {
        id: $targetId,
        clusterProjectId: $target.clusterProjectId,
        region: $target.region,
        clusterName: $target.clusterName,
        namespace: $target.namespace
      }
    end;
  [
    required_active_target("prod"),
    required_active_target("test")
  ]
' "${TARGETS_FILE}")"

FROZEN_NAMESPACES="$(jq -cer '
  [.targets[] | select(.lifecycle == "frozen") | .namespace] | unique | join("|")
' "${TARGETS_FILE}")"

snapshot_policy_name() {
  case "$1" in
    us-central1) printf '%s\n' 'octogee-central-pvc-daily' ;;
    us-west1) printf '%s\n' 'octogee-west-pvc-daily' ;;
    *)
      echo "No durable PVC snapshot policy is defined for active target region $1" >&2
      return 1
      ;;
  esac
}

verify_target_snapshots() {
  local target_json="$1" target_id project region cluster namespace policy_name policy_uri schedule_json
  target_id="$(jq -r '.id' <<<"${target_json}")"
  project="$(jq -r '.clusterProjectId' <<<"${target_json}")"
  region="$(jq -r '.region' <<<"${target_json}")"
  cluster="$(jq -r '.clusterName' <<<"${target_json}")"
  namespace="$(jq -r '.namespace' <<<"${target_json}")"
  policy_name="$(snapshot_policy_name "${region}")"
  policy_uri="https://www.googleapis.com/compute/v1/projects/${project}/regions/${region}/resourcePolicies/${policy_name}"

  if ! schedule_json="$(gcloud compute resource-policies describe "${policy_name}" --project="${project}" --region="${region}" --format=json)"; then
    echo "Active target ${target_id} lacks required snapshot schedule ${policy_name}" >&2
    return 1
  fi
  if ! jq -e --arg name "${policy_name}" --arg region_uri "https://www.googleapis.com/compute/v1/projects/${project}/regions/${region}" --arg storage_region "${region}" '
    .name == $name and
    .region == $region_uri and
    .snapshotSchedulePolicy.schedule.dailySchedule.daysInCycle == 1 and
    .snapshotSchedulePolicy.schedule.dailySchedule.startTime == "08:00" and
    .snapshotSchedulePolicy.retentionPolicy.maxRetentionDays == 14 and
    .snapshotSchedulePolicy.retentionPolicy.onSourceDiskDelete == "APPLY_RETENTION_POLICY" and
    .snapshotSchedulePolicy.snapshotProperties.storageLocations == [$storage_region]
  ' <<<"${schedule_json}" >/dev/null; then
    echo "Active target ${target_id} snapshot schedule is unsafe: ${policy_name}" >&2
    return 1
  fi

  for pvc_name in "${PVC_NAMES[@]}"; do
    local pvc_json pv_name pv_json volume_handle disk_project disk_scope disk_location disk_name location_argument disk_json
    if ! pvc_json="$(kubectl --context="gke_${project}_${region}_${cluster}" --namespace="${namespace}" get pvc "${pvc_name}" -o json)"; then
      echo "Active target ${target_id} durable PVC is unavailable: ${namespace}/${pvc_name}" >&2
      return 1
    fi
    if ! jq -e --arg namespace "${namespace}" --arg name "${pvc_name}" '
      .metadata.namespace == $namespace and .metadata.name == $name and .status.phase == "Bound" and
      (.spec.volumeName | type == "string" and length > 0)
    ' <<<"${pvc_json}" >/dev/null; then
      echo "Active target ${target_id} durable PVC is not bound: ${namespace}/${pvc_name}" >&2
      return 1
    fi
    pv_name="$(jq -r '.spec.volumeName' <<<"${pvc_json}")"
    if ! pv_json="$(kubectl --context="gke_${project}_${region}_${cluster}" get pv "${pv_name}" -o json)"; then
      echo "Active target ${target_id} PersistentVolume is unavailable: ${pv_name}" >&2
      return 1
    fi
    if ! jq -e --arg namespace "${namespace}" --arg pvc "${pvc_name}" '
      .spec.claimRef.namespace == $namespace and .spec.claimRef.name == $pvc and
      .spec.csi.driver == "pd.csi.storage.gke.io" and
      (.spec.csi.volumeHandle | type == "string" and length > 0)
    ' <<<"${pv_json}" >/dev/null; then
      echo "Active target ${target_id} PersistentVolume is not the exact durable GCE PD claim: ${pv_name}" >&2
      return 1
    fi
    volume_handle="$(jq -r '.spec.csi.volumeHandle' <<<"${pv_json}")"
    if [[ ! "${volume_handle}" =~ ^projects/([^/]+)/(zones|regions)/([^/]+)/disks/([^/]+)$ ]]; then
      echo "Active target ${target_id} PersistentVolume has invalid disk handle: ${volume_handle}" >&2
      return 1
    fi
    disk_project="${BASH_REMATCH[1]}"
    disk_scope="${BASH_REMATCH[2]}"
    disk_location="${BASH_REMATCH[3]}"
    disk_name="${BASH_REMATCH[4]}"
    if [[ "${disk_project}" != "${project}" ]]; then
      echo "Active target ${target_id} PersistentVolume belongs to unexpected project: ${disk_project}" >&2
      return 1
    fi
    if [[ "${disk_scope}" == "zones" && "${disk_location}" == "${region}-"* ]]; then
      location_argument="--zone=${disk_location}"
    elif [[ "${disk_scope}" == "regions" && "${disk_location}" == "${region}" ]]; then
      location_argument="--region=${disk_location}"
    else
      echo "Active target ${target_id} PersistentVolume is outside ${region}: ${volume_handle}" >&2
      return 1
    fi
    if ! disk_json="$(gcloud compute disks describe "${disk_name}" --project="${project}" "${location_argument}" --format=json)"; then
      echo "Active target ${target_id} durable disk is unavailable: ${disk_name}" >&2
      return 1
    fi
    if ! jq -e --arg policy "${policy_uri}" '(.resourcePolicies // []) == [$policy]' <<<"${disk_json}" >/dev/null; then
      echo "Active target ${target_id} durable disk ${disk_name} lacks required snapshot schedule ${policy_name}" >&2
      return 1
    fi
  done
}

while IFS= read -r target_json; do
  verify_target_snapshots "${target_json}"
done < <(jq -c '.[]' <<<"${ACTIVE_TARGETS_JSON}")

active_regions="$(jq -r '[.[].region] | unique | join("|")' <<<"${ACTIVE_TARGETS_JSON}")"
active_clusters="$(jq -r '[.[].clusterName] | unique | join("|")' <<<"${ACTIVE_TARGETS_JSON}")"
active_projects="$(jq -r '[.[].clusterProjectId] | unique' <<<"${ACTIVE_TARGETS_JSON}")"
if [[ "$(jq 'length' <<<"${active_projects}")" -ne 1 ]]; then
  echo "Active target workload policies span multiple cluster projects" >&2
  exit 1
fi
active_project="$(jq -r '.[0]' <<<"${active_projects}")"
policies_json="$(gcloud monitoring policies list --project="${active_project}" --format=json)"
unpaged_namespace_matcher=""
if [[ -n "${FROZEN_NAMESPACES}" ]]; then
  unpaged_namespace_matcher=", namespace!~\"${FROZEN_NAMESPACES}\""
fi

if ! jq -e --arg project "${active_project}" --arg regions "${active_regions}" --arg clusters "${active_clusters}" --arg unpagedMatcher "${unpaged_namespace_matcher}" '
  def expected($severity):
    "max by (alertname, severity, location, namespace, gateway_id) (ALERTS{project_id=\"\($project)\", location=~\"\($regions)\", cluster=~\"\($clusters)\", alertstate=\"firing\", severity=\"\($severity)\"\($unpagedMatcher)})";
  def active_policy($name; $severity; $policy_severity):
    map(select(
      .displayName == $name and
      .enabled == true and
      .severity == $policy_severity and
      ((.notificationChannels // null) | type == "array" and length > 0) and
      (.conditions | length) == 1 and
      ((.conditions[0].conditionPrometheusQueryLanguage.query // "") | rtrimstr("\n")) == expected($severity) and
      (.conditions[0].conditionPrometheusQueryLanguage.duration // "0s") == "0s" and
      .conditions[0].conditionPrometheusQueryLanguage.evaluationInterval == "30s"
    )) | length == 1;
  active_policy("Octogee workload critical"; "critical"; "CRITICAL") and
  active_policy("Octogee workload warning"; "warning"; "WARNING")
' <<<"${policies_json}" >/dev/null; then
  echo "Active target workload alert scope does not cover active targets" >&2
  exit 1
fi

echo "Active target durability verified: durable PVC schedules and workload alert scope cover every active deployment target."
