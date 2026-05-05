# Build context: repo root (see workspace-api/cloudbuild.yaml).
# workspace-api, shared/, and scripts/lib/ are all copied in so tsc can
# compile @shared/types/identity AND the shared admin-fleet-router
# factory (mounted by both workspace-api and glm-controller) along
# with src/.
#
# WORKDIR must be /workspace-api (not /app) so that tsc's emit paths —
# which mirror each source file's location relative to rootDir (the
# container root /) — produce dist/workspace-api/src/index.js, matching
# package.json main + CMD. Changing WORKDIR to /app made tsc emit
# dist/app/src/index.js and broke the runtime module resolution.
FROM node:22-slim AS builder
WORKDIR /workspace-api
COPY workspace-api/package.json workspace-api/package-lock.json* ./
RUN npm ci --ignore-scripts

# scripts/lib/admin-fleet-router.ts (et al.) live in workspace-api's tsc
# include but are physically at /scripts/lib/. Node module resolution
# walks UP from each file's directory, so `import "express"` inside
# /scripts/lib/admin-fleet-router.ts resolves through /scripts/node_modules
# — not /workspace-api/node_modules. Install scripts/'s deps so the
# compile resolves cleanly. Builder stage only — runtime image still
# only copies /workspace-api/dist (where the layout reverses: dist is
# inside /workspace-api so its imports do resolve through
# /workspace-api/node_modules).
COPY scripts/package.json scripts/package-lock.json* /scripts/
RUN npm ci --prefix /scripts --ignore-scripts

COPY workspace-api/tsconfig.json ./
COPY workspace-api/src/ ./src/
COPY shared/ /shared/
COPY scripts/lib/ /scripts/lib/
# `npm run build` = tsc → tsc-alias → verify:no-alias-leakage. The
# alias rewriter and post-build grep guard together prevent the
# MODULE_NOT_FOUND @shared/* runtime failure. See README "Shared code".
RUN npm run build

FROM node:22-slim
WORKDIR /workspace-api
# git + openssh-client are required for the Phase 6 working-tree
# routes (`workspace-api/src/lib/workspace-git.ts`). Without them
# `spawn('git', …)` ENOENTs and `git push` over SSH has no transport.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    git \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*
COPY workspace-api/package.json workspace-api/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /workspace-api/dist ./dist
USER node
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/workspace-api/src/index.js"]
