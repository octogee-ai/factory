import { randomUUID } from "node:crypto";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  type GatewayDesiredState,
  type HelmInstancesMap,
  type Operation,
} from "../../shared/types/glm.js";
import {
  buildHelmTargetMap,
  buildInstancesMap,
  diffInstancesMap,
  isReplicasOnlyUpdate,
  type ReconcileChange,
} from "./reconcile-plan.js";
import {
  createHelmSubprocessRunner,
  createLoggingHelmRunner,
  spawnHelm,
  type HelmRunner,
} from "./helm-runner.js";
import {
  createKubeSubprocessRunner,
  createLoggingKubeOps,
  type KubeOps,
} from "./lib/kube-ops.js";
import {
  createAuthSecretEnsurer,
  defaultRandomTokenHex,
} from "./auth-secret-ensurer.js";
import {
  spawnKubectl,
  syncApiFleetIngressPaths,
  syncFleetIngressPaths,
  type FleetGateway,
  type KubectlSubprocess,
} from "./fleet-ingress.js";
import {
  routeOperation,
  type OperationHandlers,
} from "./operation-router.js";
import { createOperationContext } from "./operation-context.js";
import { completeOperatorReservationAfterMigration } from "./operator-reservation-completion.js";
import { computeBootstrapWrites } from "./bootstrap.js";
import {
  computeDefaultGatewayBootstrap,
  deriveDefaultGatewayIdFromNamespace,
} from "./bootstrap-default-gateway.js";
import { createAddGatewayHandler } from "./handlers/add-gateway.js";
import { createMigrateCustomerHandler } from "./handlers/migrate-customer.js";
import { createRetireGatewayHandler } from "./handlers/retire-gateway.js";
import { createRestartGatewayHandler } from "./handlers/restart-gateway.js";
import { createRolloutHandler } from "./handlers/rollout.js";
import { createDeprovisionCustomerHandler } from "./handlers/deprovision-customer.js";
import { loadCustomerCleanupContext } from "./lib/customer-ops/cleanup-context.js";
import { createGiteaCleanupClient } from "./lib/customer-ops/gitea.js";
import { createMmCleanupClient } from "./lib/customer-ops/mattermost.js";
import { signFleetRequest } from "../../scripts/lib/fleet-signature.js";
import { SIGNATURE_HEADER } from "../../shared/types/fleet-controller.js";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";
import { createMigrationClient } from "../../scripts/lib/fleet-migration-client.js";
import {
  cutoverUserGatewayAndMarkMounted,
  type FleetStateFirestore,
} from "../../scripts/lib/fleet-state.js";
import { provisionGatewayAuthSecret } from "../../scripts/lib/secret-manager.js";
import { listGatewayBuilds } from "../../scripts/lib/artifact-registry.js";
import { workspaceSlugsForUser } from "../../scripts/lib/workspace-slugs.js";
import { deleteAuthUserTolerantOfMissing } from "../../scripts/lib/firebase-auth-helpers.js";
import { deleteHostingSitesForCustomer } from "../../scripts/lib/firebase-hosting.js";
import { GoogleAuth } from "google-auth-library";
import { startHttpServer } from "./http-server.js";
import { recordReconcile } from "./metrics.js";
import { createLogger } from "./lib/logger.js";
import { startOrphanHeartbeatReaper } from "./orphan-heartbeat-reaper.js";
import { startStuckOpReaper } from "./stuck-op-reaper.js";
import { computeChartFingerprint } from "./chart-fingerprint.js";

const logger = createLogger({
  color: process.env.NO_COLOR == null,
  debug: process.env.DEBUG != null,
});
const log = (msg: string) => logger.legacy(msg);

const RECONCILE_DEBOUNCE_MS = 1_000;
const RECONCILE_RETRY_MS_DEFAULT = 30_000;

const GATEWAY_CHART = process.env.GATEWAY_CHART ?? "/charts/octogee-gateway";

const GATEWAY_VALUES_FILE = (function () {
  const explicit = process.env.GATEWAY_VALUES_FILE;
  if (explicit) return explicit;
  const ns = process.env.K8S_NAMESPACE ?? "octogee";
  return ns === "octogee"
    ? `${GATEWAY_CHART}/values.prod.yaml`
    : `${GATEWAY_CHART}/values.test.yaml`;
})();
const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";

const AUTO_ROLL_ON_CHART_DRIFT = NAMESPACE !== "octogee";
const FLEET_CONTROLLER_PORT = process.env.FLEET_CONTROLLER_PORT ?? "3003";
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? "8080", 10);

const FLEET_INGRESS_NAME = process.env.FLEET_INGRESS_NAME ?? "octogee-gateway-fleet-control-ingress";
const FLEET_ALIAS_SERVICE = process.env.FLEET_ALIAS_SERVICE ?? "octogee-gateway";

const GATEWAY_EDGE_INGRESS_NAME =
  process.env.GATEWAY_EDGE_INGRESS_NAME ?? "gateway-edge-ingress";

const GATEWAY_EDGE_PORT = 3001;

function createGatewayPersistentVolumeClaimDeleter(
  kubeOps: KubeOps,
): (instanceName: string) => Promise<void> {
  return async (instanceName) => {
    await kubeOps.deletePersistentVolumeClaim({
      namespace: NAMESPACE,
      name: `octogee-gateway-${instanceName}-data`,
    });
  };
}

interface ControllerDeps {
  db: Firestore;
  helm: HelmRunner;
  kubeOps?: KubeOps;
  handlers: OperationHandlers;
  log: (msg: string) => void;

  syncFleetIngress?: (
    gateways: ReadonlyArray<{ gatewayId: string; instanceName: string }>,
  ) => Promise<void>;

  reconcileRetryMs?: number;

  chartFingerprint?: string;
}

function deploymentNameForInstance(instanceName: string): string {
  return `octogee-gateway-${instanceName}`;
}

async function applyChanges(
  changes: ReconcileChange[],
  deps: ControllerDeps,
): Promise<void> {
  const kubeOps = deps.kubeOps ?? createLoggingKubeOps(deps.log);
  for (const change of changes) {
    if (change.kind === "drift") {
      await deps.helm.removeInstance({
        namespace: NAMESPACE,
        instanceName: change.instanceName,
      });
      continue;
    }
    if (isReplicasOnlyUpdate(change)) {
      const replicas = change.to.replicas ?? 1;
      await kubeOps.scaleDeployment({
        namespace: NAMESPACE,
        name: deploymentNameForInstance(change.instanceName),
        replicas,
      });
      continue;
    }

    await deps.helm.upsertInstance({
      namespace: NAMESPACE,
      instanceName: change.instanceName,
      gatewayId: change.to.gatewayId,
      imageRepository: change.to.image.repository,
      imageTag: change.to.image.tag,
      serviceAccountName: change.to.serviceAccountName,
      serviceAccount: change.to.serviceAccount,
      gatewayContainerSecurityContext: change.to.gatewayContainerSecurityContext,
      persistence: change.to.persistence,
      operatorAccess: change.to.operatorAccess,
      profile: change.to.profile,
      sizingTier: change.to.sizingTier,
      replicas: change.to.replicas,
      chartPath: GATEWAY_CHART,
      valuesFile: GATEWAY_VALUES_FILE,
      chartFingerprint: deps.chartFingerprint,
    });
  }
}

async function readLiveReplicasInto(
  actualMap: Record<string, { replicas?: number }>,
  kubeOps: KubeOps,
  log: (msg: string) => void,
): Promise<void> {
  const names = Object.keys(actualMap);
  await Promise.all(
    names.map(async (instanceName) => {
      try {
        const live = await kubeOps.readDeployedReplicas({
          namespace: NAMESPACE,
          name: deploymentNameForInstance(instanceName),
        });
        if (live !== null) {
          // eslint-disable-next-line security/detect-object-injection -- instanceName comes from own actualMap keys; this only refreshes its replica count.
          actualMap[instanceName] = { ...actualMap[instanceName], replicas: live };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(
          `[glm-controller] ⚠ kube readReplicas failed for ${instanceName}: ${msg} — keeping helm-stored value`,
        );
      }
    }),
  );
}

async function readMountedByGatewayId(
  db: Firestore,
): Promise<Map<string, readonly string[]>> {
  const snap = await db.collection("gateways").get();
  const out = new Map<string, readonly string[]>();
  for (const doc of snap.docs) {
    const data = doc.data() as { mountedCustomers?: unknown };
    const mounted = Array.isArray(data.mountedCustomers)
      ? (data.mountedCustomers.filter((s): s is string => typeof s === "string"))
      : [];
    out.set(doc.id, mounted);
  }
  return out;
}

type DriftChange = Extract<ReconcileChange, { kind: "drift" }>;

interface ReconcileInputs {
  desired: GatewayDesiredState[];
  actualMap: HelmInstancesMap;
  mountedByGatewayId: Map<string, readonly string[]>;
}

async function readReconcileInputs(deps: ControllerDeps): Promise<ReconcileInputs> {
  const snap = await deps.db.collection(GLM_GATEWAYS_COLLECTION).get();
  const desired = snap.docs.map((d) => d.data() as GatewayDesiredState);
  const actualMap = await deps.helm.readDeployedInstances({ namespace: NAMESPACE });
  const kubeOpsForRead = deps.kubeOps ?? createLoggingKubeOps(deps.log);
  await readLiveReplicasInto(actualMap, kubeOpsForRead, deps.log);
  const mountedByGatewayId = await readMountedByGatewayId(deps.db);
  return { desired, actualMap, mountedByGatewayId };
}

function preservedDriftChanges(
  changes: ReconcileChange[],
  targetMap: HelmInstancesMap,
): DriftChange[] {
  return changes.filter(
    (c): c is DriftChange =>
      c.kind === "drift" &&
      Object.prototype.hasOwnProperty.call(targetMap, c.instanceName),
  );
}

function logPreservedDrift(
  deps: ControllerDeps,
  preservedDrift: DriftChange[],
  desired: GatewayDesiredState[],
): void {
  const desiredGatewayIds = new Set(desired.map((d) => d.gatewayId));
  const orphanDrift = preservedDrift.filter((c) => !desiredGatewayIds.has(c.current.gatewayId));
  const draineeDrift = preservedDrift.filter((c) => desiredGatewayIds.has(c.current.gatewayId));
  if (orphanDrift.length > 0) {
    const formatted = orphanDrift
      .map((d) => `${d.instanceName} (gatewayId=${d.current.gatewayId})`)
      .join(", ");
    deps.log(
      `[glm-controller] ⚠ 🧟 orphan helm release(s) — no matching glmGateways doc: ${formatted} (manual \`helm uninstall octogee-gw-<instanceName>\` required to remove)`,
    );
  }
  if (draineeDrift.length > 0) {
    deps.log(
      `[glm-controller] drift detected (preserved, not removed): ${draineeDrift.map((d) => d.instanceName).join(", ")}`,
    );
  }
}

async function applyTargetChanges(
  deps: ControllerDeps,
  targetVsActual: ReconcileChange[],
  desiredCount: number,
  actualCount: number,
): Promise<void> {
  if (targetVsActual.length === 0) {
    deps.log(`[glm-controller] reconcile tick: no changes (${desiredCount} desired, ${actualCount} actual)`);
    return;
  }
  const summary = targetVsActual
    .map((c) => `${c.kind === "drift" ? "remove" : c.kind}:${c.instanceName}`)
    .join(", ");
  deps.log(`[glm-controller] reconcile tick: ${targetVsActual.length} change(s) — ${summary}`);
  await applyChanges(targetVsActual, deps);
}

async function syncFleetIngressIfConfigured(
  deps: ControllerDeps,
  desired: GatewayDesiredState[],
): Promise<void> {
  const syncFleetIngress = deps.syncFleetIngress;
  if (!syncFleetIngress) return;
  const fleetGateways = desired
    .filter((g) => typeof g.gatewayId === "string" && typeof g.instanceName === "string")
    .map((g) => ({ gatewayId: g.gatewayId, instanceName: g.instanceName }));
  try {
    await syncFleetIngress(fleetGateways);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`(source=fleet-ingress) ${message}`);
  }
}

async function reconcileOnce(deps: ControllerDeps): Promise<void> {
  const { desired, actualMap, mountedByGatewayId } = await readReconcileInputs(deps);
  const desiredMap = buildInstancesMap(desired, deps.chartFingerprint);
  const changes = diffInstancesMap(actualMap, desiredMap, {
    compareChartFingerprint: AUTO_ROLL_ON_CHART_DRIFT,
  });
  const targetMap = buildHelmTargetMap(
    desired,
    actualMap,
    mountedByGatewayId,
    deps.chartFingerprint,
  );
  logPreservedDrift(deps, preservedDriftChanges(changes, targetMap), desired);
  const targetVsActual = diffInstancesMap(actualMap, targetMap, {
    compareChartFingerprint: AUTO_ROLL_ON_CHART_DRIFT,
  });
  await applyTargetChanges(deps, targetVsActual, desired.length, Object.keys(actualMap).length);
  await syncFleetIngressIfConfigured(deps, desired);
}

function clearTimer(timer: NodeJS.Timeout | null): null {
  if (timer) clearTimeout(timer);
  return null;
}

export function startReconciler(deps: ControllerDeps): () => void {
  let debounceTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let pendingTick = false;
  let stopped = false;
  const retryMs = deps.reconcileRetryMs ?? RECONCILE_RETRY_MS_DEFAULT;

  const scheduleDebouncedTick = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void tick(), RECONCILE_DEBOUNCE_MS);
  };

  const tick = async () => {
    if (inFlight) {
      pendingTick = true;
      return;
    }
    debounceTimer = clearTimer(debounceTimer);
    retryTimer = clearTimer(retryTimer);
    inFlight = true;
    try {
      await reconcileOnce(deps);
      recordReconcile("ok");
    } catch (err) {
      recordReconcile("fail");
      const message = err instanceof Error ? err.message : String(err);
      const source = message.startsWith("(source=") ? "" : "(source=helm) ";
      deps.log(
        `[glm-controller] ⚠ reconcile tick failed: ${source}${message} — retry in ${retryMs}ms`,
      );
      if (!stopped) {
        retryTimer = setTimeout(() => void tick(), retryMs);
      }
    } finally {
      inFlight = false;
      if (!stopped && pendingTick) {
        pendingTick = false;
        retryTimer = clearTimer(retryTimer);
        scheduleDebouncedTick();
      }
    }
  };

  const unsub = deps.db.collection(GLM_GATEWAYS_COLLECTION).onSnapshot(
    () => {
      if (stopped) return;
      scheduleDebouncedTick();
    },
    (err) => deps.log(`[glm-controller] ⚠ gateways snapshot error: ${String(err)}`),
  );

  return () => {
    stopped = true;
    unsub();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    pendingTick = false;
  };
}

export function startOperationWorker(deps: ControllerDeps): () => void {
  const unsub = deps.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .where("status", "==", "pending")
    .onSnapshot(
      async (snap) => {
        for (const change of snap.docChanges()) {
          if (change.type !== "added") continue;
          const op = { ...(change.doc.data() as Operation), id: change.doc.id };
          await processOperation(op, change.doc.ref, deps);
        }
      },
      (err) => deps.log(`[glm-controller] ⚠ operations snapshot error: ${String(err)}`),
    );

  return unsub;
}

async function processOperation(
  op: Operation,
  ref: FirebaseFirestore.DocumentReference,
  deps: ControllerDeps,
): Promise<void> {

let claimed = false;
  try {
    claimed = await deps.db.runTransaction(async (txn) => {
      const fresh = await txn.get(ref);
      if (!fresh.exists) return false;
      const data = fresh.data() as Operation | undefined;
      if (data?.status !== "pending") return false;
      txn.update(ref, { status: "running", startedAt: Date.now() });
      return true;
    });
  } catch (err) {
    deps.log(
      `[glm-controller] claim transaction failed op=${op.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (!claimed) {
    deps.log(`[glm-controller] op=${op.id} already claimed — skipping`);
    return;
  }

  deps.log(`[glm-controller] claim op=${op.id} kind=${op.kind}`);

  const { ctx, steps } = createOperationContext({
    persist: async (next) => {
      await ref.update({ steps: next });
    },
    log: deps.log,
    opId: op.id,
  });

  const result = await routeOperation(op, deps.handlers, ctx);
  await ref.update({
    status: result.success ? "succeeded" : "failed",
    completedAt: Date.now(),
    steps: steps.length > 0 ? steps : result.steps,
    error: result.error ?? FieldValue.delete(),
    rolledBack: result.rolledBack ?? false,
  });
  if (result.success) {
    try {
      await completeOperatorReservationAfterMigration(
        { db: deps.db, now: () => Date.now(), log: deps.log },
        op,
      );
    } catch (err) {
      deps.log(
        `[glm-controller] ⚠ operator reservation completion failed op=${op.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const status = result.success ? "succeeded" : "failed";
  const errSuffix = result.error ? ` (${result.error})` : "";
  deps.log(`[glm-controller] op=${op.id} → ${status}${errSuffix}`);
}

async function main(): Promise<void> {
  initializeApp({ credential: applicationDefault() });
  const db = getFirestore();
  const runKubectl: KubectlSubprocess = (args, opts) => spawnKubectl(args, opts);
  const authSecretEnsurer = createAuthSecretEnsurer({
    runKubectl,
    randomTokenHex: defaultRandomTokenHex,
    log,
  });
  const helm =
    process.env.HELM_RUNNER_MODE === "stub"
      ? createLoggingHelmRunner(log)
      : createHelmSubprocessRunner({
          runHelm: spawnHelm,
          log,
          ensureAuthSecret: authSecretEnsurer.ensureAuthSecret,
        });
  const kubeOps =
    process.env.KUBE_OPS_MODE === "stub"
      ? createLoggingKubeOps(log)
      : createKubeSubprocessRunner({ runKubectl, log });
  const syncFleetIngressForGateways = (gateways: ReadonlyArray<FleetGateway>) =>
    syncFleetIngressPaths({
      runKubectl,
      ingressName: FLEET_INGRESS_NAME,
      namespace: NAMESPACE,
      desiredGateways: gateways,
      fleetControllerPort: parseInt(FLEET_CONTROLLER_PORT, 10),
      aliasServiceName: FLEET_ALIAS_SERVICE,
      log,
    }).then(() => undefined);
  const syncApiFleetIngressForGateways = (gateways: ReadonlyArray<FleetGateway>) =>
    syncApiFleetIngressPaths({
      runKubectl,
      ingressName: GATEWAY_EDGE_INGRESS_NAME,
      namespace: NAMESPACE,
      desiredGateways: gateways,
      gatewayEdgePort: GATEWAY_EDGE_PORT,
      gatewayEdgeServiceName: "gateway-edge",
      log,
    }).then(() => undefined);

const syncAllFleetIngresses = async (gateways: ReadonlyArray<FleetGateway>) => {
    await syncFleetIngressForGateways(gateways);
    await syncApiFleetIngressForGateways(gateways);
  };

const handlerSyncFleetIngress = async () => {
    const snap = await db.collection(GLM_GATEWAYS_COLLECTION).get();
    const gateways: FleetGateway[] = snap.docs
      .map((d) => d.data() as { gatewayId?: unknown; instanceName?: unknown })
      .filter(
        (g): g is FleetGateway =>
          typeof g.gatewayId === "string" && typeof g.instanceName === "string",
      );
    await syncAllFleetIngresses(gateways);
  };

  const handlers = await buildHandlers(db, log, helm, kubeOps, handlerSyncFleetIngress);

  const chartFingerprint = computeChartFingerprint(GATEWAY_CHART);

  const deps: ControllerDeps = {
    db,
    helm,
    kubeOps,
    handlers,
    log,
    syncFleetIngress: syncAllFleetIngresses,
    chartFingerprint,
  };

  log(
    `[glm-controller] boot sha=${process.env.BUILD_SHA ?? "unknown"} oc=${process.env.OPENCLAW_VERSION ?? "n/a"} fork=${process.env.OPENCLAW_FORK_SHA ?? "n/a"} node=${process.version} — namespace=${NAMESPACE} gatewayChart=${GATEWAY_CHART} chartFingerprint=${chartFingerprint.slice(0, 12)} chartDriftAutoRoll=${AUTO_ROLL_ON_CHART_DRIFT} valuesFile=${GATEWAY_VALUES_FILE} fleetIngress=${FLEET_INGRESS_NAME}`,
  );

  await bootstrapGlmGateways(deps);
  await bootstrapDefaultGateway(deps);

  const stopReconciler = startReconciler(deps);
  const stopWorker = startOperationWorker(deps);

const stopReaper = startOrphanHeartbeatReaper({
    db,
    log,
    intervalMs: 60_000,
    stalenessMs: 5 * 60 * 1000,
    now: () => Date.now(),
  });

const stopStuckOpReaper = startStuckOpReaper({
    db,
    log,
    intervalMs: 60_000,
    stalenessMs: 15 * 60 * 1000,
    now: () => Date.now(),
  });
  const stopHttp = startHttpServer({
    db,
    log,
    port: HTTP_PORT,
    verifyIdToken: async (token) => {
      const decoded = await getAuth().verifyIdToken(token);
      return { uid: decoded.uid };
    },
    workspaceSlugsForUser,
    provisionGatewayAuthSecret,
    listGatewayBuilds,
    deleteAuthUserTolerantOfMissing: (uid) => deleteAuthUserTolerantOfMissing(uid, getAuth()),
  });

  const shutdown = () => {
    log("[glm-controller] shutdown signal — stopping subscribers");
    stopReconciler();
    stopWorker();
    stopReaper();
    stopStuckOpReaper();
    stopHttp();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export async function bootstrapGlmGateways(deps: ControllerDeps): Promise<void> {
  let actualMap;
  try {
    actualMap = await deps.helm.readDeployedInstances({
      namespace: NAMESPACE,
    });
  } catch (err) {
    deps.log(
      `[glm-controller] ⚠ bootstrap skipped — failed to read helm state: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const snap = await deps.db.collection(GLM_GATEWAYS_COLLECTION).get();
  const known = new Set(snap.docs.map((d) => d.id));
  const writes = computeBootstrapWrites(actualMap, known);
  if (writes.length === 0) {
    deps.log(
      `[glm-controller] bootstrap: ${Object.keys(actualMap).length} helm instance(s) already registered, no writes`,
    );
    return;
  }
  for (const w of writes) {
    try {
      await deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(w.gatewayId).create(w.doc);
      deps.log(
        `[glm-controller] bootstrap: registering existing instance ${w.doc.instanceName} as glmGateways/${w.gatewayId}`,
      );
    } catch (err) {
      if ((err as { code?: number })?.code === 6) {
        deps.log(
          `[glm-controller] bootstrap: skip ${w.gatewayId} — operator wrote a doc between snapshot and create`,
        );
        continue;
      }
      throw err;
    }
  }
}

async function resolveDefaultGatewayId(deps: ControllerDeps): Promise<string | null> {
  const orchSnap = await deps.db.doc("config/orchestrator").get();
  const existing = (orchSnap.data() as { defaultGatewayId?: unknown } | undefined)
    ?.defaultGatewayId;
  if (typeof existing === "string") return existing;

  const derived = deriveDefaultGatewayIdFromNamespace(NAMESPACE);
  if (derived === null) return null;

  try {
    await deps.db
      .doc("config/orchestrator")
      .set({ defaultGatewayId: derived }, { merge: true });
    deps.log(
      `[glm-controller] default-gateway bootstrap: self-seeded config/orchestrator.defaultGatewayId=${derived} (derived from namespace=${NAMESPACE})`,
    );
    return derived;
  } catch (err) {
    deps.log(
      `[glm-controller] ⚠ default-gateway bootstrap: self-seed failed (namespace=${NAMESPACE}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export async function bootstrapDefaultGateway(deps: ControllerDeps): Promise<void> {
  if (process.env.BOOTSTRAP_DEFAULT_GATEWAY !== "true") {
    return;
  }
  let actualMap;
  try {
    actualMap = await deps.helm.readDeployedInstances({ namespace: NAMESPACE });
  } catch (err) {
    deps.log(
      `[glm-controller] ⚠ default-gateway bootstrap skipped — failed to read helm state: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const snap = await deps.db.collection(GLM_GATEWAYS_COLLECTION).get();
  const existingGatewayIds = new Set(snap.docs.map((d) => d.id));
  const defaultGatewayId = await resolveDefaultGatewayId(deps);

  const decision = computeDefaultGatewayBootstrap({
    actualMap,
    existingGatewayIds,
    defaultGatewayId,
    instanceName: process.env.BOOTSTRAP_INSTANCE_NAME ?? "default",
    imageRepository:
      process.env.BOOTSTRAP_IMAGE_REPOSITORY ??
      "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    imageTag: process.env.BOOTSTRAP_IMAGE_TAG ?? "latest",
  });
  if (decision.kind === "skip") {
    deps.log(`[glm-controller] default-gateway bootstrap: skip — ${decision.reason}`);
    return;
  }
  try {
    await deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(decision.gatewayId).create(decision.doc);
    deps.log(
      `[glm-controller] default-gateway bootstrap: created glmGateways/${decision.gatewayId} (instanceName=${decision.doc.instanceName}, imageTag=${decision.doc.imageTag})`,
    );
  } catch (err) {
    if ((err as { code?: number })?.code === 6) {
      deps.log(
        `[glm-controller] default-gateway bootstrap: ${decision.gatewayId} doc created concurrently — skipping`,
      );
      return;
    }
    throw err;
  }
}

async function buildHandlers(
  db: Firestore,
  logFn: (msg: string) => void,
  helm: HelmRunner,
  kubeOps: KubeOps,
  syncFleetIngress: () => Promise<void>,
): Promise<OperationHandlers> {
  const secret = process.env.FLEET_CONTROLLER_SECRET;
  if (!secret) {
    throw new Error(
      "FLEET_CONTROLLER_SECRET is not set — required for migrate-customer. Refusing to start with stub handlers.",
    );
  }

  const addGateway = createAddGatewayHandler({
    helm,
    kubeOps,
    readGatewayHeartbeat: async (gatewayId) => {
      const doc = await db.collection("gateways").doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as
        | { lastHeartbeatAt?: { toMillis?: () => number } | number | Date }
        | undefined;
      const raw = data?.lastHeartbeatAt;
      if (raw == null) return null;
      let ms: number | null = null;
      if (typeof raw === "number") ms = raw;
      else if (raw instanceof Date) ms = raw.getTime();
      else if (typeof (raw as { toMillis?: () => number }).toMillis === "function") {
        ms = (raw as { toMillis: () => number }).toMillis();
      }
      return ms == null ? null : { lastHeartbeatAt: ms };
    },
    syncFleetIngress,
    helmRenderTimeoutMs: 600_000,
    deploymentCreatedTimeoutMs: 600_000,
    heartbeatTimeoutMs: 240_000,
    pollIntervalMs: 5_000,
    now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logFn,
  });

  const migrateCustomer = createMigrateCustomerHandler({
    readUser: async (uid) => {
      const doc = await db.collection("users").doc(uid).get();
      if (!doc.exists) return null;
      const data = doc.data() as
        | { username?: string; provisioning?: { openclaw?: { slug?: string; gatewayId?: string } } }
        | undefined;
      const oc = data?.provisioning?.openclaw ?? {};
      const slug = oc.slug ?? data?.username;
      const currentGatewayId = oc.gatewayId;
      if (!slug || !currentGatewayId) return null;
      return { slug, currentGatewayId };
    },
    cutoverFirestore: async (uid, toGatewayId, slug) => {
      await cutoverUserGatewayAndMarkMounted(
        {
          db: db as unknown as FleetStateFirestore,
          serverTimestamp: () => FieldValue.serverTimestamp(),
          log: logFn,
        },
        { uid, slug, toGatewayId },
      );
    },
    resolveGatewayUrl: (gatewayId) => resolveGatewayUrlFromFirestore(db, gatewayId),
    buildClient: (resolveSync) =>
      createMigrationClient({ secret, resolveGatewayUrl: resolveSync, log: logFn }),
    genMigrationId: () => `mig-${Date.now()}-${randomUUID().slice(0, 8)}`,
    now: () => Date.now(),
    log: logFn,
  });

  const retireGateway = createRetireGatewayHandler({
    helm,
    readGatewayLiveState: async (gatewayId) => {
      const doc = await db.collection("gateways").doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as
        | { mountedCustomers?: unknown; inFlightJobId?: unknown }
        | undefined;
      const mounted = Array.isArray(data?.mountedCustomers)
        ? (data!.mountedCustomers as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const inFlightJobId =
        typeof data?.inFlightJobId === "string" && data.inFlightJobId.length > 0
          ? data.inFlightJobId
          : null;
      return { mountedCustomers: mounted, inFlightJobId };
    },
    readGlmGatewayInstanceName: async (gatewayId) => {
      const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as GatewayDesiredState | undefined;
      return data?.instanceName ?? null;
    },
    deleteGlmGateway: async (gatewayId) => {
      await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).delete();
    },
    deleteGatewayHeartbeat: async (gatewayId) => {
      await db.collection("gateways").doc(gatewayId).delete();
    },
    readGatewayHeartbeatExists: async (gatewayId) => {
      const doc = await db.collection("gateways").doc(gatewayId).get();
      return doc.exists;
    },
    deleteGatewayPersistentVolumeClaim: createGatewayPersistentVolumeClaimDeleter(kubeOps),
    syncFleetIngress,
    helmUninstallTimeoutMs: 90_000,
    pollIntervalMs: 5_000,
    now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logFn,
  });

  const rollout = createRolloutHandler({
    helm,
    readCurrentSpec: async (gatewayId) => {
      const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as GatewayDesiredState | undefined;
      if (!data?.instanceName || !data.imageRepository || !data.imageTag) return null;
      return {
        instanceName: data.instanceName,
        imageRepository: data.imageRepository,
        imageTag: data.imageTag,
        profile: data.profile,
        persistence: data.persistence,
        serviceAccountName: data.serviceAccountName,
        serviceAccount: data.serviceAccount,
        operatorAccess: data.operatorAccess,
      };
    },
    updateGlmGatewayImage: async ({
      gatewayId,
      imageRepository,
      imageTag,
      profile,
      persistence,
      serviceAccountName,
      serviceAccount,
      operatorAccess,
    }) => {
      const update: Record<string, unknown> = {
        imageRepository,
        imageTag,
        profile: profile === "standard" ? FieldValue.delete() : profile,
      };
      if (persistence) {
        update.persistence = persistence;
      }
      if (serviceAccountName) {
        update.serviceAccountName = serviceAccountName;
      }
      if (serviceAccount) {
        update.serviceAccount = serviceAccount;
      }
      if (operatorAccess) {
        update.operatorAccess = operatorAccess;
      }
      await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).update(update);
    },
    readGatewayHeartbeat: async (gatewayId) => {
      const doc = await db.collection("gateways").doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as
        | { version?: unknown; lastHeartbeatAt?: { toMillis?: () => number } | number | Date }
        | undefined;
      const version = typeof data?.version === "string" ? data.version : null;
      const raw = data?.lastHeartbeatAt;
      let lastHeartbeatAt = 0;
      if (typeof raw === "number") lastHeartbeatAt = raw;
      else if (raw instanceof Date) lastHeartbeatAt = raw.getTime();
      else if (typeof (raw as { toMillis?: () => number })?.toMillis === "function") {
        lastHeartbeatAt = (raw as { toMillis: () => number }).toMillis();
      }
      return { version, lastHeartbeatAt };
    },
    helmRenderTimeoutMs: 600_000,
    heartbeatTimeoutMs: 240_000,
    pollIntervalMs: 5_000,
    now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logFn,
  });

  const deprovisionCustomer = buildDeprovisionCustomerHandler(db, secret, logFn);

  const restartGateway = createRestartGatewayHandler({
    kubeOps,
    namespace: NAMESPACE,
    now: () => Date.now(),
    log: logFn,
  });

  return {
    "add-gateway": addGateway,
    "migrate-customer": migrateCustomer,
    "retire-gateway": retireGateway,
    "restart-gateway": restartGateway,
    rollout,
    "deprovision-customer": deprovisionCustomer,
  };
}

function buildDeprovisionCustomerHandler(
  db: Firestore,
  secret: string,
  logFn: (msg: string) => void,
) {
  const giteaApiUrl =
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- in-cluster ClusterIP service, not internet-facing
    process.env.GIT_API_URL ?? "http://gitea-http.octogee.svc.cluster.local:3000/api/v1";
  const giteaToken = process.env.GIT_API_TOKEN ?? "";
  const mmBaseUrl = process.env.MM_URL ?? "";
  const mmAdminToken = process.env.MM_ADMIN_TOKEN ?? "";

  const gitea = createGiteaCleanupClient({
    apiUrl: giteaApiUrl,
    token: giteaToken,
    log: logFn,
  });
  const mattermost = createMmCleanupClient({
    baseUrl: mmBaseUrl,
    adminToken: mmAdminToken,
    log: logFn,
  });

  return createDeprovisionCustomerHandler({
    loadCleanupContext: (uid) => loadCustomerCleanupContext({ db }, uid),
    unmountFromGateway: (gatewayId, slug) =>
      callUnmountRpc(db, secret, gatewayId, slug, logFn),
    cloudCleanup: {
      gitea,
      mattermost,
      nukeUserFirestore: async (uid) => {
        const userRef = db.collection("users").doc(uid);
        await db.recursiveDelete(userRef.collection("secrets"));
        await db.recursiveDelete(userRef.collection("settings"));
        await db.recursiveDelete(userRef.collection("deploys"));
        await db.recursiveDelete(userRef.collection("customers"));
        await db.recursiveDelete(userRef.collection("workspaces"));
        await userRef.delete();
        await db.recursiveDelete(db.collection("customerStats").doc(uid));
      },
      nukeWsTickets: async (uid) => {

const FIRESTORE_BATCH_LIMIT = 500;
        const snap = await db.collection("wsTickets").where("uid", "==", uid).get();
        for (let i = 0; i < snap.docs.length; i += FIRESTORE_BATCH_LIMIT) {
          const batch = db.batch();
          for (const doc of snap.docs.slice(i, i + FIRESTORE_BATCH_LIMIT)) {
            batch.delete(doc.ref);
          }
          await batch.commit();
        }
        return { deleted: snap.size };
      },
      deleteAvatar: async (uid) => {
        const file = getStorage().bucket().file(`avatars/${uid}`);
        const [exists] = await file.exists();
        if (exists) await file.delete();
      },
      deleteAuthUser: async (uid) => {
        try {
          await getAuth().deleteUser(uid);
        } catch (err) {

const code = (err as { code?: string } | null | undefined)?.code;
          if (code === "auth/user-not-found") return;
          throw err;
        }
      },

deleteHostingSites: async (slug, projectSlugs) => {
        const auth = new GoogleAuth({

scopes: ["https://www.googleapis.com/auth/firebase.hosting"],
        });
        const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? "octogee";
        const result = await deleteHostingSitesForCustomer(
          {
            projectId,
            getAccessToken: async () => {
              const token = await auth.getAccessToken();
              if (!token) {
                throw new Error("firebase-hosting: no access token from ADC");
              }
              return token;
            },
            log: logFn,
          },
          slug,
          projectSlugs,
        );
        return { deleted: result.deleted };
      },
      log: logFn,
    },
    now: () => Date.now(),
    log: logFn,
  });
}

async function callUnmountRpc(
  db: Firestore,
  secret: string,
  gatewayId: string,
  slug: string,
  log: (msg: string) => void,
): Promise<void> {

const url = await resolveGatewayUrlFromFirestore(db, gatewayId);
  const migrationId = `deprov-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const body = JSON.stringify({ migrationId, slug });
  const signature = signFleetRequest(secret, migrationId, body);
  const resp = await fetch(`${url}/unmount/${gatewayId}`, {
    method: "POST",
    headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "<no body>");
    throw new Error(`unmount failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  log(`[deprovision] unmount RPC ok gatewayId=${gatewayId} slug=${slug}`);
}

async function resolveGatewayUrlFromFirestore(
  db: Firestore,
  gatewayId: string,
): Promise<string> {
  const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
  if (!doc.exists) {
    throw new Error(`gateway not registered in glmGateways: ${gatewayId}`);
  }
  const data = doc.data() as GatewayDesiredState | undefined;
  const instanceName = data?.instanceName;
  if (!instanceName) {
    throw new Error(`glmGateways/${gatewayId} missing instanceName`);
  }
  return `http://octogee-gateway-${instanceName}.${NAMESPACE}.svc.cluster.local:${FLEET_CONTROLLER_PORT}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
