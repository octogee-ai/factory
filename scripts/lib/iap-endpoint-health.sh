#!/usr/bin/env bash

is_iap_protected_admin_host() {
  case "$1" in
    git.octogee.com|git-test.octogee.com|mattermost.octogee.com|mattermost-test.octogee.com|monitoring.octogee.com)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_expected_iap_redirect() {
  [[ "$1" == "302" && "$2" == *"accounts.google.com"* ]]
}

iap_backend_from_ingress_annotation() {
  printf '%s' "$1" | node -e '
const fs = require("node:fs");
const backends = JSON.parse(fs.readFileSync(0, "utf8"));
const entries = Object.entries(backends);
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
