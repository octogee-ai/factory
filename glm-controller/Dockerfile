FROM node:26-slim
ARG NPM_VERSION=12.0.1
RUN npm install --global npm@${NPM_VERSION} --ignore-scripts --no-audit --no-fund

# Helm is PINNED to one version across every path that runs `helm upgrade`
# against the cluster — CI's azure/setup-helm (.github/workflows/build-and-deploy.yml)
# and the operator toolkit (infra/gateway/Dockerfile.operator-toolkit) — so the
# umbrella upgrade and Cowboy's per-gateway upgrades share identical
# server-side-apply semantics. helm-runner.ts relies on v4's `--server-side=true
# --force-conflicts` string-flag syntax + `--take-ownership` (adopts leftover
# unowned resources rather than wedging a roll); the build verifies all three
# flags below before publishing. Bump all three sites together. kubectl tracks
# stable (it is not SSA-version-sensitive).
ARG HELM_VERSION=v4.2.2

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && echo "Installing helm ${HELM_VERSION}" \
  && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-$(dpkg --print-architecture).tar.gz" \
       | tar -xz -C /tmp \
  && mv "/tmp/linux-$(dpkg --print-architecture)/helm" /usr/local/bin/helm \
  && rm -rf "/tmp/linux-$(dpkg --print-architecture)" \
  && KUBECTL_VERSION="$(curl -fsSL https://dl.k8s.io/release/stable.txt)" \
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
RUN npm ci

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
