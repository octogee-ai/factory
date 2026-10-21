# Build context: repo root. gateway-edge
# consumes packed internal directory dependencies — no sibling source is compiled.
#
# WORKDIR must be /gateway-edge (not /app) so that tsc's emit paths — which
# mirror each source file's location relative to rootDir ("..", the container
# root /) — produce dist/gateway-edge/src/index.js, matching package.json
# main + CMD.
FROM node:26-slim@sha256:f5da0a865cd28d1731e98c901355b4f3192a526a397f9f5a52607940c3b63caf AS builder
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

FROM golang:1.27.3-alpine@sha256:f2c872bcee949b7be9c490efd02b48a8a2fbf947cdf533f1c58525ec9d8170fd AS gitleaks-builder
ARG GITLEAKS_VERSION=8.30.1
RUN GODEBUG=http2client=0 CGO_ENABLED=0 go install \
      -ldflags="-X github.com/zricethezav/gitleaks/v8/version.Version=${GITLEAKS_VERSION} -X github.com/zricethezav/gitleaks/v8/version.DefaultMsg=${GITLEAKS_VERSION}" \
      github.com/zricethezav/gitleaks/v8@v${GITLEAKS_VERSION} \
    && test "$(/go/bin/gitleaks version)" = "${GITLEAKS_VERSION}"

FROM node:26-slim@sha256:f5da0a865cd28d1731e98c901355b4f3192a526a397f9f5a52607940c3b63caf
COPY infra/cloud-sql/octogee-pg-server-ca.pem /etc/ssl/certs/octogee-postgres-ca.pem
WORKDIR /gateway-edge
ARG NPM_VERSION=12.1.0
RUN npm install --global npm@${NPM_VERSION} --ignore-scripts --no-audit --no-fund \
    && npm_root="$(npm root --global)" \
    && npm install --global brace-expansion@5.0.12 --ignore-scripts --no-audit --no-fund \
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
