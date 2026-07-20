import type { Request, Response, NextFunction } from "express";
import type { Firestore } from "firebase-admin/firestore";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";

export interface RequireAdminDeps {
  verifyIdToken: (token: string) => Promise<{ uid: string }>;
  db: Firestore;
  log: (msg: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function authenticatedUid(
  deps: RequireAdminDeps,
  req: Request,
  res: Response,
): Promise<string | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }
  try {
    return (await deps.verifyIdToken(header.slice(7))).uid;
  } catch (error) {
    deps.log(`[admin-auth] verify failed: ${errorMessage(error)}`);
    res.status(401).json({ error: "Invalid token" });
    return null;
  }
}

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
    const uid = await authenticatedUid(deps, req, res);
    if (!uid) return;
    req.uid = uid;

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
    } catch (error) {
      const message = errorMessage(error);
      deps.log(`[admin-auth] role lookup failed uid=${uid}: ${message}`);
      next(error instanceof Error ? error : new Error(message));
      return;
    }
    if (!userSnap.exists || !accountAllowsInteractiveAccess(userSnap.data())) {
      res.status(403).json({ error: "Account suspended" });
      return;
    }
    const userData = userSnap.data()!;
    const email = typeof userData.email === "string" ? userData.email : null;
    req.user = { email };
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
