/**
 * Auth middleware — replaces 4 different auth patterns across 15+ Cloud Functions.
 *
 * Patterns consolidated:
 *   1. requireAuth()               — Firebase ID token from `Authorization: Bearer <token>`
 *   2. requireAdmin()              — requireAuth() + admin role check in Firestore
 *   3. requireInternalServiceAuth() — internal service-to-service calls (gateway, provisioner, cron)
 *                                    Validates `X-Internal-Service-Key` against INTERNAL_SERVICE_KEY env var.
 *   4. requireAgentKeyForUser(getUid) — `X-Agent-Key` presence + constant-time
 *                                    value validation against users/{uid}/settings/api.
 *                                    The pattern for every /internal/agents/* route.
 *   5. (no middleware)             — public endpoints get no auth middleware
 *
 * Attaches `req.uid`, `req.user`, `req.isAdmin` to the request for downstream use.
 *
 * INTERNAL_SERVICE_KEY: shared secret injected via K8s Secret into workspace-api, gateway,
 * provisioner, and any K8s CronJobs that call /internal/* routes. Rotate via K8s Secret update.
 * If unset in dev/test the middleware logs a warning and allows the request so local dev stays
 * friction-free; this permissive fallback MUST NOT ship to production (enforced by startup check).
 */
import * as crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { auth, db } from "../lib/db";
import { logger } from "./logging";

// Extend Express Request to include auth context. `namespace` is the only
// way to augment @types/express — ES2015 module syntax doesn't support
// declaration merging into a third-party type's internal namespace. This
// is the pattern the Express types' own README recommends.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      uid?: string;
      user?: FirebaseFirestore.DocumentData;
      isAdmin?: boolean;
      /** Per-customer Gitea API token (from users/{uid}/system/config.gitea.token) */
      giteaToken?: string;
    }
  }
}

/**
 * Verify Firebase ID token. Attaches uid + user doc to request.
 */
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
      // Admin check from system/config subcollection ONLY (PR #183 architecture)
      // No fallback to user doc — system/config is the sole source of truth
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

/**
 * Require admin role. Must be used after requireAuth.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (!req.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  });
}

/**
 * requireInternalServiceAuth — validates that the caller is a trusted internal service.
 *
 * Expects header: `X-Internal-Service-Key: <value>`
 * The value is compared (constant-time) against process.env.INTERNAL_SERVICE_KEY.
 *
 * In production INTERNAL_SERVICE_KEY must be set. Startup code in index.ts warns loudly
 * if it's missing so the omission is never silent in deployed environments.
 *
 * In development (INTERNAL_SERVICE_KEY unset): logs a warning and allows the request so
 * local work remains frictionless. This is intentionally a loud no-op, not silent bypass.
 *
 * Used by: /internal/billing/*, scheduled CronJobs, provisioner service.
 */
export function requireInternalServiceAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredSecret = process.env.INTERNAL_SERVICE_KEY;

  if (!configuredSecret) {
    // Dev/test fallback — allow but make noise
    logger.warn(
      "INTERNAL_SERVICE_KEY is not set — internal auth is DISABLED. " +
      "This must not happen in production."
    );
    next();
    return;
  }

  const provided = req.headers["x-internal-service-key"] as string | undefined;
  if (!provided) {
    res.status(401).json({ error: "X-Internal-Service-Key header required" });
    return;
  }

  // Constant-time comparison to prevent timing attacks
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

/**
 * requireAgentKeyForUser — presence + value validation for X-Agent-Key.
 *
 * Validates the header against the stored key at users/{uid}/settings/api.apiKey
 * using a constant-time comparison. On success, attaches `req.agentKey` and
 * `req.agentUid` for downstream handlers.
 *
 * The `getUid` callback receives the full Request so callers can source uid
 * from the body, params, or query as appropriate for the route.
 *
 * 401 cases:
 *   - missing X-Agent-Key header
 *   - uid not supplied by callback (400 instead — caller error)
 *   - no API settings doc for uid
 *   - stored key mismatch
 */
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

        // Constant-time compare to avoid leaking the stored key's length
        // via timing. Length check first since timingSafeEqual requires
        // equal-length buffers and throws otherwise.
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

