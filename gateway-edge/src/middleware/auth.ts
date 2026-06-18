import * as crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { auth, db } from "../lib/db.js";
import { resolveCanonicalWorkspaceSlug } from "../lib/canonical-workspace.js";
import { logger } from "./logging.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      uid?: string;
      user?: FirebaseFirestore.DocumentData;
      workspaceSlug?: string | null;
      isAdmin?: boolean;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const token = header.slice(7);
  auth
    .verifyIdToken(token)
    .then(async (decoded) => {
      req.uid = decoded.uid;
      const userSnap = await db.collection("users").doc(decoded.uid).get();
      if (userSnap.exists) {
        const userData = userSnap.data();
        req.user = userData;
        req.workspaceSlug = await resolveCanonicalWorkspaceSlug(decoded.uid, userData);
      }
      try {
        const configSnap = await db.collection("users").doc(decoded.uid).collection("system").doc("config").get();
        req.isAdmin = configSnap.exists && configSnap.data()?.role === "admin";
      } catch {
        req.isAdmin = false;
      }
      next();
    })
    .catch((err) => {
      logger.warn(`Auth failed: ${err.message}`);
      res.status(401).json({ error: "Invalid token" });
    });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (!req.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  });
}

function boundTenantKind(req: Request): unknown {
  return (req as Request & { boundTenant?: { kind?: unknown } }).boundTenant?.kind;
}

export function requireInternalServiceAuth(req: Request, res: Response, next: NextFunction): void {
  if (boundTenantKind(req) === "gateway") {
    next();
    return;
  }
  res.status(401).json({ error: "internal auth required" });
}

export function requireInternalPlatformAuth(req: Request, res: Response, next: NextFunction): void {
  const kind = boundTenantKind(req);
  if (kind === "gateway" || kind === "platform") {
    next();
    return;
  }
  res.status(401).json({ error: "internal auth required" });
}

function timingSafeStringEqual(a: string, b: string): boolean {
  try {
    return (
      a.length === b.length &&
      crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
    );
  } catch {
    return false;
  }
}

function bearerFromRequest(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

export function requireSocialNotificationAuth(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.SOCIAL_NOTIFICATION_BEARER_TOKEN;
  const provided = bearerFromRequest(req);
  if (configured && provided && timingSafeStringEqual(provided, configured)) {
    next();
    return;
  }
  res.status(401).json({ error: "invalid social notification bearer" });
}
