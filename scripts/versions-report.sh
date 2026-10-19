#!/usr/bin/env bash
# Writes docs/versions-report.md: newer versions for versions.yaml, GitHub Actions and Docker
# images (FP20-F-05, ADR-0018). Renovate runs in a pinned container, only looks up versions,
# and sees the repository read-only; nothing else in the repository changes.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RENOVATE_VERSION="44.133.0"
IMAGE="renovate/renovate:${RENOVATE_VERSION}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
chmod 777 "${work}" # Renovate runs as an unprivileged user in the container.

# GitHub release lookups need a token; use the local gh login for this run only (FP20-F-06).
token_used=false
if command -v gh >/dev/null && GITHUB_COM_TOKEN="$(gh auth token 2>/dev/null)"; then
  export GITHUB_COM_TOKEN
  token_used=true
else
  echo "No gh login: GitHub release lookups are limited (run 'gh auth login')." >&2
  unset GITHUB_COM_TOKEN
fi

echo "Looking up versions with Renovate ${RENOVATE_VERSION} (takes about a minute)..."
docker run --rm \
  -v "${ROOT_DIR}:/usr/src/app:ro" -v "${work}:/out" -w /usr/src/app \
  ${GITHUB_COM_TOKEN:+-e GITHUB_COM_TOKEN} -e LOG_LEVEL=warn \
  "${IMAGE}" --platform=local \
  --enabled-managers=custom.jsonata,github-actions,dockerfile,nvm \
  --report-type=file --report-path=/out/report.json >"${work}/renovate.log" 2>&1 || {
  cat "${work}/renovate.log" >&2
  exit 1
}

cd "${ROOT_DIR}"
pnpm --filter @capi-navigator/shared build >/dev/null
node packages/shared/dist/versions/report-cli.js "${work}/report.json" "${RENOVATE_VERSION}" "${token_used}"
npx prettier --write docs/versions-report.md >/dev/null
