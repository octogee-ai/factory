

import express, { Request, Response } from "express";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";

import { corsMiddleware } from "../../gateway-edge/src/middleware/cors.js";
import { requestLogger, logger } from "../../gateway-edge/src/middleware/logging.js";
import { errorHandler } from "../../gateway-edge/src/middleware/errors.js";
import { helmetMiddleware, globalRateLimit } from "../../gateway-edge/src/middleware/security.js";

import mattermostRoutes from "../../gateway-edge/src/routes/mattermost.js";
import openclawRoutes from "../../gateway-edge/src/routes/openclaw.js";
import billingRoutes from "../../gateway-edge/src/routes/billing/index.js";
import adminRoutes from "../../gateway-edge/src/routes/admin.js";
import inviteRoutes from "../../gateway-edge/src/routes/invites.js";
import integrationRoutes from "../../gateway-edge/src/routes/integrations.js";
import byosubRoutes from "../../gateway-edge/src/routes/byosub.js";
import discordRoutes from "../../gateway-edge/src/routes/discord.js";
import notificationRoutes from "../../gateway-edge/src/routes/notifications.js";
import sharingRoutes from "../../gateway-edge/src/routes/sharing.js";
import entitiesRoutes from "../../gateway-edge/src/routes/entities.js";
import profileRoutes from "../../gateway-edge/src/routes/profile.js";
import onboardingRoutes from "../../gateway-edge/src/routes/onboarding.js";
import postsRoutes from "../../gateway-edge/src/routes/posts.js";
import agentRoutes from "../../gateway-edge/src/routes/agents.js";
import builderGatewaysRoutes from "../../gateway-edge/src/routes/builder/gateways.js";

import workspaceDisplayNameRoutes from "../../gateway-edge/src/routes/workspace/display-name.js";
import workspaceFilesRoutes from "../../gateway-edge/src/routes/workspace/files.js";
import workspaceUploadRoutes from "../../gateway-edge/src/routes/workspace/upload.js";
import workspaceDeleteBlobRoutes from "../../gateway-edge/src/routes/workspace/delete-blob.js";
import workspaceExtractZipRoutes from "../../gateway-edge/src/routes/workspace/extract-zip.js";
import workspaceImportRepoRoutes from "../../gateway-edge/src/routes/workspace/import-repo.js";
import { requireAuth } from "../../gateway-edge/src/middleware/auth.js";

import projectsReadmeRoutes from "../../gateway-edge/src/routes/projects/readme.js";
import projectsCreateRoutes from "../../gateway-edge/src/routes/projects/create.js";
import projectsRetryRoutes from "../../gateway-edge/src/routes/projects/retry.js";
import projectsJoinLeaveRoutes from "../../gateway-edge/src/routes/projects/join-leave.js";
import projectsStarRoutes from "../../gateway-edge/src/routes/projects/star.js";
import projectsMembersRoutes from "../../gateway-edge/src/routes/projects/members.js";
import projectsDeleteRoutes from "../../gateway-edge/src/routes/projects/delete.js";

import internalNotificationRoutes from "../../gateway-edge/src/routes/internal/notifications.js";
import internalEngagementRoutes from "../../gateway-edge/src/routes/internal/engagement.js";
import internalCSIRoutes from "../../gateway-edge/src/routes/internal/csi.js";

import { mattermostMintRoutes, mmRestProxyHandler } from "./routes/mattermost-proxy.js";

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

const route = req.route?.path || "unmatched";
      const labels = { method: req.method, route, status: String(res.statusCode) };
      end(labels);
      httpRequestTotal.inc(labels);
    });
    next();
  });

  app.use(requestLogger);

app.all("/api/v4/*splat", mmRestProxyHandler);

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

const WORKSPACE = "/api/workspace";
  app.use(WORKSPACE, requireAuth);
  app.use(WORKSPACE, workspaceDisplayNameRoutes);
  app.use(WORKSPACE, workspaceFilesRoutes);
  app.use(WORKSPACE, workspaceUploadRoutes);
  app.use(WORKSPACE, workspaceDeleteBlobRoutes);
  app.use(WORKSPACE, workspaceExtractZipRoutes);
  app.use(WORKSPACE, workspaceImportRepoRoutes);

const PROJECTS = "/api/projects";
  app.use(PROJECTS, projectsReadmeRoutes);
  app.use(PROJECTS, projectsDeleteRoutes);
  app.use(PROJECTS, requireAuth);
  app.use(PROJECTS, projectsCreateRoutes);
  app.use(PROJECTS, projectsRetryRoutes);
  app.use(PROJECTS, projectsJoinLeaveRoutes);
  app.use(PROJECTS, projectsStarRoutes);
  app.use(PROJECTS, projectsMembersRoutes);

app.use("/api/auth/mattermost", mattermostMintRoutes);
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

app.use("/internal/agents", agentRoutes);
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
