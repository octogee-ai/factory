# Build context: repo root (see gateway-edge/cloudbuild.yaml). gateway-edge
# consumes packed internal directory dependencies — no sibling source is compiled.
#
# WORKDIR must be /gateway-edge (not /app) so that tsc's emit paths — which
# mirror each source file's location relative to rootDir ("..", the container
# root /) — produce dist/gateway-edge/src/index.js, matching package.json
# main + CMD.
FROM node:26-slim AS builder
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

FROM node:26-slim
WORKDIR /gateway-edge
ARG TARGETARCH=amd64
ARG GITLEAKS_VERSION=8.30.1
# git + openssh-client are required for the Phase 6 working-tree
# routes (`gateway-edge/src/lib/workspace-git.ts`). Without them
# `spawn('git', …)` ENOENTs and `git push` over SSH has no transport.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    git \
    openssh-client \
    curl \
    ca-certificates \
    && case "$TARGETARCH" in \
      amd64) GITLEAKS_ARCH=x64; GITLEAKS_SHA=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;; \
      arm64) GITLEAKS_ARCH=arm64; GITLEAKS_SHA=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && GITLEAKS_ARCHIVE="gitleaks_${GITLEAKS_VERSION}_linux_${GITLEAKS_ARCH}.tar.gz" \
    && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${GITLEAKS_ARCHIVE}" -o "/tmp/${GITLEAKS_ARCHIVE}" \
    && echo "${GITLEAKS_SHA}  /tmp/${GITLEAKS_ARCHIVE}" | sha256sum -c - \
    && tar -xzf "/tmp/${GITLEAKS_ARCHIVE}" -C /usr/local/bin gitleaks \
    && chmod 0755 /usr/local/bin/gitleaks \
    && rm -f "/tmp/${GITLEAKS_ARCHIVE}" \
    && rm -rf /var/lib/apt/lists/*
# The runtime install packs the direct internal directory dependencies.
COPY core/package.json /core/package.json
COPY core/dist /core/dist
COPY shared/package.json /shared/package.json
COPY shared/dist /shared/dist
COPY gateway-edge/.npmrc gateway-edge/package.json gateway-edge/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /gateway-edge/dist ./dist
COPY gateway-edge/agent-import-gitleaks.toml ./agent-import-gitleaks.toml
USER node
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/gateway-edge/src/index.js"]
