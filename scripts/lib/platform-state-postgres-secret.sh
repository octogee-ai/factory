#!/usr/bin/env bash

materialize_platform_state_postgres_secret() (
  set -euo pipefail
  umask 077
  local password_project="$1" sql_project="$2" instance="$3" namespace="$4" context="$5"
  local existing host secret_dir account
  existing="$(kubectl --context="$context" -n "$namespace" get secret platform-state-postgres --ignore-not-found -o name)"
  if [[ -n "$existing" ]]; then
    echo "platform-state-postgres already exists in $namespace; left unchanged"
    exit 0
  fi
  host="$(gcloud sql instances describe "$instance" --project="$sql_project" \
    --format='value(ipAddresses.filter("type:PRIVATE").extract(ipAddress).flatten())')"
  if [[ ! "$host" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    echo "$instance in $sql_project does not have exactly one private IPv4 address" >&2
    exit 1
  fi
  secret_dir="$(mktemp -d)"
  trap 'rm -rf "$secret_dir"' EXIT
  for account in migration runtime; do
    gcloud secrets versions access latest \
      --secret="platform-state-postgres-$account-password" --project="$password_project" > "$secret_dir/$account-password"
    if [[ ! -s "$secret_dir/$account-password" ]]; then
      echo "platform-state-postgres-$account-password is empty in $password_project" >&2
      exit 1
    fi
  done
  kubectl --context="$context" create secret generic platform-state-postgres -n "$namespace" \
    --from-literal=host="$host" \
    --from-literal=port=5432 \
    --from-literal=database=platform \
    --from-literal=sslmode=require \
    --from-literal=migration-user=platform_migrator \
    --from-literal=runtime-user=platform_state \
    --from-file=migration-password="$secret_dir/migration-password" \
    --from-file=runtime-password="$secret_dir/runtime-password" --dry-run=client -o yaml | \
    kubectl --context="$context" -n "$namespace" apply -f - >/dev/null
  echo "platform-state-postgres created in $namespace with sslmode=require"
)
