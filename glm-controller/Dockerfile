FROM node:26-slim

# helm + kubectl resolve latest stable at image build time. helm-runner.ts uses
# `--server-side=true --force-conflicts` (v4 string-flag syntax); any v4+
# release supports that, and the build verifies those flags before publishing
# the controller image. The CI deploy job pins Helm v4 separately to avoid
# azure/setup-helm's Helm 3 fallback when "latest" lookup fails.

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl rsync tini \
  && rm -rf /var/lib/apt/lists/* \
  && HELM_VERSION="$(curl -fsSL https://api.github.com/repos/helm/helm/releases/latest \
       | grep -oE '\"tag_name\": *\"v[^\"]+\"' \
       | grep -oE 'v[0-9.]+')" \
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
