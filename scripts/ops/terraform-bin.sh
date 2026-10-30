#!/usr/bin/env bash
set -euo pipefail

TERRAFORM_VERSION="1.17.1"

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
    CHECKSUM="b1ecb3fe0d0a0290c1ab6f83d967d43f25da05d0b671ee0fb355252268dce95a"
    ;;
  Darwin-x86_64)
    PLATFORM="darwin_amd64"
    CHECKSUM="fde92387cf9c0de74255003c85291f8fbede54585c10d0635ca7a43633d4d171"
    ;;
  Linux-x86_64)
    PLATFORM="linux_amd64"
    CHECKSUM="4638628058e71a55212b1c563712eac03b902128f40740f3dc8174df12135061"
    ;;
  Linux-aarch64)
    PLATFORM="linux_arm64"
    CHECKSUM="988e950a1c23058093b0e66ab2d5fb53fc18345ecfbd5871acf51dbac9325edd"
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
