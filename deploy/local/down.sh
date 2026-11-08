#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

require_tools kind
kind delete cluster --name "${CLUSTER_NAME}" --kubeconfig "${KUBECONFIG}"
rm -f "${KUBECONFIG}"
echo "Removed the local cluster and all of its data."
