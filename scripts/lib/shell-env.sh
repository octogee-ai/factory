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

read_env_file_value() {
  local env_file="$1"
  local requested_key="$2"
  [[ "$requested_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
    echo "Invalid env key: $requested_key" >&2
    return 1
  }
  [[ -f "$env_file" ]] || {
    echo "Env file does not exist: $env_file" >&2
    return 1
  }

  local line trimmed key raw_key raw_value value="" match_count=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim_env_whitespace "$line")"
    [[ -z "$trimmed" || "${trimmed:0:1}" == "#" ]] && continue
    [[ "$trimmed" != *=* ]] && continue

    raw_key="${trimmed%%=*}"
    key="$(trim_env_whitespace "$raw_key")"
    [[ "$key" == "$requested_key" ]] || continue
    raw_value="${trimmed#*=}"
    value="$(normalise_env_value "$raw_value")"
    match_count=$((match_count + 1))
  done < "$env_file"

  [[ "$match_count" == "1" ]] || {
    echo "Expected exactly one $requested_key entry in $env_file; found $match_count" >&2
    return 1
  }
  [[ -n "$value" ]] || {
    echo "$requested_key is empty in $env_file" >&2
    return 1
  }
  printf '%s' "$value"
}

configured_secret_value() {
  local value
  value="$(normalise_env_value "$1")"
  case "$value" in
    ""|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]|[Pp][Ll][Aa][Cc][Ee][Hh][Oo][Ll][Dd][Ee][Rr]-*) return 0 ;;
  esac
  printf '%s' "$value"
}

configured_stripe_price_ids_value() {
  local value
  value="$(configured_secret_value "$1")"
  [[ -z "$value" || "$value" == "{}" ]] && return 0
  printf '%s' "$value"
}

posthog_cloud_required_for_env() {
  case "$1" in
    test|prod) return 0 ;;
    custom) return 1 ;;
    *) return 1 ;;
  esac
}

materialize_stripe_price_ids_json() {
  if [[ -n "$1" ]]; then
    printf '%s' "$1"
  else
    printf '{}'
  fi
}

canonicalize_stripe_price_ids_json() {
  node - "$1" <<'NODE'
try {
  const parsed = JSON.parse(process.argv[2]);
  const sorted = Object.fromEntries(
    Object.entries(parsed).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
  process.stdout.write(JSON.stringify(sorted));
} catch {
  process.exit(1);
}
NODE
}

validate_stripe_secret_key_mode() {
  local env="$1"
  local key="$2"
  case "$env" in
    prod) [[ "$key" == sk_live_?* ]] ;;
    test|custom) [[ "$key" == sk_test_?* ]] ;;
    *) return 1 ;;
  esac
}

validate_stripe_webhook_secret() {
  local value
  value="$(configured_secret_value "$1")"
  [[ "$value" == whsec_?* ]]
}

select_environment_secret_value() {
  local env="$1"
  local secret_manager="$2"
  local env_file="$3"
  local kubernetes="$4"

  if [[ "$env" == "custom" ]]; then
    printf '%s' "${kubernetes:-${secret_manager:-$env_file}}"
  else
    printf '%s' "${secret_manager:-${env_file:-$kubernetes}}"
  fi
}

secret_manager_secret_state() {
  local name="$1"
  local project="$2"
  local listed candidate
  if ! listed="$(gcloud secrets list \
    --project="$project" \
    --format='value(name)' 2>/dev/null)"; then
    printf error
    return 0
  fi
  while IFS= read -r candidate; do
    if [[ "$candidate" == "$name" ]]; then
      printf present
      return 0
    fi
  done <<< "$listed"
  printf absent
}

save_env_file_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1

  local tmp_file
  tmp_file="$(mktemp "${env_file}.tmp.XXXXXX")"
  if [[ -f "$env_file" ]] \
    && ! awk -v key="$key" 'index($0, key "=") != 1' "$env_file" > "$tmp_file"; then
    rm -f "$tmp_file"
    return 1
  fi
  if ! printf '%s=%s\n' "$key" "$value" >> "$tmp_file" \
    || ! chmod 600 "$tmp_file" \
    || ! mv "$tmp_file" "$env_file"; then
    rm -f "$tmp_file"
    return 1
  fi
}

validate_stripe_price_ids_json() {
  node - "$1" <<'NODE'
const allowed = new Set([
  "personal_monthly",
  "personal_pro_monthly",
  "personal_pro_max_monthly",
  "builder_hobby_monthly",
  "builder_pro_monthly",
  "builder_team_monthly",
  "credit_10",
  "credit_25",
  "credit_50",
  "credit_100",
]);

try {
  const parsed = JSON.parse(process.argv[2]);
  const entries = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.entries(parsed)
    : [];
  const valid = entries.length === allowed.size && entries.every(
    ([key, value]) => allowed.has(key) && typeof value === "string" && /^price_[A-Za-z0-9]+$/.test(value),
  );
  process.exit(valid ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}
