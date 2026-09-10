# shellcheck shell=bash
# Sets ZONE to the zone that accepted the instance.
create_instance_in_first_available_zone() {
  local name="$1" zone out
  shift
  for zone in "$ZONE" ${FALLBACK_ZONES//,/ }; do
    if out="$(gcloud compute instances create "$name" --zone "$zone" "$@" 2>&1)"; then
      ZONE="$zone"
      return 0
    fi
    grep -q ZONE_RESOURCE_POOL_EXHAUSTED <<<"$out" || { printf '%s\n' "$out" >&2; return 1; }
    echo "zone $zone has no capacity for $name; trying the next zone" >&2
  done
  printf '%s\n' "$out" >&2
  return 1
}
