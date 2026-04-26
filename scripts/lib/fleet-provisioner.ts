/**
 * Gateway-side integration of the fleet controller architecture.
 *
 *   - Writes `gateways/{gatewayId}` heartbeat every GATEWAY_HEARTBEAT_INTERVAL_MS.
 *   - Starts an HTTPS-ready server on `FLEET_CONTROLLER_PORT` bound to 0.0.0.0
 *     so Cloud Tasks can push jobs in-cluster.
 *   - Composes the production `CustomerLifecycleAdapter` by wrapping the real
 *     git/blob-sync/apply-config-patch/rpc helpers.
 *
 * Always-on — greenfield, no feature flag. The provisioner calls
 * `startFleetController()` unconditionally at boot.
 *
 * Spec: docs/GATEWAY-FLEET-CONTROLLER-SPEC.md
 */

import express from "express";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { Server } from "http";
import {
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  GATEWAYS_COLLECTION,
} from "../../shared/types/fleet-controller.js";
import { ActiveRestoreSet, createRestoreCustomerHandler, IdempotencyCache } from "./fleet-http.js";
import {
  writeGatewayHeartbeat,
  type FleetStateDeps,
  type FleetStateFirestore,
  type HeartbeatSnapshot,
} from "./fleet-state.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
import { buildProductionLifecycleAdapter } from "./customer-lifecycle-prod-adapter.js";
import type { CustomerLifecycleAdapter } from "./customer-lifecycle.js";

// ── Stub kept for back-compat with anything still importing the old name. ──
// The lifecycle adapter is the single per-customer side-effect surface now.

export interface BuildAdapterOptions {
  db: Firestore;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  adminMmUserId: string | undefined;
}

/**
 * @deprecated Use `buildProductionLifecycleAdapter` from
 * `./customer-lifecycle-prod-adapter.js`. Kept as a thin re-export so
 * downstream callers can migrate at their own pace.
 */
export function buildProductionAdapter(opts: BuildAdapterOptions): CustomerLifecycleAdapter {
  return buildProductionLifecycleAdapter(opts);
}

// ── Heartbeat + HTTP server ─────────────────────────────────────────────────

export interface StartFleetOptions {
  db: Firestore;
  rpc: GatewayRpcClient;
  gatewayId: string;
  log: (msg: string) => void;
  /** Env-var resolved value. Defaults to 3003 upstream of this call. */
  port: number;
  /** HMAC secret shared with the controller. */
  secret: string;
  /** Gateway build SHA — injected via BUILD_SHA env var. */
  version: string;
  /** `openclaw --version` output. */
  openclawVersion: string;
  /** Admin MM user id for allowlist building. Optional. */
  adminMmUserId?: string;
}

export interface StartedFleetController {
  /** Stop the heartbeat timer + close the HTTP server. Idempotent. */
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

  // Local mirror of gateway state so the heartbeat payload is accurate.
  // mountedCustomers reflects what's actually mounted on this pod;
  // markJobDoneAndGatewayAcked updates the Firestore side on completion.
  // We deliberately do NOT track inFlightJobId here — that field is
  // controller-owned (controller sets on enqueue, gateway clears on
  // completion via markJob*AndGatewayAcked). Writing it from the
  // heartbeat would stomp the controller's value every 15s and break
  // pick-next serialization. See §Writer split in the spec.
  const runtime: {
    mountedCustomers: string[];
    status: "booting" | "ready";
  } = {
    mountedCustomers: [],
    status: "booting",
  };

  // `mountedCustomers` starts EMPTY on every pod boot. This reflects the
  // emptyDir reality: openclaw.json on disk was regenerated from the
  // template and only carries the default account — no customer accounts
  // are actually mounted in the OpenClaw runtime. Firestore may still hold
  // the previous pod's mountedCustomers list, but that list is stale from
  // the moment this pod starts.
  //
  // Earlier versions of this code read Firestore's `mountedCustomers` and
  // used it as local state ("so a pod restart mid-restore doesn't re-mount
  // everyone"). That was a PVC-era assumption — when gateways were pets
  // with persistent disks, the mounts survived pod cycles. Under the
  // cattle-gateway emptyDir model, the mounts DON'T survive, and
  // preserving the stale list makes the fleet controller's pick-next see
  // all customers as "already mounted" → noop-none-pending → customers
  // never come back. Observed post-#668 deploy on TEST 2026-04-23:
  // gateway booted, flipped to ready, 6 prior customers stayed in the
  // Firestore mountedCustomers list, no restore tasks fired.
  //
  // The first heartbeat after boot writes the empty list to Firestore;
  // the controller's `gateways/` onWrite trigger sees the transition and
  // enqueues the first restore task. Subsequent restore completions
  // append to `mountedCustomers` as they land.

  const cache = new IdempotencyCache();
  const activeRestores = new ActiveRestoreSet();

  // Canonical cluster-internal URL for this gateway's OpenClaw RPC. Consumed
  // by chat-proxy to open per-user upstream WS connections. Env vars resolve
  // at boot and stay constant for the pod's lifetime, so we compute once.
  // Env resolution matches createGatewayRpc's (OPENCLAW_GATEWAY_PORT falling
  // back to GATEWAY_PORT) so the heartbeat publishes the same port the
  // gateway is actually listening on when only the legacy var is set.
  //
  // Service name is `octogee-gateway` (no `-${gatewayId}` suffix) — the helm
  // chart creates one Service per namespace, not per gatewayId. Using the
  // suffix here broke chat-proxy upstream WS on 2026-04-24 after a --full
  // teardown wiped the Firestore doc (no field to compare against, every
  // heartbeat wrote the wrong URL, chat-proxy got ENOTFOUND).
  //
  // K8S_NAMESPACE must be set on the gateway deployment via downward API
  // (see helm chart); the old `|| "octogee"` default silently pinned test
  // pods to the prod namespace on writes.
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

  // Initial "booting" heartbeat — controller knows the pod exists but is
  // not yet ready for jobs. Flips to "ready" once the gateway RPC answers
  // (see waitForGatewayReady below).
  await emitHeartbeat("booting");

  // Background poll: once the gateway RPC answers, transition to ready.
  //
  // A prior iteration of this code waited for the ops bot's
  // `channels.status` entry to report `running + connected` so the log
  // window between "booting" and "ready" was quiet. That gate went wrong
  // twice (wrong account key, then wrong response-shape assumptions) and
  // each miss left the fleet hung — controller won't enqueue restore
  // jobs against a non-ready gateway, so customers stopped provisioning
  // on TEST. The simple RPC-up check is noisy during openclaw's plugin-
  // load window (ECONNREFUSED / ws-open-timeout for ~90s) but it's the
  // outcome the fleet needs, so we're back to it.
  const waitForGatewayReady = async (): Promise<void> => {
    while (runtime.status !== "ready") {
      try {
        const up = await opts.rpc.isGatewayUp(2_000);
        if (up) {
          runtime.status = "ready";
          opts.log(
            `[fleet] gateway RPC up; transitioning gateways/${opts.gatewayId} to status=ready`,
          );
          await emitHeartbeat("ready");
          return;
        }
      } catch {
        // Ignore; keep polling.
      }
      await new Promise<void>((r) => setTimeout(r, 1_000));
    }
  };
  void waitForGatewayReady();

  // Periodic heartbeat. Keeps gateways/{id}.lastHeartbeatAt fresh even
  // when no jobs are flowing, so the controller's reconciler can
  // distinguish "idle gateway" from "dead gateway".
  const heartbeatTimer = setInterval(() => {
    void emitHeartbeat(runtime.status);
  }, GATEWAY_HEARTBEAT_INTERVAL_MS);

  // HTTP server. Raw body capture is required so the signature verifier
  // can sign against byte-exact bytes.
  const app = express();
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
      // inFlightJobId is controller-owned (spec §Writer split); not tracked
      // by the gateway. Reader should query gateways/{id}.inFlightJobId in
      // Firestore for the authoritative answer.
    });
  });

  // The controller's URL shape is `{FLEET_PROXY_BASE_URL}/{gatewayId}`, so
  // the path on this pod arrives with the gatewayId as a trailing segment.
  // We could strip it at the Ingress, but handling it in the route keeps
  // the routing story debuggable (the pod can log what gatewayId the LB
  // thought it was hitting; useful when adding the second gateway).
  //
  // The handler verifies req.params.gatewayId === opts.gatewayId and 400s
  // on mismatch — guards against an LB URL map bug routing to the wrong
  // backend. Belt-and-suspenders; HMAC already bounds what a misrouted
  // request can do.
  app.post(
    "/restore-customer/:gatewayId",
    (req, res, next) => {
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
    },
    createRestoreCustomerHandler({
      secret: opts.secret,
      gatewayId: opts.gatewayId,
      stateDeps,
      activeRestores,
      // The contract exposes onMounted/onUnmounted hooks for exactly this
      // local heartbeat-state bookkeeping. Hooks are called only after the
      // canonical mutation lands, so a failed config patch leaves
      // mountedCustomers untouched — controller doesn't see a failed
      // restore as mounted.
      adapter: {
        ...adapter,
        onMounted: (slug) => {
          if (!runtime.mountedCustomers.includes(slug)) {
            runtime.mountedCustomers = [...runtime.mountedCustomers, slug];
          }
        },
        onUnmounted: (slug) => {
          runtime.mountedCustomers = runtime.mountedCustomers.filter((s) => s !== slug);
        },
      },
      cache,
      log: opts.log,
    }),
  );

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
