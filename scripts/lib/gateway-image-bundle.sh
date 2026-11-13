#!/usr/bin/env bash

octogee_gateway_image_bundle_identity() {
  local gateway_image="${1:-}"
  local gateway_edge_image="${2:-}"
  local immutable_pattern='^.+:([a-z0-9][a-z0-9._-]*)@sha256:[a-f0-9]{64}$'
  local gateway_tag=""
  local gateway_edge_tag=""

  if [[ "$gateway_image" =~ $immutable_pattern ]]; then
    gateway_tag="${BASH_REMATCH[1]}"
  else
    echo "gateway image is not an immutable image reference: $gateway_image" >&2
    return 1
  fi
  if [[ "$gateway_edge_image" =~ $immutable_pattern ]]; then
    gateway_edge_tag="${BASH_REMATCH[1]}"
  else
    echo "gateway-edge image is not an immutable image reference: $gateway_edge_image" >&2
    return 1
  fi
  if [[ "$gateway_tag" != "$gateway_edge_tag" ]]; then
    echo "bundle identity mismatch: gateway=$gateway_tag gateway-edge=$gateway_edge_tag" >&2
    return 1
  fi

  echo "$gateway_tag"
}

octogee_gateway_image_release_sha() {
  local image="${1:-}"
  local immutable_release_pattern='^.+:([a-f0-9]{7,40})-oc[a-z0-9._-]*@sha256:[a-f0-9]{64}$'

  if [[ "$image" =~ $immutable_release_pattern ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  octogee_gateway_image_bundle_identity "${1:-}" "${2:-}"
fi
