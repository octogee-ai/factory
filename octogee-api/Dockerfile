# Build context: repo root (see octogee-api/cloudbuild.yaml).
#
# octogee-api compiles gateway-edge/src/* in addition to its own src/ —
# the cluster route handlers physically live in gateway-edge/src/routes/
# and are imported via relative paths from octogee-api/src/index.ts.
# When gateway-edge is later slimmed to just its ~3 locality routes,
# the bulk of the route code moves out of that tree and this
# Dockerfile's COPY surface shrinks accordingly.
#
# Mirror of gateway-edge's build pattern: rootDir=.. so tsc emits
# dist/octogee-api/src/ alongside dist/gateway-edge/src/ (the routes).
FROM node:26-slim AS builder
WORKDIR /octogee-api

# Packed internal directory dependencies must be present at their declared sibling paths.
COPY core/package.json /core/package.json
COPY core/dist /core/dist
COPY shared/package.json /shared/package.json
COPY shared/dist /shared/dist
COPY test-helpers/package.json /test-helpers/package.json
COPY test-helpers/dist /test-helpers/dist
COPY octogee-api/.npmrc octogee-api/package.json octogee-api/package-lock.json* ./
RUN npm ci --ignore-scripts

# octogee-api compiles gateway-edge/src/* (the cluster route handlers). Install
# gateway-edge's deps so its package imports resolve during tsc by walking up
# from /gateway-edge/src/. Builder stage only.
COPY gateway-edge/.npmrc gateway-edge/package.json gateway-edge/package-lock.json* /gateway-edge/
RUN npm ci --prefix /gateway-edge --ignore-scripts

COPY scripts/ops/sync-local-file-deps.mjs /scripts/ops/sync-local-file-deps.mjs
COPY octogee-api/tsconfig.json ./
COPY octogee-api/src/ ./src/
COPY gateway-edge/src/ /gateway-edge/src/

RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────
FROM node:26-slim
WORKDIR /octogee-api
ARG NPM_VERSION=12.0.1
RUN npm install --global npm@${NPM_VERSION} --ignore-scripts --no-audit --no-fund

# The runtime install also packs the direct internal directory dependencies.
COPY core/package.json /core/package.json
COPY core/dist /core/dist
COPY shared/package.json /shared/package.json
COPY shared/dist /shared/dist
COPY octogee-api/.npmrc octogee-api/package.json octogee-api/package-lock.json* ./
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
