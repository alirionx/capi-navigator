# FP0-F-04: multi-stage build producing a single image.
# The backend serves the built frontend statically (section 4, Operations).

FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/backend apps/backend
COPY apps/frontend apps/frontend
COPY LICENSE NOTICE ./
COPY scripts/third-party-notices.mjs scripts/
# Third-party notices (served at /third-party-notices.txt) and the license gate.
RUN node scripts/third-party-notices.mjs
RUN pnpm --filter @capi-navigator/shared build \
 && pnpm --filter @capi-navigator/backend build \
 && pnpm --filter @capi-navigator/frontend build \
 && pnpm --filter @capi-navigator/backend deploy --prod --legacy /out \
 && cp -r apps/frontend/dist /out/public \
 && cp LICENSE NOTICE /out/

FROM node:24-bookworm-slim AS runtime
# Set by the release workflow from the tag; local builds are development versions.
ARG APP_VERSION=0.0.0-dev
# NODE_USE_ENV_PROXY: outbound requests honour HTTPS_PROXY, HTTP_PROXY and NO_PROXY when they are
# set (FP-29); without them nothing changes.
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=3000 \
    STATIC_DIR=/app/public \
    NODE_USE_ENV_PROXY=1
WORKDIR /app
COPY --from=build --chown=node:node /out /app
# Numeric (the user "node"), so Kubernetes can verify runAsNonRoot of the chart.
USER 1000:1000
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/main.js"]
