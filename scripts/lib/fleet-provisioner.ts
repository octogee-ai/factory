import express from "express";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { Server } from "http";
import { GATEWAY_HEARTBEAT_INTERVAL_MS } from "../../shared/types/fleet-controller.js";
import { ActiveRestoreSet, createRestoreCustomerHandler, IdempotencyCache } from "./fleet-http.js";
import {
  createExportHandler,
  createImportHandler,
  createPushStateHandler,
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
import { removeCustomerFromGateway } from "./customer-lifecycle.js";
import type { CustomerLifecycleAdapter } from "./customer-lifecycle.js";
import { startDrainLoop } from "./drain-loop.js";
import { createDeviceAuthManager } from "./byosub-device-auth.js";
import { realDeviceAuthDeps } from "./byosub-device-auth-io.js";
import { mountByosubDeviceAuth } from "./byosub-device-auth-http.js";

const DRAIN_LOOP_INTERVAL_MS = 15 * 1000;

const PROCESS_STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);

function registerByosubDeviceAuth(
  app: express.Express,
  opts: StartFleetOptions,
): void {
  const internalServiceKey = opts.internalServiceKey ?? "";
  const openclawDir =
    opts.openclawDir ??
    (process.env.HOME
      ? `${process.env.HOME}/.openclaw`
      : "/home/node/.openclaw");
  const manager = createDeviceAuthManager(
    realDeviceAuthDeps({ openclawDir, internalServiceKey, log: opts.log }),
  );
  mountByosubDeviceAuth(app, { manager, internalServiceKey, log: opts.log });
}

export interface BuildAdapterOptions {
  db: Firestore;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  adminMmUserId: string | undefined;
}

export function buildProductionAdapter(opts: BuildAdapterOptions): CustomerLifecycleAdapter {
  return buildProductionLifecycleAdapter(opts);
}

export interface StartFleetOptions {
  db?: Firestore;
  rpc: GatewayRpcClient;
  adapter?: CustomerLifecycleAdapter;
  gatewayId: string;
  log: (msg: string) => void;
  port: number;
  secret: string;
  version: string;
  openclawVersion: string;
  adminMmUserId?: string;
  platformState?: boolean;
  enableDeviceAuthRoutes?: boolean;
  
  openclawDir?: string;

internalServiceKey?: string;
}

export interface StartedFleetController {
  stop: () => Promise<void>;

whenReady: Promise<void>;
}

function slugFromAssignedUser(data: Record<string, unknown> | undefined): string | null {
  const provisioning = data?.provisioning as Record<string, unknown> | undefined;
  const openclaw = provisioning?.openclaw as Record<string, unknown> | undefined;
  const ocSlug = typeof openclaw?.slug === "string" ? openclaw.slug : null;
  const fallbackSlug = typeof data?.username === "string" ? data.username : null;
  return ocSlug ?? fallbackSlug;
}

export async function readMountedCustomersFromAssignedState(
  db: Firestore,
  gatewayId: string,
  adapter: Pick<CustomerLifecycleAdapter, "hasCustomerDir" | "customerCoachWiredInOpenclawConfig">,
): Promise<string[]> {
  const snap = await db
    .collection("users")
    .where("provisioning.openclaw.gatewayId", "==", gatewayId)
    .where("provisioning.openclaw.status", "==", "complete")
    .get();

  const mounted = new Set<string>();
  for (const doc of snap.docs) {
    const slug = slugFromAssignedUser(doc.data() as Record<string, unknown> | undefined);
    if (!slug) continue;
    if (!adapter.hasCustomerDir(slug)) continue;
    if (
      adapter.customerCoachWiredInOpenclawConfig
      && !adapter.customerCoachWiredInOpenclawConfig(slug)
    ) {
      continue;
    }
    mounted.add(slug);
  }
  return [...mounted].sort((a, b) => a.localeCompare(b));
}

interface FleetRuntime {
  mountedCustomers: string[];
  status: "booting" | "ready";
}

function startMaybeDrainLoop(params: {
  platformState: boolean;
  opts: StartFleetOptions;
  wrappedAdapter: CustomerLifecycleAdapter;
  runtime: FleetRuntime;
}): () => void {
  const { platformState, opts, wrappedAdapter, runtime } = params;
  if (!platformState || !opts.db) return () => undefined;
  return startDrainLoop({
    gatewayId: opts.gatewayId,
    intervalMs: DRAIN_LOOP_INTERVAL_MS,
    log: opts.log,
    getMounted: () => runtime.mountedCustomers,
    readAssignedSlugs: async () => {
      const snap = await opts.db!
        .collection("users")
        .where("provisioning.openclaw.gatewayId", "==", opts.gatewayId)
        .where("provisioning.openclaw.status", "==", "complete")
        .get();
      const slugs: string[] = [];
      for (const doc of snap.docs) {
        const slug = slugFromAssignedUser(doc.data() as Record<string, unknown> | undefined);
        if (slug) slugs.push(slug);
      }
      return slugs;
    },
    unmountSlug: async (slug: string) => {
      const uid = await wrappedAdapter.uidForSlug(slug);
      if (uid) {
        const result = await removeCustomerFromGateway(wrappedAdapter, uid);
        return result.wasMounted ? "drained" : "noop";
      }

      const agentId = `octogee-${slug}-coach`;
      try {
        await wrappedAdapter.applyRemoveCustomerConfigPatch(slug, agentId);
        if (wrappedAdapter.hasCustomerDir(slug)) {
          await wrappedAdapter.deleteCustomerDir(slug);
        }
        wrappedAdapter.onUnmounted?.(slug);
        return "deleted-user";
      } catch (err) {
        throw new Error(
          `slug-only cleanup failed for ${slug} (no user doc): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
}

function createStateDeps(opts: StartFleetOptions, platformState: boolean): FleetStateDeps | null {
  if (!platformState) return null;
  if (!opts.db) {
    throw new Error("[fleet] db is required when platformState is enabled");
  }
  return {
    db: opts.db as unknown as FleetStateFirestore,
    serverTimestamp: () => FieldValue.serverTimestamp(),
    log: opts.log,
  };
}

function buildFleetAdapter(opts: StartFleetOptions): CustomerLifecycleAdapter {
  if (opts.adapter) return opts.adapter;
  if (!opts.db) {
    throw new Error("[fleet] db is required when no explicit lifecycle adapter is provided");
  }
  return buildProductionAdapter({
    db: opts.db!,
    rpc: opts.rpc,
    log: opts.log,
    adminMmUserId: opts.adminMmUserId,
  });
}

function resolveK8sNamespace(): string {
  const namespace = process.env.K8S_NAMESPACE;
  if (!namespace) {
    throw new Error(
      "[fleet] K8S_NAMESPACE env var is not set. The gateway deployment must " +
        "expose it via downward API (valueFrom.fieldRef.fieldPath=metadata.namespace) " +
        "or heartbeats will publish internalUrl with a null namespace.",
    );
  }
  return namespace;
}

function wrapAdapterWithRuntime(
  adapter: CustomerLifecycleAdapter,
  runtime: FleetRuntime,
): CustomerLifecycleAdapter {
  return {
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
}

async function seedRuntimeMountedCustomers(params: {
  opts: StartFleetOptions;
  platformState: boolean;
  wrappedAdapter: CustomerLifecycleAdapter;
  runtime: FleetRuntime;
}): Promise<void> {
  const { opts, platformState, wrappedAdapter, runtime } = params;
  try {
    if (!platformState || !opts.db) return;
    runtime.mountedCustomers = await readMountedCustomersFromAssignedState(
      opts.db,
      opts.gatewayId,
      wrappedAdapter,
    );
    if (runtime.mountedCustomers.length > 0) {
      opts.log(
        `[fleet] seeded mounted customers from assigned local state: ${runtime.mountedCustomers.join(",")}`,
      );
    }
  } catch (err) {
    opts.log(
      `[fleet] ⚠ mounted-customer seed failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function startFleetController(
  opts: StartFleetOptions,
): Promise<StartedFleetController> {
  const platformState = opts.platformState !== false;
  const stateDeps = createStateDeps(opts, platformState);
  const adapter = buildFleetAdapter(opts);

  const runtime: FleetRuntime = {
    mountedCustomers: [],
    status: "booting",
  };

  const cache = new IdempotencyCache();
  const activeRestores = new ActiveRestoreSet();

  const namespace = resolveK8sNamespace();
  const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || "18789";

const instanceName = process.env.GATEWAY_INSTANCE_NAME ?? "";
  const serviceName = instanceName ? `octogee-gateway-${instanceName}` : "octogee-gateway";
  const internalUrl = `http://${serviceName}.${namespace}.svc.cluster.local:${gatewayPort}`;

  const emitHeartbeat = async (status: HeartbeatSnapshot["status"]) => {
    if (!stateDeps) return;
    try {
      await writeGatewayHeartbeat(stateDeps, {
        gatewayId: opts.gatewayId,
        status,
        version: opts.version,
        openclawVersion: opts.openclawVersion,
        mountedCustomers: runtime.mountedCustomers,
        internalUrl, startedAt: PROCESS_STARTED_AT_MS,
      });
    } catch (err) {
      opts.log(
        `[fleet] ⚠ heartbeat write failed: ${String(err)} — will retry next tick`,
      );
    }
  };

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

  const wrappedAdapter = wrapAdapterWithRuntime(adapter, runtime);

  await seedRuntimeMountedCustomers({ opts, platformState, wrappedAdapter, runtime });

  await emitHeartbeat("booting");

  const heartbeatTimer = platformState
    ? setInterval(() => {
        void emitHeartbeat(runtime.status);
      }, GATEWAY_HEARTBEAT_INTERVAL_MS)
    : null;

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

  if (stateDeps) {
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
  }

  const migrationDeps = {
    secret: opts.secret,
    gatewayId: opts.gatewayId,
    adapter: wrappedAdapter,
    log: opts.log,
    getMountedCustomers: () => runtime.mountedCustomers,
  };
  app.post("/quiesce/:gatewayId", gatewayIdGuard, createQuiesceHandler(migrationDeps));
  app.post("/export/:gatewayId", gatewayIdGuard, createExportHandler(migrationDeps));
  app.post("/push-state/:gatewayId", gatewayIdGuard, createPushStateHandler(migrationDeps));
  app.post("/import/:gatewayId", gatewayIdGuard, createImportHandler(migrationDeps));
  app.post("/unmount/:gatewayId", gatewayIdGuard, createUnmountHandler(migrationDeps));

  if (opts.enableDeviceAuthRoutes ?? platformState) {
    registerByosubDeviceAuth(app, opts);
  }

  const stopDrainLoop = startMaybeDrainLoop({
    platformState,
    opts,
    wrappedAdapter,
    runtime,
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, "0.0.0.0", () => resolve(s));
  });
  const drainLoopStatus = platformState ? `${DRAIN_LOOP_INTERVAL_MS}ms` : "disabled";
  opts.log(
    `[fleet] listening on 0.0.0.0:${opts.port}; gatewayId=${opts.gatewayId}; platformState=${platformState}; drain-loop=${drainLoopStatus}`,
  );

return {
    whenReady: waitForGatewayReady(),
    stop: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      stopDrainLoop();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
