#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="octogee-cloud"
KUBE_CONTEXT="kind-${CLUSTER_NAME}"
export KUBECONFIG="${HOME}/.kube/octogee-cloud-local"
LOCAL_PORT="${LOCAL_PORT:-8088}"
INGRESS_NODE_PORT="30088"
NAMESPACE="octogee-cloud-local"
PUBLIC_SCHEME="http"
PUBLIC_PORT_SUFFIX=":${LOCAL_PORT}"
CHAT_HOST="chat.localhost"
GIT_HOST="git.localhost"
DB_HOST="postgres"
DB_ADMIN_USER="postgres"
DB_SSLMODE="disable"
ADMIN_EMAIL="local-admin@octogee.com"
BUCKET_NAME="platform"

cluster_exists() {
  kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"
}

require_cluster() {
  cluster_exists || die "there is no local cluster yet; run ./deploy/local/up.sh first"
}

route_answers() {
  curl -fsS --max-time 15 --resolve "${1}:${LOCAL_PORT}:127.0.0.1" "http://${1}:${LOCAL_PORT}${2}"
}
