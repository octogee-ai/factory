ARG OPENCLAW_BASE_IMAGE=openclaw:local
FROM ${OPENCLAW_BASE_IMAGE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ── Octogee gateway image ────────────────────────────────────────────────────
# Base image (octogee-gateway-base) already contains:
#   - OpenClaw npm install
#   - All apt packages (curl, jq, python3, git, sqlite3, etc.)
#   - npm cache with correct ownership
#
# This image only adds NuCrew-specific code that changes per commit.
# Keep heavy/stable deps in Dockerfile.base to maximise layer cache hits.
# ─────────────────────────────────────────────────────────────────────────────

USER root

# Packed internal directory dependencies must be present before scripts installs.
COPY --chown=node:node core/package.json /octogee/core/package.json
COPY --chown=node:node core/dist /octogee/core/dist
COPY --chown=node:node shared/package.json /octogee/shared/package.json
COPY --chown=node:node shared/dist /octogee/shared/dist

# ── Octogee provisioner + site API ──────────────────────────────────────────
COPY --chown=node:node scripts/.npmrc scripts/package.json scripts/package-lock.json* /octogee/scripts/
WORKDIR /octogee/scripts
# Full install (incl. devDependencies): `typescript` is a devDep but the
# build-time typecheck two steps down (`npx tsc -p tsconfig.json --noEmit`)
# needs it on disk — without it, npx silently fetches the unrelated
# `tsc@2.0.4` registry package and exits 1. The runtime image stays slim
# via `npm prune --omit=dev` after the typecheck.
RUN npm install --no-audit --no-fund

COPY --chown=node:node scripts/entrypoints/ /octogee/scripts/entrypoints/
COPY --chown=node:node scripts/secret-resolver.mjs /octogee/scripts/
COPY --chown=node:node scripts/publish-gateway-token.mjs /octogee/scripts/
COPY --chown=node:node scripts/tsconfig.json /octogee/scripts/
COPY --chown=node:node scripts/lib/ /octogee/scripts/lib/

# ── Canonical identity module (imported via ../../shared/types/identity.js) ──
# scripts/tsconfig.json rootDir is ".." so it expects shared/ at a sibling
# path. Copy the whole shared/ dir — in particular shared/package.json —
# because Node walks up from each .ts file looking for the nearest
# package.json to determine module type. Without shared/package.json's
# `"type": "module"` field, tsx loads identity.ts as CommonJS and only
# the `default` export survives — named imports (projectGeneralChannelName,
# etc.) throw "does not provide an export" at runtime.
# See docs/DATA-MODEL-REVIEW.md §11.6 (Build-context fixes).
#
# computeThrottleLevel + fleet-controller types + social types ALL live
# under shared/types/ now — gateway-side scripts and the firebase
# functions runtime both consume from here (functions/ via the
# functions/src/_shared symlink that sidesteps its rootDir constraint).
COPY --chown=node:node shared/ /octogee/shared/

# Install shared/ deps (FULL — including devDeps like @types/ws) so the
# typecheck below can resolve imports that walk into shared/.
# `scripts/lib/builder-shell-server.ts` imports `shared/ws/upgrade-router`
# which imports the `ws` npm package; tsc needs both the runtime package
# (in shared's prod deps) AND the type declarations (in shared's
# devDependencies — @types/ws). Without this, tsc two steps down fails
# with TS2307 "Cannot find module 'ws'".
# The devDeps are pruned together with scripts/'s devDeps at the
# combined prune step below.
RUN cd /octogee/shared && npm ci --no-audit --no-fund

# ── Type-check provisioner (catches errors at build time) ───────────────────
# Then prune the dev tree — nothing in scripts/ devDependencies is needed
# at runtime (the prod entrypoint is `tsx`, a regular dep; @types/* +
# vitest + firebase-tools are test/build-only). Pruning here keeps the
# runtime image slim without breaking the typecheck above. Same prune
# for shared/ — runtime needs `ws` (prod dep), not @types/ws / vitest.
RUN npx tsc -p tsconfig.json --noEmit 2>&1; \
    EXIT=$?; \
    if [ $EXIT -ne 0 ]; then echo "❌ Type-check failed — fix errors before deploying"; exit $EXIT; fi && \
    npm prune --omit=dev --no-audit --no-fund && \
    cd /octogee/shared && npm prune --omit=dev --no-audit --no-fund


# ── Workspace templates ─────────────────────────────────────────────────────
COPY --chown=node:node templates/ /octogee/templates/

# ── Plugin extensions ────────────────────────────────────────────────────────
# Staged at /octogee/extensions/ — entrypoint copies to ~/.openclaw/extensions/
# octogee-chat-tools, octogee-preview-tools, octogee-workspace-tools,
# octogee-publish-tools, and octogee-connector-tools are small, so we npm
# install them inline below; the entrypoint's
# `elif [ -d "$ext_dir/node_modules" ]` fallback then symlinks to them.
COPY --chown=node:node infra/gateway/extensions/ /octogee/extensions/

# octogee-chat-tools runtime deps
WORKDIR /octogee/extensions/octogee-chat-tools
RUN npm install --omit=dev --no-audit --no-fund 2>&1 | tail -50 \
    && chown -R node:node /octogee/extensions/octogee-chat-tools/node_modules

# octogee-preview-tools runtime deps
WORKDIR /octogee/extensions/octogee-preview-tools
RUN npm install --omit=dev --no-audit --no-fund 2>&1 | tail -50 \
    && chown -R node:node /octogee/extensions/octogee-preview-tools/node_modules

# octogee-workspace-tools runtime deps
WORKDIR /octogee/extensions/octogee-workspace-tools
RUN npm install --omit=dev --no-audit --no-fund 2>&1 | tail -50 \
    && chown -R node:node /octogee/extensions/octogee-workspace-tools/node_modules

# octogee-publish-tools runtime deps
WORKDIR /octogee/extensions/octogee-publish-tools
RUN npm install --omit=dev --no-audit --no-fund 2>&1 | tail -50 \
    && chown -R node:node /octogee/extensions/octogee-publish-tools/node_modules

# octogee-connector-tools runtime deps
WORKDIR /octogee/extensions/octogee-connector-tools
RUN npm install --omit=dev --no-audit --no-fund 2>&1 | tail -50 \
    && chown -R node:node /octogee/extensions/octogee-connector-tools/node_modules

# octogee-status-tools runtime deps
WORKDIR /octogee/extensions/octogee-status-tools
RUN npm install --omit=dev --no-audit --no-fund 2>&1 | tail -50 \
    && chown -R node:node /octogee/extensions/octogee-status-tools/node_modules

# octogee-project-tools runtime deps
WORKDIR /octogee/extensions/octogee-project-tools
RUN npm install --omit=dev --no-audit --no-fund 2>&1 | tail -50 \
    && chown -R node:node /octogee/extensions/octogee-project-tools/node_modules

# octogee-web-tools runtime deps
WORKDIR /octogee/extensions/octogee-web-tools
RUN npm install --omit=dev --no-audit --no-fund 2>&1 | tail -50 \
    && chown -R node:node /octogee/extensions/octogee-web-tools/node_modules

# ── Runtime utilities ───────────────────────────────────────────────────────
# `chmod 1777 /tmp` is defensive: newer Debian bookworm apt sandboxes
# signature verification through user `_apt` and needs a world-writable
# /tmp. The OpenClaw npm install in Dockerfile.base sometimes leaves /tmp
# with restricted perms (observed at OC 2026.5.12: "Couldn't create
# temporary file /tmp/apt.conf.XXXX for passing config to apt-key").
RUN chmod 1777 /tmp \
    && apt-get update && apt-get install -y --no-install-recommends gettext-base \
    && rm -rf /var/lib/apt/lists/*

# ── Entrypoint + config template ───────────────────────────────────────────
COPY --chown=node:node infra/gateway/openclaw.template.json /octogee/infra/gateway/openclaw.template.json
COPY --chown=node:node infra/gateway/apply-gateway-class-policy.mjs /octogee/infra/gateway/apply-gateway-class-policy.mjs
COPY infra/gateway/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

COPY infra/gateway/.bashrc /home/node/.bashrc
RUN chown node:node /home/node/.bashrc

# Restore working directory + non-root user
WORKDIR /home/node
USER node

ENV OCTOGEE_TEMPLATES_DIR=/octogee/templates

# Suppress Node.js deprecation warnings (punycode etc.) from third-party deps
ENV NODE_OPTIONS=--no-deprecation

# Build SHA — injected by Cloud Build via --build-arg
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

# OpenClaw version + fork SHA — injected by Cloud Build via --build-arg.
# Surfaced in the boot log line so operators can confirm what's running
# without exec'ing into the pod to read package.json.
ARG OPENCLAW_VERSION=unknown
ENV OPENCLAW_VERSION=${OPENCLAW_VERSION}
ARG OPENCLAW_FORK_SHA=unknown
ENV OPENCLAW_FORK_SHA=${OPENCLAW_FORK_SHA}

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
