#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

create_cluster() {
  kind create cluster --name "${CLUSTER_NAME}" --kubeconfig "${KUBECONFIG}" --wait 5m --config=- <<YAML
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: ${INGRESS_NODE_PORT}
        hostPort: ${LOCAL_PORT}
        listenAddress: 127.0.0.1
        protocol: TCP
YAML
}

ensure_cluster() {
  step "Kubernetes in Docker (kind)"
  mkdir -p "$(dirname "${KUBECONFIG}")"
  cluster_exists || create_cluster
  kind export kubeconfig --name "${CLUSTER_NAME}" --kubeconfig "${KUBECONFIG}" >/dev/null 2>&1
  kubectl --context "${KUBE_CONTEXT}" get nodes >/dev/null
}

ensure_object_store_keys() {
  k get secret object-store >/dev/null 2>&1 && return 0
  write_object_store "http://seaweedfs:8333" "${BUCKET_NAME}" "us-east-1" "$(random_hex)" "$(random_hex)"
}

create_bucket_overrides() {
  cat <<JSON
{"spec":{"containers":[{"name":"create-bucket","image":"${AWS_CLI_IMAGE}","env":[
$(object_store_env)],
"command":["sh","-c","aws s3 mb s3://\$BUCKET 2>/dev/null || aws s3 ls s3://\$BUCKET"]}]}}
JSON
}

install_postgres() {
  step "PostgreSQL"
  k apply -f "${LOCAL_DIR}/manifests/postgres.yaml" >/dev/null
  wait_ready statefulset/postgres
}

install_object_store() {
  step "S3 object store (SeaweedFS)"
  k apply -f "${LOCAL_DIR}/manifests/seaweedfs.yaml" >/dev/null
  wait_ready deploy/seaweedfs
  k delete pod create-bucket --ignore-not-found --now >/dev/null
  k run create-bucket --image="${AWS_CLI_IMAGE}" --restart=Never --attach --rm --quiet \
    --overrides="$(create_bucket_overrides)"
}

main() {
  require_tools docker kind kubectl helm openssl curl base64
  docker info >/dev/null 2>&1 || die "Docker is not running; see docs/requirements.md"
  ensure_cluster
  ensure_namespace
  ensure_credentials
  ensure_object_store_keys
  apply_settings
  apply_model_keys
  install_postgres
  prepare_databases
  install_object_store
  install_ingress --set service.spec.type=NodePort --set "ports.web.nodePort=${INGRESS_NODE_PORT}"
  install_apps
  step "Ready"
  echo "Chat: http://${CHAT_HOST}${PUBLIC_PORT_SUFFIX}"
  echo "Git:  http://${GIT_HOST}${PUBLIC_PORT_SUFFIX}"
  echo "Sign in as ${ADMIN_USER}. Get the password with: ./deploy/local/credentials.sh"
}

main "$@"
