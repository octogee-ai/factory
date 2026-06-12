import { Express, RequestHandler, Router } from "express";

import mattermostRoutes from "./mattermost.js";
import openclawRoutes from "./openclaw.js";
import billingRoutes from "./billing/index.js";
import legalAcceptRoutes from "./legal/accept.js";
import byosubRoutes from "./byosub.js";
import adminRoutes from "./admin.js";
import inviteRoutes from "./invites.js";
import integrationRoutes from "./integrations.js";
import connectRoutes from "./connect.js";
import discordRoutes from "./discord.js";
import notificationRoutes from "./notifications.js";
import sharingRoutes from "./sharing.js";
import emailWebhookRoutes from "./email-webhook.js";
import emailUnsubscribeRoutes from "./email-unsubscribe.js";
import authEmailRoutes from "./auth-email.js";
import entitiesRoutes from "./entities.js";
import profileRoutes from "./profile.js";
import onboardingRoutes from "./onboarding.js";
import postsRoutes from "./posts.js";
import agentRoutes from "./agents.js";
import builderGatewaysRoutes from "./builder/gateways.js";
import shellsRoutes from "./shells.js";

import workspaceDisplayNameRoutes from "./workspace/display-name.js";
import workspaceFilesRoutes from "./workspace/files.js";
import workspaceUploadRoutes from "./workspace/upload.js";
import workspaceDeleteBlobRoutes from "./workspace/delete-blob.js";
import workspaceExtractZipRoutes from "./workspace/extract-zip.js";
import workspaceImportRepoRoutes from "./workspace/import-repo.js";

import projectsReadmeRoutes from "./projects/readme.js";
import projectsCreateRoutes from "./projects/create.js";
import projectsRetryRoutes from "./projects/retry.js";
import projectsJoinLeaveRoutes from "./projects/join-leave.js";
import projectsStarRoutes from "./projects/star.js";
import projectsMembersRoutes from "./projects/members.js";
import projectsDeleteRoutes from "./projects/delete.js";

import internalNotificationRoutes from "./internal/notifications.js";
import internalEngagementRoutes from "./internal/engagement.js";
import internalCSIRoutes from "./internal/csi.js";

import { requireAuth } from "../middleware/auth.js";

export interface MountClusterRoutesOpts {
  mmRestProxyHandler?: RequestHandler;
  mattermostMintRoutes?: Router;
}

export function mountClusterRoutes(app: Express, opts: MountClusterRoutesOpts = {}): void {
  if (opts.mmRestProxyHandler) {
    app.all("/api/v4/*splat", opts.mmRestProxyHandler);
  }

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

  if (opts.mattermostMintRoutes) {
    app.use("/api/auth/mattermost", opts.mattermostMintRoutes);
  }
  app.use("/api/auth/email", authEmailRoutes);
  app.use("/api/sharing", sharingRoutes);
  // Raw-body endpoints under /api/email/* (the Resend webhook) MUST be listed
  // in RAW_BODY_WEBHOOK_PATHS (see body-parsers.ts) or signature verification
  // breaks. Non-raw-body sub-routes (e.g. urlencoded one-click unsubscribe)
  // fall through to normal parsing and are fine alongside.
  app.use("/api/email/unsubscribe", emailUnsubscribeRoutes);
  app.use("/api/email", emailWebhookRoutes);
  app.use("/api/entities", entitiesRoutes);
  app.use("/api/mattermost", mattermostRoutes);
  app.use("/api/openclaw", openclawRoutes);
  app.use("/api/billing", billingRoutes);
  app.use("/api/legal", legalAcceptRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/invites", inviteRoutes);
  app.use("/api/integrations", integrationRoutes);
  app.use("/api/connect", connectRoutes);
  app.use("/api/byosub", byosubRoutes);
  app.use("/api/discord", discordRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/profile", profileRoutes);
  app.use("/api/onboarding", onboardingRoutes);
  app.use("/api/posts", postsRoutes);
  app.use("/api/agents", agentRoutes);
  app.use("/api/builder", builderGatewaysRoutes);
  app.use("/api/shells", shellsRoutes);

  app.use("/internal/agents", agentRoutes);
  app.use("/internal/notifications", notificationRoutes);
  app.use("/internal/notifications", internalNotificationRoutes);
  app.use("/internal/engagement", internalEngagementRoutes);
  app.use("/internal/csi", internalCSIRoutes);
}
