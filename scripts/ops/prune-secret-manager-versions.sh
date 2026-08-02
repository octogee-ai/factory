#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT_ID=""
APPLY=false
CONFIRMATION=""
RECEIPT_BUCKET="gs://octogee-terraform-state/receipts/secret-manager-version-prune"
RUN_ID="${SECRET_PRUNE_RUN_ID:-$(date -u +%Y%m%dt%H%M%Sz)}"

for argument in "$@"; do
  case "${argument}" in
    --project=*) PROJECT_ID="${argument#--project=}" ;;
    --apply) APPLY=true ;;
    --confirm=*) CONFIRMATION="${argument#--confirm=}" ;;
    *) echo "Unknown argument: ${argument}" >&2; exit 2 ;;
  esac
done

case "${PROJECT_ID}" in
  octogee|octogee-test|octogee-data-test|octogee-data-prod) ;;
  *) echo "Project must be octogee, octogee-test, octogee-data-test, or octogee-data-prod" >&2; exit 2 ;;
esac
if [[ ! "${RUN_ID}" =~ ^[a-z0-9-]+$ ]]; then
  echo "SECRET_PRUNE_RUN_ID must contain only lowercase letters, digits, and hyphens" >&2
  exit 2
fi

EXPECTED_CONFIRMATION="octogee/secret-versions/${PROJECT_ID}"
if [[ "${APPLY}" == "true" && "${CONFIRMATION}" != "${EXPECTED_CONFIRMATION}" ]]; then
  echo "Secret version pruning requires --confirm=${EXPECTED_CONFIRMATION}" >&2
  exit 2
fi

if [[ "${APPLY}" == "true" ]]; then
  if [[ -n "$(git -C "${REPO_ROOT}" status --porcelain)" ]]; then
    echo "Secret version pruning working tree must be clean" >&2
    exit 2
  fi
  git -C "${REPO_ROOT}" fetch --quiet origin main
  GIT_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
  ORIGIN_MAIN_HEAD="$(git -C "${REPO_ROOT}" rev-parse refs/remotes/origin/main)"
  if [[ "${GIT_COMMIT}" != "${ORIGIN_MAIN_HEAD}" ]]; then
    echo "Secret version pruning requires the exact merged origin/main commit" >&2
    exit 2
  fi
else
  GIT_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
fi

for command in gcloud git jq; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  fi
done

TEMP_DIR="$(mktemp -d -t octogee-secret-version-prune.XXXXXX)"
SECRETS_FILE="${TEMP_DIR}/secrets.json"
CANDIDATES_FILE="${TEMP_DIR}/candidates.json"
EMPTY_FILE="${TEMP_DIR}/empty.json"
RECEIPT_FILE="${TEMP_DIR}/receipt.json"
printf '%s\n' '[]' >"${CANDIDATES_FILE}"
printf '%s\n' '[]' >"${EMPTY_FILE}"
EXCLUDED_CUSTOMER_CREDENTIALS=0

cleanup() {
  find "${TEMP_DIR}" -type f -delete
  rmdir "${TEMP_DIR}"
}
trap cleanup EXIT

if ! gcloud secrets list --project="${PROJECT_ID}" --format=json >"${SECRETS_FILE}"; then
  echo "Failed to list Secret Manager secrets for ${PROJECT_ID}" >&2
  exit 1
fi

while IFS= read -r secret_json; do
  secret_name="$(jq -r '.name | split("/") | last' <<<"${secret_json}")"
  case "${secret_name}" in
    byok-*|byosub-*|gateway-model-key-*)
      EXCLUDED_CUSTOMER_CREDENTIALS=$((EXCLUDED_CUSTOMER_CREDENTIALS + 1))
      continue
      ;;
  esac
  if jq -e '
    ((.labels.uid // "") | length) > 0 or
    ((.labels.slug // "") | length) > 0 or
    .labels.byosub == "true" or
    .labels.octogee_kind == "gateway_model_key"
  ' <<<"${secret_json}" >/dev/null; then
    EXCLUDED_CUSTOMER_CREDENTIALS=$((EXCLUDED_CUSTOMER_CREDENTIALS + 1))
    continue
  fi
  versions_file="${TEMP_DIR}/${secret_name}-versions.json"
  active_file="${TEMP_DIR}/${secret_name}-active.json"
  next_file="${TEMP_DIR}/${secret_name}-next.json"
  if ! gcloud secrets versions list "${secret_name}" --project="${PROJECT_ID}" --format=json >"${versions_file}"; then
    echo "Failed to list versions for ${PROJECT_ID}/${secret_name}" >&2
    exit 1
  fi
  jq '
    map(select(.state == "ENABLED" or .state == "DISABLED")) |
    sort_by(.name | split("/") | last | tonumber) |
    reverse
  ' "${versions_file}" >"${active_file}"
  version_count="$(jq 'length' "${active_file}")"
  if [[ "${version_count}" -eq 0 ]]; then
    jq --arg secret "${secret_name}" '. + [$secret]' "${EMPTY_FILE}" >"${next_file}"
    mv "${next_file}" "${EMPTY_FILE}"
    continue
  fi
  latest_state="$(jq -r '.[0].state' "${active_file}")"
  latest_version="$(jq -r '.[0].name | split("/") | last' "${active_file}")"
  if [[ "${latest_state}" != "ENABLED" ]]; then
    echo "Secret ${PROJECT_ID}/${secret_name} newest version is not enabled: ${latest_version}" >&2
    exit 1
  fi
  if [[ "${version_count}" -eq 1 ]]; then
    continue
  fi
  entry_file="${TEMP_DIR}/${secret_name}-candidate.json"
  jq -n \
    --arg secret "${secret_name}" \
    --arg keptVersion "${latest_version}" \
    --slurpfile active "${active_file}" '
      {
        secret: $secret,
        keptVersion: $keptVersion,
        versions: [
          $active[0][1:][] |
          {version: (.name | split("/") | last), state: .state}
        ]
      }
    ' >"${entry_file}"
  jq --slurpfile entry "${entry_file}" '. + [$entry[0]]' "${CANDIDATES_FILE}" >"${next_file}"
  mv "${next_file}" "${CANDIDATES_FILE}"
done < <(jq -c 'sort_by(.name)[]' "${SECRETS_FILE}")

MODE="dry-run"
DESTROYED_VERSIONS=0
if [[ "${APPLY}" == "true" ]]; then
  MODE="apply"
  while IFS=$'\t' read -r secret_name version; do
    if ! gcloud secrets versions destroy "${version}" \
      --secret="${secret_name}" \
      --project="${PROJECT_ID}" \
      --quiet \
      >/dev/null; then
      echo "Failed to destroy superseded version ${PROJECT_ID}/${secret_name}/${version}" >&2
      exit 1
    fi
    DESTROYED_VERSIONS=$((DESTROYED_VERSIONS + 1))
  done < <(jq -r '.[] | .secret as $secret | .versions[] | [$secret, .version] | @tsv' "${CANDIDATES_FILE}")

  while IFS=$'\t' read -r secret_name kept_version; do
    verify_file="${TEMP_DIR}/${secret_name}-verify.json"
    if ! gcloud secrets versions list "${secret_name}" --project="${PROJECT_ID}" --format=json >"${verify_file}"; then
      echo "Failed to verify pruned versions for ${PROJECT_ID}/${secret_name}" >&2
      exit 1
    fi
    if ! jq -e \
      --arg kept "${kept_version}" \
      --slurpfile candidates "${CANDIDATES_FILE}" \
      --arg secret "${secret_name}" '
        . as $providerVersions |
        ([.[] | select((.name | split("/") | last) == $kept and .state == "ENABLED")] | length) == 1 and
        (($candidates[0][] | select(.secret == $secret) | .versions) as $old |
          all($old[]; .version as $version |
            ([$providerVersions[] | select((.name | split("/") | last) == $version and .state == "DESTROYED")] | length) == 1
          )
        )
      ' "${verify_file}" >/dev/null; then
      echo "Secret version destruction did not verify for ${PROJECT_ID}/${secret_name}" >&2
      exit 1
    fi
  done < <(jq -r '.[] | [.secret, .keptVersion] | @tsv' "${CANDIDATES_FILE}")
fi

GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n \
  --arg generatedAt "${GENERATED_AT}" \
  --arg gitCommit "${GIT_COMMIT}" \
  --arg project "${PROJECT_ID}" \
  --arg mode "${MODE}" \
  --argjson excludedCustomerCredentials "${EXCLUDED_CUSTOMER_CREDENTIALS}" \
  --argjson destroyedVersions "${DESTROYED_VERSIONS}" \
  --slurpfile candidates "${CANDIDATES_FILE}" \
  --slurpfile emptySecrets "${EMPTY_FILE}" '
    {
      schemaVersion: 1,
      phase: "secret-manager-version-prune",
      generatedAt: $generatedAt,
      gitCommit: $gitCommit,
      project: $project,
      mode: $mode,
      excludedCustomerCredentials: $excludedCustomerCredentials,
      candidates: $candidates[0],
      emptySecrets: $emptySecrets[0],
      destroyedVersions: $destroyedVersions,
      cleanup: (if $mode == "apply" then "verified" else "not-run" end)
    }
  ' >"${RECEIPT_FILE}"

if [[ "${APPLY}" == "true" ]]; then
  gcloud storage cp \
    "${RECEIPT_FILE}" \
    "${RECEIPT_BUCKET}/${RUN_ID}-${PROJECT_ID}-${GIT_COMMIT}.json" \
    --project=octogee \
    --quiet \
    >/dev/null
fi
cat "${RECEIPT_FILE}"
