#!/usr/bin/env bash

MM_ADMIN_PLATFORM_PAT_DESCRIPTION="octogee platform admin PAT"

mm_admin_pat_fingerprint() {
  printf '%s' "$1" | openssl dgst -sha256 -r | awk '{print $1}'
}

mm_admin_pat_is_valid() {
  local token="$1" expected_username="$2" expected_user_id="$3" expected_token_id="$4" expected_fingerprint="$5" base_url="$6"
  local me_response token_response fingerprint
  [[ -n "$token" && -n "$expected_username" && -n "$expected_user_id" && -n "$expected_token_id" && -n "$expected_fingerprint" && -n "$base_url" ]] || return 1

  fingerprint=$(mm_admin_pat_fingerprint "$token")
  [[ "$fingerprint" == "$expected_fingerprint" ]] || return 1

  me_response=$(curl -s "$base_url/api/v4/users/me" \
    -H "Authorization: Bearer $token" 2>/dev/null || true)
  if ! python3 -c '
import json, sys
try:
    user = json.loads(sys.stdin.read())
except json.JSONDecodeError:
    raise SystemExit(1)
roles = user.get("roles", "")
raise SystemExit(not (
    user.get("id") == sys.argv[1]
    and user.get("username") == sys.argv[2]
    and "system_admin" in roles.split()
))
' "$expected_user_id" "$expected_username" <<<"$me_response"; then
    return 1
  fi

  token_response=$(curl -s "$base_url/api/v4/users/tokens/$expected_token_id" \
    -H "Authorization: Bearer $token" 2>/dev/null || true)
  python3 -c '
import json, sys
try:
    access_token = json.loads(sys.stdin.read())
except json.JSONDecodeError:
    raise SystemExit(1)
raise SystemExit(not (
    access_token.get("id") == sys.argv[1]
    and access_token.get("user_id") == sys.argv[2]
    and access_token.get("description") == sys.argv[3]
    and access_token.get("is_active") is True
))
' "$expected_token_id" "$expected_user_id" "$MM_ADMIN_PLATFORM_PAT_DESCRIPTION" <<<"$token_response"
}
