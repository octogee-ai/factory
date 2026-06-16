

import express, { Router, type Express, type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { renderMetrics } from "./metrics.js";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  addAdminFleetRoutes,
  type FleetLogger,
} from "../../scripts/lib/admin-fleet-router.js";
import {
  addAdminCustomerRoutes,
  type CsiRefreshResult,
  type WorkspaceMmContextLite,
} from "../../scripts/lib/admin-customer-router.js";
import {
  createRequireAdmin,
  type RequireAdminDeps,
} from "./middleware/auth.js";

const ALLOWED_ORIGINS = new Set([
  "https://octogee.web.app",
  "https://octogee-test.web.app",
  "https://app-octogee.web.app",
  "https://app-octogee-test.web.app",
  "https://octogee.firebaseapp.com",
  "https://octogee-test.firebaseapp.com",
  "https://app-octogee.firebaseapp.com",
  "https://app-octogee-test.firebaseapp.com",
  "https://octogee.com",
  "https://www.octogee.com",
  "https://app.octogee.com",
]);

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin) || /^http:\/\/localhost:\d+$/.test(origin);
}

function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Internal-Service-Key",
    );
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export interface HttpServerDeps {
  db: Firestore;
  verifyIdToken: RequireAdminDeps["verifyIdToken"];
  log: (msg: string) => void;
  workspaceSlugsForUser: (data: {
    username?: string | null;
  }) => string[];
  provisionGatewayAuthSecret: (opts: {
    gatewayId: string;
    gatewayServiceAccount: string;
  }) => Promise<unknown>;
  listGatewayBuilds: (opts: {
    service: string;
    limit: number;
  }) => Promise<unknown[]>;
  deleteAuthUserTolerantOfMissing: (uid: string) => Promise<void>;
}

function adaptLogger(log: (msg: string) => void): FleetLogger {
  const fmt = (msg: string, meta?: Record<string, unknown>): string =>
    meta && Object.keys(meta).length > 0
      ? `${msg} ${JSON.stringify(meta)}`
      : msg;
  return {
    info: (msg, meta) => log(fmt(msg, meta)),
    warn: (msg, meta) => log(`⚠ ${fmt(msg, meta)}`),
  };
}

export function createHttpServer(deps: HttpServerDeps): Express {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "glm-controller" });
  });

  // Unauthenticated Prometheus scrape endpoint (ClusterIP-only). Scraped by GMP
  // via the glm-controller ClusterPodMonitoring in helm/monitoring/gmp-podmonitorings.yaml.
  app.get("/metrics", (_req, res) => {
    res.set("Content-Type", "text/plain; version=0.0.4");
    res.end(renderMetrics());
  });

  const adminRouter = Router();
  adminRouter.use(
    createRequireAdmin({
      verifyIdToken: deps.verifyIdToken,
      db: deps.db,
      log: deps.log,
    }),
  );

addAdminCustomerRoutes(adminRouter, {
    db: deps.db,
    FieldValue,
    logger: adaptLogger(deps.log),
    workspaceSlugsForUser: deps.workspaceSlugsForUser,
    getWorkspaceMmContext: (uid, hint) => readMmContextFromFirestore(deps.db, uid, hint),
    refreshCsiForUser: async (): Promise<CsiRefreshResult> => ({
      ok: false,
      updatedAt: null,
      unavailable: true,
      reason: "CSI refresh requires gateway-edge; the gateway pod runs the compute pipeline. Try again once a gateway pod is healthy.",
    }),
  });
  addAdminFleetRoutes(adminRouter, {
    db: deps.db,
    logger: adaptLogger(deps.log),
    workspaceSlugsForUser: deps.workspaceSlugsForUser,
    provisionGatewayAuthSecret: deps.provisionGatewayAuthSecret,
    listGatewayBuilds: deps.listGatewayBuilds,
    deleteAuthUserTolerantOfMissing: deps.deleteAuthUserTolerantOfMissing,
  });
  app.use("/api/admin", adminRouter);

  return app;
}

async function readMmContextFromFirestore(
  db: Firestore,
  uid: string,
  hint: Record<string, unknown>,
): Promise<WorkspaceMmContextLite | null> {
  const userData = hint as { username?: string; workspaceId?: string } | undefined;
  if (!userData) return null;
  const slug = userData.username ?? userData.workspaceId;
  if (!slug) return null;
  const channelSnap = await db.doc(`workspaces/${slug}/channels/coach-dm`).get();
  if (!channelSnap.exists) return { coachDmChannelId: null };
  const channelData = channelSnap.data() as { mattermost?: { channelId?: string } } | undefined;
  return { coachDmChannelId: channelData?.mattermost?.channelId ?? null };
}

export function startHttpServer(
  deps: HttpServerDeps & { port: number },
): () => void {
  const app = createHttpServer(deps);
  const server: Server = app.listen(deps.port, () => {
    deps.log(`[glm-controller] http server listening on :${deps.port}`);
  });
  return () => {
    server.close();
  };
}
