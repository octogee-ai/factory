#!/usr/bin/env bash
set -euo pipefail
set +x

TARGET=""
APPLY=false
CONFIRMATION=""

for argument in "$@"; do
  case "${argument}" in
    --target=*) TARGET="${argument#*=}" ;;
    --apply) APPLY=true ;;
    --confirm=*) CONFIRMATION="${argument#*=}" ;;
    --help|-h)
      cat <<'USAGE'
Usage: scripts/ops/reconcile-west-identity-platform-login-providers.sh --target=test-west|prod-west [--apply --confirm=octogee/identity-platform-login-providers/TARGET]

Verifies the Identity Platform login contract. --apply configures Google and
GitHub from Secret Manager and removes Microsoft/Yahoo. Required secrets in the
selected Firebase data project are FIREBASE_AUTH_GOOGLE_CLIENT_ID,
FIREBASE_AUTH_GOOGLE_CLIENT_SECRET, FIREBASE_AUTH_GITHUB_CLIENT_ID, and
FIREBASE_AUTH_GITHUB_CLIENT_SECRET. Provider values are never printed.
USAGE
      exit 0
      ;;
    *) echo "Unknown argument: ${argument}" >&2; exit 2 ;;
  esac
done

case "${TARGET}" in
  test-west)
    PROJECT_ID="octogee-data-test"
    ;;
  prod-west)
    PROJECT_ID="octogee-data-prod"
    ;;
  *) echo "Target must be test-west or prod-west" >&2; exit 2 ;;
esac

EXPECTED_CONFIRMATION="octogee/identity-platform-login-providers/${TARGET}"
if [[ "${APPLY}" == "true" && "${CONFIRMATION}" != "${EXPECTED_CONFIRMATION}" ]]; then
  echo "Apply requires --confirm=${EXPECTED_CONFIRMATION}" >&2
  exit 2
fi

for command in curl gcloud jq; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  }
done

umask 077
TEMP_DIR="$(mktemp -d -t octogee-identity-platform-login.XXXXXX)"
cleanup() {
  find "${TEMP_DIR}" -type f -delete
  rmdir "${TEMP_DIR}"
}
trap cleanup EXIT

read_required_secret() {
  local secret_name="$1"
  local secret_value

  if ! secret_value="$(gcloud secrets versions access latest --secret="${secret_name}" --project="${PROJECT_ID}")"; then
    echo "Required Secret Manager value is unavailable: ${secret_name}" >&2
    return 1
  fi
  if [[ -z "${secret_value}" ]]; then
    echo "Required Secret Manager value is empty: ${secret_name}" >&2
    return 1
  fi
  printf '%s' "${secret_value}"
}

GOOGLE_CLIENT_ID="$(read_required_secret FIREBASE_AUTH_GOOGLE_CLIENT_ID)"
GOOGLE_CLIENT_SECRET="$(read_required_secret FIREBASE_AUTH_GOOGLE_CLIENT_SECRET)"
GITHUB_CLIENT_ID="$(read_required_secret FIREBASE_AUTH_GITHUB_CLIENT_ID)"
GITHUB_CLIENT_SECRET="$(read_required_secret FIREBASE_AUTH_GITHUB_CLIENT_SECRET)"

ACCESS_TOKEN="$(gcloud auth print-access-token)"
if [[ -z "${ACCESS_TOKEN}" ]]; then
  echo "Could not obtain an access token for Identity Platform" >&2
  exit 1
fi

API_ROOT="https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT_ID}"

api_get() {
  local path="$1"
  local response_file="$2"

  if ! curl --silent --show-error --fail \
    --header "Authorization: Bearer ${ACCESS_TOKEN}" \
    --header "x-goog-user-project: ${PROJECT_ID}" \
    --output "${response_file}" \
    "${API_ROOT}/${path}"; then
    echo "Identity Platform read failed: ${path}" >&2
    return 1
  fi
}

api_mutate() {
  local method="$1"
  local path="$2"
  local payload_file="$3"
  local response_file="$4"

  if ! curl --silent --show-error --fail \
    --request "${method}" \
    --header "Authorization: Bearer ${ACCESS_TOKEN}" \
    --header "Content-Type: application/json" \
    --header "x-goog-user-project: ${PROJECT_ID}" \
    --data-binary "@${payload_file}" \
    --output "${response_file}" \
    "${API_ROOT}/${path}"; then
    echo "Identity Platform update failed: ${method} ${path}" >&2
    return 1
  fi
}

api_delete() {
  local path="$1"
  local response_file="$2"

  if ! curl --silent --show-error --fail \
    --request DELETE \
    --header "Authorization: Bearer ${ACCESS_TOKEN}" \
    --header "x-goog-user-project: ${PROJECT_ID}" \
    --output "${response_file}" \
    "${API_ROOT}/${path}"; then
    echo "Identity Platform update failed: DELETE ${path}" >&2
    return 1
  fi
}

verify_email_password() {
  local config_file="$1"

  if ! jq -e '
    .signIn.email.enabled == true and
    .signIn.email.passwordRequired == true
  ' "${config_file}" >/dev/null; then
    echo "Identity Platform email/password configuration is invalid" >&2
    return 1
  fi
}

provider_name() {
  local provider_id="$1"
  printf 'projects/%s/defaultSupportedIdpConfigs/%s' "${PROJECT_ID}" "${provider_id}"
}

verify_enabled_provider() {
  local providers_file="$1"
  local provider_id="$2"
  local expected_client_id="$3"
  local label="$4"
  local provider_suffix
  local configured_client_id

  provider_suffix="/defaultSupportedIdpConfigs/${provider_id}"
  if ! jq -e --arg suffix "${provider_suffix}" '
    [.defaultSupportedIdpConfigs[]? | select(.name | endswith($suffix))] | length == 1 and .[0].enabled == true
  ' "${providers_file}" >/dev/null; then
    echo "Identity Platform ${label} provider must exist exactly once and be enabled" >&2
    return 1
  fi

  configured_client_id="$(jq -r --arg suffix "${provider_suffix}" \
    '.defaultSupportedIdpConfigs[] | select(.name | endswith($suffix)) | .clientId' "${providers_file}")"
  if [[ "${configured_client_id}" != "${expected_client_id}" ]]; then
    echo "Identity Platform ${label} client ID differs from the dedicated login credential" >&2
    return 1
  fi
}

unsupported_provider_present() {
  local providers_file="$1"
  local provider_id="$2"
  local provider_suffix

  provider_suffix="/defaultSupportedIdpConfigs/${provider_id}"
  jq -e --arg suffix "${provider_suffix}" \
    '[.defaultSupportedIdpConfigs[]? | select(.name | endswith($suffix))] | length > 0' "${providers_file}" >/dev/null
}

verify_absent_provider() {
  local providers_file="$1"
  local provider_id="$2"
  local label="$3"

  if unsupported_provider_present "${providers_file}" "${provider_id}"; then
    echo "Identity Platform ${label} provider must be absent" >&2
    return 1
  fi
}

verify_contract() {
  local config_file="${TEMP_DIR}/config.json"
  local providers_file="${TEMP_DIR}/providers.json"

  api_get config "${config_file}"
  verify_email_password "${config_file}"
  api_get defaultSupportedIdpConfigs "${providers_file}"
  verify_enabled_provider "${providers_file}" google.com "${GOOGLE_CLIENT_ID}" Google
  verify_enabled_provider "${providers_file}" github.com "${GITHUB_CLIENT_ID}" GitHub
  verify_absent_provider "${providers_file}" microsoft.com Microsoft
  verify_absent_provider "${providers_file}" yahoo.com Yahoo
}

write_provider_payload() {
  local provider_id="$1"
  local client_id="$2"
  local client_secret="$3"
  local payload_file="$4"

  jq -n \
    --arg name "$(provider_name "${provider_id}")" \
    --arg client_id "${client_id}" \
    --arg client_secret "${client_secret}" \
    '{name: $name, enabled: true, clientId: $client_id, clientSecret: $client_secret}' >"${payload_file}"
}

reconcile_enabled_provider() {
  local providers_file="$1"
  local provider_id="$2"
  local client_id="$3"
  local client_secret="$4"
  local payload_file="${TEMP_DIR}/${provider_id}.json"
  local response_file="${TEMP_DIR}/${provider_id}.response.json"

  write_provider_payload "${provider_id}" "${client_id}" "${client_secret}" "${payload_file}"
  if unsupported_provider_present "${providers_file}" "${provider_id}"; then
    api_mutate PATCH "defaultSupportedIdpConfigs/${provider_id}?updateMask=enabled,clientId,clientSecret" "${payload_file}" "${response_file}"
  else
    api_mutate POST "defaultSupportedIdpConfigs?idpId=${provider_id}" "${payload_file}" "${response_file}"
  fi
}

remove_unsupported_provider() {
  local providers_file="$1"
  local provider_id="$2"
  local response_file="${TEMP_DIR}/${provider_id}.delete.json"

  if unsupported_provider_present "${providers_file}" "${provider_id}"; then
    api_delete "defaultSupportedIdpConfigs/${provider_id}" "${response_file}"
  fi
}

if [[ "${APPLY}" != "true" ]]; then
  verify_contract
  printf '{"target":"%s","mode":"verify","emailPassword":true,"providers":["google.com","github.com"],"absentProviders":["microsoft.com","yahoo.com"]}\n' "${TARGET}"
  exit 0
fi

PROVIDERS_FILE="${TEMP_DIR}/providers-before.json"
CONFIG_FILE="${TEMP_DIR}/config-before.json"
api_get config "${CONFIG_FILE}"
verify_email_password "${CONFIG_FILE}"
api_get defaultSupportedIdpConfigs "${PROVIDERS_FILE}"
reconcile_enabled_provider "${PROVIDERS_FILE}" google.com "${GOOGLE_CLIENT_ID}" "${GOOGLE_CLIENT_SECRET}"
reconcile_enabled_provider "${PROVIDERS_FILE}" github.com "${GITHUB_CLIENT_ID}" "${GITHUB_CLIENT_SECRET}"
remove_unsupported_provider "${PROVIDERS_FILE}" microsoft.com
remove_unsupported_provider "${PROVIDERS_FILE}" yahoo.com
verify_contract
printf '{"target":"%s","mode":"apply","emailPassword":true,"providers":["google.com","github.com"],"absentProviders":["microsoft.com","yahoo.com"]}\n' "${TARGET}"
