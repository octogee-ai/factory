

import express, { Request, Response } from "express";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";

import { corsMiddleware } from "../../gateway-edge/src/middleware/cors.js";
import { requestLogger, logger } from "../../gateway-edge/src/middleware/logging.js";
import { errorHandler } from "../../gateway-edge/src/middleware/errors.js";
import { helmetMiddleware, globalRateLimit } from "../../gateway-edge/src/middleware/security.js";

import { mountClusterRoutes } from "../../gateway-edge/src/routes/mount-cluster-routes.js";
import internalGiteaAdminRoutes from "../../gateway-edge/src/routes/internal/gitea-admin.js";
import { installBodyParsers } from "../../gateway-edge/src/middleware/body-parsers.js";
import { createEmailMetrics, setEmailMetrics } from "../../gateway-edge/src/lib/email-metrics.js";
import { mattermostMintRoutes, mmRestProxyHandler } from "./routes/mattermost-proxy.js";
import { createSiteDeployRoutes } from "./routes/site-deploy.js";
import { createOpenClawRuntimeBrokerRoutes } from "./routes/openclaw-runtime-broker.js";
import { createConnectorTokenBrokerRoutes } from "./routes/connector-token-broker.js";
import { db } from "../../gateway-edge/src/lib/db.js";
import { createKubernetesTokenReviewer } from "./lib/token-review.js";
import {
  createTenantBindingHealthState,
  startTenantBindingSelfCheck,
} from "./lib/tenant-binding-health.js";
import {
  createTenantBindingMiddleware,
  createTenantBindingMetrics,
} from "./middleware/tenant-binding.js";
import { createTenantEnforcementMiddleware } from "./middleware/tenant-enforcement.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const TENANT_BOUND_API_ROUTES = new Set([
  "/api/byosub/auth-state",
  "/api/byosub/capture",
  "/api/byosub/sync-back",
  "/api/notifications/ingest",
  // Operator gateways broker their Firebase Hosting deploy here over the KSA
  // tenant-binding token; the handler authorizes via req.boundTenant.
  "/api/site/hosting-deploy",
]);

export interface CreateAppOptions {
  tenantBindingReviewer?: Parameters<typeof createTenantBindingMiddleware>[0]["reviewer"];
  tenantBindingSelfCheck?: {
    inCluster?: boolean;
    tokenPath?: string;
  };
}

export function shouldAttemptTenantBinding(path: string): boolean {
  if (path === "/internal" || path.startsWith("/internal/")) return true;
  if (TENANT_BOUND_API_ROUTES.has(path)) return true;
  if (path.endsWith("/") && TENANT_BOUND_API_ROUTES.has(path.slice(0, -1))) {
    return true;
  }
  return false;
}

export function shouldEnforceTenantBinding(req: Request): boolean {
  if (!shouldAttemptTenantBinding(req.path)) return false;
  return Boolean(
    req.boundTenant ||
      req.get("x-k8s-sa-token") ||
      req.get("x-internal-service-key"),
  );
}

export function createApp(opts: CreateAppOptions = {}) {
  const app = express();

  const metricsRegistry = new Registry();
  collectDefaultMetrics({ register: metricsRegistry });

  const httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [metricsRegistry],
  });

  const httpRequestTotal = new Counter({
    name: "http_requests_total",
    help: "Total number of HTTP requests",
    labelNames: ["method", "route", "status"] as const,
    registers: [metricsRegistry],
  });

  setEmailMetrics(createEmailMetrics(metricsRegistry));
  const tenantBindingMetrics = createTenantBindingMetrics(metricsRegistry);
  const tenantBindingReviewer = opts.tenantBindingReviewer ?? createKubernetesTokenReviewer();
  const tenantBindingHealth = createTenantBindingHealthState();
  const tenantBindingMiddleware = createTenantBindingMiddleware({
    reviewer: tenantBindingReviewer,
    metrics: tenantBindingMetrics,
  });
  const tenantEnforcementMiddleware = createTenantEnforcementMiddleware({ db });
  startTenantBindingSelfCheck(tenantBindingHealth, {
    reviewer: tenantBindingReviewer,
    ...opts.tenantBindingSelfCheck,
    log: (msg) => logger.error(msg),
  });

  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(globalRateLimit);

  app.use((req, res, next) => {
    if (req.path === "/metrics") return next();
    const end = httpRequestDuration.startTimer();
    res.on("finish", () => {

const route = req.route?.path || "unmatched";
      const labels = { method: req.method, route, status: String(res.statusCode) };
      end(labels);
      httpRequestTotal.inc(labels);
    });
    next();
  });

  app.use(requestLogger);

  installBodyParsers(app);

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  });

  const healthHandler = (_req: Request, res: Response) => {
    const tenantBinding = tenantBindingHealth.get();
    res.status(tenantBinding.status === "unhealthy" ? 503 : 200).json({
      status: tenantBinding.status === "unhealthy" ? "degraded" : "ok",
      service: "octogee-api",
      tenantBinding,
      timestamp: new Date().toISOString(),
    });
  };
  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);

  app.use((req, res, next) => {
    if (!shouldAttemptTenantBinding(req.path)) {
      next();
      return;
    }
    tenantBindingMiddleware(req, res, next);
  });
  app.use((req, res, next) => {
    if (!shouldEnforceTenantBinding(req)) {
      next();
      return;
    }
    tenantEnforcementMiddleware(req, res, next);
  });
  mountClusterRoutes(app, {
    mmRestProxyHandler,
    mattermostMintRoutes,
  });
  // octogee-api-only: Gitea admin broker. Gateway provisioners call this with
  // their projected gateway KSA token; octogee-api holds the Gitea admin token.
  app.use("/internal/gitea", internalGiteaAdminRoutes);
  // octogee-api-only: broker the gateway-edge OpenClaw runtime Firestore
  // dependencies so cattle pods do not need ADC/datastore reach.
  app.use("/internal/openclaw", createOpenClawRuntimeBrokerRoutes({ db }));
  // octogee-api-only: broker sidecar GitHub/GitLab file-browser token reads
  // so cattle pods do not need Firestore or KMS access to user secrets.
  app.use("/internal/connectors", createConnectorTokenBrokerRoutes({ db }));
  // octogee-api-only: the Hosting-deploy broker. Mounted after the tenant-binding
  // middleware so req.boundTenant is attached; never mounted on the in-pod gateway-edge.
  app.use("/api/site/hosting-deploy", createSiteDeployRoutes({ db }));

  app.use(errorHandler);

  return app;
}

const app = createApp();

if (process.env.NODE_ENV !== "test") {
  const env = process.env.K8S_NAMESPACE || process.env.NODE_ENV || "development";
  const isProd = env !== "development" && env !== "local" && env !== "test";
  if (isProd && !process.env.INTERNAL_SERVICE_KEY) {
    logger.error(
      "FATAL: INTERNAL_SERVICE_KEY is required in non-development environments.",
    );
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info(`octogee-api boot — listening on port ${PORT}`, {
      port: PORT,
      env: process.env.K8S_NAMESPACE || "local",
      sha: process.env.BUILD_SHA || "unknown",
      node: process.version,
    });
  });
}

export default app;
