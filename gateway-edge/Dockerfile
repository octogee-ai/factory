# Build context: repo root (see gateway-edge/cloudbuild.yaml). gateway-edge
# consumes packed internal directory dependencies — no sibling source is compiled.
#
# WORKDIR must be /gateway-edge (not /app) so that tsc's emit paths — which
# mirror each source file's location relative to rootDir ("..", the container
# root /) — produce dist/gateway-edge/src/index.js, matching package.json
# main + CMD.
FROM node:26-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS builder
WORKDIR /gateway-edge
# Packed directories must be present before npm ci resolves their type interfaces.
COPY core/package.json /core/package.json
COPY core/dist /core/dist
COPY shared/package.json /shared/package.json
COPY shared/dist /shared/dist
COPY test-helpers/package.json /test-helpers/package.json
COPY test-helpers/dist /test-helpers/dist
COPY gateway-edge/.npmrc gateway-edge/package.json gateway-edge/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY scripts/ops/sync-local-file-deps.mjs /scripts/ops/sync-local-file-deps.mjs
COPY gateway-edge/tsconfig.json ./
COPY gateway-edge/src/ ./src/
# `npm run build` = tsc → tsc-alias → verify:no-alias-leakage. The
# alias rewriter and post-build grep guard together prevent the
# MODULE_NOT_FOUND @shared/* runtime failure. See README "Shared code".
RUN npm run build

FROM golang:1.27.0-alpine@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS gitleaks-builder
ARG GITLEAKS_VERSION=8.30.1
RUN GODEBUG=http2client=0 CGO_ENABLED=0 go install \
      -ldflags="-X github.com/zricethezav/gitleaks/v8/version.Version=${GITLEAKS_VERSION} -X github.com/zricethezav/gitleaks/v8/version.DefaultMsg=${GITLEAKS_VERSION}" \
      github.com/zricethezav/gitleaks/v8@v${GITLEAKS_VERSION} \
    && test "$(/go/bin/gitleaks version)" = "${GITLEAKS_VERSION}"

FROM node:26-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146
WORKDIR /gateway-edge
ARG NPM_VERSION=12.0.1
RUN npm install --global npm@${NPM_VERSION} --ignore-scripts --no-audit --no-fund \
    && npm_root="$(npm root --global)" \
    && npm install --global brace-expansion@5.0.8 --ignore-scripts --no-audit --no-fund \
    && rm -rf "$npm_root/npm/node_modules/brace-expansion" \
    && mv "$npm_root/brace-expansion" "$npm_root/npm/node_modules/brace-expansion"
# git + openssh-client are required for the Phase 6 working-tree
# routes (`gateway-edge/src/lib/workspace-git.ts`). Without them
# `spawn('git', …)` ENOENTs and `git push` over SSH has no transport.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=gitleaks-builder /go/bin/gitleaks /usr/local/bin/gitleaks
# The runtime install packs the direct internal directory dependencies.
COPY core/package.json /core/package.json
COPY core/dist /core/dist
COPY shared/package.json /shared/package.json
COPY shared/dist /shared/dist
COPY gateway-edge/.npmrc gateway-edge/package.json gateway-edge/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /gateway-edge/dist ./dist
COPY gateway-edge/agent-import-gitleaks.toml ./agent-import-gitleaks.toml
USER node
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/gateway-edge/src/index.js"]
