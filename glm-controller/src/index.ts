import { randomUUID } from "node:crypto";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  type GatewayDesiredState,
  type HelmInstancesMap,
  type Operation,
  type OperationStep,
} from "../../shared/types/glm.js";
import {
  parseHealthResponse,
  startOperatorHeartbeatPoller,
  type OperatorHeartbeatPollerDeps,
} from "./operator-heartbeat-poller.js";
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
  readGatewayAuthToken,
} from "./auth-secret-ensurer.js";
import {
  spawnKubectl,
  syncApiFleetIngressPaths,
  syncFleetIngressPaths,
  syncPreviewIngressPaths,
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
import { createGatewayServiceAccountTeardown } from "./lib/gateway-gsa.js";
import { createRestartGatewayHandler } from "./handlers/restart-gateway.js";
import { createRecycleGatewayHandler } from "./handlers/recycle-gateway.js";
import { createRolloutHandler } from "./handlers/rollout.js";
import { createDeprovisionCustomerHandler } from "./handlers/deprovision-customer.js";
import { deleteAvatarObjects } from "./lib/customer-ops/avatars.js";
import { loadCustomerCleanupContext } from "./lib/customer-ops/cleanup-context.js";
import { createGiteaCleanupClient } from "./lib/customer-ops/gitea.js";
import { createMmCleanupClient } from "./lib/customer-ops/mattermost.js";
import { createUnmountFromGateway } from "./lib/customer-ops/unmount-gateway.js";
import { resolveDefaultStorageBucket } from "./gcp-project.js";
import { signFleetRequest } from "../../scripts/lib/fleet-signature.js";
import { readAssignedSlugsForGateway } from "../../scripts/lib/assigned-roster.js";
import {
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  SIGNATURE_HEADER,
} from "../../shared/types/fleet-controller.js";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";
import { createMigrationClient } from "../../scripts/lib/fleet-migration-client.js";
import {
  cutoverUserGatewayAndMarkMounted,
  type FleetStateFirestore,
} from "../../scripts/lib/fleet-state.js";
import { provisionGatewayAuthSecret, deleteSecret } from "../../scripts/lib/secret-manager.js";
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
const OPERATOR_READY_REFRESH_MS_DEFAULT = 60_000;

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
const OPERATOR_HEARTBEAT_POLL_MS = 15_000;
const OPERATOR_HEALTH_TIMEOUT_MS = 5_000;
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? "8080", 10);

const FLEET_INGRESS_NAME = process.env.FLEET_INGRESS_NAME ?? "octogee-gateway-fleet-control-ingress";
const FLEET_INGRESS_HOST = process.env.FLEET_INGRESS_HOST;
const FLEET_ALIAS_SERVICE = process.env.FLEET_ALIAS_SERVICE ?? "octogee-gateway";

const GATEWAY_EDGE_INGRESS_NAME =
  process.env.GATEWAY_EDGE_INGRESS_NAME ?? "gateway-edge-ingress";
const GATEWAY_EDGE_INGRESS_HOST = process.env.GATEWAY_EDGE_INGRESS_HOST;
const PREVIEW_INGRESS_NAME = process.env.PREVIEW_INGRESS_NAME ?? "preview-ingress";
const PREVIEW_INGRESS_HOST = process.env.PREVIEW_INGRESS_HOST;

const GATEWAY_EDGE_PORT = 3001;
const PREVIEW_PORT = 9080;

function createGatewayPersistentVolumeClaimDeleter(
  kubeOps: KubeOps,
): (gatewayId: string) => Promise<void> {
  return async (gatewayId) => {
    await kubeOps.deletePersistentVolumeClaim({
      namespace: NAMESPACE,
      name: `octogee-gateway-${gatewayId}-data`,
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
    gateways: ReadonlyArray<{ gatewayId: string }>,
  ) => Promise<void>;

  reconcileRetryMs?: number;

  operatorReadyRefreshMs?: number;

  chartFingerprint?: string;
}

function deploymentNameForInstance(gatewayId: string): string {
  return `octogee-gateway-${gatewayId}`;
}

function gatewayServiceInternalUrl(gatewayId: string): string {
  return `http://${deploymentNameForInstance(gatewayId)}.${NAMESPACE}.svc.cluster.local:18789`;
}

function versionFromImageTag(imageTag: string | undefined): string {
  if (!imageTag) return "unknown";
  const [buildSha] = imageTag.split("-oc");
  return buildSha || imageTag;
}

function isRunningGateway(gateway: GatewayDesiredState): boolean {
  return gateway.desiredStatus !== "paused" && gateway.desiredStatus !== "retired";
}

function isRunningOperatorGateway(gateway: GatewayDesiredState): boolean {
  return gateway.profile === "operator" && isRunningGateway(gateway);
}

async function publishPlatformGatewayReady(
  db: Firestore,
  input: {
    gatewayId: string;
    imageTag?: string;
    now: number;
  },
): Promise<void> {
  const ref = db.collection("gateways").doc(input.gatewayId);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const existing = snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined;
    const patch: Record<string, unknown> = {
      gatewayId: input.gatewayId,
      status: "ready",
      version: versionFromImageTag(input.imageTag),
      internalUrl: gatewayServiceInternalUrl(input.gatewayId),
      startedAt: typeof existing?.startedAt === "number" ? existing.startedAt : input.now,
    };
    if (typeof existing?.openclawVersion === "string") {
      patch.openclawVersion = existing.openclawVersion;
    } else {
      patch.openclawVersion = "unknown";
    }
    if (!Array.isArray(existing?.mountedCustomers)) {
      patch.mountedCustomers = [];
    }
    if (!("lastError" in (existing ?? {}))) {
      patch.lastError = null;
    }
    txn.set(ref, patch, { merge: true });
  });
}

async function readGatewayHeartbeatFromFirestore(
  db: Firestore,
  gatewayId: string,
): Promise<{ lastHeartbeatAt: number } | null> {
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
        gatewayId: change.gatewayId,
      });
      continue;
    }
    if (isReplicasOnlyUpdate(change)) {
      const replicas = change.to.replicas ?? 1;
      await kubeOps.scaleDeployment({
        namespace: NAMESPACE,
        name: deploymentNameForInstance(change.gatewayId),
        replicas,
      });
      continue;
    }

    await deps.helm.upsertInstance({
      namespace: NAMESPACE,
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
    names.map(async (gatewayId) => {
      try {
        const live = await kubeOps.readDeployedReplicas({
          namespace: NAMESPACE,
          name: deploymentNameForInstance(gatewayId),
        });
        if (live !== null) {
          actualMap[gatewayId] = { ...actualMap[gatewayId], replicas: live };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(
          `[glm-controller] ⚠ kube readReplicas failed for ${gatewayId}: ${msg} — keeping helm-stored value`,
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
      Object.prototype.hasOwnProperty.call(targetMap, c.gatewayId),
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
    const formatted = orphanDrift.map((d) => d.gatewayId).join(", ");
    deps.log(
      `[glm-controller] ⚠ 🧟 orphan helm release(s) — no matching glmGateways doc: ${formatted} (manual \`helm uninstall octogee-gw-<gatewayId>\` required to remove)`,
    );
  }
  if (draineeDrift.length > 0) {
    deps.log(
      `[glm-controller] drift detected (preserved, not removed): ${draineeDrift.map((d) => d.gatewayId).join(", ")}`,
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
    .map((c) => `${c.kind === "drift" ? "remove" : c.kind}:${c.gatewayId}`)
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
    .filter((g) => typeof g.gatewayId === "string")
    .map((g) => ({ gatewayId: g.gatewayId }));
  try {
    await syncFleetIngress(fleetGateways);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`(source=fleet-ingress) ${message}`);
  }
}

interface ReadyOperatorGateway {
  gatewayId: string;
  imageTag: string;
}

async function refreshOperatorGatewayReadiness(
  deps: ControllerDeps,
  desired: GatewayDesiredState[],
): Promise<ReadyOperatorGateway[]> {
  const kubeOps = deps.kubeOps;
  if (!kubeOps) return [];
  const results = await Promise.all(
    desired.filter(isRunningOperatorGateway).map(async (gateway) => {
      if (!gateway.gatewayId) return null;
      try {
        const available = await kubeOps.readAvailableReplicas({
          namespace: NAMESPACE,
          name: deploymentNameForInstance(gateway.gatewayId),
        });
        if (available == null || available < 1) return null;
        await publishPlatformGatewayReady(deps.db, {
          gatewayId: gateway.gatewayId,
          imageTag: gateway.imageTag,
          now: Date.now(),
        });
        return {
          gatewayId: gateway.gatewayId,
          imageTag: gateway.imageTag,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log(
          `[glm-controller] ⚠ operator readiness refresh failed for ${gateway.gatewayId}: ${msg}`,
        );
        return null;
      }
    }),
  );
  return results.filter((gateway): gateway is ReadyOperatorGateway => gateway != null);
}

function markStepDone(
  steps: OperationStep[],
  name: string,
  now: number,
): OperationStep[] {
  const idx = steps.findIndex((step) => step.name === name);
  if (idx === -1) {
    return [...steps, { name, status: "done", startedAt: now, completedAt: now }];
  }

  return steps.map((step, stepIdx) => {
    if (stepIdx !== idx) return step;
    return {
      name: step.name,
      status: "done",
      startedAt: step.startedAt ?? now,
      completedAt: step.completedAt ?? now,
    };
  });
}

function recoveredAddGatewaySteps(steps: OperationStep[] | undefined, now: number): OperationStep[] {
  return [
    "helm-render",
    "deployment-ready",
    "platform-ready-record",
    "fleet-ingress",
    "reconciler-recovery",
  ].reduce((next, name) => markStepDone(next, name, now), steps ?? []);
}

function isRecoverableOperatorAddGatewayOperation(
  op: Operation | undefined,
  gatewayId: string,
): op is Operation {
  if (!op) return false;
  if (op.kind !== "add-gateway" || op.status !== "running") return false;
  if (op.input?.gatewayId !== gatewayId) return false;
  return op.input?.profile === "operator";
}

async function completeRecoveredOperatorAddGatewayOps(
  deps: ControllerDeps,
  readyGateways: ReadyOperatorGateway[],
): Promise<void> {
  if (readyGateways.length === 0) return;
  const readyGatewayIds = new Set(readyGateways.map((gateway) => gateway.gatewayId));
  const snap = await deps.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .where("status", "==", "running")
    .get();
  const now = Date.now();

  await Promise.all(
    snap.docs.map(async (doc) => {
      const data = doc.data() as Operation | undefined;
      const gatewayId =
        typeof data?.input?.gatewayId === "string" ? data.input.gatewayId : null;
      if (!gatewayId || !readyGatewayIds.has(gatewayId)) return;

      const recovered = await deps.db.runTransaction(async (txn) => {
        const fresh = await txn.get(doc.ref);
        const op = fresh.exists ? (fresh.data() as Operation | undefined) : undefined;
        if (!isRecoverableOperatorAddGatewayOperation(op, gatewayId)) return false;
        txn.update(doc.ref, {
          status: "succeeded",
          completedAt: now,
          steps: recoveredAddGatewaySteps(op.steps, now),
          error: FieldValue.delete(),
          rolledBack: false,
        });
        return true;
      });
      if (recovered) {
        deps.log(
          `[glm-controller] op=${doc.id} → succeeded (recovered operator add-gateway from ready deployment)`,
        );
      }
    }),
  );
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
  const readyOperatorGateways = await refreshOperatorGatewayReadiness(deps, desired);
  await syncFleetIngressIfConfigured(deps, desired);
  await completeRecoveredOperatorAddGatewayOps(deps, readyOperatorGateways);
}

function clearTimer(timer: NodeJS.Timeout | null): null {
  if (timer) clearTimeout(timer);
  return null;
}

export function startReconciler(deps: ControllerDeps): () => void {
  let debounceTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
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

  if (deps.operatorReadyRefreshMs && deps.operatorReadyRefreshMs > 0) {
    refreshTimer = setInterval(() => void tick(), deps.operatorReadyRefreshMs);
  }

  return () => {
    stopped = true;
    unsub();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    if (refreshTimer) clearInterval(refreshTimer);
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

export function buildOperatorHeartbeatPollerDeps(
  db: Firestore,
  log: (msg: string) => void,
  readGatewayAuthTokenForId: (gatewayId: string) => Promise<string>,
): OperatorHeartbeatPollerDeps {
  return {
    listGatewayIds: async () => {
      const snap = await db.collection(GLM_GATEWAYS_COLLECTION).get();
      return snap.docs
        .map((doc) => doc.data() as GatewayDesiredState)
        .filter(isRunningGateway)
        .map((gateway) => gateway.gatewayId);
    },
    fetchHealth: async (gatewayId) => {
      const url = `http://octogee-gateway-${gatewayId}.${NAMESPACE}.svc.cluster.local:${FLEET_CONTROLLER_PORT}/health`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OPERATOR_HEALTH_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        return parseHealthResponse(await res.json());
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    readAssignedSlugs: (gatewayId) => readAssignedSlugsForGateway(db, gatewayId),
    writeHeartbeat: async (gatewayId, record) => {
      await db
        .collection("gateways")
        .doc(gatewayId)
        .set(
          { ...record, lastHeartbeatAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
    },
    evictSlug: async (gatewayId: string, slug: string) => {
      const secret = await readGatewayAuthTokenForId(gatewayId);
      await callUnmountRpc(db, { secret, gatewayId, slug, log, tag: "evict" });
    },
    log,
  };
}

async function main(): Promise<void> {
  initializeApp({
    credential: applicationDefault(),
    storageBucket: resolveDefaultStorageBucket(process.env.GOOGLE_CLOUD_PROJECT),
  });
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
      ingressHost: FLEET_INGRESS_HOST,
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
      ingressHost: GATEWAY_EDGE_INGRESS_HOST,
      namespace: NAMESPACE,
      desiredGateways: gateways,
      gatewayEdgePort: GATEWAY_EDGE_PORT,
      gatewayEdgeServiceName: "gateway-edge",
      log,
    }).then(() => undefined);
  const syncPreviewIngressForGateways = (gateways: ReadonlyArray<FleetGateway>) =>
    syncPreviewIngressPaths({
      runKubectl,
      ingressName: PREVIEW_INGRESS_NAME,
      ingressHost: PREVIEW_INGRESS_HOST,
      namespace: NAMESPACE,
      desiredGateways: gateways,
      previewPort: PREVIEW_PORT,
      log,
    }).then(() => undefined);

const syncAllFleetIngresses = async (gateways: ReadonlyArray<FleetGateway>) => {
    await syncFleetIngressForGateways(gateways);
    await syncApiFleetIngressForGateways(gateways);
    await syncPreviewIngressForGateways(gateways);
  };

const handlerSyncFleetIngress = async () => {
    const snap = await db.collection(GLM_GATEWAYS_COLLECTION).get();
    const gateways: FleetGateway[] = snap.docs
      .map((d) => d.data() as { gatewayId?: unknown })
      .filter((g): g is FleetGateway => typeof g.gatewayId === "string");
    await syncAllFleetIngresses(gateways);
  };

  const readGatewayAuthTokenForId = (gatewayId: string) =>
    readGatewayAuthToken({ runKubectl }, { namespace: NAMESPACE, gatewayId });

  const handlers = await buildHandlers(
    db,
    log,
    helm,
    kubeOps,
    {
      syncFleetIngress: handlerSyncFleetIngress,
      readGatewayAuthTokenForId,
    },
  );

  const chartFingerprint = computeChartFingerprint(GATEWAY_CHART);

  const deps: ControllerDeps = {
    db,
    helm,
    kubeOps,
    handlers,
    log,
    syncFleetIngress: syncAllFleetIngresses,
    operatorReadyRefreshMs: OPERATOR_READY_REFRESH_MS_DEFAULT,
    chartFingerprint,
  };

  log(
    `[glm-controller] boot sha=${process.env.BUILD_SHA ?? "unknown"} oc=${process.env.OPENCLAW_VERSION ?? "n/a"} fork=${process.env.OPENCLAW_FORK_SHA ?? "n/a"} node=${process.version} — namespace=${NAMESPACE} gatewayChart=${GATEWAY_CHART} chartFingerprint=${chartFingerprint.slice(0, 12)} chartDriftAutoRoll=${AUTO_ROLL_ON_CHART_DRIFT} valuesFile=${GATEWAY_VALUES_FILE} fleetIngress=${FLEET_INGRESS_NAME}`,
  );

  await bootstrapGlmGateways(deps);
  await bootstrapDefaultGateway(deps);

  const stopReconciler = startReconciler(deps);
  const stopWorker = startOperationWorker(deps);
  const stopPoller = startOperatorHeartbeatPoller(
    buildOperatorHeartbeatPollerDeps(db, log, readGatewayAuthTokenForId),
    OPERATOR_HEARTBEAT_POLL_MS,
  );

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
    stopPoller();
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
        `[glm-controller] bootstrap: registering existing release as glmGateways/${w.gatewayId}`,
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
      `[glm-controller] default-gateway bootstrap: created glmGateways/${decision.gatewayId} (imageTag=${decision.doc.imageTag})`,
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

async function readGatewayProfileFromFirestore(
  db: Firestore,
  gatewayId: string,
): Promise<"standard" | "operator"> {
  const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
  const data = doc.data() as GatewayDesiredState | undefined;
  return data?.profile === "operator" ? "operator" : "standard";
}

function createMigrationClientBuilder(
  db: Firestore,
  secret: string,
  logFn: (msg: string) => void,
  readGatewayAuthTokenForId: (gatewayId: string) => Promise<string>,
) {
  return (resolveSync: (gatewayId: string) => string) =>
    createMigrationClient({
      secret,
      resolveGatewayUrl: resolveSync,
      log: logFn,
      resolveRequestSecret: async (gatewayId) => {
        const profile = await readGatewayProfileFromFirestore(db, gatewayId);
        if (profile !== "operator") return secret;
        return readGatewayAuthTokenForId(gatewayId);
      },
    });
}

async function buildHandlers(
  db: Firestore,
  logFn: (msg: string) => void,
  helm: HelmRunner,
  kubeOps: KubeOps,
  fleetOps: {
    syncFleetIngress: () => Promise<void>;
    readGatewayAuthTokenForId: (gatewayId: string) => Promise<string>;
  },
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
    readGatewayHeartbeat: (gatewayId) =>
      readGatewayHeartbeatFromFirestore(db, gatewayId),
    publishGatewayReady: async ({ gatewayId, imageTag }) => {
      await publishPlatformGatewayReady(db, {
        gatewayId,
        imageTag,
        now: Date.now(),
      });
    },
    syncFleetIngress: fleetOps.syncFleetIngress,
    helmRenderTimeoutMs: 600_000,
    deploymentReadyTimeoutMs: 600_000,
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
    readGatewayProfile: (gatewayId) => readGatewayProfileFromFirestore(db, gatewayId),
    buildClient: createMigrationClientBuilder(
      db,
      secret,
      logFn,
      fleetOps.readGatewayAuthTokenForId,
    ),
    genMigrationId: () => `mig-${Date.now()}-${randomUUID().slice(0, 8)}`,
    now: () => Date.now(),
    log: logFn,
  });

  const retireGateway = createRetireGatewayHandler({
    helm,
    readGatewayLiveState: async (gatewayId) => {
      const doc = await db.collection("gateways").doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as { mountedCustomers?: unknown } | undefined;
      const mounted = Array.isArray(data?.mountedCustomers)
        ? (data!.mountedCustomers as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      return { mountedCustomers: mounted };
    },
    readGlmGatewayId: async (gatewayId) => {
      const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as GatewayDesiredState | undefined;
      return data?.gatewayId ?? null;
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
    deleteGatewayKubeSecret: async (gatewayId) =>
      kubeOps.deleteSecret({ namespace: NAMESPACE, name: `gateway-auth-token-${gatewayId}` }),
    deleteAuthTokenSecret: async (gatewayId) => {
      await deleteSecret(`gateway-auth-token-${gatewayId}`);
    },
    teardownGatewayServiceAccount: createGatewayServiceAccountTeardown({
      projectId: requireEnv(
        "GOOGLE_CLOUD_PROJECT",
        "gateway service-account teardown must target this env's GCP project",
      ),
      log: logFn,
      request: async ({ url, method }) => {
        const auth = new GoogleAuth({
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        });
        const client = await auth.getClient();
        const res = await client.request<unknown>({ url, method });
        return { status: res.status };
      },
    }),
    syncFleetIngress: fleetOps.syncFleetIngress,
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
      if (!data?.gatewayId || !data.imageRepository || !data.imageTag) return null;
      return {
        gatewayId: data.gatewayId,
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

  const deprovisionCustomer = buildDeprovisionCustomerHandler(
    db,
    secret,
    logFn,
    kubeOps,
    fleetOps.readGatewayAuthTokenForId,
  );

  const restartGateway = createRestartGatewayHandler({
    kubeOps,
    namespace: NAMESPACE,
    now: () => Date.now(),
    log: logFn,
  });

  const recycleGateway = createRecycleGatewayHandler({
    readDesiredStatus: async (gatewayId) => {
      const v = (
        await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get()
      ).data()?.desiredStatus;
      return v === "running" || v === "paused" || v === "draining" || v === "retired" ? v : null;
    },
    setDesiredStatus: async (gatewayId, status) => {
      await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .doc(gatewayId)
        .set({ desiredStatus: status }, { merge: true });
    },
    readAvailableReplicas: (gatewayId) =>
      kubeOps.readAvailableReplicas({
        namespace: NAMESPACE,
        name: `octogee-gateway-${gatewayId}`,
      }),
    now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logFn,
    drainTimeoutMs: 180_000,
    readyTimeoutMs: 420_000,
    pollIntervalMs: 5_000,
  });

  return {
    "add-gateway": addGateway,
    "migrate-customer": migrateCustomer,
    "retire-gateway": retireGateway,
    "restart-gateway": restartGateway,
    "recycle-gateway": recycleGateway,
    rollout,
    "deprovision-customer": deprovisionCustomer,
  };
}

function requireEnv(name: string, why: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — ${why}. Refusing to start with a guessed default.`);
  }
  return value;
}

function buildDeprovisionCustomerHandler(
  db: Firestore,
  secret: string,
  logFn: (msg: string) => void,
  kubeOps: Pick<KubeOps, "readAvailableReplicas">,
  readGatewayAuthTokenForId: (gatewayId: string) => Promise<string>,
) {
  const cleanupEnv = (name: string) =>
    requireEnv(name, "deprovision-customer cloud cleanup requires it");
  const gitea = createGiteaCleanupClient({
    apiUrl: cleanupEnv("GIT_API_URL"),
    token: cleanupEnv("GIT_API_TOKEN"),
    log: logFn,
  });
  const mattermost = createMmCleanupClient({
    baseUrl: cleanupEnv("MM_URL"),
    adminToken: cleanupEnv("MM_ADMIN_TOKEN"),
    log: logFn,
  });

  return createDeprovisionCustomerHandler({
    loadCleanupContext: (uid) => loadCustomerCleanupContext({ db }, uid),
    unmountFromGateway: createUnmountFromGateway({
      readGatewayProfile: async (gatewayId) => {
        const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
        if (!doc.exists) return null;
        const data = doc.data() as GatewayDesiredState | undefined;
        return data?.profile === "operator" ? "operator" : "standard";
      },
      readAvailableReplicas: (gatewayId) =>
        kubeOps.readAvailableReplicas({
          namespace: NAMESPACE,
          name: deploymentNameForInstance(gatewayId),
        }),
      fleetSecret: secret,
      readGatewayAuthToken: readGatewayAuthTokenForId,
      unmountRpc: ({ gatewayId, slug, secret: rpcSecret }) =>
        callUnmountRpc(db, { secret: rpcSecret, gatewayId, slug, log: logFn }),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      log: logFn,
    }),
    cloudCleanup: {
      gitea,
      mattermost,
      nukeUserFirestore: async (uid, slug) => {
        const userRef = db.collection("users").doc(uid);
        await db.recursiveDelete(userRef.collection("secrets"));
        await db.recursiveDelete(userRef.collection("settings"));
        await db.recursiveDelete(userRef.collection("deploys"));
        await db.recursiveDelete(userRef.collection("customers"));
        await db.recursiveDelete(userRef.collection("workspaces"));
        await userRef.delete();
        await db.recursiveDelete(db.collection("customerStats").doc(uid));
        await db.recursiveDelete(db.collection("workspaces").doc(slug));
        await db.recursiveDelete(db.collection("agents").doc(uid));
      },
      deleteAvatar: (uid) => deleteAvatarObjects(getStorage().bucket(), uid),
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
        const projectId = requireEnv(
          "GOOGLE_CLOUD_PROJECT",
          "hosting-site deletion must target this env's Firebase project",
        );
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

export async function callUnmountRpc(
  db: Firestore,
  opts: {
    secret: string;
    gatewayId: string;
    slug: string;
    log: (msg: string) => void;
    tag?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const {
    secret,
    gatewayId,
    slug,
    log,
    tag = "deprov",
    timeoutMs = MIGRATION_UNMOUNT_TIMEOUT_MS,
  } = opts;

  const url = await resolveGatewayUrlFromFirestore(db, gatewayId);
  const migrationId = `${tag}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const body = JSON.stringify({ migrationId, slug });
  const signature = signFleetRequest(secret, migrationId, body);
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${url}/unmount/${gatewayId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signature,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (didTimeout) {
      throw new Error(
        `unmount timed out after ${timeoutMs}ms gatewayId=${gatewayId} slug=${slug}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "<no body>");
    throw new Error(`unmount failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  log(`[${tag}] unmount RPC ok gatewayId=${gatewayId} slug=${slug}`);
}

async function resolveGatewayUrlFromFirestore(
  db: Firestore,
  gatewayId: string,
): Promise<string> {
  const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
  if (!doc.exists) {
    throw new Error(`gateway not registered in glmGateways: ${gatewayId}`);
  }
  return `http://octogee-gateway-${gatewayId}.${NAMESPACE}.svc.cluster.local:${FLEET_CONTROLLER_PORT}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
