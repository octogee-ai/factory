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

configured_secret_value() {
  local value
  value="$(normalise_env_value "$1")"
  [[ -z "$value" || "$value" == "placeholder" ]] && return 0
  printf '%s' "$value"
}

save_env_file_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1

  local tmp_file
  tmp_file="$(mktemp "${env_file}.tmp.XXXXXX")"
  if [[ -f "$env_file" ]]; then
    grep -v "^${key}=" "$env_file" > "$tmp_file" || true
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
  "personal_annual",
  "personal_pro_monthly",
  "personal_pro_annual",
  "personal_pro_max_monthly",
  "personal_pro_max_annual",
  "builder_hobby_monthly",
  "builder_hobby_annual",
  "builder_pro_monthly",
  "builder_pro_annual",
  "builder_team_monthly",
  "builder_team_annual",
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
  const valid = entries.length > 0 && entries.every(
    ([key, value]) => allowed.has(key) && typeof value === "string" && /^price_[A-Za-z0-9]+$/.test(value),
  );
  process.exit(valid ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}
