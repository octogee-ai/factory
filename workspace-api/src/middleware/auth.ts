/**
 * Auth middleware — replaces 4 different auth patterns across 15+ Cloud Functions.
 *
 * Patterns consolidated:
 *   1. requireAuth()               — Firebase ID token from `Authorization: Bearer <token>`
 *   2. requireAdmin()              — requireAuth() + admin role check in Firestore
 *   3. requireInternalServiceAuth() — internal service-to-service calls (gateway, provisioner, cron)
 *                                    Validates `X-Internal-Service-Key` against INTERNAL_SERVICE_KEY env var.
 *   4. requireAgentKey()           — `X-Agent-Key` header for agent/user-scoped calls
 *                                    Header presence only; value is validated per-route against user doc.
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
 * requireAgentKey — verifies that an X-Agent-Key header is present.
 *
 * This is a presence-only check; the actual key value is validated per-route
 * against the agent's stored API key in Firestore (see agents.ts activate route).
 * Do NOT use this for routes that don't do their own downstream value validation.
 *
 * Used by: /internal/agents/* (which validate key against users/{uid}/settings/api)
 */
export function requireAgentKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-agent-key"] as string | undefined;
  if (!key) {
    res.status(401).json({ error: "X-Agent-Key header required" });
    return;
  }

  (req as any).agentKey = key;
  next();
}

/**
 * @deprecated Use requireInternalServiceAuth() for /internal/* routes,
 * or requireAgentKey() for agent-scoped routes that validate the key downstream.
 *
 * Left here so any callers not yet migrated get a compile error rather than silent bypass.
 * Remove once all call sites are updated.
 */
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  // Keep the X-Agent-Key check for backward compat during migration
  requireAgentKey(req, res, next);
}

/**
 * Verify workspace ownership — slug must match the caller's workspaceSlug.
 * Used after requireAuth. Returns 403 if the slug doesn't match.
 */
function requireOwnership(slugParam: "slug" | "query" = "query") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const slug =
      slugParam === "query"
        ? (req.query.slug as string) || req.body?.slug
        : req.params.slug;

    if (!slug) {
      res.status(400).json({ error: "Missing slug" });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }

    if (req.user.workspaceSlug !== slug) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  };
}
