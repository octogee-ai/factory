# Build context: repo root (see octogee-api/cloudbuild.yaml).
#
# octogee-api compiles gateway-edge/src/* in addition to its own src/ —
# the cluster route handlers physically live in gateway-edge/src/routes/
# and are imported via relative paths from octogee-api/src/index.ts.
# When gateway-edge is later slimmed to just its ~3 locality routes,
# the bulk of the route code moves out of that tree and this
# Dockerfile's COPY surface shrinks accordingly.
#
# Mirror of gateway-edge's build pattern (rootDir=.., tsc-alias for
# @shared/* alias rewriting, post-build alias-leakage guard).
FROM node:26-slim AS builder
WORKDIR /octogee-api

# @octogee/core ships as a committed tarball (file:../core/octogee-core.tgz);
# npm ci extracts it into node_modules. Copy it before any npm ci. Builder stage.
COPY core/octogee-core.tgz /core/octogee-core.tgz

COPY octogee-api/package.json octogee-api/package-lock.json* ./
RUN npm ci --ignore-scripts

# gateway-edge source files reference npm packages (express, firebase-admin,
# etc.); Node module resolution walks up from their location. Install
# gateway-edge's deps so files in /gateway-edge/src/ resolve cleanly
# during tsc. Builder stage only.
COPY gateway-edge/package.json gateway-edge/package-lock.json* /gateway-edge/
RUN npm ci --prefix /gateway-edge --ignore-scripts

# scripts/lib/* is included in tsc (admin-fleet-router etc.); install its
# deps for the same module-resolution reason.
COPY scripts/package.json scripts/package-lock.json* /scripts/
RUN npm ci --prefix /scripts --ignore-scripts

COPY octogee-api/tsconfig.json ./
COPY octogee-api/src/ ./src/
COPY gateway-edge/src/ /gateway-edge/src/
COPY shared/ /shared/
COPY scripts/lib/ /scripts/lib/
# shared/ws/upgrade-router.ts imports `ws` at build time; tsc resolves it
# by walking up from /shared, which can't see /octogee-api/node_modules.
# Install shared's own declared deps (ws + @types/ws) at /shared.
RUN npm ci --prefix /shared --ignore-scripts

RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────
FROM node:26-slim
WORKDIR /octogee-api

# sharp (image processing for workspace/upload thumbnails) needs libvips.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

# @octogee/core tarball at runtime; the compiled shim under dist/scripts/lib
# resolves @octogee/core/* from the node_modules npm ci extracts it into.
COPY core/octogee-core.tgz /core/octogee-core.tgz

COPY octogee-api/package.json octogee-api/package-lock.json* ./
RUN npm ci --omit=dev

# Runtime module resolution note: the BUILDER stage installs gateway-edge
# deps at /gateway-edge/node_modules so tsc can resolve npm packages
# imported by files under /gateway-edge/src/. That's a build-time
# concern only. At RUNTIME, the compiled .js lives under
# /octogee-api/dist/gateway-edge/... — Node's resolution walks UP from
# that path through /octogee-api/dist → /octogee-api → /octogee-api/node_modules.
# So all runtime imports resolve through octogee-api's deps, not
# gateway-edge's. No /gateway-edge install here (was previously dead
# weight + a silent divergence trap if the two package.jsons drifted).
COPY --from=builder /octogee-api/dist ./dist

# Bake the build SHA into the image so the boot banner can report it.
# Passed by Cloud Build via --build-arg BUILD_SHA=$_IMAGE_TAG. Without
# this, process.env.BUILD_SHA stays undefined and the banner logs
# "unknown" — making it hard to diagnose stale-image deploy issues
# in PROD (Bender flagged on PR #1116).
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

USER node
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/octogee-api/src/index.js"]
