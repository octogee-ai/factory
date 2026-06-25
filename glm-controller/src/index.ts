import { randomUUID } from "node:crypto";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import {
  getFirestore,
  FieldValue,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  isGatewayClass,
  isGatewayProfile,
  resolveGatewayClass,
  resolveGatewayImageProfile,
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
  isImageRoll,
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
  createGatewayModelKeySecretEnsurer,
  type GatewayModelKeySecretEnsurer,
} from "./model-key-secret-ensurer.js";
import {
  createConfiguredGatewayModelKeyIssuerBackend,
  createGatewayModelKeySourceIssuer,
  type GatewayModelKeySourceIssuer,
} from "./model-key-source-issuer.js";
import {
  spawnKubectl,
  syncEdgeIngress,
  type FleetGateway,
  type KubectlSubprocess,
} from "./fleet-ingress.js";
import {
  routeOperation,
  type OperationContext,
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
import {
  buildSiblingDoc,
  runBlueGreenRollout,
  type BlueGreenRolloutDeps,
} from "./handlers/rollout-bluegreen.js";
import { createDeprovisionCustomerHandler } from "./handlers/deprovision-customer.js";
import { deleteAvatarObjects } from "./lib/customer-ops/avatars.js";
import { loadCustomerCleanupContext } from "./lib/customer-ops/cleanup-context.js";
import { createGiteaCleanupClient } from "./lib/customer-ops/gitea.js";
import { createMmCleanupClient } from "./lib/customer-ops/mattermost.js";
import { createUnmountFromGateway } from "./lib/customer-ops/unmount-gateway.js";
import { resolveDefaultStorageBucket } from "./gcp-project.js";
import { signFleetRequest } from "../../scripts/lib/fleet-signature.js";
import {
  readAssignedSlugsForGateway,
  slugFromAssignedUser,
} from "../../scripts/lib/assigned-roster.js";
import {
  mapProjectChannelDoc,
  mapWorkspaceChannelDoc,
} from "../../scripts/lib/customer-snapshot-mapping.js";
import {
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  SIGNATURE_HEADER,
} from "../../shared/types/fleet-controller.js";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";
import { createMigrationClient } from "../../scripts/lib/fleet-migration-client.js";
import { createRsyncMigrationTransfer } from "./lib/migration-rsync-transfer.js";
import {
  cutoverUserGatewayAndMarkMounted,
  type FleetStateFirestore,
} from "../../scripts/lib/fleet-state.js";
import {
  provisionGatewayAuthSecret,
  deleteSecret,
  readSecretWithLabels,
  writeSecret,
} from "../../scripts/lib/secret-manager.js";
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
import { startHelmRecoverySweeper } from "./helm-recovery-sweeper.js";
import { resumeOrphanedRunningOps } from "./resume-orphaned-ops.js";
import {
  ACTIVATION_LEASE_SWEEP_MS_DEFAULT,
  startBuilderActivationLeaseSweeper,
} from "./builder-activation-sweeper.js";
import {
  DEDICATED_GATEWAY_IDLE_SWEEP_MS_DEFAULT,
  startDedicatedGatewayIdleSweeper,
} from "./dedicated-gateway-idle-sweeper.js";
import { startDeferredRolloutSweeper } from "./rollout-defer-sweeper.js";
import {
  buildBlueGreenMigrateOpDoc,
  runBlueGreenMigrateOp,
  type MigrateOpStatus,
} from "./rollout-migrate-op.js";
import { readShellLiveness } from "./shell-liveness.js";
import type { RolloutDeferMarker } from "./handlers/rollout.js";
import {
  PREEMPTION_HANDOFF_SWEEP_MS_DEFAULT,
  startPreemptionHandoffSweeper,
} from "./preemption-handoff-sweeper.js";
import { computeChartFingerprint } from "./chart-fingerprint.js";
import { createCachedApiServerEgressResolver } from "./apiserver-egress.js";
import type {
  FleetBrokerChannelBinding,
  FleetBrokerProjectRestore,
  FleetBrokerUserSnapshot,
} from "../../shared/types/fleet-broker.js";

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
const ACTIVATION_LEASE_SWEEP_MS = parseNonNegativeInt(
  process.env.ACTIVATION_LEASE_SWEEP_MS,
  ACTIVATION_LEASE_SWEEP_MS_DEFAULT,
);
const DEDICATED_GATEWAY_IDLE_MS = parseNonNegativeInt(
  process.env.DEDICATED_GATEWAY_IDLE_MS,
  0,
);
const DEDICATED_GATEWAY_IDLE_SWEEP_MS = parseNonNegativeInt(
  process.env.DEDICATED_GATEWAY_IDLE_SWEEP_MS,
  DEDICATED_GATEWAY_IDLE_SWEEP_MS_DEFAULT,
);
const PREEMPTION_HANDOFF_SWEEP_MS = parseNonNegativeInt(
  process.env.PREEMPTION_HANDOFF_SWEEP_MS,
  PREEMPTION_HANDOFF_SWEEP_MS_DEFAULT,
);
const HELM_RECOVERY_SWEEP_MS = parseNonNegativeInt(
  process.env.HELM_RECOVERY_SWEEP_MS,
  3 * 60 * 1000,
);
// A helm release must be pending continuously for longer than this before the
// recovery sweeper treats it as an orphaned wedge. Set > the helm `--wait` upgrade
// timeout (10m) so a legitimately in-progress install/upgrade is never recovered.
const HELM_RECOVERY_STALE_MS = parseNonNegativeInt(
  process.env.HELM_RECOVERY_STALE_MS,
  15 * 60 * 1000,
);

// One shared edge ingress carries both the api host (/api/g/<id>/* locality
// routes) and the preview host (/g/<id>/*). Cowboy owns its .spec.rules; the
// umbrella chart publishes the static base routes via the EDGE_ROUTES_CONFIGMAP
// ConfigMap and owns only the Ingress object + metadata.
const GATEWAY_EDGE_INGRESS_NAME =
  process.env.GATEWAY_EDGE_INGRESS_NAME ?? "octogee-edge-ingress";
const GATEWAY_EDGE_INGRESS_HOST = process.env.GATEWAY_EDGE_INGRESS_HOST;
const PREVIEW_INGRESS_HOST = process.env.PREVIEW_INGRESS_HOST;
const EDGE_ROUTES_CONFIGMAP =
  process.env.EDGE_ROUTES_CONFIGMAP ?? "octogee-edge-routes";
const EDGE_INGRESS_FIELD_MANAGER = "cowboy-fleet-ingress";

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

function createGatewayDeploymentRestarter(
  runKubectl: KubectlSubprocess,
  logFn: (msg: string) => void,
): (gatewayId: string) => Promise<void> {
  return async (gatewayId) => {
    const name = deploymentNameForInstance(gatewayId);
    const result = await runKubectl([
      "-n",
      NAMESPACE,
      "rollout",
      "restart",
      `deploy/${name}`,
    ]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim());
    }
    logFn(`[glm-controller] rollout restart deploy/${name} after model-key secret change`);
  };
}

interface ControllerDeps {
  db: Firestore;
  helm: HelmRunner;
  kubeOps?: KubeOps;
  modelKeySourceIssuer?: GatewayModelKeySourceIssuer;
  modelKeySecretEnsurer?: GatewayModelKeySecretEnsurer;
  restartGatewayDeployment?: (gatewayId: string) => Promise<void>;
  handlers: OperationHandlers;
  log: (msg: string) => void;

  syncFleetIngress?: (
    gateways: ReadonlyArray<{ gatewayId: string }>,
  ) => Promise<void>;

  reconcileRetryMs?: number;

  operatorReadyRefreshMs?: number;

  chartFingerprint?: string;

  resolveApiServerEgressCidrs?: () => Promise<string[]>;
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

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isRunningGateway(gateway: GatewayDesiredState): boolean {
  return gateway.desiredStatus !== "paused" && gateway.desiredStatus !== "retired";
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
  mountedByGatewayId: Map<string, readonly string[]>,
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

    // Invariant: NEVER in-place-roll a gateway's image while customers are
    // mounted — that drops every live session (the builder1 outage). Such a roll
    // must go through the blue/green orchestrator (rollout op). A stray direct
    // imageTag write lands here; refuse it loudly rather than cut a live pod.
    const mountedCount = mountedByGatewayId.get(change.gatewayId)?.length ?? 0;
    if (isImageRoll(change) && mountedCount > 0) {
      deps.log(
        `[glm-controller] ⛔ REFUSED in-place image roll of ${change.gatewayId} ` +
          `(${change.from.image.repository}:${change.from.image.tag} → ` +
          `${change.to.image.repository}:${change.to.image.tag}) — ${mountedCount} customer(s) mounted. ` +
          `Roll it via the blue/green rollout operation, not a direct imageTag write.`,
      );
      continue;
    }

    await deps.helm.upsertInstance({
      namespace: NAMESPACE,
      gatewayId: change.to.gatewayId,
      builderSlug: change.to.builderSlug,
      imageRepository: change.to.image.repository,
      imageTag: change.to.image.tag,
      serviceAccountName: change.to.serviceAccountName,
      serviceAccount: change.to.serviceAccount,
      gatewayContainerSecurityContext: change.to.gatewayContainerSecurityContext,
      persistence: change.to.persistence,
      operatorAccess: change.to.operatorAccess,
      computeClassOverride: change.to.computeClassOverride,
      profile: change.to.profile,
      gatewayClass: change.to.gatewayClass,
      imageProfile: change.to.imageProfile,
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

async function syncGatewayModelKeySecrets(
  deps: ControllerDeps,
  desired: GatewayDesiredState[],
): Promise<Set<string>> {
  const ensurer = deps.modelKeySecretEnsurer;
  const changedBrokerGateways = new Set<string>();
  if (!ensurer) return changedBrokerGateways;

  for (const gateway of desired) {
    if (!gateway.gatewayId) continue;
    const gatewayClass =
      gateway.desiredStatus === "retired" ? "shared" : resolveGatewayClass(gateway);
    try {
      const result = await ensurer.syncGatewayModelKeySecret({
        namespace: NAMESPACE,
        gatewayId: gateway.gatewayId,
        gatewayClass,
      });
      if (
        result.changed &&
        (gatewayClass === "builder" || gatewayClass === "operator") &&
        gateway.desiredStatus === "running"
      ) {
        changedBrokerGateways.add(gateway.gatewayId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`(source=model-key-secret) ${gateway.gatewayId}: ${message}`);
    }
  }

  return changedBrokerGateways;
}

async function syncGatewayModelKeySources(
  deps: ControllerDeps,
  desired: GatewayDesiredState[],
): Promise<void> {
  const issuer = deps.modelKeySourceIssuer;
  if (!issuer) return;

  for (const gateway of desired) {
    if (!gateway.gatewayId) continue;
    const gatewayClass = resolveGatewayClass(gateway);
    try {
      await issuer.syncGatewayModelKeySource({
        gatewayId: gateway.gatewayId,
        gatewayClass,
        desiredStatus: gateway.desiredStatus,
        ownerUid: gateway.ownerUid,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`(source=model-key-source) ${gateway.gatewayId}: ${message}`);
    }
  }
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
  mountedByGatewayId: Map<string, readonly string[]>,
): Promise<void> {
  if (targetVsActual.length === 0) {
    deps.log(`[glm-controller] reconcile tick: no changes (${desiredCount} desired, ${actualCount} actual)`);
    return;
  }
  const summary = targetVsActual
    .map((c) => `${c.kind === "drift" ? "remove" : c.kind}:${c.gatewayId}`)
    .join(", ");
  deps.log(`[glm-controller] reconcile tick: ${targetVsActual.length} change(s) — ${summary}`);
  await applyChanges(targetVsActual, deps, mountedByGatewayId);
}

async function restartGatewayDeploymentsForModelKeyChanges(
  deps: ControllerDeps,
  changedGatewayIds: Set<string>,
  targetVsActual: ReconcileChange[],
): Promise<void> {
  if (!deps.restartGatewayDeployment || changedGatewayIds.size === 0) return;
  const helmTouchedGatewayIds = new Set(
    targetVsActual
      .filter((change) => change.kind !== "drift")
      .map((change) => change.gatewayId),
  );
  for (const gatewayId of changedGatewayIds) {
    if (helmTouchedGatewayIds.has(gatewayId)) continue;
    try {
      await deps.restartGatewayDeployment(gatewayId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`(source=model-key-secret) ${gatewayId}: rollout restart failed: ${message}`);
    }
  }
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

interface ReadyGateway {
  gatewayId: string;
  imageTag: string;
}

async function refreshGatewayReadiness(
  deps: ControllerDeps,
  desired: GatewayDesiredState[],
): Promise<ReadyGateway[]> {
  const kubeOps = deps.kubeOps;
  if (!kubeOps) return [];
  const results = await Promise.all(
    desired.filter(isRunningGateway).map(async (gateway) => {
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
          `[glm-controller] ⚠ readiness refresh failed for ${gateway.gatewayId}: ${msg}`,
        );
        return null;
      }
    }),
  );
  return results.filter((gateway): gateway is ReadyGateway => gateway != null);
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
  return resolveGatewayClass({
    gatewayClass: isGatewayClass(op.input?.gatewayClass)
      ? op.input.gatewayClass
      : undefined,
    profile: isGatewayProfile(op.input?.profile) ? op.input.profile : undefined,
    imageProfile: isGatewayProfile(op.input?.imageProfile)
      ? op.input.imageProfile
      : undefined,
  }) === "operator";
}

async function completeRecoveredOperatorAddGatewayOps(
  deps: ControllerDeps,
  readyGateways: ReadyGateway[],
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
  await syncGatewayModelKeySources(deps, desired);
  const modelKeyChangedGatewayIds = await syncGatewayModelKeySecrets(deps, desired);
  const apiServerEgressCidrs = (await deps.resolveApiServerEgressCidrs?.()) ?? [];
  const desiredMap = buildInstancesMap(desired, deps.chartFingerprint, apiServerEgressCidrs);
  const changes = diffInstancesMap(actualMap, desiredMap, {
    compareChartFingerprint: AUTO_ROLL_ON_CHART_DRIFT,
  });
  const targetMap = buildHelmTargetMap(
    desired,
    actualMap,
    mountedByGatewayId,
    deps.chartFingerprint,
    apiServerEgressCidrs,
  );
  logPreservedDrift(deps, preservedDriftChanges(changes, targetMap), desired);
  const targetVsActual = diffInstancesMap(actualMap, targetMap, {
    compareChartFingerprint: AUTO_ROLL_ON_CHART_DRIFT,
  });
  await applyTargetChanges(
    deps,
    targetVsActual,
    desired.length,
    Object.keys(actualMap).length,
    mountedByGatewayId,
  );
  await restartGatewayDeploymentsForModelKeyChanges(
    deps,
    modelKeyChangedGatewayIds,
    targetVsActual,
  );
  const readyGateways = await refreshGatewayReadiness(deps, desired);
  await syncFleetIngressIfConfigured(deps, desired);
  await completeRecoveredOperatorAddGatewayOps(deps, readyGateways);
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

// Op kinds safe to re-drive after a controller restart (idempotent orchestrators).
// The blue/green rollout is the long, repoint-then-migrate op that strands a pool if
// abandoned mid-flight; its migrate sub-ops are re-issued by the rollout re-drive, so
// they are intentionally NOT resumed directly.
const RESUMABLE_OP_KINDS: ReadonlySet<string> = new Set(["rollout"]);

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
      const now = Date.now();
      txn.update(ref, { status: "running", startedAt: now, lastProgressAt: now });
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
  await runClaimedOperation(op, ref, deps);
}

// Re-adopt an op the previous controller instance left `running` (orphaned by a
// deploy/restart mid-op) and re-drive it. Bumps the liveness heartbeat so the
// stuck-op reaper gives the resumed run a fresh budget, and records resumeCount.
async function reAdoptAndRunOperation(
  op: Operation,
  ref: FirebaseFirestore.DocumentReference,
  deps: ControllerDeps,
): Promise<void> {
  let adopted = false;
  try {
    adopted = await deps.db.runTransaction(async (txn) => {
      const fresh = await txn.get(ref);
      if (!fresh.exists) return false;
      const data = fresh.data() as Operation | undefined;
      if (data?.status !== "running") return false;
      const now = Date.now();
      txn.update(ref, {
        startedAt: now,
        lastProgressAt: now,
        resumeCount: (typeof data.resumeCount === "number" ? data.resumeCount : 0) + 1,
      });
      return true;
    });
  } catch (err) {
    deps.log(
      `[glm-controller] re-adopt transaction failed op=${op.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (!adopted) {
    deps.log(`[glm-controller] op=${op.id} no longer running — skip resume`);
    return;
  }
  await runClaimedOperation(op, ref, deps);
}

// Run an op whose status is already `running` (freshly claimed or re-adopted):
// invoke its handler, persisting step progress (with a liveness heartbeat) and the
// terminal result.
async function runClaimedOperation(
  op: Operation,
  ref: FirebaseFirestore.DocumentReference,
  deps: ControllerDeps,
): Promise<void> {
  const { ctx, steps } = createOperationContext({
    persist: async (next) => {
      await ref.update({ steps: next, lastProgressAt: Date.now() });
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
  privateKey: string,
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
      await callUnmountRpc(db, { privateKey, gatewayId, slug, log, tag: "evict" });
    },
    log,
  };
}

type ControllerStopper = () => void;

interface DeferredRolloutMarkerDoc {
  id: string;
  data(): { rollout?: unknown };
}

interface ControllerBackgroundTasksDeps {
  db: Firestore;
  deps: ControllerDeps;
  helm: HelmRunner;
  fleetControllerPrivateKey: string;
}

export function deferredRolloutMarkersFromDocs(
  docs: ReadonlyArray<DeferredRolloutMarkerDoc>,
): Array<{ gatewayId: string; marker: RolloutDeferMarker }> {
  const out: Array<{ gatewayId: string; marker: RolloutDeferMarker }> = [];
  for (const doc of docs) {
    const r = doc.data().rollout;
    if (
      r &&
      typeof r === "object" &&
      typeof (r as RolloutDeferMarker).imageTag === "string" &&
      typeof (r as RolloutDeferMarker).imageRepository === "string"
    ) {
      const m = r as RolloutDeferMarker;
      out.push({
        gatewayId: doc.id,
        marker: {
          imageTag: m.imageTag,
          imageRepository: m.imageRepository,
          ...(m.profile ? { profile: m.profile } : {}),
          ...(m.gatewayClass ? { gatewayClass: m.gatewayClass } : {}),
          ...(m.imageProfile ? { imageProfile: m.imageProfile } : {}),
        },
      });
    }
  }
  return out;
}

function startDeferredRolloutSweeperForController(
  db: Firestore,
  log: (msg: string) => void,
): ControllerStopper {
  return startDeferredRolloutSweeper({
    listDeferredRollouts: async () => {
      const snap = await db.collection(GLM_GATEWAYS_COLLECTION).get();
      return deferredRolloutMarkersFromDocs(snap.docs);
    },
    readShellActivity: async (gatewayId) => ({
      hasActiveSession: (await readShellLiveness(db, gatewayId, Date.now())).reallyActive,
    }),
    hasInFlightRollout: async (gatewayId) => {
      const snap = await db
        .collection(GLM_OPERATIONS_COLLECTION)
        .where("gatewayId", "==", gatewayId)
        .get();
      return snap.docs.some((d) => {
        const data = d.data() as { kind?: unknown; status?: unknown };
        return (
          data.kind === "rollout" &&
          (data.status === "pending" || data.status === "running")
        );
      });
    },
    enqueueRolloutAndClearMarker: async (gatewayId, marker) => {
      const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
      const batch = db.batch();
      batch.set(opRef, {
        kind: "rollout",
        status: "pending",
        createdBy: "glm-controller-rollout-defer-sweeper",
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        input: {
          gatewayId,
          imageTag: marker.imageTag,
          imageRepository: marker.imageRepository,
          ...(marker.profile ? { profile: marker.profile } : {}),
          ...(marker.gatewayClass ? { gatewayClass: marker.gatewayClass } : {}),
          ...(marker.imageProfile ? { imageProfile: marker.imageProfile } : {}),
        },
        steps: [],
        gatewayId,
      });
      batch.update(db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId), {
        rollout: FieldValue.delete(),
      });
      await batch.commit();
      return opRef.id;
    },
    now: () => Date.now(),
    log,
  });
}

function startControllerBackgroundTasks({
  db,
  deps,
  helm,
  fleetControllerPrivateKey,
}: ControllerBackgroundTasksDeps): ControllerStopper[] {
  const stopReconciler = startReconciler(deps);
  const stopWorker = startOperationWorker(deps);
  const stopPoller = startOperatorHeartbeatPoller(
    buildOperatorHeartbeatPollerDeps(db, log, fleetControllerPrivateKey),
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
  const stopHelmRecoverySweeper = startHelmRecoverySweeper({
    listPending: () => helm.listPendingReleases({ namespace: NAMESPACE }),
    recover: (gatewayId) => helm.recoverRelease({ namespace: NAMESPACE, gatewayId }),
    now: () => Date.now(),
    staleMs: HELM_RECOVERY_STALE_MS,
    intervalMs: HELM_RECOVERY_SWEEP_MS,
    log,
  });
  const stopActivationSweeper = startBuilderActivationLeaseSweeper(
    { db, workspaceSlugsForUser, now: () => Date.now(), log },
    ACTIVATION_LEASE_SWEEP_MS,
  );
  const stopIdleSweeper = startDedicatedGatewayIdleSweeper(
    {
      db,
      idleMs: DEDICATED_GATEWAY_IDLE_MS,
      namespace: NAMESPACE,
      flushGateway: ({ gatewayId, slug, reason }) =>
        callFlushRpc(db, {
          privateKey: fleetControllerPrivateKey,
          gatewayId,
          slug,
          reason,
          log,
          tag: "idle-sleep",
        }),
      now: () => Date.now(),
      log,
    },
    DEDICATED_GATEWAY_IDLE_SWEEP_MS,
  );
  const stopPreemptionHandoffSweeper = startPreemptionHandoffSweeper(
    { db, now: () => Date.now(), log },
    PREEMPTION_HANDOFF_SWEEP_MS,
  );
  const stopDeferredRolloutSweeper = startDeferredRolloutSweeperForController(db, log);
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
  return [
    stopReconciler,
    stopWorker,
    stopPoller,
    stopReaper,
    stopStuckOpReaper,
    stopHelmRecoverySweeper,
    stopActivationSweeper,
    stopIdleSweeper,
    stopPreemptionHandoffSweeper,
    stopDeferredRolloutSweeper,
    stopHttp,
  ];
}

function createControllerShutdown(
  stoppers: ReadonlyArray<ControllerStopper>,
  log: (msg: string) => void,
): () => void {
  return () => {
    log("[glm-controller] shutdown signal — stopping subscribers");
    for (const stop of stoppers) stop();
    process.exit(0);
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
  const modelKeySecretEnsurer = createGatewayModelKeySecretEnsurer({
    runKubectl,
    readSourceSecret: async (secretName) => {
      try {
        return await readSecretWithLabels(secretName);
      } catch (err) {
        if ((err as { code?: number } | null)?.code === 5) return null;
        throw err;
      }
    },
    log,
  });
  const modelKeySourceIssuer = createGatewayModelKeySourceIssuer({
    readSourceSecret: async (secretName) => {
      try {
        return await readSecretWithLabels(secretName);
      } catch (err) {
        if ((err as { code?: number } | null)?.code === 5) return null;
        throw err;
      }
    },
    writeSourceSecret: async ({ name, value, labels }) => {
      await writeSecret({ name, value, labels });
    },
    deleteSourceSecret: deleteSecret,
    backend: createConfiguredGatewayModelKeyIssuerBackend(process.env),
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
  const syncEdgeIngressForGateways = (gateways: ReadonlyArray<FleetGateway>) =>
    syncEdgeIngress({
      runKubectl,
      ingressName: GATEWAY_EDGE_INGRESS_NAME,
      namespace: NAMESPACE,
      baseRoutesConfigMap: EDGE_ROUTES_CONFIGMAP,
      apiHost: GATEWAY_EDGE_INGRESS_HOST,
      previewHost: PREVIEW_INGRESS_HOST,
      gatewayEdgePort: GATEWAY_EDGE_PORT,
      previewPort: PREVIEW_PORT,
      desiredGateways: gateways,
      fieldManager: EDGE_INGRESS_FIELD_MANAGER,
      log,
    }).then(() => undefined);

  const handlerSyncFleetIngress = async () => {
    const snap = await db.collection(GLM_GATEWAYS_COLLECTION).get();
    const gateways: FleetGateway[] = snap.docs
      .map((d) => d.data() as { gatewayId?: unknown })
      .filter((g): g is FleetGateway => typeof g.gatewayId === "string");
    await syncEdgeIngressForGateways(gateways);
  };

  const fleetControllerPrivateKey = requireEnv(
    "FLEET_CONTROLLER_PRIVATE_KEY",
    "migrate-customer, deprovision-customer, and operator eviction RPCs require the controller signing key",
  );

  const handlers = await buildHandlers(
    db,
    log,
    helm,
    kubeOps,
    {
      syncFleetIngress: handlerSyncFleetIngress,
      privateKey: fleetControllerPrivateKey,
    },
  );

  const chartFingerprint = computeChartFingerprint(GATEWAY_CHART);

  const deps: ControllerDeps = {
    db,
    helm,
    kubeOps,
    modelKeySourceIssuer,
    modelKeySecretEnsurer,
    restartGatewayDeployment: createGatewayDeploymentRestarter(runKubectl, log),
    handlers,
    log,
    syncFleetIngress: syncEdgeIngressForGateways,
    operatorReadyRefreshMs: OPERATOR_READY_REFRESH_MS_DEFAULT,
    chartFingerprint,
    resolveApiServerEgressCidrs: createCachedApiServerEgressResolver(
      (args) => spawnKubectl(args),
      log,
    ),
  };

  log(
    `[glm-controller] boot sha=${process.env.BUILD_SHA ?? "unknown"} oc=${process.env.OPENCLAW_VERSION ?? "n/a"} fork=${process.env.OPENCLAW_FORK_SHA ?? "n/a"} node=${process.version} — namespace=${NAMESPACE} gatewayChart=${GATEWAY_CHART} chartFingerprint=${chartFingerprint.slice(0, 12)} chartDriftAutoRoll=${AUTO_ROLL_ON_CHART_DRIFT} valuesFile=${GATEWAY_VALUES_FILE}`,
  );

  await bootstrapGlmGateways(deps);
  await bootstrapDefaultGateway(deps);

  // Resume any op the previous instance left `running` when it exited mid-op (a
  // deploy/restart redeploys this single-replica controller routinely). Re-driving
  // the rollout idempotently is what keeps a redeploy from stranding a half-migrated
  // pool; it runs before the stuck-op reaper's first tick so the re-adopt heartbeat
  // protects the resumed run from being reaped.
  resumeOrphanedRunningOps({
    db,
    log,
    resumableKinds: RESUMABLE_OP_KINDS,
    redrive: (op, ref) => reAdoptAndRunOperation(op, ref, deps),
  }).catch((err) =>
    log(
      `[glm-controller] ⚠ resume-orphaned-ops sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );

  const stoppers = startControllerBackgroundTasks({
    db,
    deps,
    helm,
    fleetControllerPrivateKey,
  });
  const shutdown = createControllerShutdown(stoppers, log);
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

function createMigrationClientBuilder(
  db: Firestore,
  privateKey: string,
  logFn: (msg: string) => void,
) {
  return (resolveSync: (gatewayId: string) => string) => {
    const client = createMigrationClient({
      privateKey,
      resolveGatewayUrl: resolveSync,
      log: logFn,
    });
    return {
      ...client,
      transferState: createRsyncMigrationTransfer({
        db,
        namespace: NAMESPACE,
        privateKey,
        resolveGatewayUrl: resolveSync,
        log: logFn,
      }),
    };
  };
}

function readPath(obj: Record<string, unknown> | undefined, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function stringAt(obj: Record<string, unknown> | undefined, dotted: string): string {
  const value = readPath(obj, dotted);
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

async function collectMigrationChannelBindings(
  workspaceChannels: QueryDocumentSnapshot[],
  projectDocs: QueryDocumentSnapshot[],
): Promise<FleetBrokerChannelBinding[]> {
  const bindings: FleetBrokerChannelBinding[] = [];
  for (const ch of workspaceChannels) {
    const b = mapWorkspaceChannelDoc(ch.data());
    if (b) bindings.push(b);
  }
  const projectChannelSnaps = await Promise.all(
    projectDocs.map((p) => p.ref.collection("channels").get()),
  );
  for (let i = 0; i < projectDocs.length; i++) {
    const p = projectDocs[i];
    const projChannels = projectChannelSnaps[i];
    for (const ch of projChannels.docs) {
      const b = mapProjectChannelDoc(p.id, ch.data());
      if (b) bindings.push(b);
    }
  }
  return bindings;
}

function collectMigrationProjects(
  projectDocs: QueryDocumentSnapshot[],
): FleetBrokerProjectRestore[] {
  return projectDocs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    const out: FleetBrokerProjectRestore = {
      projectSlug: doc.id,
      giteaRepoName: typeof data.giteaRepoName === "string" ? data.giteaRepoName : null,
    };
    if (typeof data.provisioningState === "string") {
      out.provisioningState = data.provisioningState;
    }
    return out;
  });
}

// eslint-disable-next-line complexity -- Mirrors the octogee-api fleet broker snapshot shape.
async function readMigrationUserSnapshot(
  db: Firestore,
  uid: string,
): Promise<FleetBrokerUserSnapshot | null> {
  const userSnap = await db.collection("users").doc(uid).get();
  const data = userSnap.data() as Record<string, unknown> | undefined;
  if (!userSnap.exists || !data || data.approved !== true) return null;
  const slug = slugFromAssignedUser(data);
  if (!slug) return null;
  const workspaceRef = db.collection("workspaces").doc(slug);
  const [workspaceChannels, projectSnap, coachSecret, agentSnap] = await Promise.all([
    workspaceRef.collection("channels").get(),
    workspaceRef.collection("projects").get(),
    db.collection("users").doc(uid).collection("secrets").doc("coachMattermost").get(),
    db.collection("agents").doc(uid).get(),
  ]);
  const projectDocs = projectSnap.docs;
  const channels = await collectMigrationChannelBindings(workspaceChannels.docs, projectDocs);
  const projects = collectMigrationProjects(projectDocs);
  const coachData = coachSecret.data() as Record<string, unknown> | undefined;
  const agentData = agentSnap.data() as Record<string, unknown> | undefined;
  const name = typeof agentData?.name === "string" ? agentData.name : "";
  const emoji = typeof agentData?.avatarEmoji === "string" ? agentData.avatarEmoji : "";
  const status = stringAt(data, "provisioning.openclaw.status");
  return {
    uid,
    slug,
    tier: stringAt(data, "tier") || stringAt(data, "subscription.tier") || "trial",
    gatewayId: stringAt(data, "provisioning.openclaw.gatewayId"),
    status: status === "provisioning" || status === "complete" ? status : "",
    agentIds: stringArray(readPath(data, "provisioning.openclaw.agentIds")),
    repoUrl: stringAt(data, "provisioning.git.repoUrl"),
    mattermostUserId: stringAt(data, "mattermost.userId") || null,
    customerMmUserId: stringAt(data, "mattermost.userId") || null,
    greetingPosted: Boolean(
      (readPath(data, "provisioning.openclaw.greeting") as { ok?: unknown } | undefined)?.ok,
    ),
    channels,
    projects,
    ownerName: stringAt(data, "displayName") || stringAt(data, "username") || slug,
    email: stringAt(data, "email"),
    displayName: stringAt(data, "displayName"),
    lastName: stringAt(data, "lastName"),
    photoURL: stringAt(data, "photoURL"),
    onboardingVibe:
      typeof readPath(data, "onboarding.vibe") === "string"
        ? (readPath(data, "onboarding.vibe") as string)
        : null,
    coachToken: typeof coachData?.personalToken === "string" ? coachData.personalToken : null,
    coachMmUserId:
      typeof coachData?.coachMmUserId === "string" ? coachData.coachMmUserId : null,
    ...(name || emoji ? { coachIdentity: { name, emoji } } : {}),
  };
}

// eslint-disable-next-line max-lines-per-function -- Controller dependency assembly is intentionally centralized.
async function buildHandlers(
  db: Firestore,
  logFn: (msg: string) => void,
  helm: HelmRunner,
  kubeOps: KubeOps,
  fleetOps: {
    syncFleetIngress: () => Promise<void>;
    privateKey: string;
  },
): Promise<OperationHandlers> {
  const { privateKey } = fleetOps;
  if (!privateKey) {
    throw new Error(
      "FLEET_CONTROLLER_PRIVATE_KEY is not set — required for migrate-customer. Refusing to start with stub handlers.",
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
    readUserSnapshot: (uid) => readMigrationUserSnapshot(db, uid),
    readGatewayImageProfile: async (gatewayId) => {
      const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      if (!doc.exists) {
        throw new Error(`gateway not registered in glmGateways: ${gatewayId}`);
      }
      return resolveGatewayImageProfile((doc.data() as GatewayDesiredState | undefined) ?? {});
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
    buildClient: createMigrationClientBuilder(
      db,
      privateKey,
      logFn,
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

  // Blue/green rollout reuses the add/migrate/retire handlers (all in scope) as
  // its primitives: stand up a fresh-SHA sibling, migrate each mounted customer
  // onto it via the transfer plane, retire the drained source. A roll thus
  // becomes a sequence of already-tested operations rather than an in-place
  // helm upgrade that drops every live session.
  const syntheticSubOp = (
    kind: Operation["kind"],
    input: Record<string, unknown>,
  ): Operation => ({
    id: `bluegreen-${kind}`,
    kind,
    status: "running",
    createdBy: "glm-controller-rollout-bluegreen",
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
    input,
    steps: [],
  });
  const detachedCtx: OperationContext = { reportStep: async () => undefined };
  const retireInstanceLightly = async (
    gatewayId: string,
    ctx: OperationContext,
  ): Promise<{ success: boolean; error?: string }> => {
    // The customer mirrors flipped during migration, but gateways/{id}.mountedCustomers
    // is recomputed asynchronously by the heartbeat poller — clear it now so the
    // retire's mounted-gate sees the source the orchestrator has already drained,
    // instead of 409-ing on poller lag. (Reached only after every mounted customer
    // migrated, and after the shared pointer was moved to green, so the source is
    // genuinely empty.)
    await db
      .collection("gateways")
      .doc(gatewayId)
      .set({ mountedCustomers: [] }, { merge: true });
    // Drive desired state so the reconciler uninstalls the pod, then run the
    // standard teardown — but RETAIN PVC + GSA: a blue/green colour id recurs on
    // the next roll, so a routine roll must never destroy durable data.
    await db
      .collection(GLM_GATEWAYS_COLLECTION)
      .doc(gatewayId)
      .set({ desiredStatus: "retired" }, { merge: true });
    const result = await retireGateway(
      syntheticSubOp("retire-gateway", {
        gatewayId,
        retainData: true,
        retainServiceAccount: true,
      }),
      ctx,
    );
    return { success: result.success, error: result.error };
  };
  const blueGreenDeps: BlueGreenRolloutDeps = {
    createSiblingInstance: async ({
      sourceGatewayId,
      targetGatewayId,
      imageTag,
      imageRepository,
      profile,
      gatewayClass,
      imageProfile,
    }) => {
      const srcSnap = await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .doc(sourceGatewayId)
        .get();
      if (!srcSnap.exists) {
        throw new Error(`source gateway ${sourceGatewayId} not found in glmGateways`);
      }
      const clone = buildSiblingDoc(srcSnap.data() as Record<string, unknown>, {
        targetGatewayId,
        imageTag,
        imageRepository,
        profile,
        gatewayClass,
        imageProfile,
        createdBy: "glm-controller-rollout-bluegreen",
        createdAt: Date.now(),
      });
      await db.collection(GLM_GATEWAYS_COLLECTION).doc(targetGatewayId).set(clone);
    },
    awaitInstanceReady: async ({ gatewayId, imageTag, gatewayClass }, ctx) => {
      const result = await addGateway(
        syntheticSubOp("add-gateway", { gatewayId, imageTag, gatewayClass }),
        ctx,
      );
      return { ok: result.success, error: result.error };
    },
    readAssignedCustomers: async (gatewayId) => {
      const snap = await db
        .collection("users")
        .where("provisioning.openclaw.gatewayId", "==", gatewayId)
        .get();
      return snap.docs.map((d) => d.id);
    },
    // A blue/green customer migration runs as a REAL migrate-customer op, not an
    // inline synthetic one: the operation worker claims it and sets status=running,
    // and that running glmOperations record is exactly what the gitea-broker's
    // hasRunningInboundMigrationForSlug authorizes the fresh sibling's restore
    // (pubkey/bootstrap) on before the Firestore assignment cuts over. We enqueue
    // it and await its terminal status.
    migrateCustomer: ({ uid, toGatewayId }) =>
      runBlueGreenMigrateOp(
        { uid, toGatewayId },
        {
          enqueueMigrateOp: async ({ uid: u, toGatewayId: to }) => {
            const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
            await opRef.set(
              buildBlueGreenMigrateOpDoc({ uid: u, toGatewayId: to, createdAt: Date.now() }),
            );
            return opRef.id;
          },
          readOpStatus: async (opId) => {
            const snap = await db.collection(GLM_OPERATIONS_COLLECTION).doc(opId).get();
            if (!snap.exists) return null;
            const data = snap.data() as { status?: MigrateOpStatus; error?: string };
            return data.status ? { status: data.status, error: data.error } : null;
          },
          now: () => Date.now(),
          wait: (ms) => new Promise((r) => setTimeout(r, ms)),
          timeoutMs: 600_000,
          pollIntervalMs: 2_000,
          log: logFn,
        },
      ),
    isSharedDefaultPool: async (gatewayId) => {
      const configured = (await db.doc("config/orchestrator").get()).data()
        ?.defaultGatewayId;
      return typeof configured === "string" && configured === gatewayId;
    },
    repointSharedDefault: async (toGatewayId) => {
      await db
        .doc("config/orchestrator")
        .set({ defaultGatewayId: toGatewayId }, { merge: true });
    },
    retireInstance: ({ gatewayId }, ctx) => retireInstanceLightly(gatewayId, ctx),
    cleanupFailedSibling: async (gatewayId) => {
      await retireInstanceLightly(gatewayId, detachedCtx);
    },
    now: () => Date.now(),
    log: logFn,
  };

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
        gatewayClass: data.gatewayClass,
        imageProfile: data.imageProfile,
        builderSlug: data.builderSlug,
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
      gatewayClass,
      imageProfile,
      builderSlug,
      persistence,
      serviceAccountName,
      serviceAccount,
      operatorAccess,
    }) => {
      const update: Record<string, unknown> = {
        imageRepository,
        imageTag,
        ...(builderSlug ? { builderSlug } : {}),
        profile: profile === "standard" ? FieldValue.delete() : profile,
        gatewayClass,
        imageProfile: imageProfile === "standard" ? FieldValue.delete() : imageProfile,
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
    readShellActivity: async (gatewayId) => ({
      hasActiveSession: (await readShellLiveness(db, gatewayId, Date.now())).reallyActive,
    }),
    deferRollout: async (gatewayId, marker) => {
      await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .doc(gatewayId)
        .set(
          {
            rollout: {
              ...marker,
              deferredReason: "active-builder-shell",
              requestedAt: Date.now(),
            },
          },
          { merge: true },
        );
    },
    readMountedCustomers: async (gatewayId) => {
      const doc = await db.collection("gateways").doc(gatewayId).get();
      if (!doc.exists) return [];
      const data = doc.data() as { mountedCustomers?: unknown } | undefined;
      return Array.isArray(data?.mountedCustomers)
        ? (data!.mountedCustomers as unknown[]).filter(
            (s): s is string => typeof s === "string",
          )
        : [];
    },
    runBlueGreen: (input, ctx) => runBlueGreenRollout(input, blueGreenDeps, ctx),
    helmRenderTimeoutMs: 600_000,
    heartbeatTimeoutMs: 240_000,
    pollIntervalMs: 5_000,
    now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logFn,
  });

  const deprovisionCustomer = buildDeprovisionCustomerHandler(
    db,
    privateKey,
    logFn,
    kubeOps,
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
  privateKey: string,
  logFn: (msg: string) => void,
  kubeOps: Pick<KubeOps, "readAvailableReplicas">,
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
        return resolveGatewayImageProfile(data ?? {}) === "operator" ? "operator" : "standard";
      },
      readAvailableReplicas: (gatewayId) =>
        kubeOps.readAvailableReplicas({
          namespace: NAMESPACE,
          name: deploymentNameForInstance(gatewayId),
        }),
      unmountRpc: ({ gatewayId, slug }) =>
        callUnmountRpc(db, { privateKey, gatewayId, slug, log: logFn }),
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
    privateKey: string;
    gatewayId: string;
    slug: string;
    log: (msg: string) => void;
    tag?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const {
    privateKey,
    gatewayId,
    slug,
    log,
    tag = "deprov",
    timeoutMs = MIGRATION_UNMOUNT_TIMEOUT_MS,
  } = opts;

  const url = await resolveGatewayUrlFromFirestore(db, gatewayId);
  const migrationId = `${tag}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const body = JSON.stringify({ migrationId, slug });
  const signature = signFleetRequest(privateKey, migrationId, body);
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

export async function callFlushRpc(
  db: Firestore,
  opts: {
    privateKey: string;
    gatewayId: string;
    slug: string;
    reason: string;
    log: (msg: string) => void;
    tag?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const {
    privateKey,
    gatewayId,
    slug,
    reason,
    log,
    tag = "flush",
    timeoutMs = MIGRATION_TRANSFER_TIMEOUT_MS,
  } = opts;

  const url = await resolveGatewayUrlFromFirestore(db, gatewayId);
  const migrationId = `${tag}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const body = JSON.stringify({ migrationId, slug, reason });
  const signature = signFleetRequest(privateKey, migrationId, body);
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${url}/flush/${gatewayId}`, {
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
        `flush timed out after ${timeoutMs}ms gatewayId=${gatewayId} slug=${slug}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "<no body>");
    throw new Error(`flush failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  log(`[${tag}] flush RPC ok gatewayId=${gatewayId} slug=${slug}`);
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
