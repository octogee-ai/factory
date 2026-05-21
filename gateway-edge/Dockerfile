# Build context: repo root (see gateway-edge/cloudbuild.yaml).
# gateway-edge, shared/, and scripts/lib/ are all copied in so tsc can
# compile @shared/types/identity AND the shared admin-fleet-router
# factory (mounted by both gateway-edge and glm-controller) along
# with src/.
#
# WORKDIR must be /gateway-edge (not /app) so that tsc's emit paths —
# which mirror each source file's location relative to rootDir (the
# container root /) — produce dist/gateway-edge/src/index.js, matching
# package.json main + CMD. Changing WORKDIR to /app made tsc emit
# dist/app/src/index.js and broke the runtime module resolution.
FROM node:26-slim AS builder
WORKDIR /gateway-edge
COPY gateway-edge/package.json gateway-edge/package-lock.json* ./
RUN npm ci --ignore-scripts

# scripts/lib/admin-fleet-router.ts (et al.) live in gateway-edge's tsc
# include but are physically at /scripts/lib/. Node module resolution
# walks UP from each file's directory, so `import "express"` inside
# /scripts/lib/admin-fleet-router.ts resolves through /scripts/node_modules
# — not /gateway-edge/node_modules. Install scripts/'s deps so the
# compile resolves cleanly. Builder stage only — runtime image still
# only copies /gateway-edge/dist (where the layout reverses: dist is
# inside /gateway-edge so its imports do resolve through
# /gateway-edge/node_modules).
COPY scripts/package.json scripts/package-lock.json* /scripts/
RUN npm ci --prefix /scripts --ignore-scripts

COPY gateway-edge/tsconfig.json ./
COPY gateway-edge/src/ ./src/
COPY shared/ /shared/
COPY scripts/lib/ /scripts/lib/
# shared/ws/upgrade-router.ts imports `ws` at build time (pulled in
# transitively by the folded chat-proxy). tsc resolves `ws` by walking
# up from /shared, which can't see /gateway-edge/node_modules — so
# install shared's own declared deps (ws + @types/ws) at /shared.
# Runtime resolution is unaffected: the emitted dist lives under
# /gateway-edge and resolves `ws` from /gateway-edge/node_modules.
RUN npm ci --prefix /shared --ignore-scripts
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
COPY gateway-edge/package.json gateway-edge/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /gateway-edge/dist ./dist
USER node
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/gateway-edge/src/index.js"]
