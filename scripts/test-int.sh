#!/usr/bin/env bash
# Runs the backend integration tests against the local kind cluster (NF-16).

source "$(dirname "$0")/lib.sh"
[[ -f "${KIND_KUBECONFIG}" ]] || die "No kind cluster found. Run 'pnpm kind:up' first."

cd "${ROOT_DIR}"
bash scripts/crds-install.sh >/dev/null
exec pnpm --filter @capi-navigator/backend exec vitest run --config vitest.int.config.ts "$@"
