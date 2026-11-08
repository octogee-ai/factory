import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import { platformStateStore, readBuilderTier } from "../lib/platform-state.js";
import { mintTicket } from "../lib/gateway-ticket.js";
import { resolveActivityConversation } from "../lib/activity-conversation.js";
import { isMattermostPostId } from '@octogee/shared/types/mattermost-session-route';
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import {
  requestBuilderActivationLease,
  recordBuilderRuntimeActivity,
  type BuilderActivationLeaseResult,
  type BuilderRuntimeDemandCause,
} from "@octogee/core/builder-activation-lease";

const router = Router();

router.post("/runtime-activity", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !isValidGatewayId(body.gatewayId)) {
      res.status(400).json({ error: "gatewayId is required" });
      return;
    }
    const recorded = await recordBuilderRuntimeActivity({
      store: platformStateStore,
      readBuilderTier,
      uid: req.uid!,
      gatewayId: body.gatewayId,
    });
    res.json({ recorded });
  } catch (error) { next(error); }
});

async function activationGatewayId(
  uid: string,
  userData: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!userData) return null;
  const builderTier = userEntitlements().sizingKey(userData);
  if (!builderTier) return null;
  const sizingProfile = await platformStateStore.config.orchestrator.getSizingProfile(builderTier);
  if (sizingProfile.isolation !== "isolated") return null;
  const builder = await platformStateStore.builders.records.get(uid);
  if (!builder || !accountAllowsInteractiveAccess({ accountLifecycle: builder.accountLifecycle ?? undefined })) {
    return null;
  }
  const gatewayId = builder.gateway?.gatewayId;
  return builder.slug !== null && isValidGatewayId(gatewayId) ? gatewayId : null;
}

async function requestRuntimeDemand(input: {
  uid: string;
  userData: Record<string, unknown> | undefined;
  cause: BuilderRuntimeDemandCause;
  eventKey: string;
  createdBy: string;
}): Promise<BuilderActivationLeaseResult | null> {
  const reportingGatewayId = await activationGatewayId(input.uid, input.userData);
  if (!reportingGatewayId) return null;
  const assignment = await platformStateStore.gateways.assignments.get(reportingGatewayId, input.uid);
  return requestBuilderActivationLease({
    store: platformStateStore,
    readBuilderTier,
    uid: input.uid,
    reportingGatewayId,
    assignmentEpoch: assignment?.epoch,
    eventKey: input.eventKey,
    cause: input.cause,
    observedAt: Date.now(),
    createdBy: input.createdBy,
  });
}

function isMattermostActivitySelection(value: unknown): value is { channelId: string; threadRootPostId?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).every(key => key === 'channelId' || key === 'threadRootPostId')
    && isMattermostPostId(body.channelId) && (body.threadRootPostId === undefined || isMattermostPostId(body.threadRootPostId));
}

router.post("/ticket", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    if (req.body && Object.keys(req.body).length) {
      if (!isMattermostActivitySelection(req.body)) {
        res.status(400).json({ error: 'invalid_activity_channel' }); return;
      }
      const scope = await resolveActivityConversation({ db, uid, ...req.body });
      if (!scope) { res.status(403).json({ error: 'activity_channel_forbidden' }); return; }
      const { gatewayId, ...payload } = scope;
      const ticket = await mintTicket({ uid, gatewayId, purpose: 'openclaw-ws', payload });
      res.set('Cache-Control', 'no-store').json({ wsTicket: ticket.ticket, proxyUrl: process.env.API_PUBLIC_URL || '', gatewayId, sessionKey: scope.sessionKey });
      return;
    }
    const rawGatewayId = (await platformStateStore.builders.records.get(uid))?.gateway?.gatewayId;
    const gatewayId = isValidGatewayId(rawGatewayId) ? rawGatewayId : "";

    const t = await mintTicket({ uid, gatewayId, purpose: "openclaw-ws" });

    const proxyUrl = process.env.API_PUBLIC_URL || "";
    res.json({ wsTicket: t.ticket, proxyUrl, gatewayId });
  } catch (e) {
    next(e);
  }
});

// The sleep-warning modal's "I'm still here" ack. Manual demand resets the
// disposable idle clock on an active lease and summons the runtime from
// parked/returning — same lease semantics as any other intent signal.
router.post(
  "/runtime-keepalive",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.uid!;
      const result = await requestRuntimeDemand({
        uid,
        userData: req.user,
        cause: "manual",
        eventKey: `keepalive:${randomUUID()}`,
        createdBy: `runtime-keepalive:${uid}`,
      });
      if (!result) {
        res.json({ recorded: false });
        return;
      }
      const recorded = result.statusCode === 200 || result.statusCode === 202;
      res.json({
        recorded,
        ...(typeof result.body.status === "string" ? { status: result.body.status } : {}),
        ...(recorded || typeof result.body.code !== "string" ? {} : { code: result.body.code }),
      });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
