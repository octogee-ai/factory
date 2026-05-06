/**
 * Cowboy HTTP — admin / fleet API surface served from the control
 * plane. Mounts the same `addAdminFleetRoutes` factory workspace-api
 * uses, so the admin Gateways tab keeps responding even when no
 * gateway pods are booted. See
 * docs/architecture/GATEWAY-PLATFORM-SPEC.md §Gateway Lifecycle Manager.
 */
import express, { Router, type Express } from "express";
import type { Server } from "node:http";
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
  // Customer-detail routes (Customers tab + per-customer drawer) — same
  // factory workspace-api uses, so the tab keeps responding even when
  // no gateway pods are booted. CSI refresh is workspace-api-only (the
  // CSI compute pipeline lives there); we stub it with a 503 so the
  // admin UI can show a friendly "try again later" message.
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
      reason: "CSI refresh requires workspace-api; the gateway pod runs the compute pipeline. Try again once a gateway pod is healthy.",
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

/**
 * Firestore-only MM context read used by the customer-detail route.
 * Mirrors workspace-api's getWorkspaceMmContext but without the
 * extra workspace/agent metadata; the customer drawer only needs the
 * coach DM channel id for the "open chat" link.
 *
 * Takes the user-data hint the factory already loaded so we don't
 * re-fetch users/{uid} on every request — perf parity with the
 * workspace-api implementation.
 */
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
