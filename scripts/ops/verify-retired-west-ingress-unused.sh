#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID=""
SHARED_ADDRESS_NAME=""
CLOUDFLARE_ZONE_ID=""
CLOUDFLARE_ZONE_NAME=""
KUBE_CONTEXT=""
NAMESPACE=""
INGRESS_NAME=""
RECEIPT_PATH=""
RETIRED_ADDRESS_NAMES=()
HOSTNAMES=()

for arg in "$@"; do
  case "${arg}" in
    --project=*) PROJECT_ID="${arg#--project=}" ;;
    --shared-address=*) SHARED_ADDRESS_NAME="${arg#--shared-address=}" ;;
    --cloudflare-zone-id=*) CLOUDFLARE_ZONE_ID="${arg#--cloudflare-zone-id=}" ;;
    --cloudflare-zone-name=*) CLOUDFLARE_ZONE_NAME="${arg#--cloudflare-zone-name=}" ;;
    --kube-context=*) KUBE_CONTEXT="${arg#--kube-context=}" ;;
    --namespace=*) NAMESPACE="${arg#--namespace=}" ;;
    --ingress-name=*) INGRESS_NAME="${arg#--ingress-name=}" ;;
    --receipt=*) RECEIPT_PATH="${arg#--receipt=}" ;;
    --retired-address=*) RETIRED_ADDRESS_NAMES+=("${arg#--retired-address=}") ;;
    --hostname=*) HOSTNAMES+=("${arg#--hostname=}") ;;
    *) echo "Unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done

if [[
  -z "${PROJECT_ID}" ||
  -z "${SHARED_ADDRESS_NAME}" ||
  -z "${CLOUDFLARE_ZONE_ID}" ||
  -z "${CLOUDFLARE_ZONE_NAME}" ||
  -z "${KUBE_CONTEXT}" ||
  -z "${NAMESPACE}" ||
  -z "${INGRESS_NAME}" ||
  -z "${RECEIPT_PATH}"
]]; then
  echo "--project, --shared-address, --cloudflare-zone-id, --cloudflare-zone-name, --kube-context, --namespace, --ingress-name, and --receipt are required" >&2
  exit 2
fi
if [[ "${#RETIRED_ADDRESS_NAMES[@]}" -eq 0 || "${#HOSTNAMES[@]}" -eq 0 ]]; then
  echo "At least one --retired-address and --hostname are required" >&2
  exit 2
fi

if [[ "${CLOUDFLARE_ZONE_NAME}" != "octogee.com" ]]; then
  echo "Cloudflare retirement verification requires the octogee.com zone" >&2
  exit 2
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is required for authoritative DNS verification" >&2
  exit 1
fi
if [[ ! "${CLOUDFLARE_API_TOKEN}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "CLOUDFLARE_API_TOKEN has an invalid format" >&2
  exit 1
fi
if [[ -e "${RECEIPT_PATH}" || ! -d "$(dirname "${RECEIPT_PATH}")" ]]; then
  echo "Receipt path must name a new file in an existing directory" >&2
  exit 2
fi

for command in curl gcloud jq dig kubectl shasum; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  fi
done

TEMP_DIR="$(mktemp -d -t octogee-west-ingress-retirement.XXXXXX)"
ADDRESS_JSON="${TEMP_DIR}/address.json"
ADDRESS_ERROR="${TEMP_DIR}/address-error.txt"
INGRESS_JSON="${TEMP_DIR}/ingress.json"
CLOUDFLARE_RESPONSE="${TEMP_DIR}/cloudflare-response.json"
CLOUDFLARE_RECORDS="${TEMP_DIR}/cloudflare-records.json"
CLOUDFLARE_CURL_CONFIG="${TEMP_DIR}/cloudflare-curl.conf"
SANITIZED_RECEIPT="${TEMP_DIR}/sanitized-receipt.json"
JSON_UPDATE="${TEMP_DIR}/json-update.json"
RETIRED_IPS="${TEMP_DIR}/retired-ips.json"
RETIRED_IP_HASHES="${TEMP_DIR}/retired-ip-hashes.json"
printf '[]\n' >"${CLOUDFLARE_RECORDS}"
printf '[]\n' >"${RETIRED_IPS}"
printf '[]\n' >"${RETIRED_IP_HASHES}"
umask 077
printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' \
  "${CLOUDFLARE_API_TOKEN}" \
  >"${CLOUDFLARE_CURL_CONFIG}"
chmod 600 "${CLOUDFLARE_CURL_CONFIG}"
unset CLOUDFLARE_API_TOKEN

cleanup() {
  local status=$?
  trap - EXIT
  find "${TEMP_DIR}" -type f -delete
  rmdir "${TEMP_DIR}"
  exit "${status}"
}
trap cleanup EXIT

gcloud compute addresses describe "${SHARED_ADDRESS_NAME}" \
  --global \
  --project="${PROJECT_ID}" \
  --format=json >"${ADDRESS_JSON}"

if ! jq -e \
  --arg name "${SHARED_ADDRESS_NAME}" \
  '
    .name == $name and
    .addressType == "EXTERNAL" and
    (.address | type == "string" and length > 0) and
    (.users | type == "array" and length > 0) and
    all(.users[]; type == "string" and contains("/global/forwardingRules/"))
  ' "${ADDRESS_JSON}" >/dev/null; then
  echo "Shared WEST ingress address ${SHARED_ADDRESS_NAME} is not attached to the expected global edge" >&2
  exit 1
fi
SHARED_IP="$(jq -er '.address' "${ADDRESS_JSON}")"

kubectl --context "${KUBE_CONTEXT}" \
  get ingress "${INGRESS_NAME}" \
  --namespace "${NAMESPACE}" \
  --output json >"${INGRESS_JSON}"
if ! jq -e \
  --arg name "${INGRESS_NAME}" \
  --arg namespace "${NAMESPACE}" \
  --arg ip "${SHARED_IP}" \
  '
    .metadata.name == $name and
    .metadata.namespace == $namespace and
    any(.status.loadBalancer.ingress[]?; .ip == $ip)
  ' "${INGRESS_JSON}" >/dev/null; then
  echo "WEST shared address is not owned by ${NAMESPACE}/${INGRESS_NAME}" >&2
  exit 1
fi

for name in "${RETIRED_ADDRESS_NAMES[@]}"; do
  if ! gcloud compute addresses describe "${name}" \
    --global \
    --project="${PROJECT_ID}" \
    --format=json >"${ADDRESS_JSON}" 2>"${ADDRESS_ERROR}"; then
    if grep -qiE 'resource.*(was )?not found|not found|does not exist' "${ADDRESS_ERROR}"; then
      continue
    fi
    cat "${ADDRESS_ERROR}" >&2
    echo "Could not inspect retired WEST ingress address ${name}" >&2
    exit 1
  fi
  if ! jq -e \
    --arg name "${name}" \
    '
      .name == $name and
      .addressType == "EXTERNAL" and
      (.address | type == "string" and length > 0) and
      (.users | type == "array" and length == 0)
    ' "${ADDRESS_JSON}" >/dev/null; then
    echo "${name} still has forwarding-rule users" >&2
    exit 1
  fi
  retired_ip="$(jq -er '.address' "${ADDRESS_JSON}")"
  jq --arg ip "${retired_ip}" '. + [$ip] | unique' "${RETIRED_IPS}" >"${JSON_UPDATE}"
  mv "${JSON_UPDATE}" "${RETIRED_IPS}"
  retired_ip_hash="$(printf '%s' "${retired_ip}" | shasum -a 256 | awk '{print $1}')"
  jq --arg hash "${retired_ip_hash}" '. + [$hash] | unique' \
    "${RETIRED_IP_HASHES}" >"${JSON_UPDATE}"
  mv "${JSON_UPDATE}" "${RETIRED_IP_HASHES}"
done

cloudflare_get() {
  local url="$1"
  shift
  curl -q --config "${CLOUDFLARE_CURL_CONFIG}" \
    --fail-with-body --silent --show-error --get \
    "${url}" \
    "$@"
}

if ! cloudflare_get \
  "https://api.cloudflare.com/client/v4/zones" \
  --data-urlencode "name=${CLOUDFLARE_ZONE_NAME}" \
  --data-urlencode "status=active" \
  --data-urlencode "per_page=50" \
  --data-urlencode "page=1" \
  >"${CLOUDFLARE_RESPONSE}"; then
  echo "Cloudflare authoritative DNS request failed" >&2
  exit 1
fi
if ! jq -e \
  --arg zone "${CLOUDFLARE_ZONE_NAME}" \
  --arg zone_id "${CLOUDFLARE_ZONE_ID}" \
  '
    .success == true and
    (.errors | type == "array" and length == 0) and
    (.result | type == "array" and length == 1) and
    .result[0].name == $zone and
    .result[0].status == "active" and
    .result[0].id == $zone_id
  ' "${CLOUDFLARE_RESPONSE}" >/dev/null; then
  echo "Could not resolve the authoritative Cloudflare zone" >&2
  exit 1
fi

page=1
expected_total_count=""
while true; do
  if ! cloudflare_get \
    "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
    --data-urlencode "per_page=100" \
    --data-urlencode "page=${page}" \
    >"${CLOUDFLARE_RESPONSE}"; then
    echo "Cloudflare authoritative DNS request failed" >&2
    exit 1
  fi
  if ! jq -e \
    --argjson page "${page}" \
    '
      .success == true and
      (.errors | type == "array" and length == 0) and
      (.result | type == "array") and
      (.result_info | type == "object") and
      .result_info.page == $page and
      .result_info.per_page == 100 and
      (.result_info.count | type == "number") and
      .result_info.count == (.result | length) and
      (.result_info.total_count | type == "number" and . >= 1) and
      (.result_info.total_pages | type == "number" and . >= $page)
    ' "${CLOUDFLARE_RESPONSE}" >/dev/null; then
    echo "Cloudflare DNS inventory returned an invalid page" >&2
    exit 1
  fi
  total_count="$(jq -er '.result_info.total_count' "${CLOUDFLARE_RESPONSE}")"
  if [[ -z "${expected_total_count}" ]]; then
    expected_total_count="${total_count}"
  elif [[ "${total_count}" != "${expected_total_count}" ]]; then
    echo "Cloudflare DNS inventory changed during pagination" >&2
    exit 1
  fi
  jq -s '.[0] + .[1].result' \
    "${CLOUDFLARE_RECORDS}" \
    "${CLOUDFLARE_RESPONSE}" \
    >"${JSON_UPDATE}"
  mv "${JSON_UPDATE}" "${CLOUDFLARE_RECORDS}"
  total_pages="$(jq -er '.result_info.total_pages' "${CLOUDFLARE_RESPONSE}")"
  if [[ "${page}" -ge "${total_pages}" ]]; then
    break
  fi
  page=$((page + 1))
done

if ! jq -e \
  --argjson count "${expected_total_count}" \
  '
    length == $count and
    (map(.id) | all(type == "string" and length > 0)) and
    (map(.id) | unique | length) == $count
  ' "${CLOUDFLARE_RECORDS}" >/dev/null; then
  echo "Cloudflare DNS inventory did not return every authoritative record" >&2
  exit 1
fi

if jq -e \
  --slurpfile retired "${RETIRED_IPS}" \
  '
    $retired[0] as $ips |
    [ .[] | .. | strings ] as $record_strings |
    any($ips[]; . as $ip | any($record_strings[]; contains($ip)))
  ' "${CLOUDFLARE_RECORDS}" >/dev/null; then
  echo "Cloudflare DNS inventory references a retired WEST ingress address" >&2
  exit 1
fi

while IFS=$'\t' read -r record_name target; do
  current="${target%.}"
  seen="|${record_name}|"
  while true; do
    if [[
      "${current}" != "${CLOUDFLARE_ZONE_NAME}" &&
      "${current}" != *".${CLOUDFLARE_ZONE_NAME}"
    ]]; then
      echo "Cloudflare DNS inventory contains an unprovable CNAME chain" >&2
      exit 1
    fi
    if [[ "${seen}" == *"|${current}|"* ]]; then
      echo "Cloudflare DNS inventory contains an unprovable CNAME chain" >&2
      exit 1
    fi
    seen="${seen}${current}|"
    record_types="$(
      jq -r --arg name "${current}" \
        '[.[] | select((.name | rtrimstr(".")) == $name and (.type == "A" or .type == "CNAME")) | .type] | unique | .[]' \
        "${CLOUDFLARE_RECORDS}"
    )"
    if [[ "${record_types}" == "A" ]]; then
      while IFS= read -r resolved_ip; do
        if jq -e --arg ip "${resolved_ip}" 'index($ip) != null' "${RETIRED_IPS}" >/dev/null; then
          echo "Cloudflare DNS inventory references a retired WEST ingress address" >&2
          exit 1
        fi
      done < <(
        jq -r --arg name "${current}" \
          '.[] | select(.type == "A" and (.name | rtrimstr(".")) == $name) | .content' \
          "${CLOUDFLARE_RECORDS}"
      )
      break
    fi
    if [[ "${record_types}" != "CNAME" ]]; then
      echo "Cloudflare DNS inventory contains an unprovable CNAME chain" >&2
      exit 1
    fi
    next_targets="$(
      jq -r --arg name "${current}" \
        '[.[] | select(.type == "CNAME" and (.name | rtrimstr(".")) == $name) | (.content | rtrimstr("."))] | unique | .[]' \
        "${CLOUDFLARE_RECORDS}"
    )"
    if [[ "${next_targets}" == *$'\n'* || -z "${next_targets}" ]]; then
      echo "Cloudflare DNS inventory contains an unprovable CNAME chain" >&2
      exit 1
    fi
    current="${next_targets}"
  done
done < <(jq -r '.[] | select(.type == "CNAME") | [.name, .content] | @tsv' "${CLOUDFLARE_RECORDS}")

for hostname in "${HOSTNAMES[@]}"; do
  if ! jq -e \
    --arg hostname "${hostname}" \
    --arg ip "${SHARED_IP}" \
    '
      ([.[] | select(.type == "A" and .name == $hostname)] | length) == 1 and
      ([.[] | select(.type == "A" and .name == $hostname and .content == $ip)] | length) == 1
    ' "${CLOUDFLARE_RECORDS}" >/dev/null; then
    echo "Cloudflare authoritative A record ${hostname} does not point only to shared address ${SHARED_IP}" >&2
    exit 1
  fi
  resolved="$(
    dig +short A "${hostname}" \
      | sed '/^[[:space:]]*$/d' \
      | LC_ALL=C sort -u
  )"
  if [[ "${resolved}" != "${SHARED_IP}" ]]; then
    echo "${hostname} does not resolve only to shared address ${SHARED_IP}" >&2
    exit 1
  fi
done

INVENTORY_SHA256="$(
  jq -cS 'sort_by(.id)' "${CLOUDFLARE_RECORDS}" \
    | shasum -a 256 \
    | awk '{print $1}'
)"
CNAME_RECORDS_CHECKED="$(jq '[.[] | select(.type == "CNAME")] | length' "${CLOUDFLARE_RECORDS}")"
RETIRED_ADDRESS_NAMES_JSON="$(jq -n '$ARGS.positional | unique' --args "${RETIRED_ADDRESS_NAMES[@]}")"
jq -n \
  --arg checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg zone_id "${CLOUDFLARE_ZONE_ID}" \
  --arg zone_name "${CLOUDFLARE_ZONE_NAME}" \
  --arg inventory_sha256 "${INVENTORY_SHA256}" \
  --argjson pages "${page}" \
  --argjson record_count "${expected_total_count}" \
  --argjson cname_records_checked "${CNAME_RECORDS_CHECKED}" \
  --argjson retired_address_names "${RETIRED_ADDRESS_NAMES_JSON}" \
  --slurpfile retired_ip_hashes "${RETIRED_IP_HASHES}" \
  --argjson expected_hostnames_checked "${#HOSTNAMES[@]}" \
  '
    {
      schemaVersion: 1,
      checkedAt: $checked_at,
      authoritativeDns: {
        zoneId: $zone_id,
        zoneName: $zone_name,
        pages: $pages,
        recordCount: $record_count,
        cnameRecordsChecked: $cname_records_checked,
        allCnameChainsProven: true,
        completenessVerified: true,
        inventorySha256: $inventory_sha256
      },
      retiredAddresses: {
        names: $retired_address_names,
        ipHashes: $retired_ip_hashes[0]
      },
      expectedHostnamesChecked: $expected_hostnames_checked,
      status: "clear"
    }
  ' >"${SANITIZED_RECEIPT}"
mv "${SANITIZED_RECEIPT}" "${RECEIPT_PATH}"

echo "WEST ingress addresses are safe to retire."
