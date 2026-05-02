/**
 * OpenClaw gateway routes — short-lived WS ticket minting.
 *
 * Mirrors the Mattermost ticket pattern (`mattermost.ts`). Called by the
 * browser over authenticated HTTP; returns a one-time ticket + the
 * chat-proxy WS URL. The client then opens
 * `wss://<chat-proxy>/api/openclaw/ws/<ticket>` and chat-proxy validates
 * the ticket, resolves the user's assigned gateway, and opens the
 * authenticated upstream.
 *
 * Ticket lifetime: 30s (same as MM). One-time use — chat-proxy deletes
 * the doc before forwarding the upgrade.
 */
import { Router, Request, Response, NextFunction } from "express";
import * as crypto from "crypto";
import { requireAuth } from "../middleware/auth";
import { db, FieldValue } from "../lib/db";

const router = Router();

const TICKET_TTL_MS = 30_000;

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

    const proxyUrl = process.env.CHAT_PROXY_URL || "";
    res.json({ wsTicket: ticket, proxyUrl });
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

function inferChannelKind(ref: unknown): "project" | "coach-dm" | "workspace" | "unknown" {
  // Walk the ref chain back to a path. ref.id is the channel doc id;
  // ref.parent.parent.id is the parent doc (project or workspace);
  // ref.parent.parent.parent.id tells us which collection holds the parent.
  const segments: string[] = [];
  let cur: any = ref;
  while (cur && typeof cur === "object") {
    if (typeof cur.id === "string") segments.unshift(cur.id);
    cur = cur.parent;
  }
  if (segments.includes("projects")) return "project";
  const lastTwo = segments.slice(-2).join("/");
  if (lastTwo === "channels/coach-dm") return "coach-dm";
  if (lastTwo.startsWith("channels/")) return "workspace";
  return "unknown";
}

export default router;
