# Build context: repo root (see gateway-edge/cloudbuild.yaml). gateway-edge
# consumes @octogee/core + @octogee/shared (+ @octogee/test-helpers, a devDep
# for the emulator specs) as committed tarballs — no sibling source is compiled.
#
# WORKDIR must be /gateway-edge (not /app) so that tsc's emit paths — which
# mirror each source file's location relative to rootDir ("..", the container
# root /) — produce dist/gateway-edge/src/index.js, matching package.json
# main + CMD.
FROM node:26-slim AS builder
WORKDIR /gateway-edge
# Committed tarballs, before npm ci (which extracts them) for tsc .d.ts
# resolution. test-helpers is a devDep; npm ci installs it (builder only).
COPY core/octogee-core.tgz /core/octogee-core.tgz
COPY shared/octogee-shared.tgz /shared/octogee-shared.tgz
COPY test-helpers/octogee-test-helpers.tgz /test-helpers/octogee-test-helpers.tgz
COPY gateway-edge/package.json gateway-edge/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY scripts/ops/sync-local-file-deps.mjs /scripts/ops/sync-local-file-deps.mjs
COPY gateway-edge/tsconfig.json ./
COPY gateway-edge/src/ ./src/
# `npm run build` = tsc → tsc-alias → verify:no-alias-leakage. The
# alias rewriter and post-build grep guard together prevent the
# MODULE_NOT_FOUND @shared/* runtime failure. See README "Shared code".
RUN npm run build

FROM node:26-slim
WORKDIR /gateway-edge
# git + openssh-client are required for the Phase 6 working-tree
# routes (`gateway-edge/src/lib/workspace-git.ts`). Without them
# `spawn('git', …)` ENOENTs and `git push` over SSH has no transport.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    git \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*
# @octogee/core tarball at runtime; the compiled shim under dist/scripts/lib
# resolves @octogee/core/* from the extracted node_modules.
COPY core/octogee-core.tgz /core/octogee-core.tgz
COPY shared/octogee-shared.tgz /shared/octogee-shared.tgz
COPY gateway-edge/package.json gateway-edge/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /gateway-edge/dist ./dist
USER node
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/gateway-edge/src/index.js"]
