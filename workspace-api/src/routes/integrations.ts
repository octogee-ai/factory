/**
 * Integration routes — Google/Microsoft OAuth, IMAP, Twilio.
 * Migrated from functions/src/integrations/*.ts
 */
import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth";
import { logger } from "../middleware/logging";
import { db, FieldValue } from "../lib/db";
import { GOOGLE_SCOPES, MICROSOFT_SCOPES } from "../lib/integrations";
import { sanitizeReturnUrl } from "../lib/redirect-validation";

const router = Router();
const APP_URL = process.env.APP_URL || "https://octogee.com";

// ── Google OAuth ───────────────────────────────────────────────────────────

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || "https://googleoauthcallback-p57h3jzwfq-uc.a.run.app";

router.get("/google/auth-url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.query.uid as string;
    const returnUrl = sanitizeReturnUrl(req.query.returnUrl as string);
    if (!uid) { res.status(400).json({ error: "Missing uid" }); return; }

    const state = Buffer.from(JSON.stringify({ uid, returnUrl })).toString("base64url");
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    res.json({ url: `${GOOGLE_AUTH_URL}?${params}` });
  } catch (e) { next(e); }
});

router.get("/google/callback", async (req: Request, res: Response, next: NextFunction) => {
  const { code, state, error: authError } = req.query;
  if (authError) { res.redirect(`${APP_URL}/dashboard?integration_error=cancelled`); return; }
  if (!code || !state) { res.redirect(`${APP_URL}/dashboard?integration_error=invalid`); return; }

  let uid = "", returnUrl = "/dashboard";
  try {
    const decoded = JSON.parse(Buffer.from(state as string, "base64url").toString());
    uid = decoded.uid || "";
    returnUrl = decoded.returnUrl || "/dashboard";
  } catch { res.redirect(`${APP_URL}/dashboard?integration_error=invalid_state`); return; }
  if (!uid) { res.redirect(`${APP_URL}/dashboard?integration_error=missing_uid`); return; }

  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code: code as string,
        redirect_uri: GOOGLE_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error("Token exchange failed");
    const tokenData = await tokenRes.json() as any;

    const userInfoRes = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    if (!userInfoRes.ok) throw new Error("Failed to get Google user info");
    const userInfo = await userInfoRes.json() as { email: string };

    await db.collection("users").doc(uid).collection("integrations").doc("google").set({
      provider: "google", status: "connected", email: userInfo.email, scopes: GOOGLE_SCOPES,
      tokens: { accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token || null, expiresAt: Date.now() + tokenData.expires_in * 1000, tokenType: tokenData.token_type },
      connectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });

    const target = sanitizeReturnUrl(returnUrl).startsWith("http") ? sanitizeReturnUrl(returnUrl) : `${APP_URL}${sanitizeReturnUrl(returnUrl)}`;
    res.redirect(`${target}${target.includes("?") ? "&" : "?"}google_connected=true&google_email=${encodeURIComponent(userInfo.email)}`);
  } catch (err: any) {
    logger.error(`Google OAuth error for uid=${uid}: ${err.message}`);
    try { await db.collection("users").doc(uid).collection("integrations").doc("google").set({ provider: "google", status: "error", error: String(err), updatedAt: FieldValue.serverTimestamp() }, { merge: true }); } catch {}
    res.redirect(`${APP_URL}/dashboard?integration_error=google_failed`);
  }
});

// ── Microsoft OAuth ────────────────────────────────────────────────────────

const MS_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_USERINFO_URL = "https://graph.microsoft.com/v1.0/me";
const MS_REDIRECT_URI = process.env.MICROSOFT_OAUTH_REDIRECT_URI || "https://microsoftoauthcallback-p57h3jzwfq-uc.a.run.app";

router.get("/microsoft/auth-url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.query.uid as string;
    const returnUrl = sanitizeReturnUrl(req.query.returnUrl as string);
    if (!uid) { res.status(400).json({ error: "Missing uid" }); return; }

    const state = Buffer.from(JSON.stringify({ uid, returnUrl })).toString("base64url");
    const params = new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      redirect_uri: MS_REDIRECT_URI,
      response_type: "code",
      scope: MICROSOFT_SCOPES.join(" "),
      state,
      prompt: "consent",
    });
    res.json({ url: `${MS_AUTH_URL}?${params}` });
  } catch (e) { next(e); }
});

router.get("/microsoft/callback", async (req: Request, res: Response, next: NextFunction) => {
  const { code, state, error: authError } = req.query;
  if (authError) { res.redirect(`${APP_URL}/dashboard?integration_error=cancelled`); return; }
  if (!code || !state) { res.redirect(`${APP_URL}/dashboard?integration_error=invalid`); return; }

  let uid = "", returnUrl = "/dashboard";
  try {
    const decoded = JSON.parse(Buffer.from(state as string, "base64url").toString());
    uid = decoded.uid || "";
    returnUrl = decoded.returnUrl || "/dashboard";
  } catch { res.redirect(`${APP_URL}/dashboard?integration_error=invalid_state`); return; }
  if (!uid) { res.redirect(`${APP_URL}/dashboard?integration_error=missing_uid`); return; }

  try {
    const tokenRes = await fetch(MS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID!,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code: code as string,
        redirect_uri: MS_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error("Token exchange failed");
    const tokenData = await tokenRes.json() as any;

    const userInfoRes = await fetch(MS_USERINFO_URL, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    if (!userInfoRes.ok) throw new Error("Failed to get Microsoft user info");
    const userInfo = await userInfoRes.json() as { mail?: string; userPrincipalName?: string };
    const email = userInfo.mail || userInfo.userPrincipalName || "unknown";

    await db.collection("users").doc(uid).collection("integrations").doc("microsoft").set({
      provider: "microsoft", status: "connected", email, scopes: MICROSOFT_SCOPES,
      tokens: { accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token || null, expiresAt: Date.now() + tokenData.expires_in * 1000, tokenType: tokenData.token_type },
      connectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });

    const target = sanitizeReturnUrl(returnUrl).startsWith("http") ? sanitizeReturnUrl(returnUrl) : `${APP_URL}${sanitizeReturnUrl(returnUrl)}`;
    res.redirect(`${target}${target.includes("?") ? "&" : "?"}microsoft_connected=true&microsoft_email=${encodeURIComponent(email)}`);
  } catch (err: any) {
    logger.error(`Microsoft OAuth error for uid=${uid}: ${err.message}`);
    try { await db.collection("users").doc(uid).collection("integrations").doc("microsoft").set({ provider: "microsoft", status: "error", error: String(err), updatedAt: FieldValue.serverTimestamp() }, { merge: true }); } catch {}
    res.redirect(`${APP_URL}/dashboard?integration_error=microsoft_failed`);
  }
});

// ── Manual configs (IMAP, Twilio) ──────────────────────────────────────────

router.post("/imap", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const { email, imapHost, imapPort, smtpHost, smtpPort, username, password } = req.body;
    if (!email || !imapHost || !username || !password) { res.status(400).json({ error: "Missing required fields" }); return; }

    await db.collection("users").doc(uid).collection("integrations").doc("imap").set({
      provider: "imap", status: "pending", email,
      imap: { host: imapHost, port: imapPort || 993, username, encryptedPassword: password /* TODO: encrypt */ },
      smtp: { host: smtpHost || imapHost.replace("imap.", "smtp."), port: smtpPort || 587, username, encryptedPassword: password },
      connectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.post("/twilio", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const { accountSid, authToken, fromNumber } = req.body;
    if (!accountSid || !authToken || !fromNumber) { res.status(400).json({ error: "Missing required fields" }); return; }

    await db.collection("users").doc(uid).collection("integrations").doc("twilio").set({
      provider: "twilio", status: "pending",
      twilio: { accountSid, encryptedAuthToken: authToken /* TODO: encrypt */, fromNumber },
      connectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (e) { next(e); }
});

router.post("/disconnect", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const { service } = req.body;
    const validServices = ["google", "microsoft", "imap", "twilio", "whatsapp"];
    if (!service || !validServices.includes(service)) { res.status(400).json({ error: `Invalid service: ${service}` }); return; }

    await db.collection("users").doc(uid).collection("integrations").doc(service).set({
      provider: service, status: "disconnected", updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (e) { next(e); }
});

export default router;
