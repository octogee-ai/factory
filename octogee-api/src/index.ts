/**
 * octogee-api — cluster-singleton HTTP service for non-locality routes.
 *
 * Lifted from gateway-edge per `docs/specs/POST-BENDER-CLEANUP-SPEC.md`.
 * Mounts the 43 of 46 gateway-edge routes that have no per-gateway-pod
 * locality dependency. Stable hostname + stable connection pools unblock
 * Astro SSR on octogee.com (was previously round-robined across every
 * gateway pod's gateway-edge sidecar).
 *
 * Locality routes that stay on the gateway-pod sidecar:
 *   - workspace/git          (local /home/node/.openclaw/customers FS)
 *   - internal/billing       (calls localhost OpenClaw RPC for usage)
 *   - projects/deploy-preview (calls localhost site-build-api sidecar)
 *
 * Route handlers are imported as-is from gateway-edge/src/routes/* —
 * no code movement, both packages compile the same sources independently.
 * When gateway-edge is later slimmed to just its 3 locality routes, this
 * import path becomes the single source-of-truth location.
 */
import express, { Request, Response } from "express";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";

import { corsMiddleware } from "../../gateway-edge/src/middleware/cors";
import { requestLogger, logger } from "../../gateway-edge/src/middleware/logging";
import { errorHandler } from "../../gateway-edge/src/middleware/errors";
import { helmetMiddleware, globalRateLimit } from "../../gateway-edge/src/middleware/security";

// ── Cluster routes (43 of 46) ────────────────────────────────────────────
import mattermostRoutes from "../../gateway-edge/src/routes/mattermost";
import openclawRoutes from "../../gateway-edge/src/routes/openclaw";
import billingRoutes from "../../gateway-edge/src/routes/billing";
import adminRoutes from "../../gateway-edge/src/routes/admin";
import inviteRoutes from "../../gateway-edge/src/routes/invites";
import integrationRoutes from "../../gateway-edge/src/routes/integrations";
import byosubRoutes from "../../gateway-edge/src/routes/byosub";
import discordRoutes from "../../gateway-edge/src/routes/discord";
import notificationRoutes from "../../gateway-edge/src/routes/notifications";
import sharingRoutes from "../../gateway-edge/src/routes/sharing";
import entitiesRoutes from "../../gateway-edge/src/routes/entities";
import profileRoutes from "../../gateway-edge/src/routes/profile";
import onboardingRoutes from "../../gateway-edge/src/routes/onboarding";
import postsRoutes from "../../gateway-edge/src/routes/posts";
import agentRoutes from "../../gateway-edge/src/routes/agents";
import builderGatewaysRoutes from "../../gateway-edge/src/routes/builder/gateways";

// workspace/* sub-routers mounted individually so locality `git` is skipped.
import workspaceDisplayNameRoutes from "../../gateway-edge/src/routes/workspace/display-name";
import workspaceFilesRoutes from "../../gateway-edge/src/routes/workspace/files";
import workspaceUploadRoutes from "../../gateway-edge/src/routes/workspace/upload";
import workspaceDeleteBlobRoutes from "../../gateway-edge/src/routes/workspace/delete-blob";
import workspaceExtractZipRoutes from "../../gateway-edge/src/routes/workspace/extract-zip";
import workspaceImportRepoRoutes from "../../gateway-edge/src/routes/workspace/import-repo";
import { requireAuth } from "../../gateway-edge/src/middleware/auth";

// projects/* sub-routers mounted individually so locality `deploy-preview` is skipped.
import projectsReadmeRoutes from "../../gateway-edge/src/routes/projects/readme";
import projectsCreateRoutes from "../../gateway-edge/src/routes/projects/create";
import projectsRetryRoutes from "../../gateway-edge/src/routes/projects/retry";
import projectsJoinLeaveRoutes from "../../gateway-edge/src/routes/projects/join-leave";
import projectsStarRoutes from "../../gateway-edge/src/routes/projects/star";
import projectsMembersRoutes from "../../gateway-edge/src/routes/projects/members";
import projectsDeleteRoutes from "../../gateway-edge/src/routes/projects/delete";

// Internal (service-to-service, requireInternalServiceAuth).
import internalNotificationRoutes from "../../gateway-edge/src/routes/internal/notifications";
import internalEngagementRoutes from "../../gateway-edge/src/routes/internal/engagement";
import internalCSIRoutes from "../../gateway-edge/src/routes/internal/csi";
import internalBuilderShellRoutes from "../../gateway-edge/src/routes/internal/builder-shell";

const PORT = parseInt(process.env.PORT || "3001", 10);

export function createApp() {
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

  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(globalRateLimit);

  app.use((req, res, next) => {
    if (req.path === "/metrics") return next();
    const end = httpRequestDuration.startTimer();
    res.on("finish", () => {
      // Fall back to a constant label for unmatched requests — using
      // req.path here would let attacker-controlled URLs explode the
      // Prometheus series cardinality (Copilot review of #1112).
      const route = req.route?.path || "unmatched";
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

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  });

  const healthHandler = (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "octogee-api", timestamp: new Date().toISOString() });
  };
  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);

  // ── Cluster routes — single mount at /api/<path>. Unlike gateway-edge,
  // octogee-api does NOT dual-mount at /api/g/:gatewayId/* — that path is
  // the per-gateway-pod affinity seam, served only by the gateway sidecar.
  const WORKSPACE = "/api/workspace";
  app.use(WORKSPACE, requireAuth);
  app.use(WORKSPACE, workspaceDisplayNameRoutes);
  app.use(WORKSPACE, workspaceFilesRoutes);
  app.use(WORKSPACE, workspaceUploadRoutes);
  app.use(WORKSPACE, workspaceDeleteBlobRoutes);
  app.use(WORKSPACE, workspaceExtractZipRoutes);
  app.use(WORKSPACE, workspaceImportRepoRoutes);
  // workspace/git stays on gateway sidecar (local FS).

  const PROJECTS = "/api/projects";
  app.use(PROJECTS, projectsReadmeRoutes);
  app.use(PROJECTS, projectsDeleteRoutes);
  app.use(PROJECTS, requireAuth);
  app.use(PROJECTS, projectsCreateRoutes);
  app.use(PROJECTS, projectsRetryRoutes);
  app.use(PROJECTS, projectsJoinLeaveRoutes);
  app.use(PROJECTS, projectsStarRoutes);
  app.use(PROJECTS, projectsMembersRoutes);
  // projects/deploy-preview stays on gateway sidecar (calls site-build-api).

  app.use("/api/sharing", sharingRoutes);
  app.use("/api/entities", entitiesRoutes);
  app.use("/api/mattermost", mattermostRoutes);
  app.use("/api/openclaw", openclawRoutes);
  app.use("/api/billing", billingRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/invites", inviteRoutes);
  app.use("/api/integrations", integrationRoutes);
  app.use("/api/byosub", byosubRoutes);
  app.use("/api/discord", discordRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/profile", profileRoutes);
  app.use("/api/onboarding", onboardingRoutes);
  app.use("/api/posts", postsRoutes);
  app.use("/api/agents", agentRoutes);
  app.use("/api/builder", builderGatewaysRoutes);

  // Internal endpoints — internal/billing (locality) stays on gateway sidecar.
  app.use("/internal/agents", agentRoutes);
  app.use("/internal/notifications", notificationRoutes);
  app.use("/internal/notifications", internalNotificationRoutes);
  app.use("/internal/engagement", internalEngagementRoutes);
  app.use("/internal/csi", internalCSIRoutes);
  app.use("/internal/builder-shell", internalBuilderShellRoutes);

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
