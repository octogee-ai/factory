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

# ── Shared Astro deps (all customer sites symlink to this) ──────────────────
COPY --chown=node:node templates/general/package.json /opt/octogee-site-deps/package.json
RUN cd /opt/octogee-site-deps && npm install --production && chown -R node:node /opt/octogee-site-deps

# ── Octogee provisioner + site API ──────────────────────────────────────────
COPY --chown=node:node scripts/package.json scripts/package-lock.json* /octogee/scripts/
WORKDIR /octogee/scripts
RUN npm install

COPY --chown=node:node scripts/local-provisioner.ts /octogee/scripts/
COPY --chown=node:node scripts/site-api.ts /octogee/scripts/
COPY --chown=node:node scripts/update-onboarding.ts /octogee/scripts/
COPY --chown=node:node scripts/get-customer-uid.ts /octogee/scripts/
COPY --chown=node:node scripts/report-usage.ts /octogee/scripts/
COPY --chown=node:node scripts/pre-boot-config.ts /octogee/scripts/
COPY --chown=node:node scripts/trial-expiry-cron.ts /octogee/scripts/
COPY --chown=node:node scripts/tsconfig.json /octogee/scripts/
COPY --chown=node:node scripts/lib/ /octogee/scripts/lib/

# ── Type-check provisioner (catches errors at build time) ───────────────────
RUN npx tsc -p tsconfig.json --noEmit 2>&1; \
    EXIT=$?; \
    if [ $EXIT -ne 0 ]; then echo "❌ Type-check failed — fix errors before deploying"; exit $EXIT; fi


# ── Workspace templates ─────────────────────────────────────────────────────
COPY --chown=node:node templates/ /octogee/templates/

# ── Plugin extensions (Face/Brain router, etc.) ─────────────────────────────
# Staged at /octogee/extensions/ — entrypoint copies to ~/.openclaw/extensions/
# node_modules are NOT copied here — entrypoint symlinks to /opt/octogee-router-deps/
# (base image pre-installed @huggingface/transformers there to save build time)
COPY --chown=node:node infra/gateway/extensions/ /octogee/extensions/

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

# Build SHA — injected by Cloud Build via --build-arg
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
