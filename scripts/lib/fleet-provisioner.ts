import express from "express";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { Server } from "http";
import { GATEWAY_HEARTBEAT_INTERVAL_MS } from "../../shared/types/fleet-controller.js";
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
import { removeCustomerFromGateway } from "./customer-lifecycle.js";
import type { CustomerLifecycleAdapter } from "./customer-lifecycle.js";
import { startDrainLoop } from "./drain-loop.js";
import { createDeviceAuthManager } from "./byosub-device-auth.js";
import { realDeviceAuthDeps } from "./byosub-device-auth-io.js";
import { mountByosubDeviceAuth } from "./byosub-device-auth-http.js";

const DRAIN_LOOP_INTERVAL_MS = 15 * 1000;

/**
 * BYO-sub device-auth (C1b). Guarded by X-Internal-Service-Key (not the
 * fleet signature) — the only caller is workspace-api's
 * gatewayDeviceAuthClient over K8s DNS. The codex child runs with the
 * per-agent CODEX_HOME so its auth.json lands where Chunk A/B expect.
 */
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
  /** BYO-sub device-auth (C1b): where per-agent codex-homes live. */
  openclawDir?: string;
  /** Shared internal-service key — guards the device-auth endpoints and
   * authenticates the in-pod capture POST to workspace-api. */
  internalServiceKey?: string;
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
  // GATEWAY_INSTANCE_NAME is set by the Helm chart (instances.{name} key).
  // The per-instance Service is named `octogee-gateway-{name}`. Pre-refactor
  // Helm releases didn't set this env; absent → fall back to the legacy
  // alias Service `octogee-gateway` so an in-place upgrade keeps working
  // until the chart refactor lands. Once everywhere is on the new chart,
  // GATEWAY_INSTANCE_NAME is always set and this fallback is dead code.
  const instanceName = process.env.GATEWAY_INSTANCE_NAME ?? "";
  const serviceName = instanceName ? `octogee-gateway-${instanceName}` : "octogee-gateway";
  const internalUrl = `http://${serviceName}.${namespace}.svc.cluster.local:${gatewayPort}`;

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

  // Define the readiness poller but DON'T fire it yet. Invariant:
  // `void waitForGatewayReady()` must only run AFTER the express server
  // is listening (the call site lower in this function fires it once
  // `app.listen` resolves). `status=ready` must mean BOTH OpenClaw RPC
  // is up AND our own Express server is accepting connections —
  // otherwise the fleet-controller can dispatch a Cloud Task into a
  // still-bootstrapping pod.
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
    getMountedCustomers: () => runtime.mountedCustomers,
  };
  app.post("/quiesce/:gatewayId", gatewayIdGuard, createQuiesceHandler(migrationDeps));
  app.post("/export/:gatewayId", gatewayIdGuard, createExportHandler(migrationDeps));
  app.post("/import/:gatewayId", gatewayIdGuard, createImportHandler(migrationDeps));
  app.post("/unmount/:gatewayId", gatewayIdGuard, createUnmountHandler(migrationDeps));

  registerByosubDeviceAuth(app, opts);

  const stopDrainLoop = startDrainLoop({
    gatewayId: opts.gatewayId,
    intervalMs: DRAIN_LOOP_INTERVAL_MS,
    log: opts.log,
    getMounted: () => runtime.mountedCustomers,
    readAssignedSlugs: async () => {
      const snap = await opts.db
        .collection("users")
        .where("provisioning.openclaw.gatewayId", "==", opts.gatewayId)
        .where("provisioning.openclaw.status", "==", "complete")
        .get();
      const slugs: string[] = [];
      for (const doc of snap.docs) {
        const data = doc.data() as Record<string, unknown> | undefined;
        const oc = (data?.provisioning as Record<string, unknown> | undefined)?.openclaw as
          | Record<string, unknown>
          | undefined;
        // Match the adapter's `loadUserSnapshot` / `uidForSlug` semantics:
        // `provisioning.openclaw.slug` is canonical, but legacy / partial
        // user docs may only have `username`. Reading the same way the
        // rest of the lifecycle code does means a user doc the drain loop
        // can't see is one no other code can either.
        const ocSlug = typeof oc?.slug === "string" ? (oc.slug as string) : null;
        const fallbackSlug = typeof data?.username === "string" ? (data.username as string) : null;
        const slug = ocSlug ?? fallbackSlug;
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
      // No user doc — typically the nuke flow deleted users/{uid} but the
      // gateway's emptyDir still has on-disk state. Clean up directly via
      // the adapter primitives (config patch + dir delete) so the orphan
      // doesn't persist forever.
      const agentId = `octogee-${slug}-coach`;
      try {
        await wrappedAdapter.applyRemoveCustomerConfigPatch(slug, agentId);
        if (wrappedAdapter.hasCustomerDir(slug)) {
          await wrappedAdapter.deleteCustomerDir(slug);
        }
        wrappedAdapter.onUnmounted?.(slug);
        return "deleted-user";
      } catch (err) {
        // Surface as a thrown error so the drain loop logs it as a
        // failure rather than silently swallowing.
        throw new Error(
          `slug-only cleanup failed for ${slug} (no user doc): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, "0.0.0.0", () => resolve(s));
  });
  opts.log(
    `[fleet] listening on 0.0.0.0:${opts.port}; gatewayId=${opts.gatewayId}; drain-loop interval=${DRAIN_LOOP_INTERVAL_MS}ms`,
  );

  // NOW poll for OpenClaw readiness. Sequencing matters: by waiting
  // until the Express server is listening, `status=ready` becomes an
  // accurate signal that the pod can serve `/restore-customer`,
  // `/quiesce`, and `/unmount` traffic from the fleet-control Ingress.
  // Earlier the readiness poller fired on `void waitForGatewayReady()`
  // immediately after the booting heartbeat, which could flip
  // `status=ready` before `app.listen()` ever ran — letting Cloud
  // Tasks dispatch into a pod whose Express server wasn't accepting
  // connections yet, hitting a 3+ minute timeout/retry loop on
  // first-customer-after-add.
  void waitForGatewayReady();

  return {
    stop: async () => {
      clearInterval(heartbeatTimer);
      stopDrainLoop();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
