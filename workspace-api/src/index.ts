/**
 * Octogee workspace-api — consolidated HTTP service.
 *
 * Replaces ~20 Cloud Functions with a single Express app running in GKE.
 * Uses K8s DNS for Gitea and Mattermost — no VPC connectors, no ILB IPs.
 */
import express, { Request, Response } from "express";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";
import { corsMiddleware } from "./middleware/cors";
import { requestLogger } from "./middleware/logging";
import { errorHandler } from "./middleware/errors";
import { logger } from "./middleware/logging";
import { helmetMiddleware, globalRateLimit } from "./middleware/security";

// Public routes — exposed via GKE Ingress (api.octogee.com)
import workspaceRoutes from "./routes/workspace";
import mattermostRoutes from "./routes/mattermost";
import billingRoutes from "./routes/billing";
import adminRoutes from "./routes/admin";
import inviteRoutes from "./routes/invites";
import integrationRoutes from "./routes/integrations";
import discordRoutes from "./routes/discord";
import notificationRoutes from "./routes/notifications";
import sharingRoutes from "./routes/sharing";
import projectRoutes from "./routes/projects";
import entitiesRoutes from "./routes/entities";
import profileRoutes from "./routes/profile";

// Internal routes — reachable only via K8s DNS (ClusterIP), NOT via Ingress
import agentRoutes from "./routes/agents";
import internalBillingRoutes from "./routes/internal/billing";
import internalNotificationRoutes from "./routes/internal/notifications";
import internalEngagementRoutes from "./routes/internal/engagement";
import internalCSIRoutes from "./routes/internal/csi";

const PORT = parseInt(process.env.PORT || "3001", 10);

export function createApp() {
const app = express();

// ── Prometheus metrics ─────────────────────────────────────────────────────

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

// ── Global middleware ──────────────────────────────────────────────────────

// Security headers (Helmet) — must run before CORS so headers compose cleanly
app.use(helmetMiddleware);
app.use(corsMiddleware);

// Global rate limit — 300 req/min/IP, skips health + metrics
app.use(globalRateLimit);

// Metrics middleware — track request duration and counts (skip /metrics itself)
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

// Parse JSON for most routes. Stripe webhook needs raw body.
app.use((req, res, next) => {
  if (req.path === "/api/billing/webhook") {
    // Stripe needs raw body for signature verification
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

// ── Metrics endpoint ───────────────────────────────────────────────────────

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});

// ── Health check ───────────────────────────────────────────────────────────

const healthHandler = (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "workspace-api", timestamp: new Date().toISOString() });
};
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// ── Public routes (exposed via Ingress: api.octogee.com) ───────────────────

app.use("/api/workspace", workspaceRoutes);
app.use("/api/sharing", sharingRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/entities", entitiesRoutes);
app.use("/api/mattermost", mattermostRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/invites", inviteRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/discord", discordRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/profile", profileRoutes);
// Agent routes are mounted publicly (PATCH /me for Settings UI) AND internally
// (activate / deprovision); each route selects its own auth middleware.
app.use("/api/agents", agentRoutes);

// ── Internal routes (K8s DNS only — NOT routed by Ingress) ─────────────────
// Ingress only matches /api/* paths. /internal/* never reaches the LB.

app.use("/internal/agents", agentRoutes);
app.use("/internal/billing", internalBillingRoutes);
app.use("/internal/notifications", notificationRoutes);
app.use("/internal/notifications", internalNotificationRoutes);
app.use("/internal/engagement", internalEngagementRoutes);
app.use("/internal/csi", internalCSIRoutes);

// ── Global error handler ───────────────────────────────────────────────────

app.use(errorHandler);

// ── Start ──────────────────────────────────────────────────────────────────

return app;
}

const app = createApp();

if (process.env.NODE_ENV !== "test") {
  // Safety check: INTERNAL_SERVICE_KEY must be set in all non-dev deployed environments.
  // Dev (NODE_ENV=development or unset) is allowed to run without it — the middleware warns per-request.
  // Staging/prod deployments MUST inject this via K8s Secret.
  const env = process.env.K8S_NAMESPACE || process.env.NODE_ENV || "development";
  const isProd = env !== "development" && env !== "local" && env !== "test";
  if (isProd && !process.env.INTERNAL_SERVICE_KEY) {
    logger.error(
      "FATAL: INTERNAL_SERVICE_KEY is not set in a non-development environment. " +
      "All /internal/* routes are unprotected. Set this secret via K8s Secret and restart."
    );
    // Do NOT exit — keep running so the pod doesn't crash-loop and lose logs,
    // but log loudly so on-call can catch it.
  }

  app.listen(PORT, () => {
    logger.info(`workspace-api listening on port ${PORT}`, {
      port: PORT,
      env: process.env.K8S_NAMESPACE || "local",
    });
  });
}

export default app;
