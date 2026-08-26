import express, { Express, Request, RequestHandler, Response, Router } from "express";
import http from "node:http";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";
import { corsMiddleware } from "./middleware/cors.js";
import { requestLogger } from "./middleware/logging.js";
import { errorHandler } from "./middleware/errors.js";
import { logger } from "./middleware/logging.js";
import { helmetMiddleware, globalRateLimit, internalRateLimit } from "./middleware/security.js";
import { requireAuth, requireAuthenticatedUid } from "./middleware/auth.js";
import { installBodyParsers } from "./middleware/body-parsers.js";
import { createEmailMetrics, setEmailMetrics } from "./lib/email-metrics.js";
import { createNotificationMetrics, setNotificationMetrics } from "./lib/notification-metrics.js";
import { createActivityPairMetrics, setActivityPairMetrics } from "./lib/activity-pair-metrics.js";

import { mountApi } from "./routes/mount-api.js";
import automationsRoutes from "./routes/automations.js";
import gitRoutes from "./routes/workspace/git.js";
import githubReposRoutes from "./routes/workspace/github-repos.js";
import byosubHealthRoutes from "./routes/byosub-health.js";
import { createByosubAuthRouter } from "./routes/byosub-auth.js";
import internalBillingRoutes from "./routes/internal/billing.js";
import internalAgentMessageRoutes from "./routes/internal/agent-message.js";

import internalWorkspaceCommitRoutes from "./routes/internal/workspace-commit.js";
import internalGiteaAdminRoutes from "./routes/internal/gitea-admin.js";
import internalByotSyncRoutes from "./routes/internal/byot-sync.js";
import internalConnectorRoutes from "./routes/internal/connectors.js";
import { createAgentImportsRouter } from "./routes/agent-imports.js";
import { createAgentImportRuntime } from "./lib/agent-import-runtime.js";
import { mountClusterRoutes } from "./routes/mount-cluster-routes.js";
import { createSharingRoutes } from "./routes/sharing.js";
import { createProjectCreateRoutes } from "./routes/projects/create.js";
import { createProjectRepoSourceRoutes } from "./routes/projects/repo-source.js";
import type { FeaturePolicy } from "@octogee/shared/types/feature-flags";
import { createGatewayRouter } from "./public-router.js";
import {
  createRollRosterGate,
  createRollRosterStore,
  createRollRosterUpgradeGate,
  type RollRosterStore,
  type RollRosterUpgradeGate,
} from "./roll-roster.js";
import { createBrokerRollRosterSubscription } from "./broker-roll-roster.js";
import { chatProxyOwnsHttpPath } from "./chat-proxy/http-paths.js";
import { stripGatewayPrefix } from "./chat-proxy/gateway-prefix.js";
import { validateRequiredEnv } from "./lib/required-env.js";
import type { WsUpgradeRouter } from "@octogee/core/ws/upgrade-router";
import {
  attachOpenClawControlWsRoute,
  createOpenClawControlHttpRouter,
} from "./openclaw-control/surface.js";
import { startOpenClawDashboardCapabilityHeartbeat } from "./openclaw-control/capability-heartbeat.js";
import {
  createOpenClawControlMetrics,
  type OpenClawControlMetrics,
} from "./openclaw-control/metrics.js";
import {
  createOpenClawControlAuthorizationCache,
  type OpenClawControlAuthorizationCache,
} from "./openclaw-control/broker.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
type ChatProxyModule = typeof import("./chat-proxy/proxy.js");

let chatProxyModulePromise: Promise<ChatProxyModule> | null = null;
let activeChatProxyMetricsRegistry: Registry | null = null;
let activeOpenClawControlMetrics: OpenClawControlMetrics | undefined;
const openClawControlAuthorizationCache = createOpenClawControlAuthorizationCache();

async function loadChatProxyModule(): Promise<ChatProxyModule> {
  chatProxyModulePromise ??= import("./chat-proxy/proxy.js").then((mod) => {
    activeChatProxyMetricsRegistry = mod.chatProxyMetricsRegistry;
    return mod;
  });
  return chatProxyModulePromise;
}

export type GatewayEdgeSurface = "sidecar" | "cluster";

// Filled once on revision-pod boot (installRollRosterGate); null everywhere
// else (legacy pods, cluster surface, tests) — the slot then passes through.
let activeRollRosterGate: RequestHandler | null = null;

export function installRollRosterGate(gate: RequestHandler): void {
  activeRollRosterGate = gate;
}

export interface CreateAppOptions {
  surface?: GatewayEdgeSurface;
  // Route tests inject an enabling policy to exercise the workspace sharing
  // paths; unset means the flag is off, which is what the pod surface wants.
  featurePolicy?: FeaturePolicy;
}

export function createApp(opts: CreateAppOptions = {}) {
// Keep createApp() as the legacy cluster harness for route tests; the module
// entrypoint below explicitly boots the production sidecar surface.
const surface = opts.surface ?? "cluster";
const app = express();
// client → GCLB (appends client-ip, lb-ip) → gateway-router → this app
app.set("trust proxy", 2);

const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });
const openClawControlMetrics = createOpenClawControlMetrics(metricsRegistry);
if (surface === "sidecar") activeOpenClawControlMetrics = openClawControlMetrics;

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
setNotificationMetrics(createNotificationMetrics(metricsRegistry));
setActivityPairMetrics(createActivityPairMetrics(metricsRegistry));

app.use(helmetMiddleware);
app.use(corsMiddleware);

app.use(globalRateLimit);
app.use(internalRateLimit);

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

const merged = Registry.merge(
  activeChatProxyMetricsRegistry ? [metricsRegistry, activeChatProxyMetricsRegistry] : [metricsRegistry],
);
  res.set('Content-Type', merged.contentType);
  res.end(await merged.metrics());
});

const healthHandler = (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "gateway-edge", timestamp: new Date().toISOString() });
};
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// Mid-roll per-customer routing gate (roll-roster.ts). The slot sits after
// health/metrics (probes never 503 on roster load) and before every
// customer-state surface; production boot installs the real gate on revision
// pods only. Chat-proxy paths bypass Express by design — they proxy to the
// shared Mattermost service, which carries no per-revision customer state.
app.use((req, res, next) =>
  activeRollRosterGate ? activeRollRosterGate(req, res, next) : next(),
);

app.use("/api/g/:gatewayId/internal", internalByotSyncRoutes);
if (surface === "sidecar") {
  app.use("/api/g/:gatewayId/internal/agent-message", internalAgentMessageRoutes);
  app.use("/internal/workspace", internalWorkspaceCommitRoutes);
  app.use("/internal/connectors", internalConnectorRoutes);
}

if (surface === "cluster") {
  mountClusterSurface(app, opts.featurePolicy);
}

mountSidecarLocalitySurface(app, {
  dashboardEnabled: surface === "sidecar" && process.env.OPENCLAW_DASHBOARD_BRIDGE_ENABLED === "true",
  openClawControlMetrics,
  openClawControlAuthorizationCache,
});

app.use(errorHandler);

return app;
}

function mountClusterSurface(app: Express, featurePolicy?: FeaturePolicy): void {
  app.use("/internal/billing", internalBillingRoutes);
  // Legacy in-process Gitea broker surface. The durable broker lives on octogee-api;
  // the gateway-edge sidecar surface intentionally does not mount this.
  app.use("/internal/gitea", internalGiteaAdminRoutes);

  // mountClusterRoutes goes FIRST so its public /api/projects routes
  // (readme) and explicit-auth sequencing aren't shadowed by the locality
  // routers. Express tries handlers in mount order; locality routers are
  // gateway-edge-only and only match their specific paths.
  mountClusterRoutes(app, featurePolicy ? {
    sharingRoutes: createSharingRoutes({ featurePolicy }),
    projectsCreateRoutes: createProjectCreateRoutes({ featurePolicy }),
    projectsRepoSourceRoutes: createProjectRepoSourceRoutes({ featurePolicy }),
  } : {});
}

function mountSidecarLocalitySurface(app: Express, options: {
  dashboardEnabled: boolean;
  openClawControlMetrics: OpenClawControlMetrics;
  openClawControlAuthorizationCache: OpenClawControlAuthorizationCache;
}): void {
  if (options.dashboardEnabled) {
    app.use("/api/g/:gatewayId/openclaw", createOpenClawControlHttpRouter({
      env: process.env,
      metrics: options.openClawControlMetrics,
      authorizationCache: options.openClawControlAuthorizationCache,
    }));
  }
  const workspaceLocality = Router();
  workspaceLocality.use("/git", requireAuth);
  workspaceLocality.use(gitRoutes);
  workspaceLocality.use(githubReposRoutes);
  mountApi(app, "/workspace", workspaceLocality);

  // Deep byosub health runs on the customer's own pod (reached via the
  // /api/g/<gatewayId>/byosub/* locality seam), so it can read the pod's
  // auth-profile store — the proof /api/model-credentials/subscription/connection's ref-read can't give.
  const byosubLocality = Router();
  byosubLocality.use("/health", requireAuthenticatedUid);
  byosubLocality.use(byosubHealthRoutes);
  mountApi(app, "/byosub", byosubLocality);
  const automationsLocality = Router({ mergeParams: true });
  automationsLocality.use(requireAuthenticatedUid);
  automationsLocality.use(automationsRoutes);
  mountApi(app, "/automations", automationsLocality);
  const agentImportsLocality = Router({ mergeParams: true });
  agentImportsLocality.use(requireAuthenticatedUid);
  agentImportsLocality.use(createAgentImportsRouter({
    createRuntime: createAgentImportRuntime,
    localGatewayId: () => process.env.GATEWAY_ID ?? null,
  }));
  mountApi(app, "/agent-imports", agentImportsLocality);
  // connect/status/sso-submit run HERE (the customer's own pod) so the in-pod
  // claude-sso/device-auth managers accept the pod's OPENCLAW_GATEWAY_TOKEN —
  // octogee-api can't hold a per-gateway token. The flow write brokers back.
  // Mount only on the fleet-scoped path; bare /api/byosub/* is a retired
  // cluster alias and must not be masked by locality auth middleware.
  app.use("/api/g/:gatewayId/byosub", createByosubAuthRouter());
}

const app = createApp({ surface: "sidecar" });

export function dispatchGatewayEdgeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  app: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): void {
  const rawPath = (req.url || "").split("?")[0];
  if (chatProxyOwnsHttpPath(stripGatewayPrefix(rawPath), rawPath)) {
    loadChatProxyModule().then((chatProxy) => chatProxy.chatProxyHandleRequest(req, res)).catch((err) => {
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
  if (process.env.GATEWAY_EDGE_MODE === "agent-control-router") {
    const { createAgentControlCallbackRouter } = await import("./agent-control-callback-router.js");
    const namespace = process.env.K8S_NAMESPACE || "default";
    const router = createAgentControlCallbackRouter({
      namespace,
      hmacKey: process.env.AGENT_CONTROL_ROUTER_KEY ?? "",
      log: (message, meta) => logger.error(message, meta),
    });
    router.listen(PORT, () => {
      logger.info(`mattermost-callback-router boot — listening on port ${PORT}`, {
        port: PORT,
        namespace,
        sha: process.env.BUILD_SHA || "unknown",
      });
    });
  } else if (process.env.GATEWAY_EDGE_MODE === "router") {
    const server = createGatewayRouter({
      namespace: process.env.K8S_NAMESPACE || "default",
      log: (message, meta) => logger.error(message, meta),
    });
    server.listen(PORT, () => {
      logger.info(`gateway-router boot — listening on port ${PORT}`, {
        port: PORT,
        namespace: process.env.K8S_NAMESPACE || "default",
        sha: process.env.BUILD_SHA || "unknown",
      });
    });
  } else {
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
        "openclaw/activity bridges and git locality routes all " +
        "depend on these.",
    );
    process.exit(1);
  }

  // Gateway pods gate customer-state traffic on the durable assignment roster
  // (the migration quiesce gate). The gate installs SYNCHRONOUSLY with a
  // not-yet-loaded store facade, so an edge booting mid-migration answers 503 +
  // Retry-After until the roster snapshot lands — it never defaults to
  // serve-local for a quiescing customer (council-resolved). The roster read is
  // scoped to this pod's own gateway and is read-only.
  const selfRevisionId = process.env.GATEWAY_REVISION_ID ?? "";
  const rosterGatewayId = process.env.GATEWAY_ID ?? "";
  let rollRosterUpgradeGate: RollRosterUpgradeGate | null = null;
  if (selfRevisionId && rosterGatewayId) {
    let rosterStore: RollRosterStore | null = null;
    const storeFacade = {
      loaded: () => rosterStore?.loaded() ?? false,
      get: (uid: string) => rosterStore?.get(uid),
    };
    installRollRosterGate(
      createRollRosterGate({
        store: storeFacade,
        gatewayId: rosterGatewayId,
        selfRevisionId,
        log: (msg) => logger.warn(msg),
      }),
    );
    // WS upgrades bypass Express — the same roster/boot checks run at the
    // chat-proxy upgrade path.
    rollRosterUpgradeGate = createRollRosterUpgradeGate({
      store: storeFacade,
      gatewayId: rosterGatewayId,
      selfRevisionId,
      log: (msg) => logger.warn(msg),
    });
    rosterStore = createRollRosterStore({
      subscribe: createBrokerRollRosterSubscription({
        brokerUrl:
          process.env.FLEET_BROKER_URL ??
          process.env.OCTOGEE_API_URL ??
          `http://octogee-api.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:3001`,
        gatewayId: rosterGatewayId,
        revisionId: selfRevisionId,
      }),
      log: (msg) => logger.warn(msg),
    });
  }

  const server = http.createServer((req, res) =>
    dispatchGatewayEdgeRequest(req, res, app),
  );
  loadChatProxyModule().then((chatProxy) => {
    chatProxy.attachChatProxyWsUpgrade(server, { upgradeGate: rollRosterUpgradeGate });
    if (process.env.OPENCLAW_DASHBOARD_BRIDGE_ENABLED === "true") {
      attachOpenClawControlWsRoute({
        router: (server as unknown as { wsRouter: WsUpgradeRouter }).wsRouter,
        env: process.env,
        metrics: activeOpenClawControlMetrics,
        authorizationCache: openClawControlAuthorizationCache,
      });
      const dashboardHeartbeat = startOpenClawDashboardCapabilityHeartbeat({
        env: process.env,
        logError: (error) => logger.error("OpenClaw Dashboard capability heartbeat failed", {
          errorType: error instanceof Error ? error.name : "unknown",
        }),
      });
      process.once("exit", () => dashboardHeartbeat?.stop());
    }
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

    chatProxy.startChatProxyBackground().catch((err) => {
      logger.error("[chat-proxy] background boot failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }).catch((err) => {
    logger.error("[chat-proxy] module load failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
  }
}

export default app;
