#!/usr/bin/env bash
# Installs the app's own CRDs (deploy/crds) into the local kind cluster.

source "$(dirname "$0")/lib.sh"
require kubectl

[[ -f "${KIND_KUBECONFIG}" ]] || die "No kind cluster found. Run 'pnpm kind:up' first."

shopt -s nullglob
crds=("${ROOT_DIR}"/deploy/crds/*.yaml)
if (( ${#crds[@]} == 0 )); then
  log "No CRDs in deploy/crds yet; nothing to install."
  exit 0
fi

log "Installing ${#crds[@]} CRD file(s)"
kubectl apply --server-side --field-manager capi-navigator -f "${ROOT_DIR}/deploy/crds/"
