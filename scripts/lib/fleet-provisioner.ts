import express from "express";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { Server } from "http";
import {
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  GATEWAYS_COLLECTION,
} from "../../shared/types/fleet-controller.js";
import { ActiveRestoreSet, createRestoreCustomerHandler, IdempotencyCache } from "./fleet-http.js";
import {
  createExportHandler,
  createImportHandler,
  createQuiesceHandler,
  createUnmountHandler,
} from "./fleet-http-migration.js";
import {
  writeGatewayHeartbeat,
  type FleetStateDeps,
  type FleetStateFirestore,
  type HeartbeatSnapshot,
} from "./fleet-state.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
import { buildProductionLifecycleAdapter } from "./customer-lifecycle-prod-adapter.js";
import type { CustomerLifecycleAdapter } from "./customer-lifecycle.js";

export interface BuildAdapterOptions {
  db: Firestore;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  adminMmUserId: string | undefined;
}

/**
 * @deprecated Use `buildProductionLifecycleAdapter` from
 * `./customer-lifecycle-prod-adapter.js`.
 */
export function buildProductionAdapter(opts: BuildAdapterOptions): CustomerLifecycleAdapter {
  return buildProductionLifecycleAdapter(opts);
}

export interface StartFleetOptions {
  db: Firestore;
  rpc: GatewayRpcClient;
  gatewayId: string;
  log: (msg: string) => void;
  port: number;
  secret: string;
  version: string;
  openclawVersion: string;
  adminMmUserId?: string;
}

export interface StartedFleetController {
  stop: () => Promise<void>;
}

export async function startFleetController(
  opts: StartFleetOptions,
): Promise<StartedFleetController> {
  const stateDeps: FleetStateDeps = {
    db: opts.db as unknown as FleetStateFirestore,
    serverTimestamp: () => FieldValue.serverTimestamp(),
    log: opts.log,
  };

  const adapter = buildProductionAdapter({
    db: opts.db,
    rpc: opts.rpc,
    log: opts.log,
    adminMmUserId: opts.adminMmUserId,
  });

  const runtime: {
    mountedCustomers: string[];
    status: "booting" | "ready";
  } = {
    mountedCustomers: [],
    status: "booting",
  };

  const cache = new IdempotencyCache();
  const activeRestores = new ActiveRestoreSet();

  const namespace = process.env.K8S_NAMESPACE;
  if (!namespace) {
    throw new Error(
      "[fleet] K8S_NAMESPACE env var is not set. The gateway deployment must " +
        "expose it via downward API (valueFrom.fieldRef.fieldPath=metadata.namespace) " +
        "or heartbeats will publish internalUrl with a null namespace.",
    );
  }
  const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || "18789";
  const internalUrl = `http://octogee-gateway.${namespace}.svc.cluster.local:${gatewayPort}`;

  const emitHeartbeat = async (status: HeartbeatSnapshot["status"]) => {
    try {
      await writeGatewayHeartbeat(stateDeps, {
        gatewayId: opts.gatewayId,
        status,
        version: opts.version,
        openclawVersion: opts.openclawVersion,
        mountedCustomers: runtime.mountedCustomers,
        internalUrl,
      });
    } catch (err) {
      opts.log(
        `[fleet] ⚠ heartbeat write failed: ${String(err)} — will retry next tick`,
      );
    }
  };

  await emitHeartbeat("booting");

  const waitForGatewayReady = async (): Promise<void> => {
    while (runtime.status !== "ready") {
      try {
        const up = await opts.rpc.isGatewayUp(10_000);
        if (up) {
          runtime.status = "ready";
          opts.log(
            `[fleet] gateway RPC up; transitioning gateways/${opts.gatewayId} to status=ready`,
          );
          await emitHeartbeat("ready");
          return;
        }
      } catch {
        // ignore
      }
      await new Promise<void>((r) => setTimeout(r, 1_000));
    }
  };
  void waitForGatewayReady();

  const heartbeatTimer = setInterval(() => {
    void emitHeartbeat(runtime.status);
  }, GATEWAY_HEARTBEAT_INTERVAL_MS);

  const app = express();
  app.disable("x-powered-by");
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({
      status: runtime.status,
      gatewayId: opts.gatewayId,
      mounted: runtime.mountedCustomers.length,
    });
  });

  const wrappedAdapter = {
    ...adapter,
    onMounted: (slug: string) => {
      if (!runtime.mountedCustomers.includes(slug)) {
        runtime.mountedCustomers = [...runtime.mountedCustomers, slug];
      }
    },
    onUnmounted: (slug: string) => {
      runtime.mountedCustomers = runtime.mountedCustomers.filter((s) => s !== slug);
    },
  };

  const gatewayIdGuard: express.RequestHandler = (req, res, next) => {
    if (req.params.gatewayId !== opts.gatewayId) {
      opts.log(
        `[fleet-http] ⚠ path gatewayId=${req.params.gatewayId} does not match this pod's gatewayId=${opts.gatewayId} — rejecting`,
      );
      res.status(400).json({
        error: "path gatewayId does not match this gateway",
        pathGatewayId: req.params.gatewayId,
        podGatewayId: opts.gatewayId,
      });
      return;
    }
    next();
  };

  app.post(
    "/restore-customer/:gatewayId",
    gatewayIdGuard,
    createRestoreCustomerHandler({
      secret: opts.secret,
      gatewayId: opts.gatewayId,
      stateDeps,
      activeRestores,
      adapter: wrappedAdapter,
      cache,
      log: opts.log,
    }),
  );

  const migrationDeps = {
    secret: opts.secret,
    gatewayId: opts.gatewayId,
    adapter: wrappedAdapter,
    log: opts.log,
  };
  app.post("/quiesce/:gatewayId", gatewayIdGuard, createQuiesceHandler(migrationDeps));
  app.post("/export/:gatewayId", gatewayIdGuard, createExportHandler(migrationDeps));
  app.post("/import/:gatewayId", gatewayIdGuard, createImportHandler(migrationDeps));
  app.post("/unmount/:gatewayId", gatewayIdGuard, createUnmountHandler(migrationDeps));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, "0.0.0.0", () => resolve(s));
  });
  opts.log(
    `[fleet] listening on 0.0.0.0:${opts.port}; gatewayId=${opts.gatewayId}`,
  );

  return {
    stop: async () => {
      clearInterval(heartbeatTimer);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
