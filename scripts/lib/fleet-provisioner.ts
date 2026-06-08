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
  // Read-only observability (seed + report mounted customers, write this
  // gateway's own liveness heartbeat) — independent of platformState (write-side
  // provisioning). Defaults true; operator gateways set it true while
  // platformState stays false. See OPERATOR-GATEWAY-DURABILITY-SPEC §4.
  reportState?: boolean;
  enableDeviceAuthRoutes?: boolean;
  
  openclawDir?: string;

internalServiceKey?: string;
}

export interface StartedFleetController {
  stop: () => Promise<void>;

whenReady: Promise<void>;
}

export interface FleetCapabilities {
  /** Read the assigned roster + write this gateway's own liveness/mounted
   *  heartbeat (observability). Independent of provisioning. */
  reportMounted: boolean;
  /** Run the write-side platform provisioner: restore-customer, drain loop,
   *  byosub device-auth. Off inside the locked operator boundary. */
  provision: boolean;
  /** Re-derive the reported mounted set from assigned state each heartbeat.
   *  On for report-only (operator) gateways, which have no drain loop to drop a
   *  customer who moved away; off for provisioning gateways (the drain loop +
   *  mount callbacks already keep runtime.mountedCustomers honest). */
  refreshReportedMounts: boolean;
  /** At least one capability needs Firestore write deps (own heartbeat +
   *  glmGateways mirror, or restore jobs). */
  needsStateDeps: boolean;
}

// The observability-vs-provisioning seam (OPERATOR-GATEWAY-DURABILITY-SPEC §4):
// operator gateways report (reportState) WITHOUT provisioning (platformState).
// Both require a Firestore handle, so each capability also gates on hasDb.
export function resolveFleetCapabilities(opts: {
  platformState: boolean;
  reportState: boolean;
  hasDb: boolean;
}): FleetCapabilities {
  const reportMounted = opts.reportState && opts.hasDb;
  const provision = opts.platformState && opts.hasDb;
  const refreshReportedMounts = reportMounted && !provision;
  return {
    reportMounted,
    provision,
    refreshReportedMounts,
    needsStateDeps: reportMounted || provision,
  };
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
  provision: boolean;
  opts: StartFleetOptions;
  wrappedAdapter: CustomerLifecycleAdapter;
  runtime: FleetRuntime;
}): () => void {
  const { provision, opts, wrappedAdapter, runtime } = params;
  if (!provision || !opts.db) return () => undefined;
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

function createStateDeps(opts: StartFleetOptions, needsState: boolean): FleetStateDeps | null {
  if (!needsState) return null;
  if (!opts.db) {
    throw new Error("[fleet] db is required when platformState or reportState is enabled");
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
  reportMounted: boolean;
  wrappedAdapter: CustomerLifecycleAdapter;
  runtime: FleetRuntime;
}): Promise<void> {
  const { opts, reportMounted, wrappedAdapter, runtime } = params;
  try {
    if (!reportMounted || !opts.db) return;
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

/**
 * Re-derive a report-only gateway's mounted set from assigned state each heartbeat.
 * Operator gateways have no drain loop, so a customer who moved to another gateway
 * would otherwise linger in `mountedCustomers` forever — blocking retire and
 * mis-accounting the fleet. Honest reporting per OPERATOR-GATEWAY-DURABILITY-SPEC §4.1
 * (assigned ∩ has-dir ∩ coach-wired). Provisioning gateways skip this: their drain
 * loop + mount callbacks already keep runtime.mountedCustomers honest.
 *
 * Last-writer-wins: a slow refresh can briefly lose a concurrent onMounted during a
 * migration onto an operator gateway, but the next tick re-derives and reconverges,
 * so the under-report is transient and acceptable for a pinned single-owner pod.
 */
export async function maybeRefreshReportedMounts(params: {
  refresh: boolean;
  db: Firestore | undefined;
  gatewayId: string;
  adapter: Pick<
    CustomerLifecycleAdapter,
    "hasCustomerDir" | "customerCoachWiredInOpenclawConfig"
  >;
  runtime: { mountedCustomers: string[] };
  log: (msg: string) => void;
}): Promise<void> {
  if (!params.refresh || !params.db) return;
  try {
    params.runtime.mountedCustomers = await readMountedCustomersFromAssignedState(
      params.db,
      params.gatewayId,
      params.adapter,
    );
  } catch (err) {
    params.log(
      `[fleet] ⚠ mounted-customer refresh failed (keeping prior set): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export async function startFleetController(
  opts: StartFleetOptions,
): Promise<StartedFleetController> {
  const platformState = opts.platformState !== false;
  const reportState = opts.reportState !== false;
  const caps = resolveFleetCapabilities({ platformState, reportState, hasDb: !!opts.db });
  const stateDeps = createStateDeps(opts, caps.needsStateDeps);
  const adapter = buildFleetAdapter(opts);

  const runtime: FleetRuntime = {
    mountedCustomers: [],
    status: "booting",
  };

  const cache = new IdempotencyCache();
  const activeRestores = new ActiveRestoreSet();

  const namespace = resolveK8sNamespace();
  const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || "18789";

const serviceName = `octogee-gateway-${opts.gatewayId}`;
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

  await seedRuntimeMountedCustomers({ opts, reportMounted: caps.reportMounted, wrappedAdapter, runtime });

  await emitHeartbeat("booting");

  const heartbeatTimer = caps.reportMounted
    ? setInterval(() => {
        void (async () => {
          await maybeRefreshReportedMounts({
            refresh: caps.refreshReportedMounts,
            db: opts.db,
            gatewayId: opts.gatewayId,
            adapter: wrappedAdapter,
            runtime,
            log: opts.log,
          });
          await emitHeartbeat(runtime.status);
        })();
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

  if (caps.provision && stateDeps) {
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

  if (opts.enableDeviceAuthRoutes ?? caps.provision) {
    registerByosubDeviceAuth(app, opts);
  }

  const stopDrainLoop = startMaybeDrainLoop({
    provision: caps.provision,
    opts,
    wrappedAdapter,
    runtime,
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, "0.0.0.0", () => resolve(s));
  });
  const drainLoopStatus = caps.provision ? `${DRAIN_LOOP_INTERVAL_MS}ms` : "disabled";
  const reportRefreshStatus = caps.refreshReportedMounts
    ? `${GATEWAY_HEARTBEAT_INTERVAL_MS}ms`
    : "off";
  opts.log(
    `[fleet] listening on 0.0.0.0:${opts.port}; gatewayId=${opts.gatewayId}; platformState=${platformState}; reportState=${reportState}; drain-loop=${drainLoopStatus}; report-refresh=${reportRefreshStatus}`,
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
