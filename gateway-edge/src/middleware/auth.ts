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

function validateInternalServiceKey(req: Request, res: Response): boolean {
  const configuredSecret = process.env.INTERNAL_SERVICE_KEY;

  if (!configuredSecret) {
    logger.error("INTERNAL_SERVICE_KEY is not set — refusing internal request");
    res.status(503).json({ error: "Internal auth unavailable" });
    return false;
  }

  const provided = req.headers["x-internal-service-key"];
  if (!provided) {
    res.status(401).json({ error: "X-Internal-Service-Key header required" });
    return false;
  }
  if (typeof provided !== "string") {
    logger.warn(`Internal service auth rejected from ${req.ip} — invalid key`);
    res.status(401).json({ error: "Invalid internal service key" });
    return false;
  }

  let valid = false;
  try {
    valid =
      provided.length === configuredSecret.length &&
      crypto.timingSafeEqual(
        Buffer.from(provided, "utf8"),
        Buffer.from(configuredSecret, "utf8")
      );
  } catch {
    valid = false;
  }

  if (!valid) {
    logger.warn(`Internal service auth rejected from ${req.ip} — invalid key`);
    res.status(401).json({ error: "Invalid internal service key" });
    return false;
  }

  return true;
}

export function requireInternalServiceKey(req: Request, res: Response, next: NextFunction): void {
  if (!validateInternalServiceKey(req, res)) {
    return;
  }
  logger.warn("internal request authenticated via legacy INTERNAL_SERVICE_KEY", {
    route: req.path,
    ip: req.ip,
  });
  next();
}

export function requireInternalServiceAuth(req: Request, res: Response, next: NextFunction): void {
  const boundTenant = (req as Request & { boundTenant?: { kind?: unknown } }).boundTenant;
  if (boundTenant?.kind === "gateway" || boundTenant?.kind === "platform") {
    next();
    return;
  }

  requireInternalServiceKey(req, res, next);
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
    logger.info("social notification authenticated via dedicated bearer", {
      route: req.path,
    });
    next();
    return;
  }

  if (provided) {
    logger.warn("social notification bearer rejected — falling back to legacy key", {
      route: req.path,
    });
  }

  requireInternalServiceKey(req, res, next);
}
