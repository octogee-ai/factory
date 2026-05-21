import type { Request, Response, NextFunction } from "express";
import type { Firestore } from "firebase-admin/firestore";

export interface RequireAdminDeps {
  /** Verifies a Firebase ID token; throws on invalid token. */
  verifyIdToken: (token: string) => Promise<{ uid: string }>;
  db: Firestore;
  log: (msg: string) => void;
}

// Contract: the admin-fleet-router factory only reads `req.uid` (for
// `createdBy`) and `req.user.email` (for audit fields it doesn't yet
// emit on glm-controller, but gateway-edge does). Anything else on
// `req.user` is gateway-edge-specific (e.g. giteaToken) and not
// surfaced here — glm-controller only needs the auth-identity slice.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      uid?: string;
      user?: { email?: string | null };
      isAdmin?: boolean;
    }
  }
}

export function createRequireAdmin(
  deps: RequireAdminDeps,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async function requireAdmin(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    const token = header.slice(7);

    let uid: string;
    try {
      const decoded = await deps.verifyIdToken(token);
      uid = decoded.uid;
    } catch (err) {
      deps.log(
        `[admin-auth] verify failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    req.uid = uid;

    // Parallel reads — same uid, two docs, no dependency between them.
    // Saves an RTT on every admin request. Firestore failures bubble
    // up via next(err) so the Express error pipeline returns 500
    // instead of leaking an unhandled rejection (Express 4 doesn't
    // forward thrown async errors to the default error handler).
    let userSnap: FirebaseFirestore.DocumentSnapshot;
    let configSnap: FirebaseFirestore.DocumentSnapshot;
    try {
      [userSnap, configSnap] = await Promise.all([
        deps.db.collection("users").doc(uid).get(),
        deps.db
          .collection("users")
          .doc(uid)
          .collection("system")
          .doc("config")
          .get(),
      ]);
    } catch (err) {
      deps.log(
        `[admin-auth] role lookup failed uid=${uid}: ${err instanceof Error ? err.message : String(err)}`,
      );
      next(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (userSnap.exists) {
      const userData = userSnap.data();
      const email =
        typeof userData?.email === "string" ? userData.email : null;
      req.user = { email };
    }
    const role = configSnap.exists
      ? (configSnap.data() as { role?: unknown } | undefined)?.role
      : null;
    req.isAdmin = role === "admin";

    if (!req.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  };
}
