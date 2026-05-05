/**
 * Cowboy HTTP — admin / fleet API surface served from the control
 * plane. Mounts the same `addAdminFleetRoutes` factory workspace-api
 * uses, so the admin Gateways tab keeps responding even when no
 * gateway pods are booted. See
 * docs/architecture/GATEWAY-PLATFORM-SPEC.md §Gateway Lifecycle Manager.
 */
import express, { Router, type Express } from "express";
import type { Server } from "node:http";
import type { Firestore } from "firebase-admin/firestore";
import {
  addAdminFleetRoutes,
  type FleetLogger,
} from "../../scripts/lib/admin-fleet-router.js";
import {
  createRequireAdmin,
  type RequireAdminDeps,
} from "./middleware/auth.js";

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
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "glm-controller" });
  });

  const adminRouter = Router();
  adminRouter.use(
    createRequireAdmin({
      verifyIdToken: deps.verifyIdToken,
      db: deps.db,
      log: deps.log,
    }),
  );
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
