#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERRAFORM_ROOT="${REPO_ROOT}/terraform/environments/west-platform"
APPLY=false

for arg in "$@"; do
  case "${arg}" in
    --apply) APPLY=true ;;
    *) echo "Unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done

PLAN_FILE="$(mktemp -t octogee-west-platform.tfplan.XXXXXX)"
trap 'rm -f "${PLAN_FILE}"' EXIT

(
  cd "${TERRAFORM_ROOT}"
  terraform init -reconfigure
  terraform plan -input=false -out="${PLAN_FILE}"
  terraform show -no-color "${PLAN_FILE}"

  if [[ "${APPLY}" == "true" ]]; then
    terraform apply -input=false "${PLAN_FILE}"
    "${REPO_ROOT}/scripts/setup-cloud-sql.sh" --target=test-west
  fi
)
