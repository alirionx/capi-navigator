#!/usr/bin/env bash
# Removes Dex (pnpm dex:up) from the local kind cluster and the app's sign-in settings for it.

source "$(dirname "$0")/lib.sh"
require kubectl helm

APP_NAMESPACE=capi-navigator-system
if helm status dex --namespace dex >/dev/null 2>&1; then
  log "Removing Dex"
  helm uninstall dex --namespace dex --wait >/dev/null
  kubectl delete namespace dex --ignore-not-found >/dev/null
fi
docker rm -f "${KIND_CLUSTER_NAME}-dex-proxy" >/dev/null 2>&1 || true
# Remove the app's sign-in settings only if they point to this Dex.
issuer="$(kubectl -n "${APP_NAMESPACE}" get navigatorauthsettings oidc \
  -o jsonpath='{.spec.oidc.issuerUrl}' 2>/dev/null || true)"
if [[ "${issuer}" == "http://127.0.0.1:${DEX_PORT:-5556}" ]]; then
  kubectl -n "${APP_NAMESPACE}" delete navigatorauthsettings oidc --ignore-not-found >/dev/null
  kubectl -n "${APP_NAMESPACE}" delete secret capi-navigator-oidc-client --ignore-not-found >/dev/null
fi
log "Done. Sign-in with Dex is gone from the app."
