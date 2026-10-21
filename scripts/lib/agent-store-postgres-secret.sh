#!/usr/bin/env bash

materialize_agent_store_postgres_secret() (
  set -euo pipefail
  umask 077
  local project="$1" namespace="$2" context="$3" secret_prefix="${4:-agent-store-postgres}" secret_dir
  secret_dir="$(mktemp -d)"
  trap 'rm -rf "$secret_dir"' EXIT
  local key
  for key in admin-dsn client-dsn; do
    gcloud secrets versions access latest \
      --secret="$secret_prefix-$key" --project="$project" > "$secret_dir/$key"
    if [[ ! -s "$secret_dir/$key" ]]; then
      echo "$secret_prefix-$key is empty in $project" >&2
      exit 1
    fi
  done
  kubectl --context="$context" create secret generic agent-store-postgres -n "$namespace" \
    --from-file=admin-dsn="$secret_dir/admin-dsn" \
    --from-file=client-dsn="$secret_dir/client-dsn" --dry-run=client -o yaml | \
    kubectl --context="$context" -n "$namespace" apply -f - >/dev/null
)

require_agent_store_postgres_secrets() (
  set -euo pipefail
  umask 077
  local project="$1" prefix="${2:-agent-store-postgres}" key secret_dir
  secret_dir="$(mktemp -d)"
  trap 'rm -rf "$secret_dir"' EXIT
  for key in admin-dsn client-dsn; do
    if ! gcloud secrets versions access latest --secret="$prefix-$key" --project="$project" > "$secret_dir/$key" || [[ ! -s "$secret_dir/$key" ]]; then
      echo "Prepare non-empty $prefix-$key in $project before recreating this namespace; see docs/operations/POSTGRES-AGENT-STORE.md." >&2
      exit 1
    fi
  done
  node --input-type=module - "$secret_dir/client-dsn" <<'JS'
import fs from "node:fs";
import { isIP } from "node:net";
try {
  const host = new URL(fs.readFileSync(process.argv[2], "utf8")).hostname.replace(/^\[|\]$/gu, "");
  const version = isIP(host);
  if (!version) throw new Error();
  console.log(`${host}/${version === 4 ? 32 : 128}`);
} catch {
  console.error("The agent-store client DSN must use a literal database IP before recreating this namespace.");
  process.exitCode = 1;
}
JS
)
