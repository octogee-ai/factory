import { Router, Request, Response, NextFunction } from "express";
import * as crypto from "crypto";
import { requireAuth } from "../middleware/auth";
import { db, FieldValue } from "../lib/db";

const router = Router();

const TICKET_TTL_MS = 30_000;

// Canonical gatewayId shape, matches chat-proxy/src/openclaw/bridge-gateway-id.ts
// and chat-proxy/src/gateway-prefix.ts. A malformed value on the user doc is
// treated as "no provisioning" so the browser falls back to the bare path
// rather than constructing a URL that the fleet ingress can't route.
const GATEWAY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

// ── POST /ticket — mint an OC WS ticket ─────────────────────────────────────

router.post("/ticket", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;

    const ticket = crypto.randomUUID();
    await db.doc(`ocTickets/${ticket}`).set({
      uid,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Date.now() + TICKET_TTL_MS,
    });

    // Return the user's gatewayId so the browser constructs the
    // gateway-scoped WS URL (`<proxyUrl>/g/<gatewayId>/api/openclaw/ws/<ticket>`).
    // chat-proxy-fleet-ingress (chat.octogee.com) routes `/g/<gw>/*` to
    // the per-instance chat-proxy Service so the request lands in the
    // gateway's own pod and the chat-proxy bridges upstream same-pod.
    // Empty when the user has no openclaw provisioning yet — the browser
    // falls back to the bare `/api/openclaw/ws/<ticket>` path (legacy
    // single-pod default-gateway route still works during migration).
    //
    // Source: req.user is already populated by requireAuth (see
    // workspace-api/src/middleware/auth.ts) — no second Firestore read.
    const provisioning = req.user?.provisioning as { openclaw?: { gatewayId?: unknown } } | undefined;
    const rawGatewayId = provisioning?.openclaw?.gatewayId;
    const gatewayId =
      typeof rawGatewayId === "string" && GATEWAY_ID_PATTERN.test(rawGatewayId)
        ? rawGatewayId
        : "";

    const proxyUrl = process.env.CHAT_PROXY_URL || "";
    res.json({ wsTicket: ticket, proxyUrl, gatewayId });
  } catch (e) {
    next(e);
  }
});

// ── GET /channels/:channelId/activity-pair ─────────────────────────────────
//
// PWA discovery endpoint for the Activity Stream (spec §6.5 / §10 Phase 2).
// Given a primary OR activity channelId, return the pair info so the PWA's
// useActivityChannel hook can fetch from the activity sibling.
//
// Lookup: collectionGroup("channels") matched by either
// `mattermost.channelId === id` or `mattermost.activityChannelId === id`.
//
// 404 hides existence rather than confirming "the channel exists but you
// can't see it" — non-members see the same response as if the channel
// didn't exist at all. The PWA already gates feature visibility on MM
// channel membership upstream.
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
      // Try both the primary and activity channelId fields. Existing pairs
      // are queryable on either.
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
        // Channel exists but doesn't have a paired sibling yet (legacy
        // pre-Phase-1 channel). Fail-closed 404 is honest: PWA renders
        // "Waiting for activity stream..." instead of trying to fetch
        // posts from an empty/non-existent channel.
        res.status(404).json({ error: "not_paired_yet" });
        return;
      }
      // Channel kind is derivable from the doc-path shape:
      //   workspaces/{slug}/projects/{p}/channels/{c}  → "project"
      //   workspaces/{slug}/channels/coach-dm           → "coach-dm"
      //   workspaces/{slug}/channels/general|admin     → "workspace"
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
  // Walk the ref chain back to a path. ref.id is the channel doc id;
  // ref.parent.parent.id is the parent doc (project or workspace);
  // ref.parent.parent.parent.id tells us which collection holds the parent.
  const segments: string[] = [];
  let cur: any = ref;
  while (cur && typeof cur === "object") {
    if (typeof cur.id === "string") segments.unshift(cur.id);
    cur = cur.parent;
  }
  // Builder Social channels live at `community/main/channels/{name}` —
  // detect via the top-level `community` segment so they're not
  // mis-tagged as workspace-kind (their visibility default is off, not
  // on, per spec §G.S).
  if (segments[0] === "community") return "social";
  if (segments.includes("projects")) return "project";
  const lastTwo = segments.slice(-2).join("/");
  if (lastTwo === "channels/coach-dm") return "coach-dm";
  if (lastTwo.startsWith("channels/")) return "workspace";
  return "unknown";
}

export default router;
