#!/usr/bin/env bash

validate_gitea_token_consumer() {
  local deployment="$1" token_env="$2" api_url_env="$3" api_path="$4" pods pod
  if ! pods="$(kubectl get pods -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
    -l "app=$deployment" \
    -o json | python3 -c '
import json
import sys

for pod in json.load(sys.stdin).get("items", []):
    metadata = pod.get("metadata", {})
    status = pod.get("status", {})
    ready = any(
        condition.get("type") == "Ready" and condition.get("status") == "True"
        for condition in status.get("conditions", [])
    )
    if (
        not metadata.get("deletionTimestamp")
        and status.get("phase") == "Running"
        and ready
    ):
        print(metadata["name"])
')"; then
    fail "Could not list Gitea token consumer pods for $deployment"
    return 1
  fi
  if [[ -z "$pods" ]]; then
    fail "Gitea token consumer validation failed: no Ready non-terminating $deployment pod"
    return 1
  fi

  while IFS= read -r pod; do
    [[ -n "$pod" ]] || continue
    if ! kubectl exec -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" "$pod" -c "$deployment" -- \
      env TOKEN_ENV="$token_env" API_URL_ENV="$api_url_env" API_PATH="$api_path" \
      node --input-type=module -e '
const token = process.env[process.env.TOKEN_ENV];
const configuredApiUrl = process.env[process.env.API_URL_ENV];
const apiUrl = configuredApiUrl || (
  process.env.API_URL_ENV === "GITEA_URL"
    ? `http://octogee-gitea-http.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:3000`
    : ""
);
const apiPath = process.env.API_PATH;
if (!token) throw new Error(`missing ${process.env.TOKEN_ENV}`);
if (!apiUrl) throw new Error(`missing ${process.env.API_URL_ENV}`);
const identityUrl = new URL(apiPath, `${apiUrl.replace(/\/$/, "")}/`);
const response = await fetch(identityUrl, { headers: { Authorization: `token ${token}` } });
if (!response.ok) throw new Error(`Gitea authentication returned HTTP ${response.status}`);
const body = await response.json();
if (body.login !== "octogee-admin") throw new Error("Gitea authentication did not resolve octogee-admin");
const issueUrl = new URL("repos/issues/search?limit=1", identityUrl);
const issueResponse = await fetch(issueUrl, { headers: { Authorization: `token ${token}` } });
if (!issueResponse.ok) throw new Error(`Gitea issue access returned HTTP ${issueResponse.status}`);
' >/dev/null; then
      fail "Gitea token consumer validation failed: $deployment/$pod"
      return 1
    fi
  done <<< "$pods"
}

validate_gitea_token_consumers() {
  validate_gitea_token_consumer octogee-api GITEA_TOKEN GITEA_URL "api/v1/user" || return 1
  validate_gitea_token_consumer glm-controller GIT_API_TOKEN GIT_API_URL "user" || return 1
}

restart_gitea_token_consumers() {
  local deployment
  info "Restarting and authenticating Gitea token consumers serially: octogee-api and glm-controller"
  for deployment in octogee-api glm-controller; do
    kubectl rollout restart "deployment/$deployment" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" >/dev/null \
      || fail "Could not restart Gitea token consumer $deployment"
    kubectl rollout status "deployment/$deployment" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" --timeout=180s >/dev/null \
      || fail "Gitea token consumers did not become Ready: $deployment"
    case "$deployment" in
      octogee-api)
        validate_gitea_token_consumer octogee-api GITEA_TOKEN GITEA_URL "api/v1/user"
        ;;
      glm-controller)
        validate_gitea_token_consumer glm-controller GIT_API_TOKEN GIT_API_URL "user"
        ;;
    esac
  done
  ok "Gitea token consumers restarted and authenticated"
}
