import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import { mintTicket } from "../lib/gateway-ticket.js";

const router = Router();

const GATEWAY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

router.post("/ticket", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;

    const provisioning = req.user?.provisioning as { openclaw?: { gatewayId?: unknown } } | undefined;
    const rawGatewayId = provisioning?.openclaw?.gatewayId;
    const gatewayId =
      typeof rawGatewayId === "string" && GATEWAY_ID_PATTERN.test(rawGatewayId)
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

const channelKind = inferChannelKind(matched.ref);
      res.json({
        activityChannelId,
        channelKind,
      });
    } catch (e) {
      next(e);
    }
  },
);

function inferChannelKind(
  ref: unknown,
): "project" | "coach-dm" | "workspace" | "social" | "unknown" {

const segments: string[] = [];
  let cur: any = ref;
  while (cur && typeof cur === "object") {
    if (typeof cur.id === "string") segments.unshift(cur.id);
    cur = cur.parent;
  }

if (segments[0] === "community") return "social";
  if (segments.includes("projects")) return "project";
  const lastTwo = segments.slice(-2).join("/");
  if (lastTwo === "channels/coach-dm") return "coach-dm";
  if (lastTwo.startsWith("channels/")) return "workspace";
  return "unknown";
}

export default router;
