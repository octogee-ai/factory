import { Express, RequestHandler, Router } from "express";

import mattermostRoutes from "./mattermost.js";
import openclawRoutes from "./openclaw.js";
import agentModelRoutes from "./agent-models.js";
import channelSessionModelRoutes from "./channel-session-models.js";
import billingRoutes from "./billing/index.js";
import modelCredentialRoutes from "./model-credentials.js";
import legalAcceptRoutes from "./legal/accept.js";
import adminRoutes from "./admin.js";
import inviteRoutes from "./invites.js";
import integrationRoutes from "./integrations.js";
import connectRoutes from "./connect.js";
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
import gatewayAccessRoutes from "./gateway-access.js";
import accessApprovalRoutes from "./access-approvals.js";
import productivityApprovalRoutes from "./productivity-approvals.js";
import shellsRoutes from "./shells.js";

import workspaceDisplayNameRoutes from "./workspace/display-name.js";
import workspaceFilesRoutes from "./workspace/files.js";
import workspaceIssuesRoutes from "./workspace/issues.js";
import workspacePulseRoutes from "./workspace/pulse.js";
import workspaceSaveRoutes from "./workspace/save.js";
import workspaceUploadRoutes from "./workspace/upload.js";
import workspaceDeleteBlobRoutes from "./workspace/delete-blob.js";
import workspaceExtractZipRoutes from "./workspace/extract-zip.js";
import workspaceImportRepoRoutes from "./workspace/import-repo.js";

import channelsRoutes from "./channels/index.js";

import projectsReadmeRoutes from "./projects/readme.js";
import projectsCreateRoutes from "./projects/create.js";
import projectsRetryRoutes from "./projects/retry.js";
import projectsJoinLeaveRoutes from "./projects/join-leave.js";
import projectsStarRoutes from "./projects/star.js";
import projectsMembersRoutes from "./projects/members.js";
import projectsDeleteRoutes from "./projects/delete.js";
import projectsAgentRoutes from "./projects/agent.js";
import projectsRepoSourceRoutes from "./projects/repo-source.js";
import projectsRecipeRoutes from "./projects/recipe.js";

import internalNotificationRoutes from "./internal/notifications.js";
import internalWorkspaceCommitRoutes from "./internal/workspace-commit.js";

import { requireAuth } from "../middleware/auth.js";

export interface MountClusterRoutesOpts {
  mmRestProxyHandler?: RequestHandler;
  mattermostMintRoutes?: Router;
  billingRoutes?: Router;
  builderGatewaysRoutes?: Router;
  sharingRoutes?: Router;
  projectsCreateRoutes?: Router;
  projectsRepoSourceRoutes?: Router;
  productivityApprovalRoutes?: Router;
}

type RouteHandler = RequestHandler | Router;

const WORKSPACE_ROUTES: readonly RouteHandler[] = [
  requireAuth,
  workspaceDisplayNameRoutes,
  workspaceFilesRoutes,
  workspaceIssuesRoutes,
  workspacePulseRoutes,
  workspaceSaveRoutes,
  workspaceUploadRoutes,
  workspaceDeleteBlobRoutes,
  workspaceExtractZipRoutes,
  workspaceImportRepoRoutes,
];

const CHANNEL_ROUTES: readonly RouteHandler[] = [requireAuth, channelsRoutes];

function projectRoutes(opts: MountClusterRoutesOpts): readonly RouteHandler[] {
  return [
    projectsReadmeRoutes,
    projectsDeleteRoutes,
    requireAuth,
    opts.projectsCreateRoutes ?? projectsCreateRoutes,
    projectsRetryRoutes,
    projectsJoinLeaveRoutes,
    projectsStarRoutes,
    projectsMembersRoutes,
    projectsAgentRoutes,
    opts.projectsRepoSourceRoutes ?? projectsRepoSourceRoutes,
    projectsRecipeRoutes,
  ];
}

const PUBLIC_API_ROUTES: readonly (readonly [string, RouteHandler])[] = [
  ["/api/auth/email", authEmailRoutes],
  ["/api/sharing", sharingRoutes],
  ["/api/email/unsubscribe", emailUnsubscribeRoutes],
  ["/api/email", emailWebhookRoutes],
  ["/api/entities", entitiesRoutes],
  ["/api/mattermost", mattermostRoutes],
  ["/api/openclaw", openclawRoutes],
  ["/api/agent-models", agentModelRoutes],
  ["/api/channel-session-models", channelSessionModelRoutes],
  ["/api/billing", billingRoutes],
  ["/api/model-credentials", modelCredentialRoutes],
  ["/api/legal", legalAcceptRoutes],
  ["/api/admin", adminRoutes],
  ["/api/invites", inviteRoutes],
  ["/api/integrations", integrationRoutes],
  ["/api/connect", connectRoutes],
  ["/api/notifications", notificationRoutes],
  ["/api/profile", profileRoutes],
  ["/api/onboarding", onboardingRoutes],
  ["/api/posts", postsRoutes],
  ["/api/agents", agentRoutes],
  ["/api/builder", builderGatewaysRoutes],
  ["/api/gateways", gatewayAccessRoutes],
  ["/api/access-approvals", accessApprovalRoutes],
  ["/api/productivity-approvals", productivityApprovalRoutes],
  ["/api/shells", shellsRoutes],
];

const INTERNAL_ROUTES: readonly (readonly [string, RouteHandler])[] = [
  ["/internal/agents", agentRoutes],
  ["/internal/notifications", notificationRoutes],
  ["/internal/notifications", internalNotificationRoutes],
  ["/internal/workspace", internalWorkspaceCommitRoutes],
];

export function mountClusterRoutes(app: Express, opts: MountClusterRoutesOpts = {}): void {
  if (opts.mmRestProxyHandler) {
    app.all("/api/v4/*splat", opts.mmRestProxyHandler);
  }

  mountGroup(app, "/api/workspace", WORKSPACE_ROUTES);
  mountGroup(app, "/api/channels", CHANNEL_ROUTES);
  mountGroup(app, "/api/projects", projectRoutes(opts));

  if (opts.mattermostMintRoutes) {
    app.use("/api/auth/mattermost", opts.mattermostMintRoutes);
  }

  // Raw-body endpoints under /api/email/* (the Resend webhook) MUST be listed
  // in RAW_BODY_WEBHOOK_PATHS (see body-parsers.ts) or signature verification
  // breaks. Non-raw-body sub-routes (e.g. urlencoded one-click unsubscribe)
  // fall through to normal parsing and are fine alongside.
  mountRouteTable(app, PUBLIC_API_ROUTES.map(([path, route]) => {
    if (path === "/api/billing") return [path, opts.billingRoutes ?? route] as const;
    if (path === "/api/builder") return [path, opts.builderGatewaysRoutes ?? route] as const;
    if (path === "/api/sharing") return [path, opts.sharingRoutes ?? route] as const;
    if (path === "/api/productivity-approvals") {
      return [path, opts.productivityApprovalRoutes ?? route] as const;
    }
    return [path, route] as const;
  }));
  mountRouteTable(app, INTERNAL_ROUTES);
}

function mountGroup(app: Express, path: string, routes: readonly RouteHandler[]): void {
  for (const route of routes) {
    app.use(path, route);
  }
}

function mountRouteTable(app: Express, routes: readonly (readonly [string, RouteHandler])[]): void {
  for (const [path, route] of routes) {
    app.use(path, route);
  }
}
