import { Router, type Request, type Response } from "express";
import type { Firestore } from "firebase-admin/firestore";

import { slugFromAssignedUser } from "@octogee/core/assigned-roster";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { isValidUsername } from "@octogee/shared/types/identity";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
const MATTERMOST_ID = /^[a-z0-9]{26}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  const body = record(req.body);
  if (
    !bound ||
    bound.kind !== "gateway" ||
    !body ||
    Object.keys(body).length !== 1 ||
    !isValidGatewayId(body.gatewayId) ||
    body.gatewayId !== bound.gatewayId
  ) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function safeUid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("/");
}

function authorizationContext(
  req: Request,
  res: Response,
): { bound: GatewayBinding; uid: string } | null {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  if (!safeUid(req.uid)) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }
  if (bound.ownerUid && bound.ownerUid !== req.uid) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { bound, uid: req.uid };
}

async function assignedOwnerSlug(
  db: Firestore,
  uid: string,
  gatewayId: string,
): Promise<{ slug: string | null; active: boolean }> {
  const userSnap = await db.doc(`users/${uid}`).get();
  const user = userSnap.exists ? userSnap.data() : undefined;
  if (!accountAllowsInteractiveAccess(user)) return { slug: null, active: false };
  const slug = slugFromAssignedUser(user);
  const provisioning = user?.provisioning as Record<string, unknown> | undefined;
  const openclaw = provisioning?.openclaw as Record<string, unknown> | undefined;
  if (!slug || !isValidUsername(slug) || openclaw?.gatewayId !== gatewayId) {
    return { slug: null, active: true };
  }
  return { slug, active: true };
}

async function isWorkspaceOwner(db: Firestore, slug: string, uid: string): Promise<boolean> {
  const workspaceSnap = await db.doc(`workspaces/${slug}`).get();
  return workspaceSnap.exists && workspaceSnap.data()?.ownerUid === uid;
}

async function coachChannelId(db: Firestore, slug: string): Promise<string | null> {
  const channelSnap = await db.doc(`workspaces/${slug}/channels/coach-dm`).get();
  const mattermost = record(channelSnap.data()?.mattermost);
  const channelId = mattermost?.channelId;
  return typeof channelId === "string" && MATTERMOST_ID.test(channelId) ? channelId : null;
}

async function authorizeRequest(req: Request, res: Response, db: Firestore): Promise<void> {
  const context = authorizationContext(req, res);
  if (!context) return;
  const assignment = await assignedOwnerSlug(db, context.uid, context.bound.gatewayId);
  if (!assignment.active) {
    res.status(403).json(FORBIDDEN);
    return;
  }
  const { slug } = assignment;
  if (!slug) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!await isWorkspaceOwner(db, slug, context.uid)) {
    res.status(403).json(FORBIDDEN);
    return;
  }
  const authorizedCoachChannelId = await coachChannelId(db, slug);
  if (!authorizedCoachChannelId) {
    res.status(409).json({ error: "coach_channel_not_ready" });
    return;
  }
  res.json({
    slug,
    gatewayId: context.bound.gatewayId,
    coachChannelId: authorizedCoachChannelId,
  });
}

export function createAutomationAuthorizationBrokerRoutes(opts: { db: Firestore }): Router {
  const router = Router();

  router.post("/authorize", async (req, res, next) => {
    try {
      await authorizeRequest(req, res, opts.db);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
