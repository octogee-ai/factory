

import express, { Router, type Express, type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { renderMetrics } from "./metrics.js";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  addAdminFleetRoutes,
  type FleetLogger,
  type GatewayPodDiagnostics,
} from "@octogee/core/admin-fleet-router";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  OPERATOR_GATEWAY_RESERVATIONS_COLLECTION,
} from "@octogee/shared/types/glm";
import {
  addAdminCustomerRoutes,
  type WorkspaceMmContextLite,
} from "@octogee/core/admin-customer-router";
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
  readGatewayPodDiagnostics?: (gatewayId: string) => Promise<GatewayPodDiagnostics>;
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

function writeSseEvent(res: Response, event: string, data: Record<string, unknown>): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function addAdminFleetEventRoute(router: Router, deps: HttpServerDeps): void {
  router.get("/fleet-events", (req: Request, res: Response) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let closed = false;
    const primed = new Set<string>();
    const unsubscribes: Array<() => void> = [];
    const closeAfterFirstChange = req.query.once === "1";
    const keepalive = setInterval(() => {
      if (!closed) res.write(": keepalive\n\n");
    }, 30_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      for (const unsubscribe of unsubscribes) unsubscribe();
      res.end();
    };

    const watch = (collection: string) => {
      const unsubscribe = deps.db.collection(collection).onSnapshot(
        () => {
          if (closed) return;
          if (!primed.has(collection)) {
            primed.add(collection);
            return;
          }
          writeSseEvent(res, "changed", { collection, at: Date.now() });
          if (closeAfterFirstChange) close();
        },
        (err) => {
          deps.log(
            `[glm-controller] fleet event watch failed collection=${collection}: ${
              (err as Error)?.message ?? String(err)
            }`,
          );
          if (!closed) {
            writeSseEvent(res, "error", {
              collection,
              error: (err as Error)?.message ?? "watch failed",
            });
          }
        },
      );
      unsubscribes.push(unsubscribe);
    };

    writeSseEvent(res, "ready", { at: Date.now() });
    watch("users");
    watch("gateways");
    watch(GLM_GATEWAYS_COLLECTION);
    watch(GLM_OPERATIONS_COLLECTION);
    watch(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION);

    req.on("close", close);
  });
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

  addAdminFleetEventRoute(adminRouter, deps);

addAdminCustomerRoutes(adminRouter, {
    db: deps.db,
    FieldValue,
    logger: adaptLogger(deps.log),
    workspaceSlugsForUser: deps.workspaceSlugsForUser,
    getWorkspaceMmContext: (uid, hint) => readMmContextFromFirestore(deps.db, uid, hint),
  });
  addAdminFleetRoutes(adminRouter, {
    db: deps.db,
    logger: adaptLogger(deps.log),
    workspaceSlugsForUser: deps.workspaceSlugsForUser,
    provisionGatewayAuthSecret: deps.provisionGatewayAuthSecret,
    listGatewayBuilds: deps.listGatewayBuilds,
    readGatewayPodDiagnostics: deps.readGatewayPodDiagnostics,
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
