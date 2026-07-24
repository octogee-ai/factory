#!/usr/bin/env bash

validate_gitea_token_consumer() {
  local deployment="$1" token_env="$2" api_url_env="$3" api_path="$4" pods pod
  pods=$(kubectl get pods -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
    -l "app=$deployment" \
    -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\n"}{end}') \
    || fail "Could not list Gitea token consumer pods for $deployment"
  [[ -n "$pods" ]] || fail "Gitea token consumer validation failed: no Running $deployment pod"

  while IFS= read -r pod; do
    [[ -n "$pod" ]] || continue
    kubectl exec -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" "$pod" -c "$deployment" -- \
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
const url = new URL(apiPath, `${apiUrl.replace(/\/$/, "")}/`);
const response = await fetch(url, { headers: { Authorization: `token ${token}` } });
if (!response.ok) throw new Error(`Gitea authentication returned HTTP ${response.status}`);
const body = await response.json();
if (body.login !== "octogee-admin") throw new Error("Gitea authentication did not resolve octogee-admin");
' >/dev/null \
      || fail "Gitea token consumer validation failed: $deployment/$pod"
  done <<< "$pods"
}

validate_gitea_token_consumers() {
  validate_gitea_token_consumer octogee-api GITEA_TOKEN GITEA_URL "api/v1/user"
  validate_gitea_token_consumer glm-controller GIT_API_TOKEN GIT_API_URL "user"
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
