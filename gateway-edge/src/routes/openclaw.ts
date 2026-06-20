import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import { mintTicket } from "../lib/gateway-ticket.js";
import { isValidGatewayId } from "../../../shared/types/glm.js";
import {
  activationLeaseMissCanMintTicket,
  requestBuilderActivationLease,
} from "../../../scripts/lib/builder-activation-lease.js";

const router = Router();

function workspaceSlugsForUser(data: { username?: string | null }): string[] {
  return typeof data.username === "string" && data.username.length > 0
    ? [data.username]
    : [];
}

async function maybeRequestActivationBeforeTicket(
  uid: string,
  userData: Record<string, unknown> | undefined,
): Promise<{ statusCode: number; body: Record<string, unknown> } | null> {
  if (userData?.approved !== true) return null;
  const result = await requestBuilderActivationLease({
    db,
    uid,
    createdBy: `openclaw-ticket:${uid}`,
    reason: "openclaw-ticket",
    workspaceSlugsForUser,
  });
  if (result.statusCode === 202) {
    return {
      statusCode: 202,
      body: { ...result.body, openclawTicketDeferred: true },
    };
  }
  if (result.statusCode === 200 || activationLeaseMissCanMintTicket(result)) {
    return null;
  }
  return result;
}

router.post("/ticket", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;

    const activation = await maybeRequestActivationBeforeTicket(uid, req.user);
    if (activation) {
      res.status(activation.statusCode).json(activation.body);
      return;
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

router.get(
  "/channels/:channelId/activity-pair",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const channelId = req.params.channelId;
      if (!channelId) {
        res.status(400).json({ error: "channelId required" });
        return;
      }

      const fields = ["mattermost.channelId", "mattermost.activityChannelId"] as const;
      let matched: { ref: unknown; data: Record<string, unknown> } | null = null;
      for (const field of fields) {
        const snap = await db
          .collectionGroup("channels")
          .where(field, "==", channelId)
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
      const mm = (matched.data.mattermost ?? {}) as {
        channelId?: unknown;
        activityChannelId?: unknown;
      };
      const activityChannelId =
        typeof mm.activityChannelId === "string" ? mm.activityChannelId : "";
      if (!activityChannelId) {
        res.status(404).json({ error: "not_paired_yet" });
        return;
      }

      const channelPath = extractRefPath(matched.ref);
      const channelKind = inferChannelKind(matched.ref);
      if (!isLiveActivityChannelKind(channelKind)) {
        res.status(404).json({ error: "not_live_activity_channel", channelKind });
        return;
      }
      res.json({
        activityChannelId,
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
  return kind === "coach-dm" || kind === "workspace" || kind === "project";
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
