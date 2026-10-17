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
RUN pnpm --filter @capi-navigator/shared build \
 && pnpm --filter @capi-navigator/backend build \
 && pnpm --filter @capi-navigator/frontend build \
 && pnpm --filter @capi-navigator/backend deploy --prod --legacy /out \
 && cp -r apps/frontend/dist /out/public

FROM node:24-bookworm-slim AS runtime
ARG APP_VERSION=0.1.0
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=3000 \
    STATIC_DIR=/app/public
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/main.js"]
