#!/usr/bin/env bash

validate_openai_api_key() {
  local api_key="$1" status
  if [[ -z "$api_key" ]]; then
    printf 'OpenAI credential validation requires a non-empty key\n' >&2
    return 1
  fi
  if ! status="$(
    printf 'Authorization: Bearer %s\n' "$api_key" |
      curl --disable --silent --show-error \
        --output /dev/null \
        --write-out '%{http_code}' \
        --connect-timeout 10 \
        --max-time 20 \
        --request GET \
        --header @- \
        https://api.openai.com/v1/models
  )"; then
    printf 'OpenAI credential validation request failed\n' >&2
    return 1
  fi
  if [[ "$status" != "200" ]]; then
    printf 'OpenAI credential validation returned HTTP %s\n' "$status" >&2
    return 1
  fi
}
