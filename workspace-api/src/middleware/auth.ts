/**
 * Auth middleware — replaces 4 different auth patterns across 15+ Cloud Functions.
 *
 * Patterns consolidated:
 *   1. requireAuth()    — Firebase ID token from `Authorization: Bearer <token>`
 *   2. requireAdmin()   — requireAuth() + admin role check in Firestore
 *   3. requireApiKey()  — `X-Agent-Key` header (service-to-service from gateway)
 *   4. (no middleware)   — public endpoints get no auth middleware
 *
 * Attaches `req.uid`, `req.user`, `req.isAdmin` to the request for downstream use.
 */
import { Request, Response, NextFunction } from "express";
import { auth, db } from "../lib/db";
import { logger } from "./logging";

// Extend Express Request to include auth context
declare global {
  namespace Express {
    interface Request {
      uid?: string;
      user?: FirebaseFirestore.DocumentData;
      isAdmin?: boolean;
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
      // Check admin from system/config subcollection (PR #183 architecture)
      try {
        const configSnap = await db
          .collection("users")
          .doc(decoded.uid)
          .collection("system")
          .doc("config")
          .get();
        req.isAdmin = configSnap.exists && configSnap.data()?.role === "admin";
      } catch {
        // Fallback to user doc for backward compat
        req.isAdmin = req.user?.role === "admin";
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
 * Verify X-Agent-Key header (gateway → workspace-api service-to-service auth).
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-agent-key"] as string | undefined;
  if (!key) {
    res.status(401).json({ error: "X-Agent-Key header required" });
    return;
  }

  // Validate against the agent's stored API key
  // The key format is typically the agent slug, looked up in Firestore
  // For now, this passes the key through — individual routes validate against their agent doc
  (req as any).agentKey = key;
  next();
}

/**
 * Verify workspace ownership — slug must match the caller's workspaceSlug.
 * Used after requireAuth. Returns 403 if the slug doesn't match.
 */
export function requireOwnership(slugParam: "slug" | "query" = "query") {
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
