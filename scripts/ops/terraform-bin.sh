#!/usr/bin/env bash
set -euo pipefail

TERRAFORM_VERSION="1.15.8"

if command -v terraform >/dev/null 2>&1; then
  INSTALLED_VERSION="$(terraform version | sed -n '1s/^Terraform v//p')"
  if [[ "${INSTALLED_VERSION}" == "${TERRAFORM_VERSION}" ]]; then
    command -v terraform
    exit 0
  fi
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    PLATFORM="darwin_arm64"
    CHECKSUM="f210110c5698b94d803a7a63cdb0251b5455c150841478808e2bbb343f95ed68"
    ;;
  Darwin-x86_64)
    PLATFORM="darwin_amd64"
    CHECKSUM="e2e812e783771159bf758fd4e55d6dc9bb08f63e2af2c63d212721807a02c5dc"
    ;;
  Linux-x86_64)
    PLATFORM="linux_amd64"
    CHECKSUM="d25ce7b6902013ad905db3d2eab0be4cd905887fe88b81a6171b8d5503c31f3d"
    ;;
  Linux-aarch64)
    PLATFORM="linux_arm64"
    CHECKSUM="8891e9dcedc9e3b8950bc6af9d4d8af1f4cfade3062f53b9dc403a89f6ce8c9c"
    ;;
  *)
    echo "Unsupported Terraform platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

for command in curl install unzip; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  fi
done

TOOL_CACHE_ROOT="${XDG_CACHE_HOME:-${HOME:?}/.cache}/octogee-toolchain"
INSTALL_DIR="${TOOL_CACHE_ROOT}/terraform-${TERRAFORM_VERSION}-${PLATFORM}"
TERRAFORM_BIN="${INSTALL_DIR}/terraform"

path_owner() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%u' "$1"
  else
    stat -c '%u' "$1"
  fi
}

secure_path() {
  local path="$1"
  if [[ -L "${path}" ]] || [[ "$(path_owner "${path}")" != "$(id -u)" ]] || find "${path}" -prune \( -perm -002 -o -perm -020 \) -print | grep -q .; then
    echo "Terraform cache path is not private to the current user: ${path}" >&2
    exit 1
  fi
}

mkdir -p -m 0700 "${TOOL_CACHE_ROOT}" "${INSTALL_DIR}"
secure_path "${TOOL_CACHE_ROOT}"
secure_path "${INSTALL_DIR}"

if [[ -e "${TERRAFORM_BIN}" || -L "${TERRAFORM_BIN}" ]]; then
  secure_path "${TERRAFORM_BIN}"
  rm "${TERRAFORM_BIN}"
fi

DOWNLOAD_DIR="$(mktemp -d "${TOOL_CACHE_ROOT}/terraform-download.XXXXXX")"
ARCHIVE="${DOWNLOAD_DIR}/terraform_${TERRAFORM_VERSION}_${PLATFORM}.zip"

cleanup() {
  find "${DOWNLOAD_DIR}" -type f -delete
  rmdir "${DOWNLOAD_DIR}"
}
trap cleanup EXIT

curl --fail --location --silent --show-error \
  "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_${PLATFORM}.zip" \
  --output "${ARCHIVE}"

if command -v shasum >/dev/null 2>&1; then
  printf '%s  %s\n' "${CHECKSUM}" "${ARCHIVE}" | shasum -a 256 --check --status
elif command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "${CHECKSUM}" "${ARCHIVE}" | sha256sum --check --status
else
  echo "Neither shasum nor sha256sum is available" >&2
  exit 1
fi

unzip -qq "${ARCHIVE}" terraform -d "${DOWNLOAD_DIR}"
install -m 0700 "${DOWNLOAD_DIR}/terraform" "${TERRAFORM_BIN}"
echo "${TERRAFORM_BIN}"
