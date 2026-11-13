#!/usr/bin/env bash

github_oauth_verify_redirect() {
  local client_id="$1" callback_uri="$2" curl_bin="$3"
  local headers http_status location

  if ! headers="$("$curl_bin" \
    --silent \
    --show-error \
    --max-time 20 \
    --max-redirs 0 \
    --head \
    --get 'https://github.com/login/oauth/authorize' \
    --data-urlencode "client_id=$client_id" \
    --data-urlencode "redirect_uri=$callback_uri" \
    --data-urlencode 'response_type=code' \
    --data-urlencode 'scope=repo')"; then
    echo "Could not reach GitHub to verify the OAuth callback" >&2
    return 1
  fi

  http_status="$(printf '%s\n' "$headers" | awk '/^HTTP\// { status = $2 } END { sub(/\r$/, "", status); print status }')"
  location="$(printf '%s\n' "$headers" | awk 'BEGIN { IGNORECASE = 1 } /^HTTP\// { location = "" } /^location:/{ sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); location = $0 } END { print location }')"
  if [[ "$http_status" != "302" || "$location" != https://github.com/login\?* ]]; then
    echo "GitHub rejected the configured OAuth callback; register $callback_uri on this OAuth app" >&2
    return 1
  fi

  echo "GitHub OAuth authorization endpoint reachable for: $callback_uri"
  echo "Browser consent is required to prove callback registration"
}

github_oauth_require_distinct_client_ids() {
  local current_client_id="$1" peer_client_id="$2" current_target="$3" peer_target="$4"

  if [[ -n "$current_client_id" && "$current_client_id" == "$peer_client_id" ]]; then
    echo "$current_target and $peer_target must use distinct GitHub OAuth client IDs" >&2
    return 1
  fi
}

github_oauth_configured_client_id() {
  local env_file="$1"

  if ! grep -Eq '^[[:space:]]*GITHUB_CLIENT_ID[[:space:]]*=' "$env_file"; then
    return 0
  fi
  read_env_file_value "$env_file" GITHUB_CLIENT_ID
}

github_oauth_env_file_for_target() {
  local repo_dir="$1" target_id="$2"

  case "$target_id" in
    prod-central) printf '%s/.env\n' "$repo_dir" ;;
    test-central) printf '%s/.env.test\n' "$repo_dir" ;;
    *) printf '%s/.env.%s\n' "$repo_dir" "$target_id" ;;
  esac
}
