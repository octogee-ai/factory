#!/usr/bin/env bash
set -euo pipefail

image="${1:?image reference required}"
maximum_bytes="${2:?maximum compressed bytes required}"
project="${3:?Artifact Registry project required}"

if [[ ! "$maximum_bytes" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid maximum compressed bytes: ${maximum_bytes}" >&2
  exit 2
fi

if ! image_size_bytes="$(
  gcloud artifacts docker images describe "$image" \
    --project="$project" \
    --format='value(imageSizeBytes)'
)"; then
  echo "could not read Artifact Registry image size: ${image}" >&2
  exit 1
fi

if [[ ! "$image_size_bytes" =~ ^[0-9]+$ ]]; then
  echo "invalid Artifact Registry imageSizeBytes for ${image}: ${image_size_bytes:-<empty>}" >&2
  exit 2
fi

if (( image_size_bytes > maximum_bytes )); then
  echo "${image} exceeds compressed size budget: ${image_size_bytes} > ${maximum_bytes} bytes" >&2
  exit 2
fi

echo "${image} compressed size: ${image_size_bytes} / ${maximum_bytes} bytes"
