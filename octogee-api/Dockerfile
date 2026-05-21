# Build context: repo root (see octogee-api/cloudbuild.yaml).
#
# octogee-api compiles workspace-api/src/* in addition to its own src/ —
# the cluster route handlers physically live in workspace-api/src/routes/
# and are imported via relative paths from octogee-api/src/index.ts.
# When workspace-api is later renamed gateway-edge and slimmed to ~3
# locality routes, the bulk of the route code moves out of that tree and
# this Dockerfile's COPY surface shrinks accordingly.
#
# Mirror of workspace-api's build pattern (rootDir=.., tsc-alias for
# @shared/* alias rewriting, post-build alias-leakage guard).
FROM node:26-slim AS builder
WORKDIR /octogee-api

COPY octogee-api/package.json octogee-api/package-lock.json* ./
RUN npm ci --ignore-scripts

# workspace-api source files reference npm packages (express, firebase-admin,
# etc.); Node module resolution walks up from their location. Install
# workspace-api's deps so files in /workspace-api/src/ resolve cleanly
# during tsc. Builder stage only.
COPY workspace-api/package.json workspace-api/package-lock.json* /workspace-api/
RUN npm ci --prefix /workspace-api --ignore-scripts

# scripts/lib/* is included in tsc (admin-fleet-router etc.); install its
# deps for the same module-resolution reason.
COPY scripts/package.json scripts/package-lock.json* /scripts/
RUN npm ci --prefix /scripts --ignore-scripts

COPY octogee-api/tsconfig.json ./
COPY octogee-api/src/ ./src/
COPY workspace-api/src/ /workspace-api/src/
COPY shared/ /shared/
COPY scripts/lib/ /scripts/lib/

RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────
FROM node:26-slim
WORKDIR /octogee-api

# sharp (image processing for workspace/upload thumbnails) needs libvips.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

COPY octogee-api/package.json octogee-api/package-lock.json* ./
RUN npm ci --omit=dev

# Runtime module resolution note: the BUILDER stage installs workspace-api
# deps at /workspace-api/node_modules so tsc can resolve npm packages
# imported by files under /workspace-api/src/. That's a build-time
# concern only. At RUNTIME, the compiled .js lives under
# /octogee-api/dist/workspace-api/... — Node's resolution walks UP from
# that path through /octogee-api/dist → /octogee-api → /octogee-api/node_modules.
# So all runtime imports resolve through octogee-api's deps, not
# workspace-api's. No /workspace-api install here (was previously dead
# weight + a silent divergence trap if the two package.jsons drifted).
COPY --from=builder /octogee-api/dist ./dist

USER node
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/octogee-api/src/index.js"]
