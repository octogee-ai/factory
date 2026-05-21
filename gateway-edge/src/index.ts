import express, { Request, Response, Router } from "express";
import http from "node:http";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";
import { corsMiddleware } from "./middleware/cors.js";
import { requestLogger } from "./middleware/logging.js";
import { errorHandler } from "./middleware/errors.js";
import { logger } from "./middleware/logging.js";
import { helmetMiddleware, globalRateLimit } from "./middleware/security.js";
import { requireAuth } from "./middleware/auth.js";

import { mountApi } from "./routes/mount-api.js";
import gitRoutes from "./routes/workspace/git.js";
import deployPreviewRoutes from "./routes/projects/deploy-preview.js";
import internalBillingRoutes from "./routes/internal/billing.js";

// chat-proxy folded in: it shares this process's single HTTP server
// (port 3001) rather than running its own. The dispatcher in the boot
// block routes chat-proxy-owned HTTP paths to chatProxyHandleRequest and
// everything else to Express; WS upgrades + the background activity
// bridge attach the same way.
import {
  chatProxyHandleRequest,
  chatProxyOwnsHttpPath,
  attachChatProxyWsUpgrade,
  attachBuilderShellRoute,
  startChatProxyBackground,
  chatProxyMetricsRegistry,
} from "./chat-proxy/proxy.js";
import { stripGatewayPrefix } from "./chat-proxy/gateway-prefix.js";

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
  // Merge gateway-edge's registry (defaults + HTTP metrics) with
  // chat-proxy's (bridge/frame/WS metrics) — one /metrics, one port.
  const merged = Registry.merge([metricsRegistry, chatProxyMetricsRegistry]);
  res.set('Content-Type', merged.contentType);
  res.end(await merged.metrics());
});

const healthHandler = (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "gateway-edge", timestamp: new Date().toISOString() });
};
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// Locality routes only — these read/write per-gateway-pod state and
// can't move to the cluster singleton. Everything else is octogee-api.
const workspaceLocality = Router();
workspaceLocality.use(requireAuth);
workspaceLocality.use(gitRoutes);
mountApi(app, "/workspace", workspaceLocality);

const projectsLocality = Router();
projectsLocality.use(requireAuth);
projectsLocality.use(deployPreviewRoutes);
mountApi(app, "/projects", projectsLocality);

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

  // Single HTTP server for both surfaces. chat-proxy-owned paths go to
  // its raw handler; everything else to Express. WS upgrades + the
  // builder-shell route attach to the same server.
  const server = http.createServer((req, res) => {
    const rawPath = (req.url || "").split("?")[0];
    if (chatProxyOwnsHttpPath(stripGatewayPrefix(rawPath))) {
      void chatProxyHandleRequest(req, res);
    } else {
      app(req, res);
    }
  });
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

  void startChatProxyBackground().catch((err) => {
    logger.error("[chat-proxy] background boot failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  });
}

export default app;
