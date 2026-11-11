SECRET_SETUP_STEPS=()
SECRET_COMPLETENESS_STEPS=()
SECRET_VERIFY_REGISTRATIONS=()
SECRET_KEY_VALIDATORS=()
SECRET_VERIFY_CHECKS=()

load_secret_extensions() {
  local extension
  for extension in "$1"/*/secrets.sh; do
    [[ -f "$extension" ]] || continue
    # shellcheck source=/dev/null
    source "$extension"
  done
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
