import { Router, type Request, type Response } from "express";
import { db } from "../../../gateway-edge/src/lib/db.js";
import { requireAuth } from "../../../gateway-edge/src/middleware/auth.js";
import { forwardMmRest } from "../../../gateway-edge/src/chat-proxy/mm-proxy/rest.js";

const MM_INTERNAL_URL = process.env.MM_INTERNAL_URL || "";

const API_PUBLIC_URL = process.env.API_PUBLIC_URL || "";

interface CachedMmCreds {
  mmToken: string;
  mmUserId: string;
  expiresAt: number;
}

export const mmCredsCache = new Map<string, CachedMmCreds>();
const MM_CREDS_CACHE_TTL = 5 * 60 * 1000;

export const MM_CREDS_CACHE_MAX = 5000;

export function setMmCredsCache(uid: string, entry: CachedMmCreds): void {
  if (mmCredsCache.size >= MM_CREDS_CACHE_MAX && !mmCredsCache.has(uid)) {
    const now = Date.now();
    for (const [k, v] of mmCredsCache) {
      if (v.expiresAt <= now) mmCredsCache.delete(k);
    }
    while (mmCredsCache.size >= MM_CREDS_CACHE_MAX) {
      const oldest = mmCredsCache.keys().next().value;
      if (oldest === undefined) break;
      mmCredsCache.delete(oldest);
    }
  }
  mmCredsCache.set(uid, entry);
}

type GetMmCredsResult =
  | { ok: true; mmToken: string; mmUserId: string }
  | { ok: false; reason: "not-provisioned" }
  | { ok: false; reason: "lookup-error" };

async function getMmCreds(uid: string): Promise<GetMmCredsResult> {
  const cached = mmCredsCache.get(uid);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return { ok: true, mmToken: cached.mmToken, mmUserId: cached.mmUserId };
    }
    mmCredsCache.delete(uid);
  }

  try {
    const [userDoc, secretDoc] = await Promise.all([
      db.doc(`users/${uid}`).get(),
      db.doc(`users/${uid}/secrets/mattermost`).get(),
    ]);

    const mmUserId = userDoc.data()?.mattermost?.userId;
    const mmToken = secretDoc.data()?.personalToken;

    if (!mmUserId || !mmToken) return { ok: false, reason: "not-provisioned" };

    setMmCredsCache(uid, {
      mmToken,
      mmUserId,
      expiresAt: Date.now() + MM_CREDS_CACHE_TTL,
    });

    return { ok: true, mmToken, mmUserId };
  } catch (e) {
    console.error(
      `[mm-proxy] failed to load MM creds for ${uid}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { ok: false, reason: "lookup-error" };
  }
}

export const mattermostMintRoutes = Router();
mattermostMintRoutes.post("/", requireAuth, async (req: Request, res: Response) => {

if (!API_PUBLIC_URL) {
    console.error("[mm-proxy] API_PUBLIC_URL unset — refusing to mint with empty mmUrl");
    res.status(503).json({ error: "Chat service misconfigured" });
    return;
  }
  const uid = req.uid!;
  const result = await getMmCreds(uid);
  if (!result.ok) {
    if (result.reason === "lookup-error") {
      res.status(503).json({ error: "Credential lookup unavailable" });
      return;
    }
    res.status(502).json({ error: "Chat not provisioned" });
    return;
  }
  res.json({
    mmUrl: API_PUBLIC_URL,
    mmToken: result.mmToken,
    mmUserId: result.mmUserId,
  });
});

export function mmRestProxyHandler(req: Request, res: Response): void {
  
  if (!MM_INTERNAL_URL) {
    console.error("[mm-proxy] MM_INTERNAL_URL unset — cannot proxy MM REST");
    res.status(502).json({ error: "Chat service misconfigured" });
    return;
  }
  forwardMmRest(
    { mmInternalUrl: MM_INTERNAL_URL, log: (msg) => console.warn(msg) },
    req,
    res,
  );
}
