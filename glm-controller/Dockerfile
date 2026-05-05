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
# glm-controller imports several scripts/lib files via tsconfig rootDir: ".."
# — fleet-migration-{client,runner,signature} (used by migrate-customer)
# AND admin-fleet-router + secret-manager + artifact-registry +
# workspace-slugs + firebase-auth-helpers (used by the http-server lift).
# admin-fleet-router and friends import express, firebase-admin/firestore,
# google-auth-library, @google-cloud/secret-manager. Node module resolution
# walks UP from each .ts file's directory, so /app/scripts/lib/foo.ts
# resolving "express" looks in /app/scripts/node_modules — NOT
# /app/glm-controller/node_modules. Install scripts/'s deps so tsc
# resolves cleanly. Builder stage only.
COPY scripts/lib /app/scripts/lib
COPY scripts/package.json scripts/package-lock.json* /app/scripts/
RUN npm ci --prefix /app/scripts --ignore-scripts

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
