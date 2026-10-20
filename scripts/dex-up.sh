#!/usr/bin/env bash
# FP-14: Dex as OpenID Connect provider in the local kind cluster, for tests and development.
#
# Usage: pnpm dex:up      configures the app's sign-in with Dex (Authentication page), no restart.
#        pnpm dex:down    removes Dex and these settings again.
#
# Test users (password DEX_TEST_PASSWORD, default "Dex-Test-Password-1"):
#   alice@example.com  groups: capi-admins
#   bob@example.com    groups: team-a
#   carol@example.com  no groups
# Dex runs in kind behind a NodePort; a small socat container in the kind Docker network publishes
# it on 127.0.0.1, so the browser and the backend reach it under the same issuer URL (the issuer in
# the tokens must match the discovery document). This also works with Docker Desktop, which has no
# route from the host into the kind network.

source "$(dirname "$0")/lib.sh"
require kubectl helm docker

DEX_CHART_VERSION="${DEX_CHART_VERSION:-${DEX_CHART_VERSION_DEFAULT}}"
DEX_NAMESPACE=dex
DEX_NODE_PORT="${DEX_NODE_PORT:-30556}"
DEX_PORT="${DEX_PORT:-5556}"
SOCAT_IMAGE="${SOCAT_IMAGE:-${SOCAT_IMAGE_DEFAULT}}"
PROXY="${KIND_CLUSTER_NAME}-dex-proxy"
DEX_TEST_PASSWORD="${DEX_TEST_PASSWORD:-Dex-Test-Password-1}"
PUBLIC_URL="${PUBLIC_URL:-http://localhost:5173}"
APP_NAMESPACE=capi-navigator-system
SECRET=capi-navigator-oidc-client

[[ -f "${KIND_KUBECONFIG}" ]] || die "No kind cluster found. Run 'pnpm kind:up' first."

issuer="http://127.0.0.1:${DEX_PORT}"

# Client secret of the test client: kept from an earlier run, otherwise random.
client_secret="$(kubectl -n "${APP_NAMESPACE}" get secret "${SECRET}" \
  -o jsonpath='{.data.clientSecret}' 2>/dev/null | base64 -d 2>/dev/null || true)"
[[ -n "${client_secret}" ]] || client_secret="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"

if command -v htpasswd >/dev/null 2>&1; then
  hash="$(htpasswd -bnBC 10 '' "${DEX_TEST_PASSWORD}" | tr -d ':\n')"
else
  hash="$(docker run --rm httpd:2.4-alpine htpasswd -bnBC 10 '' "${DEX_TEST_PASSWORD}" | tr -d ':\n')"
fi

user() { # email username uid groups...
  local email=$1 name=$2 uid=$3
  shift 3
  printf '      - email: %s\n        username: %s\n        preferredUsername: %s\n' \
    "${email}" "${name}" "${name}"
  printf '        userID: %s\n        hash: "%s"\n' "${uid}" "${hash}"
  printf '        groups: [%s]\n' "$(IFS=,; echo "$*")"
}

values="$(mktemp)"
trap 'rm -f "${values}"' EXIT
cat >"${values}" <<EOF
service:
  type: NodePort
  ports:
    http:
      nodePort: ${DEX_NODE_PORT}
config:
  issuer: ${issuer}
  storage:
    type: memory
  oauth2:
    skipApprovalScreen: true
  enablePasswordDB: true
  staticClients:
    - id: capi-navigator
      name: CAPI Navigator
      secret: ${client_secret}
      redirectURIs:
        - ${PUBLIC_URL}/api/auth/oidc/callback
  staticPasswords:
$(user alice@example.com alice 1b4c06a2-7c0e-4f55-9c1e-5a1f0d8d1a01 capi-admins)
$(user bob@example.com bob 2c5d17b3-8d1f-4a66-8d2f-6b2a1e9e2b02 team-a)
$(user carol@example.com carol 3d6e28c4-9e20-4b77-9e30-7c3b2fa03c03)
EOF

log "Installing Dex chart ${DEX_CHART_VERSION} (issuer ${issuer})"
helm upgrade --install dex dex --repo https://charts.dexidp.io --version "${DEX_CHART_VERSION}" \
  --namespace "${DEX_NAMESPACE}" --create-namespace --values "${values}" --wait --timeout 3m >/dev/null

log "Publishing Dex on ${issuer} (container ${PROXY})"
docker rm -f "${PROXY}" >/dev/null 2>&1 || true
docker run -d --name "${PROXY}" --restart unless-stopped --network kind \
  -p "127.0.0.1:${DEX_PORT}:${DEX_PORT}" "${SOCAT_IMAGE}" \
  "tcp-listen:${DEX_PORT},fork,reuseaddr" "tcp-connect:${KIND_CLUSTER_NAME}-control-plane:${DEX_NODE_PORT}" \
  >/dev/null

log "Waiting for ${issuer}/.well-known/openid-configuration"
for _ in $(seq 1 30); do
  curl -fsS -m 3 "${issuer}/.well-known/openid-configuration" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS -m 3 "${issuer}/.well-known/openid-configuration" >/dev/null ||
  die "Dex is not reachable at ${issuer}."

log "Configuring the app's OpenID Connect sign-in (NavigatorAuthSettings oidc, Secret ${SECRET})"
kubectl -n "${APP_NAMESPACE}" create secret generic "${SECRET}" \
  --from-literal=clientSecret="${client_secret}" --dry-run=client -o yaml |
  kubectl apply --server-side --field-manager=capi-navigator-dex-up --force-conflicts -f - >/dev/null
kubectl apply --server-side --field-manager=capi-navigator-dex-up --force-conflicts -f - >/dev/null <<EOF
apiVersion: navigator.capi-navigator.io/v1alpha1
kind: NavigatorAuthSettings
metadata:
  name: oidc
  namespace: ${APP_NAMESPACE}
  labels:
    app.kubernetes.io/part-of: capi-navigator
spec:
  oidc:
    enabled: true
    issuerUrl: ${issuer}
    clientId: capi-navigator
    scopes: openid profile email groups
    groupsClaim: groups
    usernameClaim: preferred_username
    buttonLabel: Sign in with Dex
    defaultRole: viewer
EOF
log "Done. The sign-in page of pnpm dev (${PUBLIC_URL}) now offers \"Sign in with Dex\"."
log "Test users: alice@example.com (capi-admins), bob@example.com (team-a), carol@example.com"
log "Dex has new signing keys after each install: a running backend accepts them within a minute."
