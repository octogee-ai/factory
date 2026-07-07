import express from "express";
import * as path from "node:path";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { readAssignedSlugsForGateway, slugFromAssignedUser } from "./assigned-roster.js";
import type { Server } from "http";
import {
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  type FlushGatewayResponse,
} from "../../shared/types/fleet-controller.js";
import {
  createActivateImportHandler,
  createActivationManifestExportHandler,
  createAbortRsyncImportHandler,
  createExportHandler,
  createExportPathsHandler,
  createFlushHandler,
  createFinishRsyncImportHandler,
  createImportHandler,
  createPrepareImportHandler,
  createPrepareRsyncImportHandler,
  createPushRsyncStateHandler,
  createPushStateHandler,
  createQuiesceHandler,
  createRestoreHandler,
  createUnmountHandler,
  createVerifyHandler,
} from "./fleet-http-migration.js";
import {
  writeGatewayHeartbeat,
  type FleetStateDeps,
  type FleetStateFirestore,
  type HeartbeatSnapshot,
} from "./fleet-state.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
import { buildProductionLifecycleAdapter } from "./customer-lifecycle-prod-adapter.js";
import { addCustomerToGateway, removeCustomerFromGateway } from "./customer-lifecycle.js";
import type { CustomerLifecycleAdapter } from "./customer-lifecycle.js";
import { startReconcileLoop } from "./reconcile-loop.js";
import { selectStale } from "./content-convergence.js";
import { loadAppliedFingerprints, saveAppliedFingerprints } from "./applied-fingerprint-store.js";
import { createDeviceAuthManager } from "./byosub-device-auth.js";
import { realDeviceAuthDeps } from "./byosub-device-auth-io.js";
import { mountByosubDeviceAuth } from "./byosub-device-auth-http.js";
import { createClaudeSsoManager } from "./claude-sso-auth.js";
import { realClaudeSsoDeps } from "./claude-sso-auth-io.js";
import { mountClaudeSsoAuth } from "./claude-sso-auth-http.js";

const RECONCILE_LOOP_INTERVAL_MS = 15 * 1000;

const PROCESS_STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);

export function registerByosubDeviceAuth(
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
  const claudeSsoManager = createClaudeSsoManager(
    realClaudeSsoDeps({ openclawDir, internalServiceKey, log: opts.log }),
  );
  mountByosubDeviceAuth(app, { manager, internalServiceKey, log: opts.log });
  mountClaudeSsoAuth(app, {
    manager: claudeSsoManager,
    internalServiceKey,
    log: opts.log,
  });
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
  publicKey: string;
  version: string;
  openclawVersion: string;
  adminMmUserId?: string;
  platformState?: boolean;
  // Read-only observability (seed + report mounted customers, write this
  // gateway's own liveness heartbeat) — independent of local reconcile.
  // Defaults true; db-less gateways leave it false and trusted Cowboy writes
  // the heartbeat from /health.
  reportState?: boolean;
  /** Run the local assigned-roster reconcile without Firestore state ownership.
   *  Used by db-less gateway pods; desired roster and state mirrors are brokered
   *  through octogee-api. */
  localReconcile?: boolean;
  /** Credential-less local mount reconcile: trusted octogee-api returns the
   * assigned roster for this gateway identity. */
  readDesiredSlugs?: () => Promise<string[]>;
  /** Content-convergence source: slug → fingerprint of the config-affecting snapshot
   *  slice (see snapshot-fingerprint.ts). When provided, it BOTH drives the desired
   *  roster (its keys) and lets the reconcile re-ensure an already-mounted customer whose
   *  fingerprint drifted — the level-triggered path a project-agent toggle rides. Takes
   *  precedence over readDesiredSlugs. Left unset on gateways whose add-path short-circuits
   *  a coach-wired resync (operator), where a false "applied" fingerprint would mask an
   *  unpatched config. */
  readDesiredFingerprints?: () => Promise<Map<string, string>>;
  /** Trusted-side mounted mirror writer used when the pod has no Firestore. */
  stampMounted?: (uid: string, mounted: boolean) => Promise<void>;
  /** Trusted-side reconcile error mirror used when the pod has no Firestore. */
  recordReconcileError?: (slug: string, message: string) => Promise<void>;
  clearReconcileError?: (slug: string) => Promise<void>;
  
  openclawDir?: string;

internalServiceKey?: string;

flushLocalState?: (input: {
  slug: string;
  reason: string;
}) => Promise<Omit<FlushGatewayResponse, "migrationId" | "slug">>;
}

export interface StartedFleetController {
  stop: () => Promise<void>;

whenReady: Promise<void>;
}

export interface FleetCapabilities {
  /** Read the assigned roster + write this gateway's own liveness/mounted
   *  heartbeat (observability). Independent of provisioning. */
  reportMounted: boolean;
  /** Run the local reconcile loop (ensure/evict). Firestore-backed platform
   *  provisioning requires platformState+db; db-less pods use localReconcile
   *  with a brokered roster. */
  provision: boolean;
  /** At least one capability needs Firestore write deps (own heartbeat +
   *  glmGateways mirror). Brokered local reconcile can provision without it. */
  needsStateDeps: boolean;
}

// The observability-vs-provisioning seam (OPERATOR-GATEWAY-DURABILITY-SPEC §4):
// operator gateways can run brokered local reconcile without platformState.
// Firestore-backed reporting still gates on hasDb; brokered local reconcile does not.
export function resolveFleetCapabilities(opts: {
  platformState: boolean;
  reportState: boolean;
  localReconcile?: boolean;
  hasDb: boolean;
  hasBrokeredRoster?: boolean;
}): FleetCapabilities {
  const reportMounted = opts.reportState && opts.hasDb;
  const provision =
    (opts.platformState && opts.hasDb) ||
    (opts.localReconcile === true && opts.hasBrokeredRoster === true);
  return {
    reportMounted,
    provision,
    needsStateDeps: reportMounted,
  };
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

// Evict-observed: RAW on-disk dir presence (NOT coach-wired), minus migrating-in. Drives the
// reconcile's evict direction only. Raw — so a partial/junk dir left by a mount that died
// before its config patch is still drained once it's unassigned (a coach-wired-only view
// would never see it). Minus migrating-in — so a freshly-imported customer (present before
// cutover makes it desired-here) isn't drained mid-migration. This is the ONLY consumer of
// the migrating-in pin: the heartbeat report and mount-observed are deliberately pin-blind,
// so a successfully-migrated customer is reported + considered mounted the moment it's
// coach-wired, not suppressed for the pin's TTL.
export function getEvictObservedSlugs(adapter: CustomerLifecycleAdapter): string[] {
  const dirs = adapter.listLocalCustomerDirs?.() ?? adapter.listLocalCustomerSlugs?.() ?? [];
  const migratingIn = adapter.customerMigratingIn;
  return dirs.filter((s) => !migratingIn || !migratingIn(s)).sort((a, b) => a.localeCompare(b));
}

// Mount-observed: coach-wired AND fully COMPLETE (the .mounted marker ensure writes as its
// last step). Drives the reconcile's mount direction, so a coach-wired-but-incomplete slug
// (config patch landed, then greeting / mark-complete failed) stays in desired−observed and
// is re-ensured — closing the post-config wedge. Pin-blind (see getEvictObservedSlugs).
export function getMountObservedSlugs(adapter: CustomerLifecycleAdapter): string[] {
  const coachWired = adapter.listLocalCustomerSlugs?.() ?? [];
  const marked = adapter.customerMountMarked;
  return coachWired.filter((s) => !marked || marked(s)).sort((a, b) => a.localeCompare(b));
}

// Bounded, derived lastError mirror (the restoreJobs writer is gone — this is the only
// writer of gateways/{id}.lastError now). Strictly best-effort: every path swallows its
// own error so a Firestore blip can never crash the reconcile tick. lastError holds only
// the MOST RECENT ensure failure; the full history is in the [reconcile] logs.
function recordReconcileError(opts: StartFleetOptions, slug: string, message: string): void {
  if (opts.recordReconcileError) {
    opts
      .recordReconcileError(slug, message)
      .catch((err) => opts.log(`[reconcile] ${opts.gatewayId}: ⚠ broker lastError write failed: ${String(err)}`));
    return;
  }
  if (!opts.db) return;
  opts.db
    .collection("gateways")
    .doc(opts.gatewayId)
    .set(
      { lastError: { slug, message, at: FieldValue.serverTimestamp() } },
      { merge: true },
    )
    .catch((err) => opts.log(`[reconcile] ${opts.gatewayId}: ⚠ lastError write failed: ${String(err)}`));
}

// Clear only when the standing lastError is for THIS slug — a success for one slug must
// not wipe another slug's still-live error (which would otherwise flicker back next tick).
function clearReconcileError(opts: StartFleetOptions, slug: string): void {
  if (opts.clearReconcileError) {
    opts
      .clearReconcileError(slug)
      .catch((err) => opts.log(`[reconcile] ${opts.gatewayId}: ⚠ broker lastError clear failed: ${String(err)}`));
    return;
  }
  const db = opts.db;
  if (!db) return;
  const ref = db.collection("gateways").doc(opts.gatewayId);
  db
    .runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const current = snap.data()?.lastError as { slug?: string } | null | undefined;
      if (current && current.slug === slug) {
        txn.set(ref, { lastError: null }, { merge: true });
      }
    })
    .catch((err) => opts.log(`[reconcile] ${opts.gatewayId}: ⚠ lastError clear failed: ${String(err)}`));
}

function startMaybeReconcileLoop(params: {
  provision: boolean;
  opts: StartFleetOptions;
  wrappedAdapter: CustomerLifecycleAdapter;
  runtime: FleetRuntime;
  stampMounted: (uid: string, mounted: boolean) => Promise<void>;
}): () => void {
  const { provision, opts, wrappedAdapter, runtime, stampMounted } = params;

  // Content-convergence bookkeeping (only when a fingerprint source is wired). desiredFp
  // is refreshed every tick by readDesired; appliedFp records the fingerprint that was
  // live at each customer's last successful ensure. getContentStale reports mounted
  // customers where the two diverge — the signal that makes a snapshot-only change (e.g.
  // a project-agent toggle) reconverge without a remount. appliedFp mirrors to disk
  // (when openclawDir is known) so a container restart with the emptyDir intact does not
  // re-ensure an unchanged fleet; a MISSING entry is stale by definition — see
  // content-convergence.ts and applied-fingerprint-store.ts.
  const fingerprintSource = opts.readDesiredFingerprints;
  const desiredFp = new Map<string, string>();
  const appliedFpFile =
    fingerprintSource && opts.openclawDir
      ? path.join(opts.openclawDir, "applied-fingerprints.json")
      : null;
  const appliedFp = appliedFpFile ? loadAppliedFingerprints(appliedFpFile) : new Map<string, string>();
  const persistAppliedFp = (): void => {
    if (!appliedFpFile) return;
    try {
      saveAppliedFingerprints(appliedFpFile, appliedFp);
    } catch (err) {
      opts.log(`[reconcile] ⚠ applied-fingerprint persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let readDesired: (() => Promise<string[]>) | null = null;
  if (fingerprintSource) {
    readDesired = async () => {
      const next = await fingerprintSource();
      desiredFp.clear();
      for (const [slug, fp] of next) desiredFp.set(slug, fp);
      return [...next.keys()];
    };
  } else if (opts.readDesiredSlugs) {
    readDesired = opts.readDesiredSlugs;
  } else if (opts.db) {
    readDesired = () => readAssignedSlugsForGateway(opts.db!, opts.gatewayId);
  }
  if (!provision || !readDesired) return () => undefined;

  const getContentStale = fingerprintSource
    ? (): string[] => selectStale(getMountObservedSlugs(wrappedAdapter), desiredFp, appliedFp)
    : undefined;
  return startReconcileLoop({
    gatewayId: opts.gatewayId,
    intervalMs: RECONCILE_LOOP_INTERVAL_MS,
    // SERIAL (not the default cap): the production lifecycle adapter shares one mutable
    // `cachedUserData.current` across addCustomerToGateway calls (loadUserSnapshot →
    // toProvisioningContext → applyConfigPatch), so two concurrent mounts could provision
    // customer A using customer B's cached user doc / MM identity — tenant-corrupting. Keep
    // mounts serial until the adapter is request-scoped. See FLEET-RECONCILE-SPEC.
    maxConcurrent: 1,
    log: opts.log,
    getMountObserved: () => {
      // Heartbeat reports the honest coach-wired set (D2) — pin-blind, so a migrated customer
      // shows mounted as soon as it's coach-wired, not suppressed for the migrating-in TTL.
      runtime.mountedCustomers = (wrappedAdapter.listLocalCustomerSlugs?.() ?? [])
        .slice()
        .sort((a, b) => a.localeCompare(b));
      return getMountObservedSlugs(wrappedAdapter);
    },
    getEvictObserved: () => getEvictObservedSlugs(wrappedAdapter),
    ...(getContentStale ? { getContentStale } : {}),
    readDesired,
    ensureSlug: async (slug: string) => {
      const uid = await wrappedAdapter.uidForSlug(slug);
      if (!uid) throw new Error(`no user doc for assigned slug ${slug}`);
      const result = await addCustomerToGateway(wrappedAdapter, uid);
      await stampMounted(uid, true);
      // LAST step (after add succeeds AND the mounted mirror is stamped): write the on-disk
      // completion marker so mount-observed now includes this slug. Until it lands, a
      // coach-wired-but-incomplete mount stays in toMount and is re-ensured.
      wrappedAdapter.writeMountMarker?.(slug);
      // Record the fingerprint that is now applied on disk so this customer is no longer
      // reported stale — until its desired fingerprint next changes.
      if (fingerprintSource) {
        const fp = desiredFp.get(slug);
        if (fp !== undefined) {
          appliedFp.set(slug, fp);
          persistAppliedFp();
        }
      }
      return result.newCustomer ? "mounted" : "noop";
    },
    onEnsureError: (slug, message) => recordReconcileError(opts, slug, message),
    onEnsureSuccess: (slug) => clearReconcileError(opts, slug),
    unmountSlug: async (slug: string) => {
      const uid = await wrappedAdapter.uidForSlug(slug);
      if (uid) {
        const result = await removeCustomerFromGateway(wrappedAdapter, uid);
        await stampMounted(uid, false);
        if (appliedFp.delete(slug)) persistAppliedFp();
        return result.wasMounted ? "drained" : "noop";
      }

      const agentId = `octogee-${slug}-coach`;
      try {
        await wrappedAdapter.applyRemoveCustomerConfigPatch(slug, agentId);
        if (wrappedAdapter.hasCustomerDir(slug)) {
          await wrappedAdapter.deleteCustomerDir(slug);
        }
        wrappedAdapter.onUnmounted?.(slug);
        if (appliedFp.delete(slug)) persistAppliedFp();
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
    throw new Error("[fleet] db is required when reportState is enabled");
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

export async function startFleetController(
  opts: StartFleetOptions,
): Promise<StartedFleetController> {
  const platformState = opts.platformState !== false;
  const reportState = opts.reportState !== false;
  const caps = resolveFleetCapabilities({
    platformState,
    reportState,
    localReconcile: opts.localReconcile === true,
    hasDb: !!opts.db,
    hasBrokeredRoster: !!opts.readDesiredSlugs || !!opts.readDesiredFingerprints,
  });
  const stateDeps = createStateDeps(opts, caps.needsStateDeps);
  const adapter = buildFleetAdapter(opts);

  const runtime: FleetRuntime = {
    mountedCustomers: [],
    status: "booting",
  };

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

  // Derived readiness mirror (D5): stamp on-disk presence onto the user doc for cheap
  // PWA queries. Nothing branches on it — it mirrors observed, never drives mounting.
  const stampMounted = async (uid: string, mounted: boolean): Promise<void> => {
    if (opts.stampMounted) {
      await opts.stampMounted(uid, mounted);
      return;
    }
    if (!opts.db) return;
    try {
      await opts.db
        .collection("users")
        .doc(uid)
        .update({ "provisioning.openclaw.mounted": mounted });
    } catch (err) {
      opts.log(`[reconcile] ⚠ mounted-mirror stamp failed for ${uid}: ${String(err)}`);
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
      version: opts.version,
      startedAt: PROCESS_STARTED_AT_MS,
      customers: adapter.listLocalCustomerSlugs?.() ?? [],
      // Slugs mid-migration-import — Cowboy's operator poller skips these as eviction
      // candidates until cutover moves their assignment (the operator path has no in-pod
      // reconcile to honor the pin).
      migratingIn: adapter.listMigratingInSlugs?.() ?? [],
    });
  });

  const wrappedAdapter = wrapAdapterWithRuntime(adapter, runtime);

  await seedRuntimeMountedCustomers({ opts, reportMounted: caps.reportMounted, wrappedAdapter, runtime });

  await emitHeartbeat("booting");

  const heartbeatTimer = caps.reportMounted
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

  const migrationDeps = {
    publicKey: opts.publicKey,
    gatewayId: opts.gatewayId,
    adapter: wrappedAdapter,
    log: opts.log,
    getMountedCustomers: () => runtime.mountedCustomers,
    flushLocalState: opts.flushLocalState,
  };
  app.post("/restore/:gatewayId", gatewayIdGuard, createRestoreHandler(migrationDeps));
  app.post("/quiesce/:gatewayId", gatewayIdGuard, createQuiesceHandler(migrationDeps));
  app.post("/flush/:gatewayId", gatewayIdGuard, createFlushHandler(migrationDeps));
  app.post("/verify/:gatewayId", gatewayIdGuard, createVerifyHandler(migrationDeps));
  app.post("/export/:gatewayId", gatewayIdGuard, createExportHandler(migrationDeps));
  app.post("/export-paths/:gatewayId", gatewayIdGuard, createExportPathsHandler(migrationDeps));
  app.post(
    "/export-activation-manifest/:gatewayId",
    gatewayIdGuard,
    createActivationManifestExportHandler(migrationDeps),
  );
  app.post("/prepare-import/:gatewayId", gatewayIdGuard, createPrepareImportHandler(migrationDeps));
  app.post("/activate-import/:gatewayId", gatewayIdGuard, createActivateImportHandler(migrationDeps));
  app.post("/prepare-rsync-import/:gatewayId", gatewayIdGuard, createPrepareRsyncImportHandler(migrationDeps));
  app.post("/push-rsync-state/:gatewayId", gatewayIdGuard, createPushRsyncStateHandler(migrationDeps));
  app.post("/finish-rsync-import/:gatewayId", gatewayIdGuard, createFinishRsyncImportHandler(migrationDeps));
  app.post("/abort-rsync-import/:gatewayId", gatewayIdGuard, createAbortRsyncImportHandler(migrationDeps));
  app.post("/push-state/:gatewayId", gatewayIdGuard, createPushStateHandler(migrationDeps));
  app.post("/import/:gatewayId", gatewayIdGuard, createImportHandler(migrationDeps));
  app.post("/unmount/:gatewayId", gatewayIdGuard, createUnmountHandler(migrationDeps));

  registerByosubDeviceAuth(app, opts);

  const stopReconcileLoop = startMaybeReconcileLoop({
    provision: caps.provision,
    opts,
    wrappedAdapter,
    runtime,
    stampMounted,
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, "0.0.0.0", () => resolve(s));
  });
  const reconcileLoopStatus = caps.provision ? `${RECONCILE_LOOP_INTERVAL_MS}ms` : "disabled";
  opts.log(
    `[fleet] listening on 0.0.0.0:${opts.port}; gatewayId=${opts.gatewayId}; platformState=${platformState}; reportState=${reportState}; reconcile-loop=${reconcileLoopStatus}`,
  );

return {
    whenReady: waitForGatewayReady(),
    stop: async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      stopReconcileLoop();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
