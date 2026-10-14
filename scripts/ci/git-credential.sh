#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = get ]; then
  access_token="$(gcloud auth print-access-token)"
  token="$(curl --fail --silent --show-error --request POST \
    --header "Authorization: Bearer $access_token" \
    "https://cloudbuild.googleapis.com/v2/${CI_REPOSITORY:?repository required}:accessReadToken" | jq -er '.token')"
  [ -n "$token" ] || { echo 'Empty repository read token' >&2; exit 1; }
  printf 'username=x-access-token\npassword=%s\n' "$token"
fi
