import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import { mintTicket } from "../lib/gateway-ticket.js";
import { isValidGatewayId } from "../../../shared/types/glm.js";

const router = Router();

router.post("/ticket", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;

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

function inferChannelKind(
  ref: unknown,
): "project" | "coach-dm" | "workspace" | "social" | "unknown" {
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
  if (lastTwo.startsWith("channels/")) return "workspace";
  return "unknown";
}

function extractRefPath(ref: unknown): string | null {
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
