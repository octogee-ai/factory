#!/usr/bin/env bash

IAP_ENDPOINT_HEALTH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$IAP_ENDPOINT_HEALTH_DIR/deployment-target.sh"
IAP_PROTECTED_ADMIN_HOSTS=""

iap_protected_admin_hosts() {
  local environment field origin hosts=""
  for environment in prod test; do
    for field in git_origin mattermost_origin; do
      origin="$(octogee_deployment_target_field "--environment=$environment" "$field")" || return 1
      hosts+="${origin#https://}"$'\n'
    done
  done
  origin="$(node "$IAP_ENDPOINT_HEALTH_DIR/control-plane-config.mjs" monitoring_iap_domain)" || return 1
  printf '%s%s\n' "$hosts" "$origin"
}

is_iap_protected_admin_host() {
  if [[ -z "$IAP_PROTECTED_ADMIN_HOSTS" ]]; then
    IAP_PROTECTED_ADMIN_HOSTS="$(iap_protected_admin_hosts)" || {
      echo "Could not resolve the IAP-protected admin hosts" >&2
      exit 1
    }
  fi
  grep -qxF -- "$1" <<< "$IAP_PROTECTED_ADMIN_HOSTS"
}

is_expected_iap_redirect() {
  [[ "$1" == "302" && "$2" == *"accounts.google.com"* ]]
}

iap_backend_from_ingress_annotation() {
  printf '%s' "$1" | node -e '
const fs = require("node:fs");
const backends = JSON.parse(fs.readFileSync(0, "utf8"));
const entries = Object.entries(backends).filter(
  ([name]) => !name.includes("default-http-backend"),
);
if (entries.length !== 1 || entries[0][1] !== "HEALTHY") process.exit(1);
process.stdout.write(entries[0][0]);
'
}

is_iap_enabled_backend_json() {
  printf '%s' "$1" | node -e '
const fs = require("node:fs");
const backend = JSON.parse(fs.readFileSync(0, "utf8"));
process.exit(backend.iap?.enabled === true ? 0 : 1);
'
}

iap_policy_grants_principal() {
  printf '%s' "$1" | node -e '
const fs = require("node:fs");
const policy = JSON.parse(fs.readFileSync(0, "utf8"));
const principal = process.argv[1];
const granted = policy.bindings?.some(
  (binding) =>
    binding.role === "roles/iap.httpsResourceAccessor" &&
    binding.members?.includes(principal),
);
process.exit(granted ? 0 : 1);
' "$2"
}
