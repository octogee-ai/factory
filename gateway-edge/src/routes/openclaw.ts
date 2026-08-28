import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../middleware/logging.js";
import { db } from "../lib/db.js";
import { mintTicket } from "../lib/gateway-ticket.js";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { resolveBuilderTier } from "@octogee/shared/types/billing";
import { BUILDER_TIERS } from "@octogee/shared/types/billing-tiers";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import {
  requestBuilderActivationLease,
  type BuilderActivationLeaseResult,
  type BuilderRuntimeDemandCause,
} from "@octogee/core/builder-activation-lease";

const router = Router();

export type ActivityHistoryMode = "channel" | "run-threads";

export interface ActivityHistoryTarget {
  activityChannelId: string;
  historyMode: "run-threads";
  legacyActivityChannelId?: string;
}

export function resolveActivityHistoryTarget(
  data: Record<string, unknown>,
  requestedChannelId: string,
): ActivityHistoryTarget | null {
  const mattermost = (data.mattermost ?? {}) as {
    channelId?: unknown;
    activityChannelId?: unknown;
  };
  const primaryChannelId = typeof mattermost.channelId === "string" ? mattermost.channelId : "";
  const activityChannelId =
    typeof mattermost.activityChannelId === "string" ? mattermost.activityChannelId : "";
  return requestedChannelId === primaryChannelId && primaryChannelId
    ? {
        activityChannelId: primaryChannelId,
        historyMode: "run-threads",
        ...(activityChannelId && activityChannelId !== primaryChannelId
          ? { legacyActivityChannelId: activityChannelId }
          : {}),
      }
    : null;
}

function activationGatewayId(
  userData: Record<string, unknown> | undefined,
): string | null {
  if (!userData || !accountAllowsInteractiveAccess(userData)) return null;
  const builderTier = resolveBuilderTier(userData);
  if (!builderTier || BUILDER_TIERS[builderTier].instance === null) return null;
  const provisioning = userData.provisioning as
    | { openclaw?: { gatewayId?: unknown; slug?: unknown } }
    | undefined;
  const hasSlug =
    typeof provisioning?.openclaw?.slug === "string" ||
    typeof userData.username === "string";
  return hasSlug && isValidGatewayId(provisioning?.openclaw?.gatewayId)
    ? provisioning.openclaw.gatewayId
    : null;
}

async function requestRuntimeDemand(input: {
  uid: string;
  userData: Record<string, unknown> | undefined;
  cause: BuilderRuntimeDemandCause;
  eventKey: string;
  createdBy: string;
}): Promise<BuilderActivationLeaseResult | null> {
  const reportingGatewayId = activationGatewayId(input.userData);
  if (!reportingGatewayId) return null;
  const assignmentSnap = await db.doc(
    `gateways/${reportingGatewayId}/assignments/${input.uid}`,
  ).get();
  const assignmentData = assignmentSnap.exists
    ? assignmentSnap.data() as Record<string, unknown>
    : undefined;
  return requestBuilderActivationLease({
    db,
    uid: input.uid,
    reportingGatewayId,
    assignmentEpoch:
      typeof assignmentData?.epoch === "number"
        ? assignmentData.epoch
        : undefined,
    eventKey: input.eventKey,
    cause: input.cause,
    observedAt: Date.now(),
    createdBy: input.createdBy,
  });
}

async function maybeRequestActivationBeforeTicket(
  uid: string,
  userData: Record<string, unknown> | undefined,
): Promise<void> {
  try {
    const result = await requestRuntimeDemand({
      uid,
      userData,
      cause: "ticket",
      eventKey: `ticket:${randomUUID()}`,
      createdBy: `openclaw-ticket:${uid}`,
    });
    if (result && result.statusCode !== 200 && result.statusCode !== 202) {
      logger.warn("[openclaw-ticket] disposable activation rejected", {
        uid,
        statusCode: result.statusCode,
        code: result.body.code,
      });
    }
  } catch (error) {
    logger.warn("[openclaw-ticket] disposable activation unavailable", {
      uid,
      error,
    });
  }
}

router.post("/ticket", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;

    if ((req.body as { anticipate?: unknown } | undefined)?.anticipate === true) {
      await maybeRequestActivationBeforeTicket(uid, req.user);
    }

    const provisioning = req.user?.provisioning as { openclaw?: { gatewayId?: unknown } } | undefined;
    const rawGatewayId = provisioning?.openclaw?.gatewayId;
    const gatewayId =
      isValidGatewayId(rawGatewayId)
        ? rawGatewayId
        : "";

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

router.get(
  "/channels/:channelId/activity-history",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const channelId = typeof req.params.channelId === "string" ? req.params.channelId : "";
      if (!channelId) {
        res.status(400).json({ error: "channelId required" });
        return;
      }

      const queryFields = ["mattermost.channelId"] as const;
      const selectedFields = ["mattermost.channelId", "mattermost.activityChannelId"] as const;
      let matched: { ref: unknown; data: Record<string, unknown> } | null = null;
      for (const field of queryFields) {
        const snap = await db
          .collectionGroup("channels")
          .where(field, "==", channelId)
          .select(...selectedFields)
          .get();
        if (snap.docs.length > 0) {
          const doc = snap.docs[0];
          matched = { ref: (doc as { ref: unknown }).ref, data: doc.data() ?? {} };
          break;
        }
      }
      if (!matched) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const historyTarget = resolveActivityHistoryTarget(matched.data, channelId);
      if (!historyTarget) {
        res.status(404).json({ error: "activity_history_unavailable" });
        return;
      }

      const channelPath = extractRefPath(matched.ref);
      const channelKind = inferChannelKind(matched.ref);
      if (!isLiveActivityChannelKind(channelKind)) {
        res.status(404).json({ error: "not_live_activity_channel", channelKind });
        return;
      }
      if (channelKind === "workspace-admin" && req.isAdmin !== true) {
        res.status(403).json({ error: "admin_access_required" });
        return;
      }
      res.json({
        ...historyTarget,
        channelKind,
        channelPath,
      });
    } catch (e) {
      next(e);
    }
  },
);

export type OpenClawActivityChannelKind =
  | "project"
  | "coach-dm"
  | "workspace"
  | "workspace-admin"
  | "social"
  | "unknown";

export function inferChannelKind(
  ref: unknown,
): OpenClawActivityChannelKind {
  const segments: string[] = [];
  let cur: unknown = ref;
  while (cur && typeof cur === "object") {
    const node = cur as { id?: unknown; parent?: unknown };
    if (typeof node.id === "string") segments.unshift(node.id);
    cur = node.parent;
  }

  if (segments[0] === "community") return "social";
  if (segments.includes("projects")) return "project";
  const lastTwo = segments.slice(-2).join("/");
  if (lastTwo === "channels/coach-dm") return "coach-dm";
  if (lastTwo === "channels/admin") return "workspace-admin";
  if (lastTwo.startsWith("channels/")) return "workspace";
  return "unknown";
}

export function isLiveActivityChannelKind(kind: OpenClawActivityChannelKind): boolean {
  return kind === "coach-dm"
    || kind === "workspace-admin"
    || kind === "workspace"
    || kind === "project";
}

export function extractRefPath(ref: unknown): string | null {
  if (!ref || typeof ref !== "object") return null;
  const direct = (ref as { path?: unknown }).path;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const segments: string[] = [];
  let cur: unknown = ref;
  while (cur && typeof cur === "object") {
    const node = cur as { id?: unknown; parent?: unknown };
    if (typeof node.id === "string" && node.id.length > 0) {
      segments.unshift(node.id);
    }
    cur = node.parent;
  }
  return segments.length > 0 ? segments.join("/") : null;
}

export default router;
