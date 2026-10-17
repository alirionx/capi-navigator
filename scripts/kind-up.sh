#!/usr/bin/env bash
# FP0-F-06: local kind cluster acting as home and management cluster.
#
# Usage: pnpm kind:up [--bare]
#   --bare   create only the cluster, without cert-manager and CAPI Operator
#            (to test the installation instructions of FP-3, FP3-F-03)

source "$(dirname "$0")/lib.sh"
require kind kubectl helm docker

BARE=false
for arg in "$@"; do
  case "$arg" in
    --bare) BARE=true ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

mkdir -p "$(dirname "${KIND_KUBECONFIG}")"

if kind get clusters 2>/dev/null | grep -qx "${KIND_CLUSTER_NAME}"; then
  log "kind cluster '${KIND_CLUSTER_NAME}' already exists"
  kind export kubeconfig --name "${KIND_CLUSTER_NAME}" --kubeconfig "${KIND_KUBECONFIG}" >/dev/null
else
  log "Creating kind cluster '${KIND_CLUSTER_NAME}'"
  kind create cluster --name "${KIND_CLUSTER_NAME}" --kubeconfig "${KIND_KUBECONFIG}" --wait 120s
fi

kubectl create namespace capi-navigator-system --dry-run=client -o yaml | kubectl apply -f - >/dev/null

if [[ "${BARE}" == "true" ]]; then
  log "--bare: skipping cert-manager and CAPI Operator"
else
  log "Installing cert-manager ${CERT_MANAGER_VERSION}"
  helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager \
    --version "${CERT_MANAGER_VERSION}" \
    --namespace cert-manager --create-namespace \
    --set crds.enabled=true \
    --wait --timeout 5m

  log "Installing CAPI Operator ${CAPI_OPERATOR_VERSION}"
  helm upgrade --install capi-operator cluster-api-operator \
    --repo https://kubernetes-sigs.github.io/cluster-api-operator \
    --version "${CAPI_OPERATOR_VERSION}" \
    --namespace capi-operator-system --create-namespace \
    --wait --timeout 5m
fi

log "Done. Kubeconfig: ${KIND_KUBECONFIG}"
log "Start the app with: pnpm dev"
