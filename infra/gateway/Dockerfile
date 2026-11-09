ARG OPENCLAW_BASE_IMAGE=octogee-gateway-base
ARG RUNTIME_BASE_IMAGE=${OPENCLAW_BASE_IMAGE}
FROM ${OPENCLAW_BASE_IMAGE} AS gateway-build

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
#
# Install scripts stay enabled and strict so an unreviewed dependency install
# cannot be silently skipped in the gateway image.
RUN npm install --no-audit --no-fund

COPY --chown=node:node scripts/entrypoints/ /octogee/scripts/entrypoints/
COPY --chown=node:node scripts/libexec/ /octogee/scripts/libexec/
COPY --chown=node:node scripts/secret-resolver.mjs /octogee/scripts/
COPY --chown=node:node scripts/publish-gateway-token.mjs /octogee/scripts/
COPY --chown=node:node scripts/tsconfig.json /octogee/scripts/
COPY --chown=node:node scripts/lib/ /octogee/scripts/lib/
COPY --chown=node:node .github/actions/release-digest-manifest/desktop-image.mjs .github/actions/release-digest-manifest/desktop-image.d.mts /octogee/.github/actions/release-digest-manifest/
COPY --chown=node:node scripts/ops/verify-native-modules.mjs /octogee/scripts/ops/
COPY --chown=node:node scripts/ops/migrate-builder-stores.ts /octogee/scripts/ops/
RUN /octogee/scripts/node_modules/.bin/esbuild /octogee/scripts/secret-resolver.mjs \
      --bundle --platform=node --format=esm \
      --outfile=/tmp/octogee-secret-resolver.mjs \
    && cp /tmp/octogee-secret-resolver.mjs /octogee/scripts/secret-resolver.mjs \
    && rm /tmp/octogee-secret-resolver.mjs \
    && chown root:root /octogee/scripts \
    && chmod 755 /octogee/scripts \
    && chmod 500 /octogee/scripts/secret-resolver.mjs

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
# The devDeps are pruned together with scripts/'s devDeps at the
# combined prune step below.
RUN cd /octogee/shared && npm ci --no-audit --no-fund

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

# ── Native-module gate ──────────────────────────────────────────────────────
# Validate every native module declared by scripts/package.json after pruning,
# before an image can be pushed.
RUN node ops/verify-native-modules.mjs

# ── Workspace templates ─────────────────────────────────────────────────────
# ── Plugin extensions ────────────────────────────────────────────────────────
# Staged at /octogee/extensions/ and projected into ~/.openclaw/extensions/.
# Each extension ships as one self-contained index.js: runtime dependencies are
# bundled in, only node builtins and openclaw/plugin-sdk/* stay external, and no
# node_modules tree is left for OpenClaw's plugin-generation capture to copy.
COPY --chown=node:node infra/gateway/extensions/ /octogee/extensions/
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

# Keep full devDependency installs, compiler inputs, npm caches, and deleted
# extension TypeScript sources out of the deliverable image. COPY transfers the
# verified post-prune filesystem state without the builder stage's lower layers.
FROM ${RUNTIME_BASE_IMAGE} AS gateway-runtime
COPY infra/cloud-sql/octogee-pg-server-ca.pem /etc/ssl/certs/octogee-postgres-ca.pem

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER root

COPY --from=gateway-build --chown=node:node /octogee/core /octogee/core
COPY --from=gateway-build --chown=node:node /octogee/scripts /octogee/scripts
COPY --from=gateway-build --chown=node:node /octogee/.github/actions/release-digest-manifest /octogee/.github/actions/release-digest-manifest
COPY --from=gateway-build --chown=node:node /octogee/shared /octogee/shared
COPY --from=gateway-build --chown=node:node /octogee/extensions /octogee/extensions
COPY --from=gateway-build --chown=root:root /octogee/bundled-extensions/octogee-identity-tools /usr/local/lib/node_modules/openclaw/dist/extensions/octogee-identity-tools
RUN chown root:root /octogee/scripts \
    && chmod 755 /octogee/scripts \
    && chmod 500 /octogee/scripts/secret-resolver.mjs

# Workspace templates are runtime data and bypass the build stage.
COPY --chown=node:node templates/ /octogee/templates/

# ── Runtime utilities ───────────────────────────────────────────────────────
# `chmod 1777 /tmp` is defensive: newer Debian bookworm apt sandboxes
# signature verification through user `_apt` and needs a world-writable
# /tmp. The OpenClaw npm install in Dockerfile.base sometimes leaves /tmp
# with restricted perms (observed at OC 2026.5.12: "Couldn't create
# temporary file /tmp/apt.conf.XXXX for passing config to apt-key").
RUN chmod 1777 /tmp \
    && apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends btrfs-progs gettext-base libx11-6 libxi6 libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*

# ── Computer-use skills ────────────────────────────────────────────────────
COPY infra/gateway/hobby-skills /opt/octogee/skills/computer-x11
COPY infra/gateway/cua-skills /tmp/cua-skills
COPY infra/gateway/install-cua-skills.mjs /tmp/install-cua-skills.mjs
RUN node /tmp/install-cua-skills.mjs "$(npm root -g)/openclaw" /tmp/cua-skills /opt/octogee/skills/computer \
    && rm -rf /tmp/cua-skills /tmp/install-cua-skills.mjs

# ── Entrypoint + config templates ──────────────────────────────────────────
COPY --chown=node:node infra/gateway/openclaw.template.json /octogee/infra/gateway/openclaw.template.json
COPY --chown=node:node infra/gateway/openclaw.builder.template.json /octogee/infra/gateway/openclaw.builder.template.json
COPY --chown=node:node infra/gateway/workflow-tools.mjs /octogee/infra/gateway/workflow-tools.mjs
COPY --chown=node:node infra/gateway/apply-gateway-class-policy.mjs /octogee/infra/gateway/apply-gateway-class-policy.mjs
COPY --chown=node:node infra/gateway/quarantine-customer-cron-jobs.mjs /octogee/infra/gateway/quarantine-customer-cron-jobs.mjs
COPY --chmod=755 infra/gateway/shared-auxiliary-runner.sh /octogee/infra/gateway/shared-auxiliary-runner.sh
COPY infra/gateway/entrypoint.sh /usr/local/bin/entrypoint.sh
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
COPY infra/gateway/builder-toolchain-wrapper.sh /usr/local/libexec/octogee-builder-toolchain
COPY infra/gateway/verify-openclaw-runtime-deps.sh /usr/local/bin/verify-openclaw-runtime-deps
COPY infra/gateway/verify-runtime-image.sh /usr/local/bin/verify-runtime-image
COPY infra/gateway/verify-config-templates.mjs /usr/local/libexec/verify-config-templates.mjs
ARG OPENCLAW_RUNTIME_PLUGINS=mattermost,parallel-plugin,codex
ARG ENABLE_BUILDER_TOOLCHAIN_WRAPPER=false
RUN chmod 755 /usr/local/bin/octogee-hobby-desktop /usr/local/bin/octogee-hobby-session /usr/local/bin/octo-desktop-browser /usr/local/bin/octo-desktop-control /usr/local/bin/entrypoint.sh /usr/local/bin/octogee-desktop-node /usr/local/bin/octogee /usr/local/bin/octo-desk /usr/local/bin/octo-desktop-style /usr/local/bin/verify-openclaw-runtime-deps /usr/local/bin/verify-runtime-image /usr/local/libexec/octogee-builder-toolchain \
    && /usr/local/bin/verify-openclaw-runtime-deps "$OPENCLAW_RUNTIME_PLUGINS" \
    && case "$ENABLE_BUILDER_TOOLCHAIN_WRAPPER" in \
      false) \
        apt-get update && apt-get install -y --no-install-recommends tigervnc-standalone-server tigervnc-tools openbox tint2 sakura pcmanfm mousepad adwaita-icon-theme fonts-noto-core dbus-x11 at-spi2-core wmctrl x11-utils x11-xserver-utils xdotool imagemagick libglib2.0-bin libgtk-3-bin \
        && rm -rf /var/lib/apt/lists/* \
        && test -x /usr/local/bin/claude \
        && test -x /usr/local/bin/codex \
        && test -x /usr/bin/chromium \
        && test -x /usr/bin/gtk-launch \
        && test -x /usr/bin/tint2 \
        && test -x /usr/bin/sakura \
        && test -x /usr/bin/mousepad \
        && test -f /usr/share/themes/Octogee/openbox-3/themerc \
        && python3 -c 'import xml.etree.ElementTree as tree; tree.parse("/usr/share/octogee/hobby-desktop/rc.xml"); tree.parse("/usr/share/octogee/hobby-desktop/menu.xml")' \
        && sed -i 's|^Exec=/usr/bin/chromium %U$|Exec=/usr/local/bin/octo-desktop-browser --new-window %U|' /usr/share/applications/chromium.desktop \
        && grep -qxF 'Exec=/usr/local/bin/octo-desktop-browser --new-window %U' /usr/share/applications/chromium.desktop \
        ;; \
      true) \
        rm -f /usr/local/bin/claude /usr/local/bin/codex /usr/bin/chromium \
        && ln -s /usr/local/libexec/octogee-builder-toolchain /usr/local/bin/claude \
        && ln -s /usr/local/libexec/octogee-builder-toolchain /usr/local/bin/codex \
        && ln -s /usr/local/libexec/octogee-builder-toolchain /usr/bin/chromium \
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
