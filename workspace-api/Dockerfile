# Build context: repo root (see workspace-api/cloudbuild.yaml).
# workspace-api and shared/ are both copied in so tsc can compile
# @shared/types/identity along with src/.
FROM node:22-slim AS builder
WORKDIR /app
COPY workspace-api/package.json workspace-api/package-lock.json* ./
RUN npm ci --ignore-scripts
COPY workspace-api/tsconfig.json ./
COPY workspace-api/src/ ./src/
COPY shared/ ../shared/
RUN npx tsc

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*
COPY workspace-api/package.json workspace-api/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/workspace-api/src/index.js"]
