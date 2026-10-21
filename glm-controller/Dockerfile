FROM node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1
COPY infra/cloud-sql/octogee-pg-server-ca.pem /etc/ssl/certs/octogee-postgres-ca.pem
ARG NPM_VERSION=12.1.0
RUN npm install --global npm@${NPM_VERSION} --ignore-scripts --no-audit --no-fund \
    && npm_root="$(npm root --global)" \
    && npm install --global brace-expansion@5.0.12 --ignore-scripts --no-audit --no-fund \
    && rm -rf "$npm_root/npm/node_modules/brace-expansion" \
    && mv "$npm_root/brace-expansion" "$npm_root/npm/node_modules/brace-expansion"

# Helm is PINNED to one version across every path that runs `helm upgrade`
# against the cluster — CI's toolchain (ci/install-tools.sh) and the Builder
# toolchain (infra/gateway/builder-toolchain/groups.json) — so the
# umbrella upgrade and Cowboy's per-gateway upgrades share identical
# server-side-apply semantics. helm-runner.ts relies on v4's `--server-side=true
# --force-conflicts` string-flag syntax + `--take-ownership` (adopts leftover
# unowned resources rather than wedging a roll); the build verifies all three
# flags below before publishing. Bump all three sites together. kubectl is
# also pinned — resolving it from dl.k8s.io/release/stable.txt at build time
# made this image's bytes depend on an untracked, time-varying network read,
# which the per-image build-fingerprint (.github/actions/build-image-fingerprint/)
# can't see: two builds from an identical git tree could silently get
# different kubectl versions, defeating fingerprint-based reuse.
ARG HELM_VERSION=v4.3.0
ARG KUBECTL_VERSION=v1.36.5

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && echo "Installing helm ${HELM_VERSION}" \
  && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-$(dpkg --print-architecture).tar.gz" \
       | tar -xz -C /tmp \
  && mv "/tmp/linux-$(dpkg --print-architecture)/helm" /usr/local/bin/helm \
  && rm -rf "/tmp/linux-$(dpkg --print-architecture)" \
  && echo "Installing kubectl ${KUBECTL_VERSION}" \
  && curl -fsSL -o /usr/local/bin/kubectl \
       "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/$(dpkg --print-architecture)/kubectl" \
  && chmod +x /usr/local/bin/kubectl \
  && helm version --short \
  && helm upgrade --help | grep -q -- '--server-side' \
  && helm upgrade --help | grep -q -- '--force-conflicts' \
  && helm upgrade --help | grep -q -- '--take-ownership' \
  && kubectl version --client=true

# Build context must be the repo root: `docker build -f
# glm-controller/Dockerfile .` from the repo root. tsconfig rootDir: ".."
# emits dist/glm-controller/src/ (matches the ENTRYPOINT below).
WORKDIR /app/glm-controller

# Packed internal directory dependencies must exist at the declared sibling paths
# before npm ci. Single-stage, so they remain available for runtime resolution.
COPY core/package.json /app/core/package.json
COPY core/dist /app/core/dist
COPY shared/package.json /app/shared/package.json
COPY shared/dist /app/shared/dist

# Two-stage install: dev deps for the build (typescript), then prune to
# runtime-only after `tsc` finishes. Avoids `npx tsc` falling back to a
# downloaded unpinned compiler.
COPY glm-controller/.npmrc glm-controller/package.json glm-controller/package-lock.json* ./
# --ignore-scripts for parity with every other service image: nothing here is
# native, so no dependency install script is load-bearing. npm 12 already
# blocks them (no allowScripts policy) and says so only in a warning — stating
# the intent keeps the image independent of which npm builds it (#2834).
RUN npm ci --ignore-scripts

COPY glm-controller/tsconfig.json ./
COPY glm-controller/src ./src

RUN npx tsc \
  && npm prune --omit=dev

# Bake both helm charts into the image:
#   - /charts/octogee         — umbrella (mattermost, gitea, glm-controller,
#                               ingresses, gateway-fleet spanning resources)
#   - /charts/octogee-gateway — standalone single-instance gateway pod chart
#                               (one helm release per gateway instance,
#                               installed by Cowboy at runtime)
# Chart pins move with the controller's image SHA — no runtime git
# clone, no drift between desired-state writes and the chart shape
# Cowboy renders against.
COPY helm/octogee         /charts/octogee
COPY helm/octogee-gateway /charts/octogee-gateway

USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/glm-controller/src/index.js"]
