import { Router, Request, Response, NextFunction } from "express";
import * as crypto from "crypto";
import { requireAuth } from "../middleware/auth.js";
import { db, FieldValue, Timestamp } from "../lib/db.js";
import { getWorkspaceMmContext } from "../lib/mattermost-context.js";

const router = Router();

const GATEWAY_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function extractValidGatewayId(user: { provisioning?: unknown }): string {
  const provisioning = user.provisioning as { openclaw?: { gatewayId?: unknown } } | undefined;
  const raw = provisioning?.openclaw?.gatewayId;
  return typeof raw === "string" && GATEWAY_ID_RE.test(raw) ? raw : "";
}

function inviteStatusMessage(data: {
  status?: string;
  inviteeFirstName?: string;
  inviteeEmail?: string;
  error?: string;
}): string {
  if (data.status === "completed") return `${data.inviteeFirstName || data.inviteeEmail} has been added!`;
  if (data.status === "failed") return data.error || "Invite failed";
  return "Processing...";
}

type InviteeResolution =
  | { ok: false; status: number; error: string }
  | { ok: true; id: string; firstName: string; mmUserId: string; normalizedEmail: string };

// Resolve an invitee by email. `firstName` mirrors the stored doc value
// (`firstName || ""`); message sites apply the `|| normalizedEmail` fallback.
async function resolveInviteeByEmail(email: string): Promise<InviteeResolution> {
  const normalizedEmail = email.toLowerCase().trim();
  const snap = await db.collection("users").where("email", "==", normalizedEmail).limit(1).get();
  if (snap.empty) return { ok: false, status: 404, error: "No Octogee user found with that email" };
  const data = snap.docs[0].data();
  if (!data.mattermost?.userId) return { ok: false, status: 400, error: "That user's workspace isn't set up yet" };
  return {
    ok: true,
    id: snap.docs[0].id,
    firstName: data.firstName || "",
    mmUserId: data.mattermost.userId,
    normalizedEmail,
  };
}

function existingInviteResponse(
  existing: { id: string; data: Record<string, unknown> },
  inviteeName: string,
): { message: string; inviteId?: string } {
  if (existing.data.status === "completed") return { message: `${inviteeName} is already in this channel` };
  return { message: "Invite is being processed...", inviteId: existing.id };
}

async function findExistingInvite(
  channelId: string,
  inviteeUid: string,
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const existing = await db.collection("invites")
    .where("channelId", "==", channelId)
    .where("inviteeUid", "==", inviteeUid)
    .where("status", "in", ["pending", "completed"])
    .limit(1).get();
  if (existing.empty) return null;
  return { id: existing.docs[0].id, data: existing.docs[0].data() };
}

// Link-state validation (expiry + usage cap). The caller-onboarding check
// stays inline in the handler so TS narrows callerData.mattermost afterwards.
function validateInviteLink(linkData: {
  expiresAt?: { toDate?: () => Date };
  maxUses?: number;
  uses?: number;
}): { status: number; error: string } | null {
  const expiresAt = linkData.expiresAt?.toDate?.() ?? new Date(0);
  if (Date.now() > expiresAt.getTime()) return { status: 410, error: "This invite link has expired" };
  if ((linkData.maxUses ?? 0) > 0 && (linkData.uses ?? 0) >= (linkData.maxUses ?? 0)) {
    return { status: 410, error: "This invite link has reached its usage limit" };
  }
  return null;
}

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

    const proxyUrl = process.env.API_PUBLIC_URL || "";
    const coachMmUserId = ctx.coachUserId || null;
    const coachName = userData.onboarding?.coachName || null;
    const gatewayId = extractValidGatewayId(userData);

    res.json({ mmUserId, dmChannelId, proxyUrl, gatewayId, coachMmUserId, coachName });
  } catch (e) { next(e); }
});

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

    const invitee = await resolveInviteeByEmail(email);
    if (!invitee.ok) {
      res.status(invitee.status).json({ error: invitee.error });
      return;
    }
    const inviteeName = invitee.firstName || invitee.normalizedEmail;

    const existing = await findExistingInvite(channelId, invitee.id);
    if (existing) {
      res.json(existingInviteResponse(existing, inviteeName));
      return;
    }

    const inviteRef = await db.collection("invites").add({
      callerUid,
      callerEmail: callerData.email || "",
      callerFirstName: callerData.firstName || "",
      inviteeUid: invitee.id,
      inviteeEmail: invitee.normalizedEmail,
      inviteeFirstName: invitee.firstName,
      inviteeMmUserId: invitee.mmUserId,
      channelId,
      status: "pending",
      error: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    res.json({
      message: `Inviting ${inviteeName}...`,
      inviteId: inviteRef.id,
    });
  } catch (e) { next(e); }
});

router.get("/invite-status", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const inviteId = req.query.inviteId as string;
    if (!inviteId) { res.status(400).json({ error: "inviteId is required" }); return; }

    const doc = await db.doc(`invites/${inviteId}`).get();
    if (!doc.exists) { res.status(404).json({ error: "Invite not found" }); return; }

    const data = doc.data()!;
    res.json({ status: data.status, message: inviteStatusMessage(data) });
  } catch (e) { next(e); }
});

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

router.post("/accept-invite-link", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const callerUid = req.uid!;
    const callerData = req.user!;
    const { token } = req.body ?? {};

    if (!token) { res.status(400).json({ error: "token is required" }); return; }

    const linkDoc = await db.doc(`channelInvites/${token}`).get();
    if (!linkDoc.exists) { res.status(404).json({ error: "Invite link not found" }); return; }

    const linkData = linkDoc.data()!;
    const linkError = validateInviteLink(linkData);
    if (linkError) { res.status(linkError.status).json({ error: linkError.error }); return; }

    if (!callerData.mattermost?.userId) {
      res.status(400).json({ error: "You need to complete onboarding before joining a channel" });
      return;
    }

    const channelId = linkData.channelId;

    const existing = await findExistingInvite(channelId, callerUid);
    if (existing) {
      res.json({
        inviteId: existing.id,
        channelId,
        message: existing.data.status === "completed" ? "You're already in this channel" : "Joining channel...",
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
