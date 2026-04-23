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

export default router;
