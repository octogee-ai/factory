ARG OPENCLAW_BASE_IMAGE=openclaw:local
FROM ${OPENCLAW_BASE_IMAGE}

# ── Octogee gateway image ────────────────────────────────────────────────────
# Base image (octogee-gateway-base) already contains:
#   - OpenClaw npm install
#   - All apt packages (curl, jq, python3, chromium, git, sqlite3, etc.)
#   - @huggingface/transformers (1.2GB) at /opt/octogee-router-deps/node_modules
#   - npm cache with correct ownership
#
# This image only adds NuCrew-specific code that changes per commit.
# Keep heavy/stable deps in Dockerfile.base to maximise layer cache hits.
# ─────────────────────────────────────────────────────────────────────────────

USER root

# ── SSH client (for Gitea git operations via SSH) ──────────────────────────
# TODO: move to Dockerfile.base on next base image rebuild
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*

# ── Octogee provisioner + site API ──────────────────────────────────────────
COPY --chown=node:node scripts/package.json scripts/package-lock.json* /octogee/scripts/
WORKDIR /octogee/scripts
RUN npm install

COPY --chown=node:node scripts/local-provisioner.ts /octogee/scripts/
COPY --chown=node:node scripts/site-build-api.ts /octogee/scripts/
COPY --chown=node:node scripts/preview-proxy.ts /octogee/scripts/
COPY --chown=node:node scripts/get-customer-uid.ts /octogee/scripts/
COPY --chown=node:node scripts/pre-boot-config.ts /octogee/scripts/
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
COPY --chown=node:node shared/ /octogee/shared/

# ── Type-check provisioner (catches errors at build time) ───────────────────
RUN npx tsc -p tsconfig.json --noEmit 2>&1; \
    EXIT=$?; \
    if [ $EXIT -ne 0 ]; then echo "❌ Type-check failed — fix errors before deploying"; exit $EXIT; fi


# ── Workspace templates ─────────────────────────────────────────────────────
COPY --chown=node:node templates/ /octogee/templates/

# ── Plugin extensions (Face/Brain router, etc.) ─────────────────────────────
# Staged at /octogee/extensions/ — entrypoint copies to ~/.openclaw/extensions/
# octogee-router's node_modules are symlinked at runtime to
# /opt/octogee-router-deps/ (base image pre-installed @huggingface/transformers
# there to save build time; ~1.2 GB).
# octogee-mattermost-tools is small (~50 MB firebase-admin + tiny typebox +
# prom-client) so we npm install it inline below; the entrypoint's
# `elif [ -d "$ext_dir/node_modules" ]` fallback then symlinks to it.
COPY --chown=node:node infra/gateway/extensions/ /octogee/extensions/

# octogee-mattermost-tools runtime deps
WORKDIR /octogee/extensions/octogee-mattermost-tools
RUN npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3 \
    && chown -R node:node /octogee/extensions/octogee-mattermost-tools/node_modules

# ── Config template (for ephemeral bootstrap) ──────────────────────────────
# openclaw.template.json + envsubst replaces the old known-good config

# ── envsubst for config templating ──────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends gettext-base && rm -rf /var/lib/apt/lists/*

# ── Entrypoint + config template ───────────────────────────────────────────
COPY --chown=node:node infra/gateway/openclaw.template.json /octogee/infra/gateway/openclaw.template.json
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

EXPOSE 9091

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
