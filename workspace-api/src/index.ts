/**
 * Octogee workspace-api — consolidated HTTP service.
 *
 * Replaces ~20 Cloud Functions with a single Express app running in GKE.
 * Uses K8s DNS for Gitea and Mattermost — no VPC connectors, no ILB IPs.
 */
import express from "express";
import { corsMiddleware } from "./middleware/cors";
import { requestLogger } from "./middleware/logging";
import { errorHandler } from "./middleware/errors";
import { logger } from "./middleware/logging";

// Public routes — exposed via GKE Ingress (api.octogee.com)
import workspaceRoutes from "./routes/workspace";
import mattermostRoutes from "./routes/mattermost";
import billingRoutes from "./routes/billing";
import adminRoutes from "./routes/admin";
import leadRoutes from "./routes/leads";
import inviteRoutes from "./routes/invites";
import integrationRoutes from "./routes/integrations";
import discordRoutes from "./routes/discord";

// Internal routes — reachable only via K8s DNS (ClusterIP), NOT via Ingress
import dataRoutes from "./routes/data";
import agentRoutes from "./routes/agents";
import internalBillingRoutes from "./routes/internal/billing";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// ── Global middleware ──────────────────────────────────────────────────────

app.use(corsMiddleware);
app.use(requestLogger);

// Parse JSON for most routes. Stripe webhook needs raw body.
app.use((req, res, next) => {
  if (req.path === "/api/billing/webhook") {
    // Stripe needs raw body for signature verification
    express.raw({ type: "application/json" })(req, res, (err) => {
      if (err) return next(err);
      (req as any).rawBody = req.body;
      next();
    });
  } else {
    express.json({ limit: "10mb" })(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true }));

// ── Health check ───────────────────────────────────────────────────────────

const healthHandler = (_req: any, res: any) => {
  res.json({ status: "ok", service: "workspace-api", timestamp: new Date().toISOString() });
};
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

// ── Public routes (exposed via Ingress: api.octogee.com) ───────────────────

app.use("/api/workspace", workspaceRoutes);
app.use("/api/mattermost", mattermostRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/invites", inviteRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/discord", discordRoutes);

// ── Internal routes (K8s DNS only — NOT routed by Ingress) ─────────────────
// Ingress only matches /api/* paths. /internal/* never reaches the LB.

app.use("/internal/data", dataRoutes);
app.use("/internal/agents", agentRoutes);
app.use("/internal/billing", internalBillingRoutes);

// ── Global error handler ───────────────────────────────────────────────────

app.use(errorHandler);

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`workspace-api listening on port ${PORT}`, {
    port: PORT,
    env: process.env.K8S_NAMESPACE || "local",
  });
});

export default app;
