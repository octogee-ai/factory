#!/usr/bin/env bash
set -euo pipefail

image="${1:?image required}"
repository="${2:?repository required}"
source_sha="${3:?full source SHA required}"
project="${4:?project required}"

[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]]
source_ref="${repository}/${image}:${source_sha:0:7}"
target_ref="${repository}/${image}:${source_sha}"

resolve_digest() {
  gcloud artifacts docker images describe "$1" \
    --project="$project" --format='value(image_summary.digest)'
}

source_digest="$(resolve_digest "$source_ref")"
[[ "$source_digest" =~ ^sha256:[a-f0-9]{64}$ ]]

target_digest=""
if target_digest="$(resolve_digest "$target_ref" 2>/dev/null)"; then
  if [ "$target_digest" != "$source_digest" ]; then
    echo "full-SHA tag collision: ${target_ref} is ${target_digest}, expected ${source_digest}" >&2
    exit 2
  fi
  exit 0
fi

create_error="$(mktemp)"
trap 'rm -f "$create_error"' EXIT
if ! gcloud artifacts tags create "$source_sha" \
  --location="${repository%%-docker.pkg.dev/*}" \
  --repository="${repository##*/}" \
  --package="$image" \
  --version="$source_digest" \
  --project="$project" --quiet 2>"$create_error"; then
  if ! target_digest="$(resolve_digest "$target_ref" 2>/dev/null)" || [ "$target_digest" != "$source_digest" ]; then
    cat "$create_error" >&2
    echo "could not create full-SHA tag: ${target_ref}" >&2
    exit 2
  fi
  exit 0
fi
target_digest="$(resolve_digest "$target_ref")"
if [ "$target_digest" != "$source_digest" ]; then
  echo "full-SHA tag changed after creation: ${target_ref} is ${target_digest}, expected ${source_digest}" >&2
  exit 2
fi
