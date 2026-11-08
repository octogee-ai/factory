#!/bin/bash

failures=0

check() {
  local name="${1}"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "ok    ${name}"
  else
    echo "FAIL  ${name}"
    failures=$((failures + 1))
  fi
}

one_shot() {
  k delete pod "${1}" --ignore-not-found --now
  k run "${1}" --image="${2}" --restart=Never --attach --rm --quiet --overrides="${3}"
}

database_overrides() {
  cat <<JSON
{"spec":{"containers":[{"name":"check-database","image":"${POSTGRES_IMAGE}","env":[
{"name":"PGHOST","valueFrom":{"configMapKeyRef":{"name":"platform-settings","key":"db-host"}}},
{"name":"PGSSLMODE","valueFrom":{"configMapKeyRef":{"name":"platform-settings","key":"db-sslmode"}}},
{"name":"PGUSER","value":"platform"},
{"name":"PGDATABASE","value":"platform"},
{"name":"PGPASSWORD","valueFrom":{"secretKeyRef":{"name":"platform-credentials","key":"platform-db-password"}}}],
"command":["sh","-c","test \"\$(psql -Atc \"select count(*) from pg_extension where extname in ('vector','unaccent','pg_trgm')\")\" = 3"]}]}}
JSON
}

object_store_overrides() {
  cat <<JSON
{"spec":{"containers":[{"name":"check-object-store","image":"${AWS_CLI_IMAGE}","env":[
$(object_store_env)],
"command":["sh","-c","set -e; echo round-trip > /tmp/o; aws s3 cp /tmp/o s3://\$BUCKET/check.txt; U=\$(aws s3 presign s3://\$BUCKET/check.txt --expires-in 60); curl -fsS \"\$U\" | grep -q round-trip; aws s3 rm s3://\$BUCKET/check.txt"]}]}}
JSON
}

database_works() {
  one_shot check-database "${POSTGRES_IMAGE}" "$(database_overrides)"
}

object_store_round_trip() {
  one_shot check-object-store "${AWS_CLI_IMAGE}" "$(object_store_overrides)"
}

bot_exists() {
  mmctl_local user search "${BOT_NAME}" | grep -qw "${BOT_NAME}"
}

gateway_ready() {
  k exec deploy/gateway -c gateway -- node -e \
    "fetch('http://127.0.0.1:18789/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
}

gateway_connected_to_chat() {
  k logs deploy/gateway -c gateway | grep -q "\[mattermost\] connected as"
}

run_checks() {
  check "PostgreSQL has the required extensions" database_works
  check "S3 store round trip with a signed URL" object_store_round_trip
  check "Chat answers through the ingress" route_answers "${CHAT_HOST}" /api/v4/system/ping
  check "Git answers through the ingress" route_answers "${GIT_HOST}" /api/healthz
  check "Agent bot exists in chat" bot_exists
  check "Gateway is ready" gateway_ready
  check "Gateway connected to chat" gateway_connected_to_chat
  [ "${failures}" -eq 0 ] || die "${failures} of the checks failed"
  echo "All checks passed."
}
