#!/usr/bin/env bash
# Removes Dex (pnpm dex:up) from the local kind cluster and the OIDC settings for pnpm dev.

source "$(dirname "$0")/lib.sh"
require kubectl helm

ENV_FILE="${ROOT_DIR}/.kube/dex-${KIND_CLUSTER_NAME}.env"
if helm status dex --namespace dex >/dev/null 2>&1; then
  log "Removing Dex"
  helm uninstall dex --namespace dex --wait >/dev/null
  kubectl delete namespace dex --ignore-not-found >/dev/null
fi
docker rm -f "${KIND_CLUSTER_NAME}-dex-proxy" >/dev/null 2>&1 || true
rm -f "${ENV_FILE}"
log "Done. Restart pnpm dev to sign in without OIDC."
