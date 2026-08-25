import * as crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { auth, db } from "../lib/db.js";
import { resolveCanonicalWorkspaceSlug } from "../lib/canonical-workspace.js";
import { logger } from "./logging.js";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      uid?: string;
      authTime?: number;
      user?: FirebaseFirestore.DocumentData;
      workspaceSlug?: string | null;
      isAdmin?: boolean;
    }
  }
}

function authenticateUid(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const token = header.slice(7);
  void (async () => {
    let decoded: Awaited<ReturnType<typeof auth.verifyIdToken>>;
    try {
      decoded = await auth.verifyIdToken(token);
    } catch (err) {
      logger.warn(`Auth failed: ${(err as Error).message}`);
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    req.uid = decoded.uid;
    req.authTime = Number.isSafeInteger(decoded.auth_time) ? decoded.auth_time : undefined;
    next();
  })();
}

export const RECENT_AUTH_MAX_AGE_SECONDS = 5 * 60;

export function requireRecentAuthentication(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const authTime = req.authTime;
  if (
    typeof authTime !== "number" ||
    authTime > nowSeconds + 60 ||
    nowSeconds - authTime > RECENT_AUTH_MAX_AGE_SECONDS
  ) {
    res.status(403).json({
      error: "auth/requires-recent-login",
      message: "Recent authentication required",
    });
    return;
  }
  next();
}

export function requireAuthenticatedUid(req: Request, res: Response, next: NextFunction): void {
  authenticateUid(req, res, next);
}

function attachActiveUser(
  req: Request,
  res: Response,
  next: NextFunction,
  allowUnregistered: boolean,
): void {
  void (async () => {
    const userSnap = await db.collection("users").doc(req.uid!).get();
    if (!userSnap.exists) {
      if (allowUnregistered) {
        req.user = undefined;
        next();
        return;
      }
      res.status(403).json({ error: "Account is not active" });
      return;
    }
    const userData = userSnap.data()!;
    if (!accountAllowsInteractiveAccess(userData)) {
      res.status(403).json({ error: "Account is not active" });
      return;
    }
    req.user = userData;
    next();
  })().catch((err) => {
    logger.warn(`Auth lookup failed: ${(err as Error).message}`);
    res.status(503).json({ error: "Authentication lookup unavailable" });
  });
}

function attachAuthContext(req: Request, res: Response, next: NextFunction): void {
  const uid = req.uid!;
  void (async () => {
    req.workspaceSlug = await resolveCanonicalWorkspaceSlug(uid, req.user);
    try {
      const configSnap = await db.collection("users").doc(uid).collection("system").doc("config").get();
      req.isAdmin = configSnap.exists && configSnap.data()?.role === "admin";
    } catch {
      req.isAdmin = false;
    }
    next();
  })().catch((err) => {
    logger.warn(`Auth lookup failed: ${err.message}`);
    res.status(503).json({ error: "Authentication lookup unavailable" });
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  requireAuthenticatedUid(req, res, () => {
    attachActiveUser(req, res, () => attachAuthContext(req, res, next), false);
  });
}

export function requireAuthAllowUnregistered(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  requireAuthenticatedUid(req, res, () => {
    attachActiveUser(req, res, () => attachAuthContext(req, res, next), true);
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
