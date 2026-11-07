

import express, { Router, type Express, type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { publicAppOriginsFromEnv } from "@octogee/core/public-app-origins";
import { renderMetrics } from "./metrics.js";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  addAdminFleetRoutes,
  type FleetLogger,
  type GatewayPodDiagnostics,
} from "@octogee/core/admin-fleet-router";
import type { CentralReleaseAuthority } from "@octogee/core/artifact-registry";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
} from "@octogee/shared/types/glm";
import {
  addAdminCustomerRoutes,
  type WorkspaceMmContextLite,
} from "@octogee/core/admin-customer-router";
import {
  createRequireAdmin,
  type RequireAdminDeps,
} from "./middleware/auth.js";

const ALLOWED_ORIGINS = new Set(publicAppOriginsFromEnv());

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin) ||
    (process.env.OCTOGEE_ALLOW_LOCAL_ORIGINS === "true" && /^http:\/\/localhost:\d+$/.test(origin));
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
  releaseEnvironment?: "test" | "prod" | null;
  releaseAuthority?: CentralReleaseAuthority;
  readGatewayPodDiagnostics?: (gatewayId: string) => Promise<GatewayPodDiagnostics>;
  readGatewayPodDiagnosticsBatch?: (
    gatewayIds: readonly string[],
  ) => Promise<Record<string, GatewayPodDiagnostics>>;
  requestNativeReturnSourceRecovery?: (input: { uid: string; operationId: string; requestedAt: number; requestedBy: string }) => Promise<boolean>;
  suspendAuthUser: (uid: string) => Promise<void>;
  revokeConnectorGrantsForUser: (uid: string) => Promise<void>;
  fleetEventListenerLingerMs?: number;
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

// A dropped SSE stream (LB idle timeout, tab reconnect) must not re-buy the
// initial snapshot of every watched collection: watchers are shared across all
// connections and outlive the last one by lingerMs.
const FLEET_EVENT_LINGER_MS_DEFAULT = 10 * 60_000;

const ACTIVE_OPERATION_STATUSES = ["pending", "running"] as const;

type FleetEvent =
  | { kind: "changed"; collection: string; at: number }
  | { kind: "error"; collection: string; error: string };

interface FleetEventHub {
  subscribe(handler: (event: FleetEvent) => void): () => void;
}

interface FleetEventWatchTarget {
  onSnapshot(
    next: (snap: unknown) => void,
    onError: (err: unknown) => void,
  ): () => void;
}

function createFleetEventHub(deps: {
  db: Firestore;
  log: (msg: string) => void;
  lingerMs: number;
}): FleetEventHub {
  const subscribers = new Set<(event: FleetEvent) => void>();
  const primed = new Set<string>();
  let unsubscribes: Array<() => void> | null = null;
  let lingerTimer: NodeJS.Timeout | null = null;

  const emit = (event: FleetEvent) => {
    for (const subscriber of [...subscribers]) subscriber(event);
  };

  const watch = (collection: string, target: FleetEventWatchTarget) =>
    target.onSnapshot(
      () => {
        if (!primed.has(collection)) {
          primed.add(collection);
          return;
        }
        emit({ kind: "changed", collection, at: Date.now() });
      },
      (err) => {
        deps.log(
          `[glm-controller] fleet event watch failed collection=${collection}: ${
            (err as Error)?.message ?? String(err)
          }`,
        );
        emit({
          kind: "error",
          collection,
          error: (err as Error)?.message ?? "watch failed",
        });
      },
    );

  const ensureWatchers = () => {
    if (unsubscribes) return;
    primed.clear();
    unsubscribes = [
      watch("users", deps.db.collection("users")),
      watch("gateways", deps.db.collection("gateways")),
      watch("config", deps.db.collection("config")),
      watch(GLM_GATEWAYS_COLLECTION, deps.db.collection(GLM_GATEWAYS_COLLECTION)),
      watch(
        GLM_OPERATIONS_COLLECTION,
        deps.db
          .collection(GLM_OPERATIONS_COLLECTION)
          .where("status", "in", [...ACTIVE_OPERATION_STATUSES]),
      ),
    ];
  };

  const teardown = () => {
    for (const unsubscribe of unsubscribes ?? []) unsubscribe();
    unsubscribes = null;
    primed.clear();
  };

  return {
    subscribe(handler) {
      if (lingerTimer) {
        clearTimeout(lingerTimer);
        lingerTimer = null;
      }
      subscribers.add(handler);
      ensureWatchers();
      return () => {
        subscribers.delete(handler);
        if (subscribers.size > 0 || lingerTimer) return;
        if (deps.lingerMs <= 0) {
          teardown();
          return;
        }
        lingerTimer = setTimeout(() => {
          lingerTimer = null;
          if (subscribers.size === 0) teardown();
        }, deps.lingerMs);
        lingerTimer.unref?.();
      };
    },
  };
}

function addAdminFleetEventRoute(
  router: Router,
  hub: FleetEventHub,
): void {
  router.get("/fleet-events", (req: Request, res: Response) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const closeAfterFirstChange = req.query.once === "1";
    const keepalive = setInterval(() => {
      if (!closed) res.write(": keepalive\n\n");
    }, 30_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsubscribe();
      res.end();
    };

    writeSseEvent(res, "ready", { at: Date.now() });
    unsubscribe = hub.subscribe((event) => {
      if (closed) return;
      if (event.kind === "changed") {
        writeSseEvent(res, "changed", { collection: event.collection, at: event.at });
        if (closeAfterFirstChange) close();
        return;
      }
      writeSseEvent(res, "error", { collection: event.collection, error: event.error });
    });
    req.on("close", close);
  });
}

function addHealthAndMetricsRoutes(app: Express): void {
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "glm-controller" });
  });

  app.get("/metrics", (_req, res) => {
    res.set("Content-Type", "text/plain; version=0.0.4");
    res.end(renderMetrics());
  });
}

export function createHttpServer(deps: HttpServerDeps): Express {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json());

  addHealthAndMetricsRoutes(app);

  const adminRouter = Router();
  adminRouter.use(
    createRequireAdmin({
      verifyIdToken: deps.verifyIdToken,
      db: deps.db,
      log: deps.log,
    }),
  );

  addAdminFleetEventRoute(
    adminRouter,
    createFleetEventHub({
      db: deps.db,
      log: deps.log,
      lingerMs: deps.fleetEventListenerLingerMs ?? FLEET_EVENT_LINGER_MS_DEFAULT,
    }),
  );

  addAdminCustomerRoutes(adminRouter, {
    db: deps.db,
    FieldValue,
    logger: adaptLogger(deps.log),
    workspaceSlugsForUser: deps.workspaceSlugsForUser,
    getWorkspaceMmContext: (uid, hint) => readMmContextFromFirestore(deps.db, uid, hint),
  });
  addAdminFleetRoutes(adminRouter, {
    computerReplacementEnabled: true,
    db: deps.db,
    logger: adaptLogger(deps.log),
    workspaceSlugsForUser: deps.workspaceSlugsForUser,
    provisionGatewayAuthSecret: deps.provisionGatewayAuthSecret,
    listGatewayBuilds: deps.listGatewayBuilds,
    releaseEnvironment: deps.releaseEnvironment,
    releaseAuthority: deps.releaseAuthority,
    readGatewayPodDiagnostics: deps.readGatewayPodDiagnostics,
    readGatewayPodDiagnosticsBatch: deps.readGatewayPodDiagnosticsBatch,
    requestNativeReturnSourceRecovery: deps.requestNativeReturnSourceRecovery,
    suspendAuthUser: deps.suspendAuthUser,
    revokeConnectorGrantsForUser: deps.revokeConnectorGrantsForUser,
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
