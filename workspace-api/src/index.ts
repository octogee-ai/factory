import express, { Request, Response } from "express";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";
import { corsMiddleware } from "./middleware/cors";
import { requestLogger } from "./middleware/logging";
import { errorHandler } from "./middleware/errors";
import { logger } from "./middleware/logging";
import { helmetMiddleware, globalRateLimit } from "./middleware/security";

import { mountApi } from "./routes/mount-api";
import workspaceRoutes from "./routes/workspace";
import mattermostRoutes from "./routes/mattermost";
import openclawRoutes from "./routes/openclaw";
import billingRoutes from "./routes/billing";
import adminRoutes from "./routes/admin";
import inviteRoutes from "./routes/invites";
import integrationRoutes from "./routes/integrations";
import byosubRoutes from "./routes/byosub";
import discordRoutes from "./routes/discord";
import notificationRoutes from "./routes/notifications";
import sharingRoutes from "./routes/sharing";
import projectRoutes from "./routes/projects";
import entitiesRoutes from "./routes/entities";
import profileRoutes from "./routes/profile";
import onboardingRoutes from "./routes/onboarding";
import postsRoutes from "./routes/posts";

import agentRoutes from "./routes/agents";
import internalBillingRoutes from "./routes/internal/billing";
import internalNotificationRoutes from "./routes/internal/notifications";
import internalEngagementRoutes from "./routes/internal/engagement";
import internalCSIRoutes from "./routes/internal/csi";

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
    const route = req.route?.path || req.path;
    const labels = { method: req.method, route, status: String(res.statusCode) };
    end(labels);
    httpRequestTotal.inc(labels);
  });
  next();
});

app.use(requestLogger);

app.use((req, res, next) => {
  if (req.path === "/api/billing/webhook") {
    express.raw({ type: "application/json" })(req, res, (err) => {
      if (err) return next(err);
      (req as Request & { rawBody?: Buffer }).rawBody = req.body;
      next();
    });
  } else {
    express.json({ limit: "10mb" })(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true }));

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});

const healthHandler = (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "workspace-api", timestamp: new Date().toISOString() });
};
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// All `/api/<p>` routes are dual-mounted at `/api/g/:gatewayId/<p>` too,
// the fleet path-affinity seam (FLEET-API-ROUTING-SPEC.md). Cowboy's
// per-gateway ingress paths target the per-instance workspace-api
// Service, so a scoped request lands on the user's home gateway pod
// where local per-customer state lives. Handlers are unchanged: the
// path's :gatewayId is a routing key, not an authz input — authz stays
// Firebase token + slug/project ownership.
mountApi(app, "/workspace", workspaceRoutes);
mountApi(app, "/sharing", sharingRoutes);
mountApi(app, "/projects", projectRoutes);
mountApi(app, "/entities", entitiesRoutes);
mountApi(app, "/mattermost", mattermostRoutes);
mountApi(app, "/openclaw", openclawRoutes);
mountApi(app, "/billing", billingRoutes);
mountApi(app, "/admin", adminRoutes);
mountApi(app, "/invites", inviteRoutes);
mountApi(app, "/integrations", integrationRoutes);
mountApi(app, "/byosub", byosubRoutes);
mountApi(app, "/discord", discordRoutes);
mountApi(app, "/notifications", notificationRoutes);
mountApi(app, "/profile", profileRoutes);
mountApi(app, "/onboarding", onboardingRoutes);
mountApi(app, "/posts", postsRoutes);
mountApi(app, "/agents", agentRoutes);

app.use("/internal/agents", agentRoutes);
app.use("/internal/billing", internalBillingRoutes);
app.use("/internal/notifications", notificationRoutes);
app.use("/internal/notifications", internalNotificationRoutes);
app.use("/internal/engagement", internalEngagementRoutes);
app.use("/internal/csi", internalCSIRoutes);

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
    logger.info(`workspace-api boot — listening on port ${PORT}`, {
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
