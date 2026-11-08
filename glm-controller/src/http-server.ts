

import express, { Router, type Express, type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { publicAppOriginsFromEnv } from "@octogee/core/public-app-origins";
import { renderMetrics } from "./metrics.js";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { BuilderAccountReader } from "@octogee/core/builder-account";
import {
  addAdminFleetRoutes,
  type FleetLogger,
  type GatewayPodDiagnostics,
} from "@octogee/core/admin-fleet-router";
import type { CentralReleaseAuthority } from "@octogee/core/artifact-registry";
import type {
  PlatformStateStore,
  WatchAggregate,
  WatchRequest,
  WatchSubscription,
} from "@octogee/core/platform-state";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
} from "@octogee/shared/types/glm";
import { addAdminCustomerRoutes } from "@octogee/core/admin-customer-router";
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

export type ProductAdminRoutes = (
  router: Router,
  deps: { db: Firestore; FieldValue: { serverTimestamp: () => unknown } },
) => void;

export interface HttpServerDeps {
  addProductAdminRoutes?: ProductAdminRoutes;
  db: Firestore;
  store: PlatformStateStore;
  accounts: BuilderAccountReader;
  verifyIdToken: RequireAdminDeps["verifyIdToken"];
  log: (msg: string) => void;
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

interface FleetEventWatch {
  readonly collection: string;
  readonly request: WatchRequest<WatchAggregate>;
}

const FLEET_EVENT_WATCHES: readonly FleetEventWatch[] = [
  { collection: "users", request: { aggregate: "builders", filter: {} } },
  { collection: "gateways", request: { aggregate: "gateways", filter: {} } },
  { collection: "config", request: { aggregate: "config", filter: {} } },
  { collection: GLM_GATEWAYS_COLLECTION, request: { aggregate: "fleetRegistry", filter: {} } },
  {
    collection: GLM_OPERATIONS_COLLECTION,
    request: { aggregate: "operations", filter: { statuses: ACTIVE_OPERATION_STATUSES } },
  },
];

function createFleetEventHub(deps: {
  store: Pick<PlatformStateStore, "watch">;
  log: (msg: string) => void;
  lingerMs: number;
}): FleetEventHub {
  const subscribers = new Set<(event: FleetEvent) => void>();
  let subscriptions: WatchSubscription[] | null = null;
  let lingerTimer: NodeJS.Timeout | null = null;

  const emit = (event: FleetEvent) => {
    for (const subscriber of [...subscribers]) subscriber(event);
  };

  const reportFailure = (collection: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`[glm-controller] fleet event watch failed collection=${collection}: ${message}`);
    emit({ kind: "error", collection, error: message });
  };

  const watch = ({ collection, request }: FleetEventWatch): WatchSubscription => {
    let primed = false;
    const subscription = deps.store.watch(request, {
      onEvent: (event) => {
        if (event.kind === "resync") return;
        if (!primed) {
          primed = true;
          return;
        }
        emit({ kind: "changed", collection, at: Date.now() });
      },
      onError: (error) => reportFailure(collection, error),
    });
    subscription.closed.catch((error: unknown) => reportFailure(collection, error));
    return subscription;
  };

  const ensureWatchers = () => {
    if (subscriptions) return;
    subscriptions = FLEET_EVENT_WATCHES.map(watch);
  };

  const teardown = () => {
    for (const subscription of subscriptions ?? []) void subscription.close();
    subscriptions = null;
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
      store: deps.store,
      accounts: deps.accounts,
      log: deps.log,
    }),
  );

  addAdminFleetEventRoute(
    adminRouter,
    createFleetEventHub({
      store: deps.store,
      log: deps.log,
      lingerMs: deps.fleetEventListenerLingerMs ?? FLEET_EVENT_LINGER_MS_DEFAULT,
    }),
  );

  addAdminCustomerRoutes(adminRouter, {
    db: deps.db,
    store: deps.store,
    FieldValue,
    logger: adaptLogger(deps.log),
  });
  deps.addProductAdminRoutes?.(adminRouter, { db: deps.db, FieldValue });
  addAdminFleetRoutes(adminRouter, {
    computerReplacementEnabled: true,
    db: deps.db,
    store: deps.store,
    logger: adaptLogger(deps.log),
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
