#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERRAFORM_ROOT="${REPO_ROOT}/terraform/environments/west-platform"
TERRAFORM_BIN="$("${REPO_ROOT}/scripts/ops/terraform-bin.sh")"
RECEIPT_GENERATOR="${REPO_ROOT}/scripts/ops/terraform-plan-receipt.mjs"
PLAN_VERIFIER="${REPO_ROOT}/scripts/ops/verify-west-ingress-plan.mjs"
INGRESS_STATE_ADOPTER="${REPO_ROOT}/scripts/ops/adopt-west-ingress-addresses.sh"
RETIREMENT_PREFLIGHT="${REPO_ROOT}/scripts/ops/verify-retired-west-ingress-unused.sh"
EXPECTED_CONFIRMATION="octogee/us-west1/ingress-addresses"
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
  echo "Apply requires --confirm=octogee/us-west1/ingress-addresses" >&2
  exit 2
fi

if [[ "${APPLY}" == "true" || "${VERIFY_ONLY}" == "true" ]]; then
  if [[ -n "$(git -C "${REPO_ROOT}" status --porcelain)" ]]; then
    echo "WEST ingress working tree must be clean before apply" >&2
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

for command in gcloud node; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  fi
done

TEMP_DIR="$(mktemp -d -t octogee-west-ingress.XXXXXX)"
PRE_APPLY_PLAN="${TEMP_DIR}/pre-apply.tfplan"
PRE_APPLY_RECEIPT="${TEMP_DIR}/pre-apply.json"
ZERO_DRIFT_PLAN="${TEMP_DIR}/zero-drift.tfplan"
ZERO_DRIFT_RECEIPT="${TEMP_DIR}/zero-drift.json"
ADDRESS_RECEIPT="${TEMP_DIR}/addresses.json"
DNS_INVENTORY_RECEIPT="${TEMP_DIR}/dns-inventory.json"
RUN_TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
GIT_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"

INGRESS_CHANGE_ADDRESSES=(
  'google_compute_global_address.west_ingress["gitea-ip-test-west"]'
  'google_compute_global_address.west_ingress["gitea-ip-west"]'
  'google_compute_global_address.west_ingress["mattermost-ip-test-west"]'
  'google_compute_global_address.west_ingress["mattermost-ip-west"]'
  'google_compute_global_address.west_ingress["preview-ip-test-west"]'
  'google_compute_global_address.west_ingress["preview-ip-west"]'
  'google_compute_global_address.west_ingress["workspace-api-ip-test-west"]'
  'google_compute_global_address.west_ingress["workspace-api-ip-west"]'
)
INGRESS_DESTRUCTIVE_ADDRESSES=(
  'google_compute_global_address.west_ingress["gitea-ip-test-west"]'
  'google_compute_global_address.west_ingress["mattermost-ip-test-west"]'
  'google_compute_global_address.west_ingress["preview-ip-test-west"]'
)

cleanup() {
  local status=$?
  trap - EXIT
  if ! find "${TEMP_DIR}" -type f -delete; then
    echo "Failed to remove WEST ingress temporary files" >&2
    status=1
  fi
  if ! rmdir "${TEMP_DIR}"; then
    echo "Failed to remove WEST ingress temporary directory" >&2
    status=1
  fi
  exit "${status}"
}
trap cleanup EXIT

write_receipt() {
  local plan_file="$1"
  local phase="$2"
  local receipt_file="$3"
  local receipt_arguments=(
    "--target=west-platform-ingress"
    "--phase=${phase}"
    "--git-commit=${GIT_COMMIT}"
  )
  if [[ "${phase}" == "pre-apply" ]]; then
    local address
    for address in "${INGRESS_CHANGE_ADDRESSES[@]}"; do
      receipt_arguments+=("--allow-change=${address}")
    done
    for address in "${INGRESS_DESTRUCTIVE_ADDRESSES[@]}"; do
      receipt_arguments+=("--allow-destroy=${address}")
    done
  fi
  "${TERRAFORM_BIN}" show -json "${plan_file}" \
    | node "${RECEIPT_GENERATOR}" "${receipt_arguments[@]}" \
    >"${receipt_file}"
}

upload_receipt() {
  local phase="$1"
  local receipt_file="$2"
  gcloud storage cp \
    "${receipt_file}" \
    "${RECEIPT_BUCKET}/${RUN_TIMESTAMP}-ingress-${phase}-${GIT_COMMIT}.json"
}

verify_addresses() {
  "${TERRAFORM_BIN}" output -json ingress_addresses >"${ADDRESS_RECEIPT}"
  node "${PLAN_VERIFIER}" --addresses <"${ADDRESS_RECEIPT}" >/dev/null
}

cd "${TERRAFORM_ROOT}"
"${TERRAFORM_BIN}" init -reconfigure
if [[ "${APPLY}" == "true" ]]; then
  "${INGRESS_STATE_ADOPTER}" \
    "--project=octogee" \
    "--terraform-bin=${TERRAFORM_BIN}" \
    "--confirm=octogee/us-west1/octogee-gateway"
fi
"${TERRAFORM_BIN}" plan \
  -input=false \
  -var=foundation_rebuild=false \
  -var=reserve_ingress_addresses=true \
  -out="${PRE_APPLY_PLAN}"
write_receipt "${PRE_APPLY_PLAN}" pre-apply "${PRE_APPLY_RECEIPT}"
PLAN_RESULT="$(node "${PLAN_VERIFIER}" --plan <"${PRE_APPLY_RECEIPT}")"

if [[ "${VERIFY_ONLY}" == "true" ]]; then
  if [[ "${PLAN_RESULT}" != "unchanged" ]]; then
    echo "WEST ingress verification found unapplied address reservations" >&2
    exit 2
  fi
  verify_addresses
  echo "WEST ingress addresses verified and drift-free."
  exit 0
fi

if [[ "${APPLY}" != "true" ]]; then
  echo "Plan result: ${PLAN_RESULT}. Re-run with --apply --confirm=${EXPECTED_CONFIRMATION} after review."
  exit 0
fi

if [[ "${PLAN_RESULT}" == "retire" || "${PLAN_RESULT}" == "reconcile" ]]; then
  "${RETIREMENT_PREFLIGHT}" \
    "--project=octogee" \
    "--shared-address=workspace-api-ip-test-west" \
    "--cloudflare-zone-id=${CLOUDFLARE_ZONE_ID:-}" \
    "--cloudflare-zone-name=octogee.com" \
    "--kube-context=gke_us-west1_octogee" \
    "--namespace=octogee-test-west" \
    "--ingress-name=octogee-edge-ingress" \
    "--receipt=${DNS_INVENTORY_RECEIPT}" \
    "--retired-address=gitea-ip-test-west" \
    "--retired-address=mattermost-ip-test-west" \
    "--retired-address=preview-ip-test-west" \
    "--hostname=api-test.octogee.com" \
    "--hostname=git-test.octogee.com" \
    "--hostname=mattermost-test.octogee.com" \
    "--hostname=preview-test.octogee.com"
  upload_receipt dns-inventory "${DNS_INVENTORY_RECEIPT}"
fi

upload_receipt pre-apply "${PRE_APPLY_RECEIPT}"
if [[ "${PLAN_RESULT}" != "unchanged" ]]; then
  "${TERRAFORM_BIN}" apply -input=false "${PRE_APPLY_PLAN}"
fi

set +e
"${TERRAFORM_BIN}" plan \
  -input=false \
  -var=foundation_rebuild=false \
  -var=reserve_ingress_addresses=true \
  -detailed-exitcode \
  -out="${ZERO_DRIFT_PLAN}"
ZERO_DRIFT_STATUS=$?
set -e
if [[ "${ZERO_DRIFT_STATUS}" -ne 0 ]]; then
  if [[ "${ZERO_DRIFT_STATUS}" -eq 2 ]]; then
    "${TERRAFORM_BIN}" show -no-color "${ZERO_DRIFT_PLAN}" >&2
    echo "WEST ingress verification found Terraform drift" >&2
  fi
  exit "${ZERO_DRIFT_STATUS}"
fi
write_receipt "${ZERO_DRIFT_PLAN}" zero-drift "${ZERO_DRIFT_RECEIPT}"
node "${PLAN_VERIFIER}" --plan <"${ZERO_DRIFT_RECEIPT}" >/dev/null
verify_addresses
upload_receipt zero-drift "${ZERO_DRIFT_RECEIPT}"
upload_receipt addresses "${ADDRESS_RECEIPT}"
echo "WEST ingress addresses reconciled, verified, and drift-free."
