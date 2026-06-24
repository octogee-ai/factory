import express, { Express, Request, Response, Router } from "express";
import http from "node:http";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";
import { corsMiddleware } from "./middleware/cors.js";
import { requestLogger } from "./middleware/logging.js";
import { errorHandler } from "./middleware/errors.js";
import { logger } from "./middleware/logging.js";
import { helmetMiddleware, globalRateLimit } from "./middleware/security.js";
import { requireAuth } from "./middleware/auth.js";
import { installBodyParsers } from "./middleware/body-parsers.js";
import { createEmailMetrics, setEmailMetrics } from "./lib/email-metrics.js";

import { mountApi } from "./routes/mount-api.js";
import gitRoutes from "./routes/workspace/git.js";
import githubReposRoutes from "./routes/workspace/github-repos.js";
import deployPreviewRoutes from "./routes/projects/deploy-preview.js";
import byosubHealthRoutes from "./routes/byosub-health.js";
import internalBillingRoutes from "./routes/internal/billing.js";

import internalBuilderShellRoutes from "./routes/internal/builder-shell.js";
import internalSiteDeployRoutes from "./routes/internal/site-deploy.js";
import internalGiteaAdminRoutes from "./routes/internal/gitea-admin.js";
import internalByotSyncRoutes from "./routes/internal/byot-sync.js";
import { mountClusterRoutes } from "./routes/mount-cluster-routes.js";

import {
  chatProxyHandleRequest,
  chatProxyOwnsHttpPath,
  attachChatProxyWsUpgrade,
  attachBuilderShellRoute,
  startChatProxyBackground,
  chatProxyMetricsRegistry,
} from "./chat-proxy/proxy.js";
import { stripGatewayPrefix } from "./chat-proxy/gateway-prefix.js";
import { validateRequiredEnv } from "./lib/required-env.js";

const PORT = parseInt(process.env.PORT || "3001", 10);

export type GatewayEdgeSurface = "sidecar" | "cluster";

export interface CreateAppOptions {
  surface?: GatewayEdgeSurface;
}

export function createApp(opts: CreateAppOptions = {}) {
// Keep createApp() as the legacy cluster harness for route tests; the module
// entrypoint below explicitly boots the production sidecar surface.
const surface = opts.surface ?? "cluster";
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

setEmailMetrics(createEmailMetrics(metricsRegistry));

app.use(helmetMiddleware);
app.use(corsMiddleware);

app.use(globalRateLimit);

app.use((req, res, next) => {
  if (req.path === '/metrics') return next();
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {

const route = req.route?.path || 'unmatched';
    const labels = { method: req.method, route, status: String(res.statusCode) };
    end(labels);
    httpRequestTotal.inc(labels);
  });
  next();
});

app.use(requestLogger);

installBodyParsers(app);

app.get('/metrics', async (_req, res) => {

const merged = Registry.merge([metricsRegistry, chatProxyMetricsRegistry]);
  res.set('Content-Type', merged.contentType);
  res.end(await merged.metrics());
});

const healthHandler = (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "gateway-edge", timestamp: new Date().toISOString() });
};
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// builder-shell has two caller shapes: redeem is pod-local (the in-pod bridge,
// bare path), kill is cross-pod (octogee-api → the owner pod via the
// /api/g/<id>/* fleet seam). The HTTP server hands Express the raw url without
// stripping the fleet prefix, so the scoped form needs its own mount.
app.use("/internal/builder-shell", internalBuilderShellRoutes);
app.use("/api/g/:gatewayId/internal/builder-shell", internalBuilderShellRoutes);
app.use("/api/g/:gatewayId/internal", internalByotSyncRoutes);

if (surface === "cluster") {
  mountClusterSurface(app);
}

mountSidecarLocalitySurface(app);

app.use(errorHandler);

return app;
}

function mountClusterSurface(app: Express): void {
  app.use("/internal/billing", internalBillingRoutes);
  // Hosting-deploy broker route. Operator gateways no longer wire site-build-api to
  // this path; their publishing is CI/CD-owned. Kept fail-closed behind internal auth
  // for any trusted caller that explicitly configures OCTOGEE_API_URL.
  app.use("/internal/site", internalSiteDeployRoutes);
  // Legacy in-process Gitea broker surface. The durable broker lives on octogee-api;
  // the gateway-edge sidecar surface intentionally does not mount this.
  app.use("/internal/gitea", internalGiteaAdminRoutes);

  // mountClusterRoutes goes FIRST so its public /api/projects routes
  // (readme) and explicit-auth sequencing aren't shadowed by the locality
  // routers. Express tries handlers in mount order; locality routers are
  // gateway-edge-only and only match their specific paths.
  mountClusterRoutes(app);
}

function mountSidecarLocalitySurface(app: Express): void {
  const workspaceLocality = Router();
  workspaceLocality.use("/git", requireAuth);
  workspaceLocality.use(gitRoutes);
  workspaceLocality.use(githubReposRoutes);
  mountApi(app, "/workspace", workspaceLocality);

  const projectsLocality = Router();
  projectsLocality.use("/:wid/:pid/deploy-preview", requireAuth);
  projectsLocality.use(deployPreviewRoutes);
  mountApi(app, "/projects", projectsLocality);

  // Deep byosub health runs on the customer's own pod (reached via the
  // /api/g/<gatewayId>/byosub/* locality seam), so it can read the pod's
  // auth-profile store — the proof /api/byosub/connection's ref-read can't give.
  const byosubLocality = Router();
  byosubLocality.use("/health", requireAuth);
  byosubLocality.use(byosubHealthRoutes);
  mountApi(app, "/byosub", byosubLocality);
}

const app = createApp({ surface: "sidecar" });

export function dispatchGatewayEdgeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): void {
  const rawPath = (req.url || "").split("?")[0];
  if (chatProxyOwnsHttpPath(stripGatewayPrefix(rawPath))) {
    chatProxyHandleRequest(req, res).catch((err) => {
      logger.error("[chat-proxy] request handler failed", {
        path: rawPath,
        err: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      }
    });
  } else {
    app(req, res);
  }
}

if (process.env.NODE_ENV !== "test") {
  const env = process.env.K8S_NAMESPACE || process.env.NODE_ENV || "development";
  const isProd = env !== "development" && env !== "local" && env !== "test";
  const { missing } = validateRequiredEnv(process.env, {
    isProd,
    profile: process.env.GATEWAY_PROFILE,
  });
  if (missing.length > 0) {
    logger.error(
      `FATAL: required gateway-edge env unset: ${missing.join(", ")}. ` +
        "Supplied per-gateway via the chart's gatewayEdge.env/.secrets ranges " +
        "(threaded by Cowboy); a missing one means a skewed render or a " +
        "dropped-on-apply duplicate. Refusing to boot rather than limp — the " +
        "openclaw/activity bridges, git locality routes, and builder-shell all " +
        "depend on these.",
    );
    process.exit(1);
  }

const server = http.createServer((req, res) =>
    dispatchGatewayEdgeRequest(req, res, app),
  );
  attachChatProxyWsUpgrade(server);
  attachBuilderShellRoute(server).catch((err) => {
    logger.error("[builder-shell] route attach failed — WS route disabled", {
      err: err instanceof Error ? err.message : String(err),
    });
  });

  server.listen(PORT, () => {
    logger.info(`gateway-edge boot — listening on port ${PORT}`, {
      port: PORT,
      env: process.env.K8S_NAMESPACE || "local",
      sha: process.env.BUILD_SHA || "unknown",
      oc: process.env.OPENCLAW_VERSION || "n/a",
      fork: process.env.OPENCLAW_FORK_SHA || "n/a",
      node: process.version,
    });
  });

  startChatProxyBackground().catch((err) => {
    logger.error("[chat-proxy] background boot failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

export default app;
