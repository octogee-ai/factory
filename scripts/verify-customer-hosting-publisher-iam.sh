#!/usr/bin/env bash
set -euo pipefail

DEPLOYMENT_TARGET=""
for arg in "$@"; do
  case "${arg}" in
    --target=*) DEPLOYMENT_TARGET="${arg#*=}" ;;
    *) echo "Unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done

source "$(dirname "${BASH_SOURCE[0]}")/lib/deployment-target.sh"
if [[ -z "${DEPLOYMENT_TARGET}" ]] || ! octogee_load_deployment_target "--target=${DEPLOYMENT_TARGET}"; then
  echo "Unsupported deployment target: ${DEPLOYMENT_TARGET:-<missing>}" >&2
  exit 2
fi
HOSTING_PROJECT_ID="${TARGET_CUSTOMER_HOSTING_PROJECT}"
CLUSTER_PROJECT_ID="${TARGET_CLUSTER_PROJECT}"
NAMESPACE="${TARGET_NAMESPACE}"

PUBLISHER_EMAIL="octogee-project-publisher@${HOSTING_PROJECT_ID}.iam.gserviceaccount.com"
PUBLISHER_MEMBER="serviceAccount:${PUBLISHER_EMAIL}"
PUBLISHER_KSA="serviceAccount:${CLUSTER_PROJECT_ID}.svc.id.goog[${NAMESPACE}/octogee-project-publisher]"
JOURNAL_BUCKET="gs://${HOSTING_PROJECT_ID}-publish-journal"

PROJECT_POLICY="$(gcloud projects get-iam-policy "${HOSTING_PROJECT_ID}" --format=json)"
PROJECT_ROLES="$(jq -r --arg member "${PUBLISHER_MEMBER}" \
  '.bindings[]? | select((.members // []) | index($member)) | .role' \
  <<<"${PROJECT_POLICY}" | sort -u)"
if [[ "${PROJECT_ROLES}" != "roles/firebasehosting.admin" ]]; then
  echo "Unexpected publisher project IAM for ${HOSTING_PROJECT_ID}: ${PROJECT_ROLES:-<none>}" >&2
  exit 1
fi

FORBIDDEN_PROJECT_MEMBERS="$(jq -r '
  .bindings[]?.members[]?
  | select(test("^serviceAccount:(octogee-api|octogee-project-runner)@"))
' <<<"${PROJECT_POLICY}" | sort -u)"
if [[ -n "${FORBIDDEN_PROJECT_MEMBERS}" ]]; then
  echo "Forbidden API or runner IAM exists in ${HOSTING_PROJECT_ID}: ${FORBIDDEN_PROJECT_MEMBERS}" >&2
  exit 1
fi

SERVICE_ACCOUNT_POLICY="$(gcloud iam service-accounts get-iam-policy "${PUBLISHER_EMAIL}" \
  --project="${HOSTING_PROJECT_ID}" --format=json)"
WORKLOAD_IDENTITY_MEMBERS="$(jq -r '
  .bindings[]?
  | select(.role == "roles/iam.workloadIdentityUser")
  | .members[]?
' <<<"${SERVICE_ACCOUNT_POLICY}" | sort -u)"
if [[ "${WORKLOAD_IDENTITY_MEMBERS}" != "${PUBLISHER_KSA}" ]]; then
  echo "Unexpected publisher Workload Identity IAM: ${WORKLOAD_IDENTITY_MEMBERS:-<none>}" >&2
  exit 1
fi

JOURNAL_POLICY="$(gcloud storage buckets get-iam-policy "${JOURNAL_BUCKET}" --format=json)"
JOURNAL_ROLES="$(jq -r --arg member "${PUBLISHER_MEMBER}" \
  '.bindings[]? | select((.members // []) | index($member)) | .role' \
  <<<"${JOURNAL_POLICY}" | sort -u)"
EXPECTED_JOURNAL_ROLES=$'roles/storage.objectCreator\nroles/storage.objectViewer'
if [[ "${JOURNAL_ROLES}" != "${EXPECTED_JOURNAL_ROLES}" ]]; then
  echo "Unexpected publisher journal IAM for ${JOURNAL_BUCKET}: ${JOURNAL_ROLES:-<none>}" >&2
  exit 1
fi

printf 'Customer Hosting publisher IAM verified for %s.\n' "${DEPLOYMENT_TARGET}"
