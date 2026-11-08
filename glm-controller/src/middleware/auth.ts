import type { Request, Response, NextFunction } from "express";
import type { BuilderAccount, BuilderAccountReader } from "@octogee/core/builder-account";
import type { BuilderRecord, PlatformStateStore, Stored } from "@octogee/core/platform-state";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";

export interface RequireAdminDeps {
  verifyIdToken: (token: string) => Promise<{ uid: string }>;
  store: Pick<PlatformStateStore, "builders">;
  accounts: Pick<BuilderAccountReader, "get">;
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

    let builder: Stored<BuilderRecord> | null;
    let account: BuilderAccount | null;
    try {
      [builder, account] = await Promise.all([
        deps.store.builders.records.get(uid),
        deps.accounts.get(uid),
      ]);
    } catch (error) {
      const message = errorMessage(error);
      deps.log(`[admin-auth] role lookup failed uid=${uid}: ${message}`);
      next(error instanceof Error ? error : new Error(message));
      return;
    }
    if (builder === null || !accountAllowsInteractiveAccess({ accountLifecycle: builder.accountLifecycle })) {
      res.status(403).json({ error: "Account suspended" });
      return;
    }
    req.user = { email: account?.email ?? null };
    req.isAdmin = builder.role === "admin";

    if (!req.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  };
}
