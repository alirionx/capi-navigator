# Shared settings for the local development scripts. Source, do not execute.
#
# All scripts work exclusively against the local kind cluster. KUBECONFIG is always
# overridden so a kubeconfig of a real cluster in the user's environment is never touched.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-capi-navigator}"
KIND_KUBECONFIG="${ROOT_DIR}/.kube/kind-${KIND_CLUSTER_NAME}.yaml"

# Defaults from versions.yaml (pnpm versions:generate writes scripts/versions.generated.env).
# shellcheck source=versions.generated.env
source "${ROOT_DIR}/scripts/versions.generated.env"
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-${CERT_MANAGER_VERSION_DEFAULT}}"
CAPI_OPERATOR_VERSION="${CAPI_OPERATOR_VERSION:-${CAPI_OPERATOR_VERSION_DEFAULT}}"

export KUBECONFIG="${KIND_KUBECONFIG}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is required but not installed."
  done
}
