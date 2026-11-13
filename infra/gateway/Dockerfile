ARG OPENCLAW_BASE_IMAGE=octogee-gateway-base
ARG RUNTIME_BASE_IMAGE=${OPENCLAW_BASE_IMAGE}
ARG GATEWAY_SYSTEM_IMAGE=${OPENCLAW_BASE_IMAGE}
FROM ${GATEWAY_SYSTEM_IMAGE} AS gateway-dependencies

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER root

COPY --chown=node:node core/package.json /octogee/core/package.json
COPY --chown=node:node shared/package.json shared/package-lock.json /octogee/shared/
COPY --from=product --chown=node:node shared/package.json /product/shared/package.json
COPY --chown=node:node scripts/.npmrc scripts/package.json scripts/package-lock.json /octogee/scripts/

WORKDIR /octogee/scripts
RUN npm install --no-audit --no-fund \
    && cd /octogee/shared && npm ci --no-audit --no-fund

FROM gateway-dependencies AS gateway-production-dependencies

RUN npm prune --omit=dev --no-audit --no-fund \
    && cd /octogee/shared && npm prune --omit=dev --no-audit --no-fund

FROM ${GATEWAY_SYSTEM_IMAGE} AS gateway-local-packages

USER root

COPY core/package.json /octogee/core/package.json
COPY core/dist /octogee/core/dist
COPY shared/package.json /octogee/shared/package.json
COPY shared/dist /octogee/shared/dist
COPY --from=product shared/package.json /product/shared/package.json
COPY --from=product shared/dist /product/shared/dist
COPY infra/gateway/pack-local-deps.sh /tmp/pack-local-deps.sh
RUN bash /tmp/pack-local-deps.sh /octogee/core /packages/@octogee/core \
    && bash /tmp/pack-local-deps.sh /octogee/shared /packages/@octogee/shared \
    && bash /tmp/pack-local-deps.sh /product/shared /packages/@octogee/product-shared

FROM ${OPENCLAW_BASE_IMAGE} AS gateway-build

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER root
WORKDIR /octogee/scripts

COPY --from=gateway-dependencies /octogee /octogee
COPY --from=gateway-local-packages --chown=node:node /packages /octogee/scripts/node_modules
COPY --from=gateway-local-packages --chown=node:node /octogee/core/dist /octogee/core/dist
COPY --chown=node:node shared/ /octogee/shared/

COPY --chown=node:node scripts/entrypoints/ /octogee/scripts/entrypoints/
COPY --chown=node:node scripts/libexec/ /octogee/scripts/libexec/
COPY --chown=node:node scripts/secret-resolver.mjs /octogee/scripts/
COPY --chown=node:node scripts/publish-gateway-token.mjs /octogee/scripts/
COPY --chown=node:node scripts/tsconfig.json /octogee/scripts/
COPY --chown=node:node scripts/lib/ /octogee/scripts/lib/
COPY --chown=node:node scripts/product/lib/octogee-entitlements.ts /octogee/scripts/product/lib/
COPY --chown=node:node scripts/ops/verify-native-modules.mjs /octogee/scripts/ops/
COPY --chown=node:node scripts/ops/migrate-user-stores.ts /octogee/scripts/ops/
RUN /octogee/scripts/node_modules/.bin/esbuild /octogee/scripts/secret-resolver.mjs \
      --bundle --platform=node --format=esm \
      --outfile=/tmp/octogee-secret-resolver.mjs \
    && cp /tmp/octogee-secret-resolver.mjs /octogee/scripts/secret-resolver.mjs \
    && rm /tmp/octogee-secret-resolver.mjs

RUN /octogee/scripts/node_modules/.bin/esbuild /octogee/scripts/entrypoints/source-transfer-stage.ts \
      --bundle --platform=node --format=esm --packages=external \
      --outfile=/octogee/scripts/source-transfer-stage.mjs
RUN /octogee/scripts/node_modules/.bin/esbuild \
      /octogee/scripts/entrypoints/supervise-runner.ts \
      /octogee/scripts/entrypoints/fleet-controller.ts \
      /octogee/scripts/entrypoints/byosub-syncback-runner.ts \
      /octogee/scripts/entrypoints/runner-metrics-exporter.ts \
      --bundle --platform=node --format=esm --packages=external \
      --outdir=/octogee/scripts/shared-runners --out-extension:.js=.mjs

RUN /octogee/scripts/node_modules/.bin/tsc -p tsconfig.json --noEmit \
    || { echo "Type-check failed — fix errors before deploying" >&2; exit 1; }

# ── Workspace templates ─────────────────────────────────────────────────────
# ── Plugin extensions ────────────────────────────────────────────────────────
# Staged at /octogee/extensions/ and projected into ~/.openclaw/extensions/.
# Each extension ships as one self-contained index.js: runtime dependencies are
# bundled in, only node builtins and openclaw/plugin-sdk/* stay external, and no
# node_modules tree is left for OpenClaw's plugin-generation capture to copy.
COPY --chown=node:node infra/gateway/extensions/platform/ /octogee/extensions/
COPY --chown=node:node infra/gateway/extensions/product/ /octogee/extensions/
COPY --chown=node:node infra/gateway/build-extensions.mjs \
      infra/gateway/extension-manifest.mjs \
      infra/gateway/verify-extension-bundles.mjs \
      /octogee/infra/gateway/
RUN node /octogee/infra/gateway/build-extensions.mjs \
      /octogee/extensions \
      /octogee/scripts/node_modules/.bin/esbuild

COPY infra/gateway/bundled-extensions/octogee-identity-tools/ /octogee/bundled-extensions/octogee-identity-tools/
RUN /octogee/scripts/node_modules/.bin/esbuild /octogee/bundled-extensions/octogee-identity-tools/index.ts \
      --bundle --platform=node --format=esm --target=node24 --packages=external \
      --alias:@octogee/core=/octogee/core/dist --alias:@octogee/shared=/octogee/shared/dist \
      --outfile=/octogee/bundled-extensions/octogee-identity-tools/index.js \
    && rm /octogee/bundled-extensions/octogee-identity-tools/index.ts

# ── Extension bundle gate ───────────────────────────────────────────────────
# A plugin whose imports do not resolve is skipped at boot — the gateway comes
# up Ready with fewer plugins than configured and only `openclaw` CLI output
# names the missing module. Load each bundle here, where a failure can still
# stop the image from being pushed, and refuse any leftover node_modules.
RUN node /octogee/infra/gateway/verify-extension-bundles.mjs /octogee/extensions /usr/local/lib/node_modules/openclaw

FROM gateway-build AS gateway-payload

RUN rm -rf /octogee/scripts/node_modules /octogee/shared/node_modules

FROM ${RUNTIME_BASE_IMAGE} AS gateway-runtime

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER root

COPY --link --from=gateway-production-dependencies --chown=1000:1000 /octogee/scripts/node_modules /octogee/scripts/node_modules
COPY --link --from=gateway-production-dependencies --chown=1000:1000 /octogee/shared/node_modules /octogee/shared/node_modules
COPY --from=gateway-local-packages --chown=node:node /packages /octogee/scripts/node_modules
COPY --from=gateway-payload --chown=node:node /octogee/core /octogee/core
COPY --from=gateway-payload --chown=node:node /octogee/scripts /octogee/scripts
COPY --from=gateway-payload --chown=node:node /octogee/shared /octogee/shared
COPY --from=gateway-payload --chown=node:node /octogee/extensions /octogee/extensions
COPY --from=gateway-payload --chown=root:root /octogee/bundled-extensions/octogee-identity-tools /usr/local/lib/node_modules/openclaw/dist/extensions/octogee-identity-tools
COPY infra/cloud-sql/octogee-pg-server-ca.pem /etc/ssl/certs/octogee-postgres-ca.pem
RUN chown root:root /octogee/scripts \
    && chmod 755 /octogee/scripts \
    && chmod 500 /octogee/scripts/secret-resolver.mjs
RUN node /octogee/scripts/ops/verify-native-modules.mjs

# Workspace templates are runtime data and bypass the build stage.
COPY --chown=node:node templates/claws/ /octogee/templates/claws/
COPY --chown=node:node templates/github-workflow/ /octogee/templates/github-workflow/
COPY --chown=node:node templates/shared/ /octogee/templates/shared/
COPY --chown=node:node templates/tiers/ /octogee/templates/tiers/
COPY --chown=node:node templates/product/tiers/ /octogee/templates/tiers/

# ── Computer-use skills ────────────────────────────────────────────────────
COPY infra/gateway/hobby-skills /opt/octogee/skills/computer-x11
COPY infra/gateway/cua-skills /tmp/cua-skills
COPY infra/gateway/install-cua-skills.mjs /tmp/install-cua-skills.mjs
RUN node /tmp/install-cua-skills.mjs "$(npm root -g)/openclaw" /tmp/cua-skills /opt/octogee/skills/computer \
    && rm -rf /tmp/cua-skills /tmp/install-cua-skills.mjs

# ── Entrypoint + config templates ──────────────────────────────────────────
COPY --chown=node:node infra/gateway/openclaw.template.json /octogee/infra/gateway/openclaw.template.json
COPY --chown=node:node infra/gateway/openclaw.isolated.template.json /octogee/infra/gateway/openclaw.isolated.template.json
COPY --chown=node:node infra/gateway/workflow-tools.mjs /octogee/infra/gateway/workflow-tools.mjs
COPY --chown=node:node infra/gateway/apply-gateway-class-policy.mjs /octogee/infra/gateway/apply-gateway-class-policy.mjs
COPY --chown=node:node infra/gateway/quarantine-user-cron-jobs.mjs /octogee/infra/gateway/quarantine-user-cron-jobs.mjs
COPY --chmod=755 infra/gateway/shared-auxiliary-runner.sh /octogee/infra/gateway/shared-auxiliary-runner.sh
COPY infra/gateway/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY infra/gateway/gateway-class-dual-read.sh /usr/local/libexec/gateway-class-dual-read.sh
COPY infra/gateway/desktop-node.sh /usr/local/bin/octogee-desktop-node
COPY infra/gateway/hobby-desktop.sh /usr/local/bin/octogee-hobby-desktop
COPY infra/gateway/hobby-session.sh /usr/local/bin/octogee-hobby-session
COPY infra/desktop/rootfs/usr/local/bin/octo-desktop-browser /usr/local/bin/octo-desktop-browser
COPY infra/desktop/rootfs/usr/local/bin/octo-desktop-control /usr/local/bin/octo-desktop-control
COPY infra/desktop/rootfs/usr/share/omarchy/octo-desktop/desk /usr/share/omarchy/octo-desktop/desk
COPY infra/desktop/image/rootfs/etc/chromium/policies/managed/octogee-desk.json /etc/chromium/policies/managed/octogee-desk.json
COPY infra/gateway/hobby-desktop/rc.xml infra/gateway/hobby-desktop/menu.xml infra/gateway/hobby-desktop/tint2rc /usr/share/octogee/hobby-desktop/
COPY infra/gateway/hobby-desktop/theme /usr/share/themes/Octogee
COPY infra/gateway/hobby-desktop/applications /usr/share/applications
COPY infra/gateway/hobby-desktop/icons/hicolor /usr/share/icons/hicolor
COPY infra/gateway/octogee /usr/local/bin/octogee
COPY infra/gateway/octo-desk /usr/local/bin/octo-desk
COPY --chmod=755 infra/gateway/octo-project /usr/local/bin/octo-project
COPY infra/gateway/octo-desktop-style /usr/local/bin/octo-desktop-style
COPY infra/gateway/isolated-toolchain-wrapper.sh /usr/local/libexec/octogee-isolated-toolchain
COPY infra/gateway/verify-openclaw-runtime-deps.sh /usr/local/bin/verify-openclaw-runtime-deps
COPY infra/gateway/verify-runtime-image.sh /usr/local/bin/verify-runtime-image
COPY infra/gateway/verify-config-templates.mjs /usr/local/libexec/verify-config-templates.mjs
ARG OPENCLAW_RUNTIME_PLUGINS=mattermost,parallel-plugin,codex
ARG ENABLE_BUILDER_TOOLCHAIN_WRAPPER=false
RUN chmod 755 /usr/local/bin/octogee-hobby-desktop /usr/local/bin/octogee-hobby-session /usr/local/bin/octo-desktop-browser /usr/local/bin/octo-desktop-control /usr/local/bin/entrypoint.sh /usr/local/bin/octogee-desktop-node /usr/local/bin/octogee /usr/local/bin/octo-desk /usr/local/bin/octo-desktop-style /usr/local/bin/verify-openclaw-runtime-deps /usr/local/bin/verify-runtime-image /usr/local/libexec/octogee-isolated-toolchain \
    && /usr/local/bin/verify-openclaw-runtime-deps "$OPENCLAW_RUNTIME_PLUGINS" \
    && case "$ENABLE_BUILDER_TOOLCHAIN_WRAPPER" in \
      false) \
        test -x /usr/local/bin/claude \
        && test -x /usr/local/bin/codex \
        && test -x /usr/bin/chromium \
        && test -x /usr/bin/gtk-launch \
        && test -x /usr/bin/tint2 \
        && test -x /usr/bin/sakura \
        && test -x /usr/bin/mousepad \
        && test -f /usr/share/themes/Octogee/openbox-3/themerc \
        && python3 -c 'import xml.etree.ElementTree as tree; tree.parse("/usr/share/octogee/hobby-desktop/rc.xml"); tree.parse("/usr/share/octogee/hobby-desktop/menu.xml")' \
        && grep -qxF 'Exec=/usr/local/bin/octo-desktop-browser --new-window %U' /usr/share/applications/chromium.desktop \
        ;; \
      true) \
        rm -f /usr/local/bin/claude /usr/local/bin/codex /usr/bin/chromium \
        && ln -s /usr/local/libexec/octogee-isolated-toolchain /usr/local/bin/claude \
        && ln -s /usr/local/libexec/octogee-isolated-toolchain /usr/local/bin/codex \
        && ln -s /usr/local/libexec/octogee-isolated-toolchain /usr/bin/chromium \
        ;; \
      *) \
        echo "ENABLE_BUILDER_TOOLCHAIN_WRAPPER must be true or false" >&2 \
        && exit 2 \
        ;; \
    esac

# ── Runtime image gate ──────────────────────────────────────────────────────
ARG IMAGE_PROFILE=gateway
RUN /usr/local/bin/verify-runtime-image "$IMAGE_PROFILE" \
    && cd /octogee/scripts \
    && node --input-type=module -e 'import { beginWorkspaceIdentityBoot } from "@octogee/core/openclaw-workspace-bootstrap"; beginWorkspaceIdentityBoot({ GATEWAY_CLASS: "shared" });'

COPY infra/gateway/.bashrc /etc/skel/.bashrc
COPY infra/gateway/.bashrc /home/node/.bashrc
RUN chown node:node /home/node/.bashrc \
    && install -d -o node -g node /home/node/.cache

# Restore working directory + non-root user
WORKDIR /home/node
USER node
RUN node /usr/local/libexec/verify-config-templates.mjs /octogee/infra/gateway /octogee/extensions /opt/openclaw-runtime-deps/npm

ENV OCTOGEE_TEMPLATES_DIR=/octogee/templates
ENV PATH=/work/cache/toolchains/active/bin:${PATH}

# Suppress Node.js deprecation warnings (punycode etc.) from third-party deps
ENV NODE_OPTIONS=--no-deprecation
ENV OPENCLAW_OFFLINE=1
ENV CLAUDE_BIN=/usr/local/bin/claude

# Build SHA — injected by Cloud Build via --build-arg
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
