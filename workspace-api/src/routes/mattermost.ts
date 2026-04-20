/**
 * Mattermost routes — token exchange, admin token, channel invites.
 * Migrated from functions/src/mattermost/{token,adminToken,invite}.ts
 */
import { Router, Request, Response, NextFunction } from "express";
import * as crypto from "crypto";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { db, FieldValue, Timestamp } from "../lib/db";
import { getWorkspaceMmContext } from "../lib/mattermost-context";

const router = Router();

// ── GET /token — user MM credentials ──────────────────────────────────────

router.get("/token", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const userData = req.user!;

    const ctx = await getWorkspaceMmContext(uid, undefined, userData);
    const mmUserId = ctx?.userId;
    const dmChannelId = ctx?.coachDmChannelId;

    if (!mmUserId || !dmChannelId) {
      res.status(202).json({
        status: "provisioning",
        message: "Chat is being set up. Please try again in a few seconds.",
      });
      return;
    }

    const secretDoc = await db.doc(`users/${uid}/secrets/mattermost`).get();
    const hasToken = secretDoc.exists && !!secretDoc.data()?.personalToken;

    if (!hasToken) {
      res.status(202).json({
        status: "provisioning",
        message: "Chat credentials are being set up.",
      });
      return;
    }

    const ticket = crypto.randomUUID();
    await db.doc(`wsTickets/${ticket}`).set({
      uid,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Date.now() + 30_000,
    });

    const proxyUrl = process.env.CHAT_PROXY_URL || "";
    const coachMmUserId = ctx.coachUserId || null;
    const coachName = userData.onboarding?.coachName || null;

    res.json({ mmUserId, dmChannelId, proxyUrl, wsTicket: ticket, coachMmUserId, coachName });
  } catch (e) { next(e); }
});

// ── GET /admin-token — admin MM credentials ───────────────────────────────

router.get("/admin-token", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;

    const personalToken = process.env.MM_ADMIN_TOKEN;
    if (!personalToken) {
      res.status(503).json({
        status: "unavailable",
        message: "Admin chat credentials not configured.",
      });
      return;
    }

    const adminDoc = await db.doc("system/mattermostAdmin").get();
    const adminData = adminDoc.data() ?? {};
    const mmUserId = adminData.userId;
    const proxyUrl = adminData.proxyUrl || process.env.CHAT_PROXY_URL || "";

    if (!mmUserId) {
      res.status(503).json({
        status: "unavailable",
        message: "Admin chat credentials incomplete.",
      });
      return;
    }

    const ticket = crypto.randomUUID();
    await db.doc(`wsTickets/${ticket}`).set({
      uid,
      isAdminTicket: true,
      adminMmUserId: mmUserId,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Date.now() + 30_000,
    });

    res.json({ mmUserId, dmChannelId: "", proxyUrl, wsTicket: ticket });
  } catch (e) { next(e); }
});

// ── POST /invite — invite user to channel by email ────────────────────────

router.post("/invite", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const callerUid = req.uid!;
    const callerData = req.user!;
    const { channelId, email } = req.body ?? {};

    if (!channelId || !email) {
      res.status(400).json({ error: "channelId and email are required" });
      return;
    }

    if (!callerData.mattermost?.userId) {
      res.status(403).json({ error: "You don't have chat access" });
      return;
    }

    const callerCtx = await getWorkspaceMmContext(callerUid, undefined, callerData);
    const callerChannelId = callerCtx?.coachDmChannelId;
    if (callerChannelId && callerChannelId !== channelId) {
      res.status(403).json({ error: "You can only invite to your own channel" });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const inviteeSnap = await db.collection("users").where("email", "==", normalizedEmail).limit(1).get();

    if (inviteeSnap.empty) {
      res.status(404).json({ error: "No Octogee user found with that email" });
      return;
    }

    const inviteeDoc = inviteeSnap.docs[0];
    const inviteeData = inviteeDoc.data();
    if (!inviteeData.mattermost?.userId) {
      res.status(400).json({ error: "That user's workspace isn't set up yet" });
      return;
    }

    // Check for duplicate
    const existing = await db.collection("invites")
      .where("channelId", "==", channelId)
      .where("inviteeUid", "==", inviteeDoc.id)
      .where("status", "in", ["pending", "completed"])
      .limit(1).get();

    if (!existing.empty) {
      const existingData = existing.docs[0].data();
      if (existingData.status === "completed") {
        res.json({ message: `${inviteeData.firstName || normalizedEmail} is already in this channel` });
      } else {
        res.json({ message: "Invite is being processed...", inviteId: existing.docs[0].id });
      }
      return;
    }

    const inviteRef = await db.collection("invites").add({
      callerUid,
      callerEmail: callerData.email || "",
      callerFirstName: callerData.firstName || "",
      inviteeUid: inviteeDoc.id,
      inviteeEmail: normalizedEmail,
      inviteeFirstName: inviteeData.firstName || "",
      inviteeMmUserId: inviteeData.mattermost.userId,
      channelId,
      status: "pending",
      error: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    res.json({
      message: `Inviting ${inviteeData.firstName || normalizedEmail}...`,
      inviteId: inviteRef.id,
    });
  } catch (e) { next(e); }
});

// ── GET /invite-status — poll invite status ───────────────────────────────

router.get("/invite-status", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const inviteId = req.query.inviteId as string;
    if (!inviteId) { res.status(400).json({ error: "inviteId is required" }); return; }

    const doc = await db.doc(`invites/${inviteId}`).get();
    if (!doc.exists) { res.status(404).json({ error: "Invite not found" }); return; }

    const data = doc.data()!;
    res.json({
      status: data.status,
      message: data.status === "completed"
        ? `${data.inviteeFirstName || data.inviteeEmail} has been added!`
        : data.status === "failed"
          ? data.error || "Invite failed"
          : "Processing...",
    });
  } catch (e) { next(e); }
});

// ── POST /invite-link — create shareable invite link ──────────────────────

router.post("/invite-link", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const callerUid = req.uid!;
    const callerData = req.user!;
    const { channelId, expiresInHours } = req.body ?? {};

    if (!channelId) { res.status(400).json({ error: "channelId is required" }); return; }

    if (!callerData.mattermost?.userId) {
      res.status(403).json({ error: "You don't have chat access" });
      return;
    }

    const callerCtx = await getWorkspaceMmContext(callerUid, undefined, callerData);
    const callerChannels = [callerCtx?.coachDmChannelId, callerCtx?.generalChannelId].filter(Boolean);
    if (callerChannels.length > 0 && !callerChannels.includes(channelId)) {
      res.status(403).json({ error: "You can only create invite links for your own channels" });
      return;
    }

    const token = crypto.randomUUID();
    const hours = typeof expiresInHours === "number" && expiresInHours > 0 ? expiresInHours : 72;
    const expiresAt = Timestamp.fromDate(new Date(Date.now() + hours * 60 * 60 * 1000));

    await db.doc(`channelInvites/${token}`).set({
      channelId,
      createdBy: callerUid,
      expiresAt,
      uses: 0,
      maxUses: 0,
      createdAt: FieldValue.serverTimestamp(),
    });

    const siteBase = process.env.SITE_URL || "https://octogee.web.app";
    res.json({
      inviteUrl: `${siteBase}/invite/${token}`,
      token,
      expiresAt: expiresAt.toDate().toISOString(),
    });
  } catch (e) { next(e); }
});

// ── POST /accept-invite-link — join channel via invite link ───────────────

router.post("/accept-invite-link", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const callerUid = req.uid!;
    const callerData = req.user!;
    const { token } = req.body ?? {};

    if (!token) { res.status(400).json({ error: "token is required" }); return; }

    const linkDoc = await db.doc(`channelInvites/${token}`).get();
    if (!linkDoc.exists) { res.status(404).json({ error: "Invite link not found" }); return; }

    const linkData = linkDoc.data()!;
    const expiresAt = linkData.expiresAt?.toDate?.() ?? new Date(0);
    if (Date.now() > expiresAt.getTime()) {
      res.status(410).json({ error: "This invite link has expired" });
      return;
    }
    if (linkData.maxUses > 0 && linkData.uses >= linkData.maxUses) {
      res.status(410).json({ error: "This invite link has reached its usage limit" });
      return;
    }

    if (!callerData.mattermost?.userId) {
      res.status(400).json({ error: "You need to complete onboarding before joining a channel" });
      return;
    }

    const channelId = linkData.channelId;

    const existing = await db.collection("invites")
      .where("channelId", "==", channelId)
      .where("inviteeUid", "==", callerUid)
      .where("status", "in", ["pending", "completed"])
      .limit(1).get();

    if (!existing.empty) {
      const existingData = existing.docs[0].data();
      res.json({
        inviteId: existing.docs[0].id,
        channelId,
        message: existingData.status === "completed" ? "You're already in this channel" : "Joining channel...",
      });
      return;
    }

    const inviteRef = await db.collection("invites").add({
      callerUid: linkData.createdBy,
      callerEmail: "",
      callerFirstName: "",
      inviteeUid: callerUid,
      inviteeEmail: callerData.email || "",
      inviteeFirstName: callerData.firstName || "",
      inviteeMmUserId: callerData.mattermost.userId,
      channelId,
      status: "pending",
      error: null,
      inviteLinkToken: token,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await db.doc(`channelInvites/${token}`).update({ uses: FieldValue.increment(1) });

    res.json({ inviteId: inviteRef.id, channelId, message: "Joining channel..." });
  } catch (e) { next(e); }
});

export default router;
