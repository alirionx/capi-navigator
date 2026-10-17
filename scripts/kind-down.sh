#!/usr/bin/env bash
# Deletes the local kind cluster created by kind-up.sh.

source "$(dirname "$0")/lib.sh"
require kind

log "Deleting kind cluster '${KIND_CLUSTER_NAME}'"
kind delete cluster --name "${KIND_CLUSTER_NAME}" --kubeconfig "${KIND_KUBECONFIG}"
rm -f "${KIND_KUBECONFIG}"
