#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID=""
SQL_INSTANCE=""
TERRAFORM_BIN=""
SELECTOR=""
RECEIPT_BUCKET=""
RUN_TIMESTAMP=""
GIT_COMMIT=""
TEMP_DIR=""
CANDIDATE_ADDRESSES=()

for argument in "$@"; do
  case "${argument}" in
    --project=*) PROJECT_ID="${argument#--project=}" ;;
    --instance=*) SQL_INSTANCE="${argument#--instance=}" ;;
    --terraform-bin=*) TERRAFORM_BIN="${argument#--terraform-bin=}" ;;
    --selector=*) SELECTOR="${argument#--selector=}" ;;
    --receipt-bucket=*) RECEIPT_BUCKET="${argument#--receipt-bucket=}" ;;
    --run-timestamp=*) RUN_TIMESTAMP="${argument#--run-timestamp=}" ;;
    --git-commit=*) GIT_COMMIT="${argument#--git-commit=}" ;;
    --temp-dir=*) TEMP_DIR="${argument#--temp-dir=}" ;;
    --candidate=*) CANDIDATE_ADDRESSES+=("${argument#--candidate=}") ;;
    *) echo "Unknown argument: ${argument}" >&2; exit 2 ;;
  esac
done

for required_value in \
  "${PROJECT_ID}" \
  "${SQL_INSTANCE}" \
  "${TERRAFORM_BIN}" \
  "${SELECTOR}" \
  "${RECEIPT_BUCKET}" \
  "${RUN_TIMESTAMP}" \
  "${GIT_COMMIT}" \
  "${TEMP_DIR}"; do
  if [[ -z "${required_value}" ]]; then
    echo "All reconciliation arguments are required" >&2
    exit 2
  fi
done
if [[ "${#CANDIDATE_ADDRESSES[@]}" -eq 0 ]]; then
  echo "At least one --candidate Terraform state address is required" >&2
  exit 2
fi
if [[ ! -x "${TERRAFORM_BIN}" ]]; then
  echo "Terraform binary is unavailable: ${TERRAFORM_BIN}" >&2
  exit 1
fi
if [[ ! -f "${SELECTOR}" ]]; then
  echo "Terraform state selector is unavailable: ${SELECTOR}" >&2
  exit 1
fi

STATE_BEFORE="${TEMP_DIR}/terraform-sql-child-state-before.txt"
TARGETS_BEFORE="${TEMP_DIR}/terraform-sql-child-state-targets-before.txt"
TARGETS_BEFORE_JSON="${TEMP_DIR}/terraform-sql-child-state-targets-before.json"
EXPECTED_ADDRESSES="${TEMP_DIR}/terraform-sql-child-state-expected.txt"
EXPECTED_ADDRESSES_JSON="${TEMP_DIR}/terraform-sql-child-state-expected.json"
STATE_AFTER="${TEMP_DIR}/terraform-sql-child-state-after.txt"
TARGETS_AFTER="${TEMP_DIR}/terraform-sql-child-state-targets-after.txt"
TARGETS_AFTER_JSON="${TEMP_DIR}/terraform-sql-child-state-targets-after.json"
INTENT_RECEIPT="${TEMP_DIR}/terraform-sql-child-state-intent.json"
COMPLETION_RECEIPT="${TEMP_DIR}/terraform-sql-child-state-completion.json"

discover_sql_inventory() {
  if ! gcloud sql instances list \
    --project="${PROJECT_ID}" \
    --filter="name=${SQL_INSTANCE}" \
    --format='value(name)'; then
    echo "Cloud SQL inventory discovery failed; refusing state retirement" >&2
    return 1
  fi
}

select_candidates() {
  local state_file="$1"
  local output_file="$2"
  local selector_arguments=()
  local address
  for address in "${CANDIDATE_ADDRESSES[@]}"; do
    selector_arguments+=("--candidate=${address}")
  done
  node "${SELECTOR}" "${selector_arguments[@]}" <"${state_file}" >"${output_file}"
}

upload_receipt() {
  local phase="$1"
  local receipt_file="$2"
  gcloud storage cp \
    "${receipt_file}" \
    "${RECEIPT_BUCKET}/${RUN_TIMESTAMP}-${phase}-${GIT_COMMIT}.json"
}

if ! sql_instance_inventory="$(discover_sql_inventory)"; then
  exit 1
fi
if [[ "${sql_instance_inventory}" == "${SQL_INSTANCE}" ]]; then
  exit 0
fi
if [[ -n "${sql_instance_inventory}" ]]; then
  echo "Unexpected WEST Cloud SQL inventory: ${sql_instance_inventory}" >&2
  exit 1
fi

printf '%s\n' "${CANDIDATE_ADDRESSES[@]}" >"${EXPECTED_ADDRESSES}"
jq -Rsc 'split("\n") | map(select(length > 0))' \
  "${EXPECTED_ADDRESSES}" \
  >"${EXPECTED_ADDRESSES_JSON}"
"${TERRAFORM_BIN}" state list >"${STATE_BEFORE}"
select_candidates "${STATE_BEFORE}" "${TARGETS_BEFORE}"
jq -Rsc 'split("\n") | map(select(length > 0))' \
  "${TARGETS_BEFORE}" \
  >"${TARGETS_BEFORE_JSON}"

if [[ -s "${TARGETS_BEFORE}" ]]; then
  jq -n \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg gitCommit "${GIT_COMMIT}" \
    --arg instance "${SQL_INSTANCE}" \
    --slurpfile stateAddresses "${TARGETS_BEFORE_JSON}" \
    '{schemaVersion: 1, target: "west-platform", phase: "pre-sql-child-state-retirement", generatedAt: $generatedAt, gitCommit: $gitCommit, instance: $instance, stateAddresses: $stateAddresses[0]}' \
    >"${INTENT_RECEIPT}"
  upload_receipt "pre-sql-child-state-retirement" "${INTENT_RECEIPT}"

  if ! sql_instance_inventory="$(discover_sql_inventory)"; then
    exit 1
  fi
  if [[ -n "${sql_instance_inventory}" ]]; then
    echo "WEST Cloud SQL appeared before state retirement; refusing mutation" >&2
    exit 1
  fi

  while IFS= read -r address; do
    [[ -z "${address}" ]] && continue
    "${TERRAFORM_BIN}" state rm "${address}"
  done <"${TARGETS_BEFORE}"
fi

"${TERRAFORM_BIN}" state list >"${STATE_AFTER}"
select_candidates "${STATE_AFTER}" "${TARGETS_AFTER}"
jq -Rsc 'split("\n") | map(select(length > 0))' \
  "${TARGETS_AFTER}" \
  >"${TARGETS_AFTER_JSON}"
if [[ -s "${TARGETS_AFTER}" ]]; then
  echo "Cloud SQL child state remains after retirement" >&2
  cat "${TARGETS_AFTER}" >&2
  exit 1
fi

jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg gitCommit "${GIT_COMMIT}" \
  --arg instance "${SQL_INSTANCE}" \
  --slurpfile retiredThisRun "${TARGETS_BEFORE_JSON}" \
  --slurpfile verifiedAbsentStateAddresses "${EXPECTED_ADDRESSES_JSON}" \
  --slurpfile remainingStateAddresses "${TARGETS_AFTER_JSON}" \
  '{schemaVersion: 1, target: "west-platform", phase: "sql-child-state-retirement", generatedAt: $generatedAt, gitCommit: $gitCommit, instance: $instance, retiredThisRun: $retiredThisRun[0], verifiedAbsentStateAddresses: $verifiedAbsentStateAddresses[0], remainingStateAddresses: $remainingStateAddresses[0]}' \
  >"${COMPLETION_RECEIPT}"
upload_receipt "sql-child-state-retirement" "${COMPLETION_RECEIPT}"
