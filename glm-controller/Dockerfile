FROM node:24-bookworm-slim

ARG HELM_VERSION=v3.16.4
ARG KUBECTL_VERSION=v1.31.4

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-$(dpkg --print-architecture).tar.gz" \
       | tar -xz -C /tmp \
  && mv "/tmp/linux-$(dpkg --print-architecture)/helm" /usr/local/bin/helm \
  && rm -rf "/tmp/linux-$(dpkg --print-architecture)" \
  && curl -fsSL -o /usr/local/bin/kubectl \
       "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/$(dpkg --print-architecture)/kubectl" \
  && chmod +x /usr/local/bin/kubectl \
  && helm version --short \
  && kubectl version --client=true

# Mirror the repo layout under /app so the controller's tsconfig.json
# (rootDir: .., includes ../shared/types/**) resolves identically to local
# dev. Build context must be the repo root: `docker build -f
# glm-controller/Dockerfile .` from the repo root.
WORKDIR /app/glm-controller

# Two-stage install: dev deps for the build (typescript), then prune to
# runtime-only after `tsc` finishes. Avoids `npx tsc` falling back to a
# downloaded unpinned compiler.
COPY glm-controller/package.json glm-controller/package-lock.json* ./
RUN npm ci

COPY glm-controller/tsconfig.json ./
COPY glm-controller/src ./src
COPY shared /app/shared

RUN npx tsc \
  && npm prune --omit=dev

# Bake the umbrella chart into the image at the path the controller's
# values.yaml points at by default (helm.chartPath = /charts/octogee).
# The chart pin moves with the controller's image SHA — no runtime
# git clone, no chart drift.
COPY helm/octogee /charts/octogee

USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/glm-controller/src/index.js"]
