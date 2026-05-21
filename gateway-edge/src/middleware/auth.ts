import * as crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { auth, db } from "../lib/db";
import { logger } from "./logging";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      uid?: string;
      user?: FirebaseFirestore.DocumentData;
      isAdmin?: boolean;
      giteaToken?: string;
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
        req.user = userSnap.data();
      }
      try {
        const configSnap = await db
          .collection("users")
          .doc(decoded.uid)
          .collection("system")
          .doc("config")
          .get();
        req.isAdmin = configSnap.exists && configSnap.data()?.role === "admin";
        req.giteaToken = configSnap.data()?.gitea?.token || undefined;
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

export function requireInternalServiceAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredSecret = process.env.INTERNAL_SERVICE_KEY;

  if (!configuredSecret) {
    logger.error("INTERNAL_SERVICE_KEY is not set — refusing internal request");
    res.status(503).json({ error: "Internal auth unavailable" });
    return;
  }

  const provided = req.headers["x-internal-service-key"] as string | undefined;
  if (!provided) {
    res.status(401).json({ error: "X-Internal-Service-Key header required" });
    return;
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
    return;
  }

  next();
}

export function requireAgentKeyForUser(
  getUid: (req: Request) => string | undefined,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const key = req.headers["x-agent-key"] as string | undefined;
    if (!key) {
      res.status(401).json({ error: "X-Agent-Key header required" });
      return;
    }

    const uid = getUid(req);
    if (!uid) {
      res.status(400).json({ error: "missing_uid" });
      return;
    }

    db.doc(`users/${uid}/settings/api`)
      .get()
      .then((snap) => {
        if (!snap.exists) {
          res.status(401).json({ error: "unauthorized", message: "No API key on record" });
          return;
        }
        const stored = snap.data()?.apiKey as string | undefined;
        if (!stored) {
          res.status(401).json({ error: "unauthorized", message: "No API key on record" });
          return;
        }

        let valid = false;
        try {
          valid =
            stored.length === key.length &&
            crypto.timingSafeEqual(
              Buffer.from(stored, "utf8"),
              Buffer.from(key, "utf8"),
            );
        } catch {
          valid = false;
        }

        if (!valid) {
          logger.warn(`Agent-key auth rejected for uid=${uid} from ${req.ip}`);
          res.status(401).json({ error: "unauthorized", message: "Invalid API key" });
          return;
        }

        (req as Request & { agentKey?: string; agentUid?: string }).agentKey = key;
        (req as Request & { agentUid?: string }).agentUid = uid;
        next();
      })
      .catch((err) => {
        logger.warn(`Agent-key auth failed for uid=${uid}: ${err.message}`);
        res.status(500).json({ error: "auth_check_failed" });
      });
  };
}

