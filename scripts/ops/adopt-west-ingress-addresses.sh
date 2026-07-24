#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID=""
TERRAFORM_BIN="terraform"
CONFIRMATION=""
EXPECTED_CONFIRMATION="octogee/us-west1/octogee-gateway"

for arg in "$@"; do
  case "${arg}" in
    --project=*) PROJECT_ID="${arg#--project=}" ;;
    --terraform-bin=*) TERRAFORM_BIN="${arg#--terraform-bin=}" ;;
    --confirm=*) CONFIRMATION="${arg#--confirm=}" ;;
    *) echo "Unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done

if [[ -z "${PROJECT_ID}" ]]; then
  echo "--project is required" >&2
  exit 2
fi
if [[ "${CONFIRMATION}" != "${EXPECTED_CONFIRMATION}" ]]; then
  echo "Ingress state adoption requires --confirm=${EXPECTED_CONFIRMATION}" >&2
  exit 2
fi

for command in "${TERRAFORM_BIN}" gcloud jq; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  fi
done

TEMP_DIR="$(mktemp -d -t octogee-west-ingress-adoption.XXXXXX)"
DECLARED_NAMES_JSON="${TEMP_DIR}/declared-names.json"
DECLARED_NAMES="${TEMP_DIR}/declared-names.txt"
STATE_ADDRESSES="${TEMP_DIR}/state-addresses.txt"
DISCOVERY_JSON="${TEMP_DIR}/discovery.json"
DISCOVERY_ERROR="${TEMP_DIR}/discovery-error.txt"

cleanup() {
  local status=$?
  trap - EXIT
  if ! find "${TEMP_DIR}" -type f -delete; then
    echo "Failed to remove WEST ingress adoption temporary files" >&2
    status=1
  fi
  if ! rmdir "${TEMP_DIR}"; then
    echo "Failed to remove WEST ingress adoption temporary directory" >&2
    status=1
  fi
  exit "${status}"
}
trap cleanup EXIT

printf '%s\n' 'jsonencode(sort(tolist(local.ingress_address_names)))' \
  | "${TERRAFORM_BIN}" console -var=reserve_ingress_addresses=true \
  >"${DECLARED_NAMES_JSON}"
jq -er '
  if type != "string" then
    error("Terraform console must return a JSON-encoded string")
  else
    fromjson
  end
  | if
      type != "array" or
      length == 0 or
      length != (unique | length) or
      any(.[];
        type != "string" or
        (test("^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$") | not)
      )
    then
    error("west_ingress names must be a non-empty string array")
  else
    .[]
  end
' "${DECLARED_NAMES_JSON}" >"${DECLARED_NAMES}"
if ! LC_ALL=C sort -c "${DECLARED_NAMES}"; then
  echo "Terraform did not return deterministically ordered WEST ingress names" >&2
  exit 1
fi

"${TERRAFORM_BIN}" state list >"${STATE_ADDRESSES}"
ADOPTED=false

while IFS= read -r name; do
  address="google_compute_global_address.west_ingress[\"${name}\"]"
  if grep -Fqx "${address}" "${STATE_ADDRESSES}"; then
    continue
  fi

  if ! gcloud compute addresses describe "${name}" \
    --global \
    --project="${PROJECT_ID}" \
    --format=json >"${DISCOVERY_JSON}" 2>"${DISCOVERY_ERROR}"; then
    if grep -qiE 'resource.*(was )?not found|not found' "${DISCOVERY_ERROR}"; then
      continue
    fi
    cat "${DISCOVERY_ERROR}" >&2
    echo "Could not determine whether WEST ingress address ${name} exists" >&2
    exit 1
  fi

  if ! jq -e \
    --arg name "${name}" \
    --arg project "${PROJECT_ID}" \
    '
      .name == $name and
      .addressType == "EXTERNAL" and
      (.selfLink | type == "string" and endswith("/projects/" + $project + "/global/addresses/" + $name))
    ' "${DISCOVERY_JSON}" >/dev/null; then
    echo "Existing WEST ingress address ${name} has an unexpected identity; expected project ${PROJECT_ID}, global scope, and EXTERNAL type" >&2
    exit 1
  fi

  "${TERRAFORM_BIN}" import \
    -var=reserve_ingress_addresses=true \
    "${address}" \
    "projects/${PROJECT_ID}/global/addresses/${name}"
  ADOPTED=true
done <"${DECLARED_NAMES}"

if [[ "${ADOPTED}" == "true" ]]; then
  echo "Adopted existing WEST ingress addresses into Terraform state."
else
  echo "No existing WEST ingress addresses required Terraform-state adoption."
fi
