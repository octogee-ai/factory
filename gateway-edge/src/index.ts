import express, { Request, Response, Router } from "express";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";
import { corsMiddleware } from "./middleware/cors";
import { requestLogger } from "./middleware/logging";
import { errorHandler } from "./middleware/errors";
import { logger } from "./middleware/logging";
import { helmetMiddleware, globalRateLimit } from "./middleware/security";
import { requireAuth } from "./middleware/auth";

import { mountApi } from "./routes/mount-api";
// Locality routers — handle requests that read/write per-gateway-pod
// state. Stay mounted on this sidecar because they cannot be served
// from a stable cluster service. Per POST-BENDER-CLEANUP-SPEC §2.5,
// gateway-edge no longer mounts the 16 cluster prefixes
// (sharing, entities, mattermost, openclaw, billing, admin, invites,
// integrations, byosub, discord, notifications, profile, onboarding,
// posts, agents, builder) — those moved to octogee-api.
import gitRoutes from "./routes/workspace/git";
import deployPreviewRoutes from "./routes/projects/deploy-preview";
import internalBillingRoutes from "./routes/internal/billing";

const PORT = parseInt(process.env.PORT || "3001", 10);

export function createApp() {
const app = express();

const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

const httpRequestTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metricsRegistry],
});

app.use(helmetMiddleware);
app.use(corsMiddleware);

app.use(globalRateLimit);

app.use((req, res, next) => {
  if (req.path === '/metrics') return next();
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    // Fall back to a constant label for unmatched requests — req.path
    // would let attacker-controlled URLs explode the Prometheus series
    // cardinality. Same pattern octogee-api uses.
    const route = req.route?.path || 'unmatched';
    const labels = { method: req.method, route, status: String(res.statusCode) };
    end(labels);
    httpRequestTotal.inc(labels);
  });
  next();
});

app.use(requestLogger);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});

const healthHandler = (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "gateway-edge", timestamp: new Date().toISOString() });
};
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// Locality routers, mounted at both /api/<p> and /api/g/:gatewayId/<p>
// via mountApi (FLEET-API-ROUTING-SPEC.md). Cowboy's per-gateway
// ingress paths target the per-instance gateway-edge Service, so a
// scoped request lands on the user's home gateway pod where local
// per-customer state lives.

// workspace/git — read/write the local /home/node/.openclaw/customers
// working tree on this pod.
const workspaceLocality = Router();
workspaceLocality.use(requireAuth);
workspaceLocality.use(gitRoutes);
mountApi(app, "/workspace", workspaceLocality);

// projects/.../deploy-preview — calls localhost site-build-api sidecar
// on this pod. The other projects sub-routers (create, retry, star,
// members, join-leave, readme, delete) are cluster — octogee-api owns
// them.
const projectsLocality = Router();
projectsLocality.use(requireAuth);
projectsLocality.use(deployPreviewRoutes);
mountApi(app, "/projects", projectsLocality);

// Internal billing — usage RPC against localhost OpenClaw. Not Ingress-
// routed (intra-cluster service-to-service only). The other /internal/*
// endpoints (notifications, engagement, csi, builder-shell, agents) are
// cluster — octogee-api owns them.
app.use("/internal/billing", internalBillingRoutes);

app.use(errorHandler);

return app;
}

const app = createApp();

if (process.env.NODE_ENV !== "test") {
  const env = process.env.K8S_NAMESPACE || process.env.NODE_ENV || "development";
  const isProd = env !== "development" && env !== "local" && env !== "test";
  if (isProd && !process.env.INTERNAL_SERVICE_KEY) {
    logger.error(
      "FATAL: INTERNAL_SERVICE_KEY is required in non-development environments. " +
      "Set it via K8s Secret and restart."
    );
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info(`gateway-edge boot — listening on port ${PORT}`, {
      port: PORT,
      env: process.env.K8S_NAMESPACE || "local",
      sha: process.env.BUILD_SHA || "unknown",
      oc: process.env.OPENCLAW_VERSION || "n/a",
      fork: process.env.OPENCLAW_FORK_SHA || "n/a",
      node: process.version,
    });
  });
}

export default app;
