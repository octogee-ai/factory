#!/usr/bin/env bash
set -euo pipefail

image="${1:?image reference required}"
maximum_bytes="${2:?maximum compressed bytes required}"
project="${3:?Artifact Registry project required}"

if [[ ! "$maximum_bytes" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid maximum compressed bytes: ${maximum_bytes}" >&2
  exit 2
fi

if ! image_digest="$(
  gcloud artifacts docker images describe "$image" \
    --project="$project" \
    --format='value(image_summary.digest)'
)"; then
  echo "could not resolve Artifact Registry image digest: ${image}" >&2
  exit 1
fi

if [[ ! "$image_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "invalid Artifact Registry image digest for ${image}: ${image_digest:-<empty>}" >&2
  exit 2
fi

package_ref="${image%@*}"
package_ref="${package_ref%:*}"
if ! image_size_bytes="$(
  gcloud artifacts docker images list "$package_ref" \
    --project="$project" \
    --include-tags \
    --filter="version=\"${image_digest}\"" \
    --format='value(metadata.imageSizeBytes)'
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
