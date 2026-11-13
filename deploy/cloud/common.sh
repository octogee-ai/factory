#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-octogee-cloud}"
NAMESPACE="octogee-cloud"
PUBLIC_SCHEME="https"
PUBLIC_PORT_SUFFIX=""
DB_ADMIN_USER="postgres"
DB_SSLMODE="require"

require_settings() {
  local name missing=""
  for name in "$@"; do
    [ -n "$(printenv "${name}" || true)" ] || missing="${missing} ${name}"
  done
  [ -z "${missing}" ] || die "missing settings:${missing}; see docs/running-in-the-cloud.md"
}

use_dedicated_kubeconfig() {
  mkdir -p "${HOME}/.kube"
  export KUBECONFIG="${HOME}/.kube/octogee-cloud-${1}"
}

load_public_hosts() {
  CHAT_HOST="chat.${DOMAIN}"
  GIT_HOST="git.${DOMAIN}"
  ADMIN_EMAIL="platform-admin@${DOMAIN}"
}

open_installed_cluster() {
  case "${1:-}" in
    gcp | aws) ;;
    *) die "name the provider: gcp or aws" ;;
  esac
  require_tools kubectl curl base64
  require_settings DOMAIN
  use_dedicated_kubeconfig "${1}"
  [ -f "${KUBECONFIG}" ] || die "no cluster credentials at ${KUBECONFIG}; run the install first"
  KUBE_CONTEXT="$(kubectl config current-context)"
  load_public_hosts
}

route_answers() {
  curl -fsS --max-time 15 "https://${1}${2}"
}

install_cert_manager() {
  step "TLS certificates (cert-manager)"
  helm --kube-context "${KUBE_CONTEXT}" -n cert-manager upgrade --install cert-manager cert-manager \
    --repo https://charts.jetstack.io --version "${CERT_MANAGER_VERSION}" \
    --create-namespace --set crds.enabled=true --wait --timeout 8m >/dev/null
  kubectl --context "${KUBE_CONTEXT}" apply -f - >/dev/null <<YAML
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ${ACME_EMAIL}
    privateKeySecretRef:
      name: letsencrypt-account
    solvers:
      - http01:
          ingress:
            ingressClassName: traefik
YAML
}

print_dns_records() {
  local address
  address="$(k get service traefik \
    -o 'jsonpath={.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}')"
  [ -n "${address}" ] || die "the load balancer has no address yet; run this install again in a few minutes"
  step "Ready"
  echo "Point these two DNS records at ${address}:"
  echo "  ${CHAT_HOST}"
  echo "  ${GIT_HOST}"
  echo "Certificates are issued once DNS resolves."
  echo "Then open https://${CHAT_HOST} and sign in as ${ADMIN_USER}."
  echo "Password: ./deploy/cloud/credentials.sh ${PROVIDER}"
  echo "Check it: ./deploy/cloud/check.sh ${PROVIDER}"
}

install_on_cluster() {
  install_cert_manager
  install_ingress --set ports.websecure.expose.default=true "$@"
  install_apps
  print_dns_records
}
