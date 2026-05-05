# Build context: repo root (see workspace-api/cloudbuild.yaml).
# workspace-api and shared/ are both copied in so tsc can compile
# @shared/types/identity along with src/.
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
COPY workspace-api/tsconfig.json ./
COPY workspace-api/src/ ./src/
COPY shared/ /shared/
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
