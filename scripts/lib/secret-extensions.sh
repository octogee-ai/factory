#!/usr/bin/env bash

# shellcheck disable=SC2034
SECRET_SETUP_STEPS=()
SECRET_COMPLETENESS_STEPS=()
SECRET_VERIFY_REGISTRATIONS=()
SECRET_KEY_VALIDATORS=()
SECRET_VERIFY_CHECKS=()

load_secret_extensions() {
  local extension loaded=()
  for extension in "$1"/*/secrets.sh; do
    [[ -f "$extension" ]] || continue
    # shellcheck source=/dev/null
    source "$extension"
    loaded+=("$(basename "$(dirname "$extension")")")
  done
  if [[ ${#loaded[@]} -eq 0 ]]; then
    echo "No secret extensions loaded"
  else
    echo "Secret extensions loaded: ${loaded[*]}"
  fi
}

run_secret_steps() {
  local step
  for step in "$@"; do
    "$step"
  done
}

secret_key_invalid_reason() {
  local validator reason
  for validator in ${SECRET_KEY_VALIDATORS[@]+"${SECRET_KEY_VALIDATORS[@]}"}; do
    reason="$("$validator" "$1" "$2" "$3")"
    if [[ -n "$reason" ]]; then
      printf '%s' "$reason"
      return 0
    fi
  done
}
