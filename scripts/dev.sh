#!/usr/bin/env bash
# Starts backend and frontend in watch mode against the local kind cluster.

source "$(dirname "$0")/lib.sh"

if [[ ! -f "${KIND_KUBECONFIG}" ]]; then
  printf '\033[1;33mWarning:\033[0m no kind cluster found; run "pnpm kind:up". The home cluster will show as not reachable.\n'
fi

export LOG_JSON="${LOG_JSON:-false}"

cd "${ROOT_DIR}"
pnpm --filter @capi-navigator/shared build
exec pnpm -r --parallel dev
