#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERRAFORM_ROOT="${REPO_ROOT}/terraform/environments/west-platform"
RECEIPT_GENERATOR="${REPO_ROOT}/scripts/ops/terraform-plan-receipt.mjs"
PROTECTION_TARGET_SELECTOR="${REPO_ROOT}/scripts/ops/terraform-protection-targets.mjs"
SQL_STATE_RECONCILER="${REPO_ROOT}/scripts/ops/reconcile-deleted-sql-child-state.sh"
VERIFY_SCRIPT="${REPO_ROOT}/scripts/verify-west-foundation.sh"
TERRAFORM_BIN="$("${REPO_ROOT}/scripts/ops/terraform-bin.sh")"
PROJECT_ID="octogee"
REGION="us-west1"
CLUSTER_NAME="octogee-gateway"
GENERATED_KUBE_CONTEXT="gke_${PROJECT_ID}_${REGION}_${CLUSTER_NAME}"
SHORT_KUBE_CONTEXT="gke_us-west1_octogee"
SQL_INSTANCE="octogee-pg-west"
EXPECTED_CONFIRMATION="octogee/us-west1/octogee-gateway"
RECEIPT_BUCKET="gs://octogee-terraform-state/receipts/west-platform"
APPLY=false
VERIFY_ONLY=false
CONFIRMATION=""

for arg in "$@"; do
  case "${arg}" in
    --apply) APPLY=true ;;
    --verify-only) VERIFY_ONLY=true ;;
    --confirm=*) CONFIRMATION="${arg#--confirm=}" ;;
    *) echo "Unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done

if [[ "${APPLY}" == "true" && "${VERIFY_ONLY}" == "true" ]]; then
  echo "--apply and --verify-only cannot be combined" >&2
  exit 2
fi

if [[ "${APPLY}" == "true" && "${CONFIRMATION}" != "${EXPECTED_CONFIRMATION}" ]]; then
  echo "Apply requires --confirm=octogee/us-west1/octogee-gateway" >&2
  exit 2
fi

if [[ "${APPLY}" == "true" || "${VERIFY_ONLY}" == "true" ]]; then
  if [[ -n "$(git -C "${REPO_ROOT}" status --porcelain)" ]]; then
    echo "WEST foundation working tree must be clean before apply" >&2
    exit 2
  fi
  git -C "${REPO_ROOT}" fetch --quiet origin main
  CURRENT_HEAD="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
  ORIGIN_MAIN_HEAD="$(git -C "${REPO_ROOT}" rev-parse refs/remotes/origin/main)"
  if [[ "${CURRENT_HEAD}" != "${ORIGIN_MAIN_HEAD}" ]]; then
    echo "Apply requires the exact merged origin/main commit" >&2
    exit 2
  fi
fi

for command in gcloud jq kubectl node; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  fi
done

configure_operator_kube_context() {
  local cluster
  local user

  gcloud container clusters get-credentials "${CLUSTER_NAME}" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" >/dev/null
  cluster="$(kubectl config view --raw -o json \
    | jq -r --arg context "${GENERATED_KUBE_CONTEXT}" \
      '.contexts[] | select(.name == $context) | .context.cluster')"
  user="$(kubectl config view --raw -o json \
    | jq -r --arg context "${GENERATED_KUBE_CONTEXT}" \
      '.contexts[] | select(.name == $context) | .context.user')"
  if [[ -z "${cluster}" || -z "${user}" ]]; then
    echo "gcloud did not create the expected WEST kube context" >&2
    return 1
  fi
  kubectl config set-context "${SHORT_KUBE_CONTEXT}" \
    --cluster="${cluster}" \
    --user="${user}" >/dev/null
  kubectl --context "${SHORT_KUBE_CONTEXT}" cluster-info >/dev/null
}

TEMP_DIR="$(mktemp -d -t octogee-west-platform.XXXXXX)"
PRE_APPLY_PLAN="${TEMP_DIR}/pre-apply.tfplan"
PRE_APPLY_RECEIPT="${TEMP_DIR}/pre-apply.json"
POST_RETIREMENT_PLAN="${TEMP_DIR}/post-retirement.tfplan"
POST_RETIREMENT_RECEIPT="${TEMP_DIR}/post-retirement.json"
PROTECTION_PLAN="${TEMP_DIR}/protection.tfplan"
PROTECTION_RECEIPT="${TEMP_DIR}/protection.json"
ZERO_DRIFT_PLAN="${TEMP_DIR}/zero-drift.tfplan"
ZERO_DRIFT_RECEIPT="${TEMP_DIR}/zero-drift.json"
BACKUP_RECEIPT="${TEMP_DIR}/pre-replacement-backup.json"
BACKUP_JSON="${TEMP_DIR}/pre-replacement-backup-source.json"
BACKUP_VERIFICATION_JSON="${TEMP_DIR}/pre-replacement-backup-verification.json"
STATE_ADDRESSES="${TEMP_DIR}/terraform-state-addresses.txt"
PROTECTION_TARGETS="${TEMP_DIR}/terraform-protection-targets.txt"
RUN_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
GIT_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
PROTECTION_REQUIRED=false
APPLY_PLAN="${PRE_APPLY_PLAN}"

DESTRUCTIVE_ADDRESSES=(
  'google_compute_address.west_private_service["gitea"]'
  'google_compute_address.west_private_service["mattermost"]'
  'google_container_cluster.west'
  'google_sql_database_instance.west'
  'google_vpc_access_connector.west'
)

REBUILD_CHANGE_ADDRESSES=(
  'google_compute_address.west_private_service["gitea"]'
  'google_compute_address.west_private_service["mattermost"]'
  'google_compute_global_address.private_services'
  'google_compute_global_address.west_ingress["gitea-ip-test-west"]'
  'google_compute_global_address.west_ingress["gitea-ip-west"]'
  'google_compute_global_address.west_ingress["mattermost-ip-test-west"]'
  'google_compute_global_address.west_ingress["mattermost-ip-west"]'
  'google_compute_global_address.west_ingress["preview-ip-test-west"]'
  'google_compute_global_address.west_ingress["preview-ip-west"]'
  'google_compute_global_address.west_ingress["workspace-api-ip-test-west"]'
  'google_compute_global_address.west_ingress["workspace-api-ip-west"]'
  'google_compute_network.west'
  'google_compute_resource_policy.west_pvc_snapshots'
  'google_compute_router.west'
  'google_compute_router_nat.west'
  'google_compute_subnetwork.connector'
  'google_compute_subnetwork.gke'
  'google_container_cluster.west'
  'google_monitoring_alert_policy.gke_notifications'
  'google_monitoring_alert_policy.workload_critical'
  'google_monitoring_alert_policy.workload_warning'
  'google_monitoring_notification_channel.operator_email'
  'google_project_iam_custom_role.github_actions_west_pvc_snapshots'
  'google_project_iam_member.github_actions_west_pvc_snapshots'
  'google_project_service_identity.cloud_sql'
  'google_project_service.required["pubsub.googleapis.com"]'
  'google_project_service.required["storage.googleapis.com"]'
  'google_pubsub_subscription.gke_notifications_archive'
  'google_pubsub_topic.gke_notifications'
  'google_service_networking_connection.private_services'
  'google_sql_database.environment["gitea_prod"]'
  'google_sql_database.environment["gitea_test"]'
  'google_sql_database.environment["mattermost_prod"]'
  'google_sql_database.environment["mattermost_test"]'
  'google_sql_database_instance.west'
  'google_storage_bucket.west_recovery'
  'google_storage_bucket_iam_member.cloud_sql_recovery'
  'google_vpc_access_connector.west'
)

PROTECTION_CHANGE_ADDRESSES=(
  'google_container_cluster.west'
  'google_sql_database_instance.west'
  'google_vpc_access_connector.west'
)

SQL_CHILD_STATE_ADDRESSES=(
  'google_sql_database.environment["gitea_prod"]'
  'google_sql_database.environment["gitea_test"]'
  'google_sql_database.environment["mattermost_prod"]'
  'google_sql_database.environment["mattermost_test"]'
)

write_receipt() {
  local plan_file="$1"
  local phase="$2"
  local receipt_file="$3"
  local review_scope="$4"
  local receipt_arguments=(
    "--target=west-platform"
    "--phase=${phase}"
    "--git-commit=${GIT_COMMIT}"
  )

  if [[ "${review_scope}" == "rebuild" ]]; then
    local address
    for address in "${DESTRUCTIVE_ADDRESSES[@]}"; do
      receipt_arguments+=("--allow-destroy=${address}")
    done
    for address in "${REBUILD_CHANGE_ADDRESSES[@]}"; do
      receipt_arguments+=("--allow-change=${address}")
    done
  elif [[ "${review_scope}" == "protection" ]]; then
    local address
    for address in "${PROTECTION_CHANGE_ADDRESSES[@]}"; do
      receipt_arguments+=("--allow-change=${address}")
    done
  elif [[ "${review_scope}" != "zero-drift" ]]; then
    echo "Unknown WEST receipt review scope: ${review_scope}" >&2
    return 1
  fi

  "${TERRAFORM_BIN}" show -json "${plan_file}" \
    | node "${RECEIPT_GENERATOR}" "${receipt_arguments[@]}" \
    >"${receipt_file}"
  jq . "${receipt_file}"
}

upload_receipt() {
  local phase="$1"
  local receipt_file="$2"
  gcloud storage cp \
    "${receipt_file}" \
    "${RECEIPT_BUCKET}/${RUN_TIMESTAMP}-${phase}-${GIT_COMMIT}.json"
}

receipt_requires_deletion() {
  local receipt_file="$1"
  local address="$2"
  jq -e \
    --arg address "${address}" \
    'any(.changes[]?; .address == $address and (.actions | index("delete") != null))' \
    "${receipt_file}" >/dev/null
}

reconcile_deleted_sql_child_state() {
  local arguments=(
    "--project=${PROJECT_ID}"
    "--instance=${SQL_INSTANCE}"
    "--terraform-bin=${TERRAFORM_BIN}"
    "--selector=${PROTECTION_TARGET_SELECTOR}"
    "--receipt-bucket=${RECEIPT_BUCKET}"
    "--run-timestamp=${RUN_TIMESTAMP}"
    "--git-commit=${GIT_COMMIT}"
    "--temp-dir=${TEMP_DIR}"
  )
  local address
  for address in "${SQL_CHILD_STATE_ADDRESSES[@]}"; do
    arguments+=("--candidate=${address}")
  done
  "${SQL_STATE_RECONCILER}" "${arguments[@]}"
}

retire_replaced_foundation() {
  if [[ "${CLUSTER_REPLACEMENT_REQUIRED}" == "true" ]]; then
    local cluster_name
    cluster_name="$(gcloud container clusters list \
      --project="${PROJECT_ID}" \
      --filter="name=${CLUSTER_NAME} AND location=${REGION}" \
      --format='value(name)')"
    if [[ "${cluster_name}" == "${CLUSTER_NAME}" ]]; then
      gcloud container clusters delete "${CLUSTER_NAME}" \
        --project="${PROJECT_ID}" \
        --region="${REGION}" \
        --quiet
    elif [[ -n "${cluster_name}" ]]; then
      echo "Unexpected WEST cluster inventory: ${cluster_name}" >&2
      return 1
    fi
  fi

  if [[ "${SQL_REPLACEMENT_REQUIRED}" == "true" ]]; then
    local sql_instance
    sql_instance="$(gcloud sql instances list \
      --project="${PROJECT_ID}" \
      --filter="name=${SQL_INSTANCE}" \
      --format='value(name)')"
    if [[ "${sql_instance}" == "${SQL_INSTANCE}" ]]; then
      gcloud sql instances patch "${SQL_INSTANCE}" \
        --project="${PROJECT_ID}" \
        --no-deletion-protection \
        --retain-backups-on-delete \
        --quiet
      if ! gcloud sql instances delete "${SQL_INSTANCE}" \
        --project="${PROJECT_ID}" \
        --enable-final-backup \
        --final-backup-description="private-west-foundation-rebuild-${RUN_TIMESTAMP}" \
        --final-backup-retention-days=30 \
        --quiet; then
        echo "Cloud SQL retirement failed; restoring API deletion protection" >&2
        gcloud sql instances patch "${SQL_INSTANCE}" \
          --project="${PROJECT_ID}" \
          --deletion-protection \
          --retain-backups-on-delete \
          --quiet
        return 1
      fi
    elif [[ -n "${sql_instance}" ]]; then
      echo "Unexpected WEST Cloud SQL inventory: ${sql_instance}" >&2
      return 1
    fi
    reconcile_deleted_sql_child_state
  fi
}

protect_foundation() {
  local phase="$1"
  shift

  "${TERRAFORM_BIN}" plan \
    -input=false \
    -var=foundation_rebuild=false \
    "$@" \
    -out="${PROTECTION_PLAN}" || return 1
  write_receipt "${PROTECTION_PLAN}" "${phase}" "${PROTECTION_RECEIPT}" protection || return 1
  "${TERRAFORM_BIN}" apply -input=false "${PROTECTION_PLAN}" || return 1
  upload_receipt "${phase}" "${PROTECTION_RECEIPT}" || return 1
}

emergency_protect_foundation() {
  local selector_arguments=()
  local address
  local phase
  local protection_failed=false
  local target_index=0

  "${TERRAFORM_BIN}" state list >"${STATE_ADDRESSES}" || return 1
  for address in "${PROTECTION_CHANGE_ADDRESSES[@]}"; do
    selector_arguments+=("--candidate=${address}")
  done
  node "${PROTECTION_TARGET_SELECTOR}" "${selector_arguments[@]}" \
    <"${STATE_ADDRESSES}" \
    >"${PROTECTION_TARGETS}" || return 1

  if [[ ! -s "${PROTECTION_TARGETS}" ]]; then
    echo "No protection-capable WEST resources are present in Terraform state" >&2
    PROTECTION_REQUIRED=false
    return 0
  fi

  while IFS= read -r address; do
    [[ -z "${address}" ]] && continue
    target_index=$((target_index + 1))
    phase="emergency-protection-${target_index}"
    if ! protect_foundation "${phase}" "-target=${address}"; then
      echo "Emergency protection failed for ${address}" >&2
      protection_failed=true
    fi
  done <"${PROTECTION_TARGETS}"

  if [[ "${protection_failed}" == "true" ]]; then
    return 1
  fi
  PROTECTION_REQUIRED=false
}

cleanup() {
  local status=$?
  trap - EXIT

  if [[ "${PROTECTION_REQUIRED}" == "true" ]]; then
    echo "Restoring WEST foundation deletion protection after an interrupted rebuild" >&2
    if ! emergency_protect_foundation; then
      echo "CRITICAL: WEST foundation deletion protection could not be restored" >&2
      status=1
    fi
  fi

  if ! find "${TEMP_DIR}" -type f -delete; then
    echo "Failed to remove WEST foundation temporary files" >&2
    status=1
  fi
  if ! rmdir "${TEMP_DIR}"; then
    echo "Failed to remove WEST foundation temporary directory" >&2
    status=1
  fi
  exit "${status}"
}
trap cleanup EXIT

verify_zero_drift() {
  "${VERIFY_SCRIPT}"

  set +e
  "${TERRAFORM_BIN}" plan \
    -input=false \
    -detailed-exitcode \
    -out="${ZERO_DRIFT_PLAN}"
  ZERO_DRIFT_STATUS=$?
  set -e

  if [[ "${ZERO_DRIFT_STATUS}" -ne 0 ]]; then
    if [[ "${ZERO_DRIFT_STATUS}" -eq 2 ]]; then
      "${TERRAFORM_BIN}" show -no-color "${ZERO_DRIFT_PLAN}" >&2
      echo "WEST foundation verification found Terraform drift" >&2
    fi
    exit "${ZERO_DRIFT_STATUS}"
  fi

  write_receipt "${ZERO_DRIFT_PLAN}" "zero-drift" "${ZERO_DRIFT_RECEIPT}" zero-drift
  upload_receipt "zero-drift" "${ZERO_DRIFT_RECEIPT}"
  configure_operator_kube_context
}

cd "${TERRAFORM_ROOT}"
"${TERRAFORM_BIN}" init -reconfigure

if [[ "${VERIFY_ONLY}" == "true" ]]; then
  verify_zero_drift
  echo "WEST foundation verified and drift-free."
  exit 0
fi

if [[ "${APPLY}" == "true" ]]; then
  reconcile_deleted_sql_child_state
fi

"${TERRAFORM_BIN}" plan \
  -input=false \
  -var=foundation_rebuild=true \
  -out="${PRE_APPLY_PLAN}"
write_receipt "${PRE_APPLY_PLAN}" "pre-apply" "${PRE_APPLY_RECEIPT}" rebuild

if [[ "${APPLY}" != "true" ]]; then
  echo "Plan only. Re-run with --apply --confirm=${EXPECTED_CONFIRMATION} after review."
  exit 0
fi

if receipt_requires_deletion \
  "${PRE_APPLY_RECEIPT}" \
  'google_container_cluster.west'; then
  CLUSTER_REPLACEMENT_REQUIRED=true
else
  CLUSTER_REPLACEMENT_REQUIRED=false
fi

if receipt_requires_deletion \
  "${PRE_APPLY_RECEIPT}" \
  'google_sql_database_instance.west'; then
  SQL_REPLACEMENT_REQUIRED=true
else
  SQL_REPLACEMENT_REQUIRED=false
fi

if [[ "${SQL_REPLACEMENT_REQUIRED}" == "true" ]]; then
  gcloud sql instances describe "${SQL_INSTANCE}" \
    --project="${PROJECT_ID}" \
    --format=json >"${BACKUP_JSON}"
  BACKUP_DESCRIPTION="pre-private-west-foundation-${RUN_TIMESTAMP}"
  gcloud sql instances patch "${SQL_INSTANCE}" \
    --project="${PROJECT_ID}" \
    --retain-backups-on-delete \
    --quiet
  gcloud sql backups create \
    --instance="${SQL_INSTANCE}" \
    --project="${PROJECT_ID}" \
    --description="${BACKUP_DESCRIPTION}" \
    --quiet
  BACKUP_ID="$(gcloud sql backups list \
    --instance="${SQL_INSTANCE}" \
    --project="${PROJECT_ID}" \
    --filter="description=${BACKUP_DESCRIPTION}" \
    --limit=1 \
    --format='value(id)')"
  if [[ -z "${BACKUP_ID}" ]]; then
    echo "Cloud SQL did not return the pre-replacement backup ID" >&2
    exit 1
  fi
  gcloud sql backups describe "${BACKUP_ID}" \
    --instance="${SQL_INSTANCE}" \
    --project="${PROJECT_ID}" \
    --format=json >"${BACKUP_VERIFICATION_JSON}"
  if ! jq -e '.status == "SUCCESSFUL"' "${BACKUP_VERIFICATION_JSON}" >/dev/null; then
    echo "Cloud SQL pre-replacement backup is not successful" >&2
    jq '{id, status, description}' "${BACKUP_VERIFICATION_JSON}" >&2
    exit 1
  fi
  jq -n \
    --arg backupId "${BACKUP_ID}" \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg gitCommit "${GIT_COMMIT}" \
    --arg instance "${SQL_INSTANCE}" \
    '{schemaVersion: 1, target: "west-platform", phase: "pre-replacement-backup", generatedAt: $createdAt, gitCommit: $gitCommit, instance: $instance, backupId: $backupId, retainBackupsOnDelete: true}' \
    >"${BACKUP_RECEIPT}"
  upload_receipt "pre-replacement-backup" "${BACKUP_RECEIPT}"
fi

upload_receipt "pre-apply" "${PRE_APPLY_RECEIPT}"
if [[ "${CLUSTER_REPLACEMENT_REQUIRED}" == "true" || "${SQL_REPLACEMENT_REQUIRED}" == "true" ]]; then
  retire_replaced_foundation
  "${TERRAFORM_BIN}" plan \
    -input=false \
    -var=foundation_rebuild=true \
    -out="${POST_RETIREMENT_PLAN}"
  write_receipt \
    "${POST_RETIREMENT_PLAN}" \
    "post-retirement" \
    "${POST_RETIREMENT_RECEIPT}" \
    rebuild
  upload_receipt "post-retirement" "${POST_RETIREMENT_RECEIPT}"
  APPLY_PLAN="${POST_RETIREMENT_PLAN}"
fi
PROTECTION_REQUIRED=true
"${TERRAFORM_BIN}" apply -input=false "${APPLY_PLAN}"
protect_foundation "protection"
PROTECTION_REQUIRED=false
"${REPO_ROOT}/scripts/setup-cloud-sql.sh" --target=test-west --rotate
verify_zero_drift
echo "WEST foundation rebuilt, verified, protected, and drift-free."
