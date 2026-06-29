#!/usr/bin/env bash

trim_env_whitespace() {
  local value="$1"
  value="${value%$'\r'}"
  while [[ "$value" == [[:space:]]* ]]; do
    value="${value#?}"
  done
  while [[ "$value" == *[[:space:]] ]]; do
    value="${value%?}"
  done
  printf '%s' "$value"
}

normalise_env_value() {
  local value
  value="$(trim_env_whitespace "$1")"
  if (( ${#value} >= 2 )); then
    local first="${value:0:1}"
    local last="${value: -1}"
    if [[ ( "$first" == '"' && "$last" == '"' ) || ( "$first" == "'" && "$last" == "'" ) ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "$value"
}

load_env_file() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0

  local line trimmed key raw_key raw_value value
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim_env_whitespace "$line")"
    [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]] && continue
    [[ "$trimmed" != *=* ]] && continue

    raw_key="${trimmed%%=*}"
    raw_value="${trimmed#*=}"
    key="$(trim_env_whitespace "$raw_key")"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="$(normalise_env_value "$raw_value")"
    [[ -n "$value" ]] || continue
    export "$key=$value"
  done < "$env_file"
}
