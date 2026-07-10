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
  operatorGatewayServiceAccountName,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  type GatewayDesiredState,
  type HelmInstanceValue,
  type HelmInstancesMap,
  type Operation,
  type OperationStep,
} from "@octogee/shared/types/glm";
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
  effectiveGatewayServiceAccountName,
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
import { createGatewayServiceAccountEnsurer } from "./gateway-service-account-ensurer.js";
import {
  createGatewayEdgeServiceEnsurer,
  type GatewayEdgeServiceEnsurer,
} from "./gateway-edge-service-ensurer.js";
import {
  revisionHeartbeatMerge,
  readHeartbeatLiveness,
  readMountedCustomers,
  heartbeatTeardownAction,
  LEGACY_HEARTBEAT_FIELDS,
} from "./heartbeat-relocation.js";
import {
  runConvergeEmptyPass,
  type ConvergeEmptyDeps,
} from "./converge-empty.js";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  gatewayEdgeServiceName,
  isGatewayDesiredDoc,
  isRevisionRealizationDoc,
  type GatewayDoc,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import { createRevisionTombstoneWriter } from "./revision-tombstone-writer.js";
import {
  createGatewayModelKeySecretEnsurer,
  gatewayModelKeySecretName,
  type GatewayModelKeySecretEnsurer,
} from "./model-key-secret-ensurer.js";
import {
  createConfiguredGatewayModelKeyIssuerBackend,
  createGatewayModelKeySourceIssuer,
  type GatewayModelKeySourceIssuer,
} from "./model-key-source-issuer.js";
import { guardedCreateRevisionDoc } from "./revision-creation.js";
import {
  spawnKubectl,
  syncEdgeIngress,
  type FleetGateway,
  type KubectlSubprocess,
} from "./fleet-ingress.js";
import {
  routeOperation,
  type OperationHandlers,
} from "./operation-router.js";
import { createOperationContext } from "./operation-context.js";
import {
  decideOperationClaim,
  isSeriallyExclusiveKind,
  type OperationRef,
  type PendingOperationRef,
} from "./operation-queue.js";
import { buildOperationCompletionUpdate } from "./operation-retry.js";
import { completeOperatorReservationAfterMigration } from "./operator-reservation-completion.js";
import { computeBootstrapWrites } from "./bootstrap.js";
import {
  collectKnownRevisionIds,
  collectLiveManagedRevisionIds,
} from "./managed-revision-ids.js";
import {
  computeDefaultGatewayBootstrap,
  deriveDefaultGatewayIdFromNamespace,
} from "./bootstrap-default-gateway.js";
import { createAddGatewayHandler } from "./handlers/add-gateway.js";
import { createMigrateCustomerHandler } from "./handlers/migrate-customer.js";
import { createRetireGatewayHandler } from "./handlers/retire-gateway.js";
import { createGatewayServiceAccountTeardown } from "./lib/gateway-gsa.js";
import { createGatewayWorkloadIdentityEnsurer } from "./lib/gateway-workload-identity.js";
import { createRestartGatewayHandler } from "./handlers/restart-gateway.js";
import { createRecycleGatewayHandler } from "./handlers/recycle-gateway.js";
import { createRolloutHandler } from "./handlers/rollout.js";
import {
  ROLL_MIGRATE_SOURCE,
  buildRollMigrateOpDoc,
  runRollPass,
  type RollMigrationSnapshot,
  type RollPassDeps,
} from "./converge-roll.js";
import { createDeprovisionCustomerHandler } from "./handlers/deprovision-customer.js";
import { deleteAvatarObjects } from "./lib/customer-ops/avatars.js";
import { loadCustomerCleanupContext } from "./lib/customer-ops/cleanup-context.js";
import { createGiteaCleanupClient } from "./lib/customer-ops/gitea.js";
import { createMmCleanupClient } from "./lib/customer-ops/mattermost.js";
import { createUnmountFromGateway } from "./lib/customer-ops/unmount-gateway.js";
import { resolveDefaultStorageBucket } from "./gcp-project.js";
import { signFleetRequest } from "@octogee/core/fleet-signature";
import {
  readAssignedSlugsForGateway,
  slugFromAssignedUser,
} from "@octogee/core/assigned-roster";
import {
  readAssignmentDoc,
  readAssignmentDocsForGateway,
  resolvePlacementRevision,
  type PlacementResolution,
} from "@octogee/core/assignment-doc";
import {
  byotSystemConfigFromDoc,
  mapProjectChannelDoc,
  mapWorkspaceChannelDoc,
} from "@octogee/core/customer-snapshot-mapping";
import {
  GATEWAYS_COLLECTION,
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  SIGNATURE_HEADER,
} from "@octogee/shared/types/fleet-controller";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";
import { createMigrationClient } from "@octogee/core/fleet-migration-client";
import { createRsyncMigrationTransfer } from "./lib/migration-rsync-transfer.js";
import {
  commitCutoverAtomic,
  markAssignmentState,
  type FleetStateFirestore,
} from "@octogee/core/fleet-state";
import {
  provisionGatewayAuthSecret,
  deleteSecret,
  readSecretWithLabels,
  writeSecret,
} from "@octogee/core/secret-manager";
import { listGatewayBuilds } from "@octogee/core/artifact-registry";
import { reconcileImagePins } from "./reconcile-image-pins.js";
import { workspaceSlugsForUser } from "@octogee/core/workspace-slugs";
import { deleteAuthUserTolerantOfMissing } from "@octogee/core/firebase-auth-helpers";
import { deleteHostingSitesForCustomer } from "@octogee/core/firebase-hosting";
import { GoogleAuth } from "google-auth-library";
import { startHttpServer, startMaintenanceHttpServer } from "./http-server.js";
import { recordGatewayHealth, recordReconcile } from "./metrics.js";
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
import { readShellLiveness } from "./shell-liveness.js";
import {
  PREEMPTION_HANDOFF_SWEEP_MS_DEFAULT,
  startPreemptionHandoffSweeper,
} from "./preemption-handoff-sweeper.js";
import {
  RELEASE_RETENTION_SWEEP_MS_DEFAULT,
  firestoreReleaseRetentionDeps,
  startReleaseRetentionSweeper,
} from "./release-retention-sweeper.js";
import { computeChartFingerprint } from "./chart-fingerprint.js";
import { createCachedApiServerEgressResolver } from "./apiserver-egress.js";
import {
  createFirestoreMaintenanceGate,
  startMaintenanceRestartWatcher,
  type ControllerMaintenanceGate,
} from "./maintenance-gate.js";
import type {
  FleetBrokerChannelBinding,
  FleetBrokerProjectRestore,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";

const logger = createLogger({
  color: process.env.NO_COLOR == null,
  debug: process.env.DEBUG != null,
});
const log = (msg: string) => logger.legacy(msg);
const WORKLOAD_IDENTITY_ANNOTATION = "iam.gke.io/gcp-service-account";

const RECONCILE_DEBOUNCE_MS = 1_000;
const RECONCILE_RETRY_MS_DEFAULT = 30_000;
const OPERATOR_READY_REFRESH_MS_DEFAULT = 60_000;
const MAINTENANCE_GATE_POLL_MS = 5_000;

// Wall-clock budget for a converge-empty revision to become ready (Deployment
// available + heartbeat version match) before it is marked failed instead of
// re-driven. Generous — a cold gateway boot + image pull can take minutes.
const CONVERGE_EMPTY_READINESS_TIMEOUT_MS = 15 * 60_000;

const GATEWAY_CHART = process.env.GATEWAY_CHART ?? "/charts/octogee-gateway";
const ORCHESTRATOR_CONFIG_DOC_PATH = "config/orchestrator";

const GATEWAY_VALUES_FILE = (function () {
  const explicit = process.env.GATEWAY_VALUES_FILE;
  if (explicit) return explicit;
  const ns = process.env.K8S_NAMESPACE ?? "octogee";
  return ns === "octogee"
    ? `${GATEWAY_CHART}/values.prod.yaml`
    : `${GATEWAY_CHART}/values.test.yaml`;
})();
const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";
const PIN_ENV = NAMESPACE === "octogee" ? "prod" : "test";

const AUTO_ROLL_ON_CHART_DRIFT = NAMESPACE !== "octogee";
const FLEET_CONTROLLER_PORT = process.env.FLEET_CONTROLLER_PORT ?? "3003";
const OPERATOR_HEARTBEAT_POLL_MS = 15_000;
const OPERATOR_HEALTH_TIMEOUT_MS = 5_000;
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? "8080", 10);
// Release-roll pacing (converge-roll.ts): how long a flipped source keeps
// forwarding before its revision-scoped teardown, and how long a failed drain
// migration backs off before the level-triggered retry.
const ROLL_SOURCE_FORWARDER_TTL_MS = parseNonNegativeInt(
  process.env.ROLL_SOURCE_FORWARDER_TTL_MS,
  5 * 60 * 1000,
);
const ROLL_MIGRATE_RETRY_BACKOFF_MS = parseNonNegativeInt(
  process.env.ROLL_MIGRATE_RETRY_BACKOFF_MS,
  5 * 60 * 1000,
);

// Lets out-of-loop callers (the roll arm's pacing, the rollout op handler)
// nudge the reconciler without holding a reference to its closure; installed by
// startReconciler.
const requestReconcileTickRef: { fire?: () => void } = {};
const ACTIVATION_LEASE_SWEEP_MS = parseNonNegativeInt(
  process.env.ACTIVATION_LEASE_SWEEP_MS,
  ACTIVATION_LEASE_SWEEP_MS_DEFAULT,
);
const DEDICATED_GATEWAY_IDLE_MS_DEFAULT = 30 * 60 * 1000;
const DEDICATED_GATEWAY_IDLE_MS = parseNonNegativeInt(
  process.env.DEDICATED_GATEWAY_IDLE_MS,
  DEDICATED_GATEWAY_IDLE_MS_DEFAULT,
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
const RELEASE_RETENTION_SWEEP_MS = parseNonNegativeInt(
  process.env.RELEASE_RETENTION_SWEEP_MS,
  RELEASE_RETENTION_SWEEP_MS_DEFAULT,
);
// A helm release must be pending continuously for longer than this before the
// recovery sweeper treats it as an orphaned wedge. Set > the helm `--wait` upgrade
// timeout (10m) so a legitimately in-progress install/upgrade is never recovered.
const HELM_RECOVERY_STALE_MS = parseNonNegativeInt(
  process.env.HELM_RECOVERY_STALE_MS,
  15 * 60 * 1000,
);

// One shared edge ingress carries the api host (/g/<id>/* gateway-local public
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
  reconcileImagePins?: (
    env: string,
    instances: ReadonlyArray<{ imageRepository: string; imageTag: string }>,
    log: (msg: string) => void,
  ) => Promise<void>;
  handlers: OperationHandlers;
  log: (msg: string) => void;
  maintenanceGate?: ControllerMaintenanceGate;

  syncFleetIngress?: (
    gateways: ReadonlyArray<{ gatewayId: string }>,
  ) => Promise<void>;

  ensureGatewayWorkloadIdentity?: (opts: { serviceAccountName: string }) => Promise<void>;
  ensureGatewayServiceAccount?: (opts: {
    namespace: string;
    serviceAccountName: string;
    annotations?: Record<string, string>;
  }) => Promise<void>;

  // Additive converge-EMPTY pass (GATEWAY-RELEASES-SPEC). Gated to gateways that
  // carry the new gateways/{id} desired docs; dormant until the backfill creates
  // them. Runs after the legacy reconcile and never alters the legacy path.
  convergeEmpty?: () => Promise<void>;

  // The release-roll arm (converge-roll.ts) — runs after convergeEmpty each
  // tick, deriving all progress from durable state.
  convergeRoll?: () => Promise<void>;

  reconcileRetryMs?: number;

  operatorReadyRefreshMs?: number;

  chartFingerprint?: string;

  resolveApiServerEgressCidrs?: () => Promise<string[]>;
}

function maintenanceFreezeReasonSuffix(reason: string | null): string {
  return reason ? `: ${reason}` : "";
}

async function maintenanceGateFrozen(
  gate: ControllerMaintenanceGate | undefined,
  log: (msg: string) => void,
  scope: string,
): Promise<boolean> {
  if (!gate) return false;
  try {
    const state = await gate.state();
    if (!state.frozen) return false;
    log(
      `[glm-controller] maintenance freeze blocks ${scope}${maintenanceFreezeReasonSuffix(state.reason)}`,
    );
    return true;
  } catch (err) {
    log(
      `[glm-controller] maintenance gate read failed; blocking ${scope}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

async function controllerWorkFrozen(
  deps: ControllerDeps,
  scope: string,
): Promise<boolean> {
  return maintenanceGateFrozen(deps.maintenanceGate, deps.log, scope);
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

async function readDedicatedGatewayIdleMs(db: Firestore): Promise<number> {
  const snap = await db.doc(ORCHESTRATOR_CONFIG_DOC_PATH).get();
  const value = snap.exists
    ? (snap.data() as { dedicatedGatewayIdleMs?: unknown } | undefined)?.dedicatedGatewayIdleMs
    : undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : DEDICATED_GATEWAY_IDLE_MS;
}

function isRunningGateway(gateway: GatewayDesiredState): boolean {
  return gateway.desiredStatus !== "paused" && gateway.desiredStatus !== "retired";
}

function configuredGatewayServiceAccount(): string | null {
  const serviceAccount = process.env.GATEWAY_SERVICE_ACCOUNT?.trim();
  return serviceAccount && serviceAccount.length > 0 ? serviceAccount : null;
}

function generatedWorkloadIdentityBindingTarget(
  target: HelmInstanceValue,
): { serviceAccountName: string } | null {
  const configuredGatewayGsa = configuredGatewayServiceAccount();
  if (!configuredGatewayGsa || !target.serviceAccountName || target.serviceAccount?.create !== true) {
    return null;
  }
  const annotatedGsa = target.serviceAccount.annotations?.[WORKLOAD_IDENTITY_ANNOTATION];
  if (annotatedGsa !== configuredGatewayGsa) return null;
  return { serviceAccountName: target.serviceAccountName };
}

async function publishPlatformGatewayReady(
  db: Firestore,
  input: {
    gatewayId: string;
    imageTag?: string;
    now: number;
  },
): Promise<void> {
  // Readiness telemetry lives ONLY at glmGateways/{id}.heartbeat (collision fix,
  // GATEWAY-RELEASES-SPEC cutover step 2). The legacy flat gateways/{id}
  // dual-write is CONTRACTED: it recreated the runtime fields the identity
  // backfill refuses on, so leaving it live made the backfill precondition
  // unsatisfiable on a real fleet. Preserved fields (startedAt, openclawVersion,
  // mountedCustomers, lastError) are read from — and written back to — the
  // relocated heartbeat sub-doc.
  const glmRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.gatewayId);
  await db.runTransaction(async (txn) => {
    const glmSnap = await txn.get(glmRef);
    const glmData = glmSnap.exists ? (glmSnap.data() as Record<string, unknown> | undefined) : undefined;
    const existingHb =
      glmData?.heartbeat && typeof glmData.heartbeat === "object" && !Array.isArray(glmData.heartbeat)
        ? (glmData.heartbeat as Record<string, unknown>)
        : undefined;
    const patch: Record<string, unknown> = {
      status: "ready",
      version: versionFromImageTag(input.imageTag),
      internalUrl: gatewayServiceInternalUrl(input.gatewayId),
      startedAt: typeof existingHb?.startedAt === "number" ? existingHb.startedAt : input.now,
      openclawVersion:
        typeof existingHb?.openclawVersion === "string" ? existingHb.openclawVersion : "unknown",
    };
    if (!Array.isArray(existingHb?.mountedCustomers)) {
      patch.mountedCustomers = [];
    }
    if (!("lastError" in (existingHb ?? {}))) {
      patch.lastError = null;
    }
    txn.set(glmRef, { heartbeat: patch }, { merge: true });
  });
}

async function readGatewayHeartbeatFromFirestore(
  db: Firestore,
  gatewayId: string,
): Promise<{ lastHeartbeatAt: number; version?: string | null } | null> {
  // Prefer glmGateways/{id}.heartbeat (collision fix); fall back to the legacy
  // flat gateways/{id} doc during expand.
  const [glmSnap, legacySnap] = await Promise.all([
    db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get(),
    db.collection("gateways").doc(gatewayId).get(),
  ]);
  return readHeartbeatLiveness(
    glmSnap.exists ? (glmSnap.data() as Record<string, unknown>) : undefined,
    legacySnap.exists ? (legacySnap.data() as Record<string, unknown>) : undefined,
  );
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

    const workloadIdentityTarget = generatedWorkloadIdentityBindingTarget(change.to);
    if (workloadIdentityTarget) {
      if (!deps.ensureGatewayWorkloadIdentity) {
        throw new Error("gateway Workload Identity ensurer is not configured");
      }
      await deps.ensureGatewayWorkloadIdentity(workloadIdentityTarget);
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
  // Mounted-customer telemetry now rides glmGateways/{id}.heartbeat (collision
  // fix). Dual-read during expand: prefer the glm heartbeat sub-doc, fall back
  // to the legacy flat gateways/{id}.mountedCustomers.
  const [glmSnap, legacySnap] = await Promise.all([
    db.collection(GLM_GATEWAYS_COLLECTION).get(),
    db.collection("gateways").get(),
  ]);
  const legacyById = new Map<string, Record<string, unknown>>();
  for (const doc of legacySnap.docs) legacyById.set(doc.id, doc.data() as Record<string, unknown>);
  const out = new Map<string, readonly string[]>();
  const seen = new Set<string>();
  for (const doc of glmSnap.docs) {
    seen.add(doc.id);
    out.set(doc.id, readMountedCustomers(doc.data() as Record<string, unknown>, legacyById.get(doc.id)));
  }
  for (const [id, data] of legacyById) {
    if (!seen.has(id)) out.set(id, readMountedCustomers(undefined, data));
  }
  return out;
}

// Production wiring for the converge-EMPTY pass. Gated on gateways/{id} docs
// that pass isGatewayDesiredDoc — legacy heartbeat docs dual-written to
// gateways/{id} lack desiredRelease and are filtered out, so the pass is
// dormant until the backfill creates real desired docs.
function buildConvergeEmptyDeps(args: {
  db: Firestore;
  helm: HelmRunner;
  kubeOps: KubeOps;
  gatewayEdgeServiceEnsurer: GatewayEdgeServiceEnsurer;
  chartFingerprint?: string;
  log: (msg: string) => void;
}): ConvergeEmptyDeps {
  const { db, helm, kubeOps, gatewayEdgeServiceEnsurer, chartFingerprint, log } = args;
  return {
    namespace: NAMESPACE,
    chartPath: GATEWAY_CHART,
    valuesFile: GATEWAY_VALUES_FILE,
    chartFingerprint,
    readinessTimeoutMs: CONVERGE_EMPTY_READINESS_TIMEOUT_MS,
    log,
    now: () => Date.now(),
    readGatewayDesiredDocs: async () => {
      const snap = await db.collection("gateways").get();
      return snap.docs.map((d) => d.data()).filter(isGatewayDesiredDoc);
    },
    readReleasePayload: (gatewayId, release) =>
      readReleasePayloadFromFirestore(db, gatewayId, release),
    servingRevisionExists: async (gatewayId) => {
      const snap = await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .where("gateway", "==", gatewayId)
        .get();
      return snap.docs.some((d) => {
        const data = d.data();
        if (!isRevisionRealizationDoc(data)) return false;
        return data.lifecycle === "serving" && data.retiredAt == null;
      });
    },
    readExistingRevision: async (revisionId) => {
      const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
      if (!doc.exists) return null;
      const data = doc.data();
      if (!isRevisionRealizationDoc(data)) return null;
      return {
        createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
        lifecycle: data.lifecycle,
        helmApplied: data.helm.lastAppliedAt != null,
      };
    },
    createRevisionDoc: async (doc) => {
      await guardedCreateRevisionDoc(db, doc);
    },
    helmUpsertRevision: async (opts) => {
      await helm.upsertInstance({ ...opts, chartFingerprint });
    },
    markRevisionHelmApplied: async (revisionId, at) => {
      await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .doc(revisionId)
        .set({ helm: { lastAppliedAt: at } }, { merge: true });
    },
    waitForRevisionReady: async ({ revisionId, expectedImageTag }) => {
      const available = await kubeOps.readAvailableReplicas({
        namespace: NAMESPACE,
        name: deploymentNameForInstance(revisionId),
      });
      if (available == null || available < 1) return false;
      const hb = await readGatewayHeartbeatFromFirestore(db, revisionId);
      return convergeHeartbeatMatchesImageTag(hb?.version ?? null, expectedImageTag);
    },
    markRevisionServing: async (revisionId) => {
      await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .doc(revisionId)
        .set({ lifecycle: "serving" }, { merge: true });
    },
    ensurePerGatewayEdgeService: async ({ gatewayId, revisionId }) => {
      await gatewayEdgeServiceEnsurer.ensurePerGatewayEdgeService({
        namespace: NAMESPACE,
        gatewayId,
        revisionId,
      });
    },
    markRevisionFailed: async (revisionId, message) => {
      await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .doc(revisionId)
        .set(
          { lifecycle: "failed", lastError: { message, at: Date.now() } },
          { merge: true },
        );
    },
    writeConvergeCompletion: async (gatewayId, patch) => {
      await db
        .collection("gateways")
        .doc(gatewayId)
        .set({ ...patch, updatedAt: Date.now(), updatedBy: "cowboy" }, { merge: true });
    },
  };
}

// The revision heartbeat reports the build SHA (version); the release image tag
// is `<sha>-oc<ocVersion>`. Match either the full tag or its SHA prefix.
function convergeHeartbeatMatchesImageTag(
  version: string | null,
  imageTag: string,
): boolean {
  if (!version) return false;
  if (version === imageTag) return true;
  return version === versionFromImageTag(imageTag);
}

async function readReleasePayloadFromFirestore(
  db: Firestore,
  gatewayId: string,
  release: number,
): Promise<ReleasePayload | null> {
  const doc = await db
    .collection(GATEWAYS_COLLECTION)
    .doc(gatewayId)
    .collection(GATEWAY_RELEASES_SUBCOLLECTION)
    .doc(String(release))
    .get();
  if (!doc.exists) return null;
  const payload = (doc.data() as { payload?: unknown } | undefined)?.payload;
  return payload && typeof payload === "object" ? (payload as ReleasePayload) : null;
}

const ROLL_MIGRATE_STATUSES = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "rolled-back",
] as const);

// Map a glmOperations doc onto the roll arm's migration snapshot — only
// release-roll migrations targeting this gateway AND enqueued by THIS roll
// (rollOperationId) count; a superseded roll's leftovers never block a drain.
function rollMigrationSnapshotFromOpDoc(
  data: Record<string, unknown>,
  gatewayId: string,
  rollOperationId: string,
): { createdAt: number; snap: RollMigrationSnapshot } | null {
  const input = data.input as Record<string, unknown> | undefined;
  if (
    input?.toGatewayId !== gatewayId ||
    input?.source !== ROLL_MIGRATE_SOURCE ||
    input?.rollOperationId !== rollOperationId
  ) {
    return null;
  }
  const status = data.status as RollMigrationSnapshot["status"];
  if (!ROLL_MIGRATE_STATUSES.has(status)) return null;
  return {
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    snap: {
      status,
      ...(typeof data.error === "string" ? { error: data.error } : {}),
      completedAt: typeof data.completedAt === "number" ? data.completedAt : null,
    },
  };
}

// Production wiring for the roll arm (converge-roll.ts). Shares the converge
// readers; adds the drain-migration queue plumbing, the revision-scoped
// teardown primitives, and the tombstone writer. Deliberately ABSENT: any
// gateway-scoped teardown (KSA, auth/model-key secrets, GSA, gateways/{id}) —
// a roll can only ever uninstall a revision's own Helm release.
function buildRollPassDeps(args: {
  db: Firestore;
  helm: HelmRunner;
  kubeOps: KubeOps;
  gatewayEdgeServiceEnsurer: GatewayEdgeServiceEnsurer;
  chartFingerprint?: string;
  log: (msg: string) => void;
}): RollPassDeps {
  const { db, helm, kubeOps, gatewayEdgeServiceEnsurer, chartFingerprint, log } = args;
  const tombstoneWriter = createRevisionTombstoneWriter({
    db,
    now: () => Date.now(),
    log,
  });
  return {
    namespace: NAMESPACE,
    chartPath: GATEWAY_CHART,
    valuesFile: GATEWAY_VALUES_FILE,
    chartFingerprint,
    readinessTimeoutMs: CONVERGE_EMPTY_READINESS_TIMEOUT_MS,
    sourceForwarderTtlMs: ROLL_SOURCE_FORWARDER_TTL_MS,
    migrateRetryBackoffMs: ROLL_MIGRATE_RETRY_BACKOFF_MS,
    readGatewayDesiredDocs: async () => {
      const snap = await db.collection(GATEWAYS_COLLECTION).get();
      return snap.docs.map((d) => d.data()).filter(isGatewayDesiredDoc);
    },
    readReleasePayload: (gatewayId, release) =>
      readReleasePayloadFromFirestore(db, gatewayId, release),
    readRevisionDoc: async (revisionId) => {
      const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
      if (!doc.exists) return null;
      const data = doc.data();
      return isRevisionRealizationDoc(data) ? data : null;
    },
    createRevisionDoc: async (doc) => {
      await guardedCreateRevisionDoc(db, doc);
    },
    helmUpsertRevision: async (opts) => {
      await helm.upsertInstance({ ...opts, chartFingerprint });
    },
    markRevisionHelmApplied: async (revisionId, at) => {
      await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .doc(revisionId)
        .set({ helm: { lastAppliedAt: at } }, { merge: true });
    },
    helmUninstallRevision: async (revisionId) => {
      await helm.removeInstance({ namespace: NAMESPACE, gatewayId: revisionId });
    },
    deleteRevisionDoc: async (revisionId) => {
      await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).delete();
    },
    patchRevisionDoc: async (revisionId, patch) => {
      await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .doc(revisionId)
        .set(patch as Record<string, unknown>, { merge: true });
    },
    checkRevisionReady: async ({ revisionId, expectedImageTag }) => {
      const available = await kubeOps.readAvailableReplicas({
        namespace: NAMESPACE,
        name: deploymentNameForInstance(revisionId),
      });
      if (available == null || available < 1) return false;
      const hb = await readGatewayHeartbeatFromFirestore(db, revisionId);
      return convergeHeartbeatMatchesImageTag(hb?.version ?? null, expectedImageTag);
    },
    patchGatewayDoc: async (gatewayId, patch) => {
      await db
        .collection(GATEWAYS_COLLECTION)
        .doc(gatewayId)
        .set({ ...patch, updatedAt: Date.now(), updatedBy: "cowboy" }, { merge: true });
    },
    readAssignments: (gatewayId) => readAssignmentDocsForGateway(db, gatewayId),
    readRollMigration: async ({ uid, gatewayId, rollOperationId }) => {
      const snap = await db
        .collection(GLM_OPERATIONS_COLLECTION)
        .where("kind", "==", "migrate-customer")
        .where("inputUid", "==", uid)
        .get();
      let newest: { createdAt: number; snap: RollMigrationSnapshot } | null = null;
      for (const doc of snap.docs) {
        const candidate = rollMigrationSnapshotFromOpDoc(doc.data() as Record<string, unknown>, gatewayId, rollOperationId);
        if (!candidate) continue;
        if (newest && newest.createdAt >= candidate.createdAt) continue;
        newest = candidate;
      }
      return newest?.snap ?? null;
    },
    enqueueRollMigration: async ({ uid, slug, gatewayId, rollOperationId }) => {
      const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
      await opRef.set(
        buildRollMigrateOpDoc({
          uid,
          builderSlug: slug,
          gatewayId,
          rollOperationId,
          createdAt: Date.now(),
        }),
      );
      return opRef.id;
    },
    hasActiveShell: async (gatewayId) =>
      (await readShellLiveness(db, gatewayId, Date.now())).reallyActive,
    ensurePerGatewayEdgeService: async ({ gatewayId, revisionId }) => {
      await gatewayEdgeServiceEnsurer.ensurePerGatewayEdgeService({
        namespace: NAMESPACE,
        gatewayId,
        revisionId,
      });
    },
    writeRevisionTombstone: (input) => tombstoneWriter.writeTombstone(input),
    requestTick: (delayMs) => {
      const timer = setTimeout(
        () => requestReconcileTickRef.fire?.(),
        Math.min(Math.max(delayMs, 1), 60_000),
      );
      timer.unref?.();
    },
    now: () => Date.now(),
    log,
  };
}

// FieldValue.delete() patch that strips the legacy dual-written heartbeat fields
// from a doc without deleting the doc itself — used when gateways/{id} is a
// durable GatewayDoc that retire must preserve.
function clearedHeartbeatFieldsPatch(): Record<string, unknown> {
  const del = FieldValue.delete();
  const out: Record<string, unknown> = {};
  for (const field of LEGACY_HEARTBEAT_FIELDS) out[field] = del;
  return out;
}

type DriftChange = Extract<ReconcileChange, { kind: "drift" }>;

interface ReconcileInputs {
  desired: GatewayDesiredState[];
  managedRevisionIds: Set<string>;
  actualMap: HelmInstancesMap;
  mountedByGatewayId: Map<string, readonly string[]>;
}

async function readReconcileInputs(deps: ControllerDeps): Promise<ReconcileInputs> {
  const [snap, gatewaySnap] = await Promise.all([
    deps.db.collection(GLM_GATEWAYS_COLLECTION).get(),
    deps.db.collection(GATEWAYS_COLLECTION).get(),
  ]);
  // glmGateways now holds two doc kinds during expand: legacy bare-id desired
  // docs (the legacy Helm targets) AND {gw}-rN revision-realization docs owned
  // by the converge arm. Filter the revision docs OUT so they never become
  // undefined legacy Helm targets (and get reaped as drift).
  const desired = snap.docs
    .map((d) => d.data())
    .filter((data) => !isRevisionRealizationDoc(data))
    .map((data) => data as GatewayDesiredState);
  const managedRevisionIds = collectLiveManagedRevisionIds({
    revisionDocs: snap.docs.map((d) => d.data()),
    gatewayDocs: gatewaySnap.docs.map((d) => d.data()),
  });
  const actualMap = await deps.helm.readDeployedInstances({ namespace: NAMESPACE });
  const kubeOpsForRead = deps.kubeOps ?? createLoggingKubeOps(deps.log);
  await readLiveReplicasInto(actualMap, kubeOpsForRead, deps.log);
  const mountedByGatewayId = await readMountedByGatewayId(deps.db);
  return { desired, managedRevisionIds, actualMap, mountedByGatewayId };
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
  managedRevisionIds: ReadonlySet<string>,
): void {
  const desiredGatewayIds = new Set(desired.map((d) => d.gatewayId));
  const orphanDrift = preservedDrift.filter(
    (c) =>
      !desiredGatewayIds.has(c.gatewayId) &&
      !managedRevisionIds.has(c.gatewayId),
  );
  const draineeDrift = preservedDrift.filter((c) => desiredGatewayIds.has(c.gatewayId));
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
  targetMap: HelmInstancesMap,
): Promise<void> {
  const syncFleetIngress = deps.syncFleetIngress;
  if (!syncFleetIngress) return;
  try {
    await syncFleetIngress(fleetGatewaysFromTargetMap(targetMap));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`(source=fleet-ingress) ${message}`);
  }
}

async function syncGatewayServiceAccounts(
  deps: ControllerDeps,
  targetMap: HelmInstancesMap,
): Promise<void> {
  const ensure = deps.ensureGatewayServiceAccount;
  if (!ensure) return;
  const seen = new Set<string>();
  for (const [instanceId, target] of Object.entries(targetMap).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const gatewayId = target.gatewayId || instanceId;
    const serviceAccountName = effectiveGatewayServiceAccountName(
      gatewayId,
      target.serviceAccountName,
    );
    const key = JSON.stringify([serviceAccountName, target.serviceAccount?.annotations ?? {}]);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await ensure({
        namespace: NAMESPACE,
        serviceAccountName,
        annotations: target.serviceAccount?.annotations,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`(source=gateway-service-account) ${gatewayId}: ${message}`);
    }
  }
}

function fleetGatewaysFromTargetMap(targetMap: HelmInstancesMap): FleetGateway[] {
  return Object.keys(targetMap).map((gatewayId) => ({ gatewayId }));
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
        const availableReplicas = available ?? 0;
        if (availableReplicas < 1) {
          return {
            ready: null,
            health: { gatewayId: gateway.gatewayId, availableReplicas },
          };
        }
        await publishPlatformGatewayReady(deps.db, {
          gatewayId: gateway.gatewayId,
          imageTag: gateway.imageTag,
          now: Date.now(),
        });
        return {
          ready: {
            gatewayId: gateway.gatewayId,
            imageTag: gateway.imageTag,
          },
          health: { gatewayId: gateway.gatewayId, availableReplicas },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log(
          `[glm-controller] ⚠ readiness refresh failed for ${gateway.gatewayId}: ${msg}`,
        );
        return {
          ready: null,
          health: { gatewayId: gateway.gatewayId, availableReplicas: 0 },
        };
      }
    }),
  );
  recordGatewayHealth(
    results
      .map((result) => result?.health ?? null)
      .filter((sample): sample is { gatewayId: string; availableReplicas: number } => sample != null),
  );
  return results
    .map((result) => result?.ready ?? null)
    .filter((gateway): gateway is ReadyGateway => gateway != null);
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
  if (await controllerWorkFrozen(deps, "reconcile")) return;
  const { desired, managedRevisionIds, actualMap, mountedByGatewayId } = await readReconcileInputs(deps);
  if (deps.reconcileImagePins) {
    try {
      await deps.reconcileImagePins(PIN_ENV, desired, deps.log);
    } catch (err) {
      deps.log(`[image-pins] ⚠ reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await syncGatewayModelKeySources(deps, desired);
  const modelKeyChangedGatewayIds = await syncGatewayModelKeySecrets(deps, desired);
  const apiServerEgressCidrs = (await deps.resolveApiServerEgressCidrs?.()) ?? [];
  const desiredMap = buildInstancesMap(
    desired,
    deps.chartFingerprint,
    apiServerEgressCidrs,
  );
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
  await syncGatewayServiceAccounts(deps, targetMap);
  logPreservedDrift(
    deps,
    preservedDriftChanges(changes, targetMap),
    desired,
    managedRevisionIds,
  );
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
  await syncFleetIngressIfConfigured(deps, targetMap);
  await completeRecoveredOperatorAddGatewayOps(deps, readyGateways);
  // Additive, gated, dormant until the backfill creates gateways/{id} desired
  // docs. Runs last so it never perturbs the legacy reconcile above.
  if (deps.convergeEmpty) {
    try {
      await deps.convergeEmpty();
    } catch (err) {
      deps.log(`[converge-empty] ⚠ pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // The roll arm derives from the same desired docs; after convergeEmpty so a
  // fresh gateway lands its first revision before any roll is considered.
  if (deps.convergeRoll) {
    try {
      await deps.convergeRoll();
    } catch (err) {
      deps.log(`[converge-roll] ⚠ pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function clearTimer(timer: NodeJS.Timeout | null): null {
  if (timer) clearTimeout(timer);
  return null;
}

function compareFingerprintKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function reconcileFingerprintStableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(reconcileFingerprintStableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
    compareFingerprintKeys(a, b),
  );
  const parts = entries.map((entry) => {
    const key = JSON.stringify(entry[0]);
    const val = reconcileFingerprintStableStringify(entry[1]);
    return `${key}:${val}`;
  });
  return `{${parts.join(",")}}`;
}

// Reconcile-relevant fingerprint of a glmGateways doc: everything EXCEPT the
// heartbeat sub-doc. A heartbeat-only write (the poller, publishPlatformGateway-
// Ready) leaves this unchanged.
function reconcileRelevantFingerprint(data: Record<string, unknown>): string {
  const { heartbeat: _heartbeat, ...rest } = data;
  return reconcileFingerprintStableStringify(rest);
}

interface ReconcileSnapshotDocChange {
  type: string;
  doc: { id: string; data(): Record<string, unknown> };
}

// True when a glmGateways snapshot carries a reconcile-relevant (non-heartbeat)
// change. added/removed always count; a modified doc counts only if its
// non-heartbeat projection changed. Mutates `fingerprints` to the new state.
// This is what stops the controller from self-triggering a helm-list churn loop
// on every ~15s heartbeat write into the watched collection.
export function snapshotHasReconcileRelevantChange(
  changes: ReadonlyArray<ReconcileSnapshotDocChange>,
  fingerprints: Map<string, string>,
): boolean {
  let relevant = false;
  for (const change of changes) {
    if (change.type === "removed") {
      fingerprints.delete(change.doc.id);
      relevant = true;
      continue;
    }
    const fp = reconcileRelevantFingerprint(change.doc.data());
    if (fingerprints.get(change.doc.id) !== fp) relevant = true;
    fingerprints.set(change.doc.id, fp);
  }
  return relevant;
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
  requestReconcileTickRef.fire = scheduleDebouncedTick;

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

  const reconcileFingerprints = new Map<string, string>();
  const unsub = deps.db.collection(GLM_GATEWAYS_COLLECTION).onSnapshot(
    (snap?: { docChanges?: () => ReconcileSnapshotDocChange[] }) => {
      if (stopped) return;
      const changes = snap?.docChanges?.();
      // No snapshot payload (test fakes / defensive) → schedule a tick. With a
      // payload, skip heartbeat-only changes so a heartbeat write into the
      // watched collection doesn't self-trigger reconcile churn.
      if (!changes || snapshotHasReconcileRelevantChange(changes, reconcileFingerprints)) {
        scheduleDebouncedTick();
      }
    },
    (err) => deps.log(`[glm-controller] ⚠ gateways snapshot error: ${String(err)}`),
  );

  if (deps.operatorReadyRefreshMs && deps.operatorReadyRefreshMs > 0) {
    refreshTimer = setInterval(() => void tick(), deps.operatorReadyRefreshMs);
  }

  return () => {
    stopped = true;
    unsub();
    if (requestReconcileTickRef.fire === scheduleDebouncedTick) {
      requestReconcileTickRef.fire = undefined;
    }
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

// How often the queue drain re-scans pending ops. It exists for two cases the
// onSnapshot listener above can't see: an op queued behind a conflicting rollout
// (unblocked when the OTHER doc changes, not this one) and a retry whose backoff
// has elapsed (unblocked by time passing, not a Firestore event). Cadence mirrors
// the stuck-op-reaper's level-triggered pattern.
export const OPERATION_QUEUE_DRAIN_MS_DEFAULT = 20_000;

// Op kinds safe to re-drive after a controller restart (idempotent orchestrators).
// The blue/green rollout is the long, repoint-then-migrate op that strands a pool if
// abandoned mid-flight; its migrate sub-ops are re-issued by the rollout re-drive, so
// they are intentionally NOT resumed directly.
const RESUMABLE_OP_KINDS: ReadonlySet<string> = new Set(["rollout"]);

// Claim, queue, or skip a pending op in one transaction: reads the OTHER
// running AND pending ops of the same serially-exclusive kind alongside the
// candidate doc so the queue decision (operation-queue.ts) and the write it
// produces are atomic — two rollout ops evaluated back-to-back can never both
// see "no conflict". The pending read is what keeps the onSnapshot fast path
// FIFO per scope: a newly created op queues behind an older already-queued one
// instead of jumping ahead of it.
async function attemptClaimOrQueueOperation(
  op: Operation,
  ref: FirebaseFirestore.DocumentReference,
  deps: ControllerDeps,
): Promise<{ outcome: "claimed" | "queued" | "skipped"; fresh?: Operation }> {
  try {
    return await deps.db.runTransaction(async (txn) => {
      if (deps.maintenanceGate) {
        const gate = await deps.maintenanceGate.stateInTransaction(txn);
        if (gate.frozen) return { outcome: "skipped" as const };
      }
      const fresh = await txn.get(ref);
      if (!fresh.exists) return { outcome: "skipped" as const };
      const data = fresh.data() as Operation | undefined;
      if (!data) return { outcome: "skipped" as const };

      let runningOpsSameKind: OperationRef[] = [];
      let pendingOpsSameKind: PendingOperationRef[] = [];
      if (isSeriallyExclusiveKind(op.kind)) {
        const opsOfKind = deps.db
          .collection(GLM_OPERATIONS_COLLECTION)
          .where("kind", "==", op.kind);
        const [runningSnap, pendingSnap] = await Promise.all([
          txn.get(opsOfKind.where("status", "==", "running")),
          txn.get(opsOfKind.where("status", "==", "pending")),
        ]);
        runningOpsSameKind = runningSnap.docs.map((d) => ({
          id: d.id,
          kind: op.kind,
          input: (d.data() as Operation).input,
        }));
        pendingOpsSameKind = pendingSnap.docs.map((d) => {
          const pendingData = d.data() as Operation;
          return {
            id: d.id,
            kind: op.kind,
            input: pendingData.input,
            createdAt: pendingData.createdAt,
          };
        });
      }

      const decision = decideOperationClaim({
        op: {
          id: op.id,
          kind: op.kind,
          status: data.status,
          createdAt: data.createdAt,
          nextAttemptAt: data.nextAttemptAt,
          input: data.input,
        },
        now: Date.now(),
        runningOpsSameKind,
        pendingOpsSameKind,
      });

      if (decision.outcome === "skip") return { outcome: "skipped" as const };
      if (decision.outcome === "queue") {
        if (data.waitingOn !== decision.waitingOn) {
          txn.update(ref, { waitingOn: decision.waitingOn });
        }
        return { outcome: "queued" as const };
      }
      const now = Date.now();
      txn.update(ref, {
        status: "running",
        startedAt: now,
        lastProgressAt: now,
        waitingOn: FieldValue.delete(),
        nextAttemptAt: FieldValue.delete(),
      });
      // The completion write derives attempts/attemptHistory from the op the
      // handler ran with — hand back the transaction's fresh read so a stale
      // worker snapshot can't reset the retry cap or drop history.
      return { outcome: "claimed" as const, fresh: { ...data, id: op.id, startedAt: now } };
    });
  } catch (err) {
    deps.log(
      `[glm-controller] claim transaction failed op=${op.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { outcome: "skipped" };
  }
}

export async function processOperation(
  op: Operation,
  ref: FirebaseFirestore.DocumentReference,
  deps: ControllerDeps,
): Promise<void> {
  const claim = await attemptClaimOrQueueOperation(op, ref, deps);
  if (claim.outcome === "queued") {
    deps.log(`[glm-controller] op=${op.id} kind=${op.kind} queued — waiting on a conflicting op`);
    return;
  }
  if (claim.outcome !== "claimed" || !claim.fresh) return;

  deps.log(`[glm-controller] claim op=${op.id} kind=${op.kind}`);
  await runClaimedOperation(claim.fresh, ref, deps);
}

// Re-scan every pending op (FIFO by createdAt) and try to claim each. The
// correctness net for (a) an op queued behind a since-finished conflicting op,
// and (b) a retry whose backoff window has elapsed — see OPERATION_QUEUE_DRAIN_MS_DEFAULT.
export async function drainPendingOperationsOnce(deps: ControllerDeps): Promise<void> {
  // Equality-only query, FIFO sort in memory: status+createdAt has no
  // composite index and must never need one — an orderBy here throws
  // FAILED_PRECONDITION in the real Firestore and silently kills the drain.
  const snap = await deps.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .where("status", "==", "pending")
    .get();
  const ops = snap.docs
    .map((doc) => ({ op: { ...(doc.data() as Operation), id: doc.id }, ref: doc.ref }))
    .sort((a, b) => (a.op.createdAt ?? 0) - (b.op.createdAt ?? 0));
  for (const { op, ref } of ops) {
    await processOperation(op, ref, deps);
  }
}

export function startOperationQueueDrain(
  deps: ControllerDeps,
  intervalMs: number = OPERATION_QUEUE_DRAIN_MS_DEFAULT,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    drainPendingOperationsOnce(deps).catch((err) => {
      deps.log(
        `[glm-controller] ⚠ operation queue drain failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Re-adopt an op the previous controller instance left `running` (orphaned by a
// deploy/restart mid-op) and re-drive it. Bumps the liveness heartbeat so the
// stuck-op reaper gives the resumed run a fresh budget, and records resumeCount.
// The op stays `running` throughout — a resumed rollout still holds the serial
// lock other pending rollout ops queue behind.
async function reAdoptAndRunOperation(
  op: Operation,
  ref: FirebaseFirestore.DocumentReference,
  deps: ControllerDeps,
): Promise<void> {
  let adopted: Operation | null = null;
  try {
    adopted = await deps.db.runTransaction(async (txn) => {
      if (deps.maintenanceGate) {
        const gate = await deps.maintenanceGate.stateInTransaction(txn);
        if (gate.frozen) return null;
      }
      const fresh = await txn.get(ref);
      if (!fresh.exists) return null;
      const data = fresh.data() as Operation | undefined;
      if (data?.status !== "running") return null;
      const now = Date.now();
      txn.update(ref, {
        startedAt: now,
        lastProgressAt: now,
        resumeCount: (typeof data.resumeCount === "number" ? data.resumeCount : 0) + 1,
      });
      return { ...data, id: op.id, startedAt: now };
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
  await runClaimedOperation(adopted, ref, deps);
}

// Run an op whose status is already `running` (freshly claimed or re-adopted):
// invoke its handler, persist step progress (with a liveness heartbeat), then
// complete it — or, for a transient failure under the attempt cap, requeue it to
// `pending` with backoff (operation-retry.ts) instead of failing it terminally.
async function runClaimedOperation(
  op: Operation,
  ref: FirebaseFirestore.DocumentReference,
  deps: ControllerDeps,
): Promise<void> {
  if (await controllerWorkFrozen(deps, `operation ${op.id}`)) return;
  const { ctx, steps } = createOperationContext({
    persist: async (next) => {
      await ref.update({ steps: next, lastProgressAt: Date.now() });
    },
    log: deps.log,
    opId: op.id,
  });

  const result = await routeOperation(op, deps.handlers, ctx);
  const completion = buildOperationCompletionUpdate({
    op: { attempts: op.attempts, attemptHistory: op.attemptHistory },
    result,
    steps,
    now: Date.now(),
  });
  await ref.update(completion);

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
    deps.log(`[glm-controller] op=${op.id} → succeeded`);
    return;
  }

  if (completion.status === "pending") {
    deps.log(
      `[glm-controller] op=${op.id} attempt ${String(completion.attempts)} failed transiently — ${result.error ?? "unknown error"} — retrying`,
    );
    return;
  }

  deps.log(`[glm-controller] op=${op.id} → failed (${result.error})`);
}

export function buildOperatorHeartbeatPollerDeps(
  db: Firestore,
  log: (msg: string) => void,
  privateKey: string,
): OperatorHeartbeatPollerDeps {
  return {
    listGatewayIds: async () => {
      const snap = await db.collection(GLM_GATEWAYS_COLLECTION).get();
      return heartbeatPollInstanceIds(snap.docs);
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
    readAssignedSlugs: async (instanceId) => {
      const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(instanceId).get();
      const target = heartbeatRosterTarget(instanceId, snap.data());
      return readAssignedSlugsForGateway(db, target.gatewayId, {
        ...(target.revisionId ? { revisionId: target.revisionId } : {}),
      });
    },
    writeHeartbeat: async (gatewayId, record) => {
      // Live telemetry lands only at glmGateways/{id}.heartbeat (the collision
      // fix). The legacy flat gateways/{id} dual-write is retired — a per-poll
      // flat write recreates the heartbeat fields the identity backfill refuses
      // on, blocking it forever. Out-of-lane readers read the heartbeat sub-doc.
      const lastHeartbeatAt = FieldValue.serverTimestamp();
      const batch = db.batch();
      const merge = revisionHeartbeatMerge(record, lastHeartbeatAt);
      merge.heartbeat.internalUrl = gatewayServiceInternalUrl(gatewayId);
      batch.set(
        db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId),
        merge,
        { merge: true },
      );
      await batch.commit();
    },
    evictSlug: async (gatewayId: string, slug: string) => {
      const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      if (isRevisionRealizationDoc(snap.data())) return;
      await callUnmountRpc(db, { privateKey, gatewayId, slug, log, tag: "evict" });
    },
    log,
  };
}

interface HeartbeatPollDocLike {
  id: string;
  data(): Record<string, unknown> | undefined;
}

function isLegacyGatewayDesiredState(
  data: Record<string, unknown>,
): data is Record<string, unknown> & GatewayDesiredState {
  return (
    typeof data.gatewayId === "string" &&
    typeof data.imageRepository === "string" &&
    typeof data.imageTag === "string" &&
    typeof data.desiredStatus === "string" &&
    typeof data.createdBy === "string"
  );
}

export function heartbeatPollInstanceIds(docs: HeartbeatPollDocLike[]): string[] {
  const ids: string[] = [];
  for (const doc of docs) {
    const data = doc.data() ?? {};
    if (isRevisionRealizationDoc(data)) {
      if (data.lifecycle !== "retired" && data.lifecycle !== "failed") ids.push(data.revisionId);
      continue;
    }
    if (isLegacyGatewayDesiredState(data) && isRunningGateway(data)) ids.push(doc.id);
  }
  return ids;
}

export function heartbeatRosterTarget(
  instanceId: string,
  data: Record<string, unknown> | undefined,
): { gatewayId: string; revisionId?: string } {
  if (isRevisionRealizationDoc(data)) {
    return { gatewayId: data.gateway, revisionId: data.revisionId };
  }
  return { gatewayId: instanceId };
}

type ControllerStopper = () => void;

interface ControllerBackgroundTasksDeps {
  db: Firestore;
  deps: ControllerDeps;
  helm: HelmRunner;
  fleetControllerPrivateKey: string;
}

function startControllerBackgroundTasks({
  db,
  deps,
  helm,
  fleetControllerPrivateKey,
}: ControllerBackgroundTasksDeps): ControllerStopper[] {
  const stopReconciler = startReconciler(deps);
  const stopWorker = startOperationWorker(deps);
  const stopOperationQueueDrain = startOperationQueueDrain(deps);
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
      readIdleMs: () => readDedicatedGatewayIdleMs(db),
      namespace: NAMESPACE,
      now: () => Date.now(),
      log,
    },
    DEDICATED_GATEWAY_IDLE_SWEEP_MS,
  );
  const stopPreemptionHandoffSweeper = startPreemptionHandoffSweeper(
    { db, now: () => Date.now(), log },
    PREEMPTION_HANDOFF_SWEEP_MS,
  );
  const stopReleaseRetentionSweeper = startReleaseRetentionSweeper(
    firestoreReleaseRetentionDeps(db, log),
    RELEASE_RETENTION_SWEEP_MS,
  );
  const httpKubeOps = deps.kubeOps;
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
    ...(httpKubeOps
      ? {
          readGatewayPodDiagnostics: (gatewayId: string) =>
            httpKubeOps.readGatewayPodDiagnostics({ namespace: NAMESPACE, gatewayId }),
        }
      : {}),
    deleteAuthUserTolerantOfMissing: (uid) => deleteAuthUserTolerantOfMissing(uid, getAuth()),
    dedicatedGatewayIdleDefaultMs: DEDICATED_GATEWAY_IDLE_MS,
    dedicatedGatewayIdleSweepMs: DEDICATED_GATEWAY_IDLE_SWEEP_MS,
  });
  return [
    stopReconciler,
    stopWorker,
    stopOperationQueueDrain,
    stopPoller,
    stopReaper,
    stopStuckOpReaper,
    stopHelmRecoverySweeper,
    stopActivationSweeper,
    stopIdleSweeper,
    stopPreemptionHandoffSweeper,
    stopReleaseRetentionSweeper,
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

function holdFrozenController(
  maintenanceGate: ControllerMaintenanceGate,
  log: (msg: string) => void,
): void {
  const shutdown = createControllerShutdown(
    [
      startMaintenanceHttpServer({ port: HTTP_PORT, log }),
      startMaintenanceRestartWatcher({
        gate: maintenanceGate,
        log,
        restart: () => {
          log("[glm-controller] maintenance freeze cleared; restarting to resume startup safely");
          process.exit(0);
        },
        restartWhenFrozen: false,
        intervalMs: MAINTENANCE_GATE_POLL_MS,
      }),
    ],
    log,
  );
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

interface ControllerRuntime {
  deps: ControllerDeps;
  fleetControllerPrivateKey: string;
  chartFingerprint: string;
}

async function createControllerRuntime(
  db: Firestore,
  maintenanceGate: ControllerMaintenanceGate,
): Promise<ControllerRuntime> {
  const runKubectl: KubectlSubprocess = (args, opts) => spawnKubectl(args, opts);
  const authSecretEnsurer = createAuthSecretEnsurer({
    runKubectl,
    randomTokenHex: defaultRandomTokenHex,
    log,
  });
  const serviceAccountEnsurer = createGatewayServiceAccountEnsurer({
    runKubectl,
    log,
  });
  const gatewayEdgeServiceEnsurer = createGatewayEdgeServiceEnsurer({
    runKubectl,
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
          ensureServiceAccount: serviceAccountEnsurer.ensureServiceAccount,
        });
  const kubeOps =
    process.env.KUBE_OPS_MODE === "stub"
      ? createLoggingKubeOps(log)
      : createKubeSubprocessRunner({ runKubectl, log });
  const workloadIdentityAuth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const gatewayWorkloadIdentityEnsurer = createGatewayWorkloadIdentityEnsurer({
    gatewayServiceAccount: requireEnv(
      "GATEWAY_SERVICE_ACCOUNT",
      "generated operator gateway KSAs must bind to the gateway pod GSA",
    ),
    workloadIdentityProject: requireEnv(
      "GKE_WORKLOAD_IDENTITY_PROJECT",
      "generated operator gateway KSA IAM members must target the GKE Workload Identity pool project",
    ),
    namespace: NAMESPACE,
    log,
    request: async ({ url, method, data }) => {
      const client = await workloadIdentityAuth.getClient();
      const res = await client.request<unknown>({ url, method, data });
      return { status: res.status, data: res.data };
    },
  });
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

  const chartFingerprint = computeChartFingerprint(GATEWAY_CHART);
  const resolveApiServerEgressCidrs = createCachedApiServerEgressResolver(
    (args) => spawnKubectl(args),
    log,
  );

  const handlerSyncFleetIngress = async () => {
    const { desired, actualMap, mountedByGatewayId } = await readReconcileInputs({
      db,
      helm,
      kubeOps,
      handlers: {} as OperationHandlers,
      log,
    });
    const apiServerEgressCidrs = await resolveApiServerEgressCidrs();
    const targetMap = buildHelmTargetMap(
      desired,
      actualMap,
      mountedByGatewayId,
      chartFingerprint,
      apiServerEgressCidrs,
    );
    await syncEdgeIngressForGateways(fleetGatewaysFromTargetMap(targetMap));
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
      modelKeySourceIssuer,
    },
  );

  const convergeEmpty = () =>
    runConvergeEmptyPass(
      buildConvergeEmptyDeps({
        db,
        helm,
        kubeOps,
        gatewayEdgeServiceEnsurer,
        chartFingerprint,
        log,
      }),
    );

  const convergeRoll = () =>
    runRollPass(
      buildRollPassDeps({
        db,
        helm,
        kubeOps,
        gatewayEdgeServiceEnsurer,
        chartFingerprint,
        log,
      }),
    );

  const deps: ControllerDeps = {
    db,
    helm,
    kubeOps,
    modelKeySourceIssuer,
    modelKeySecretEnsurer,
    restartGatewayDeployment: createGatewayDeploymentRestarter(runKubectl, log),
    reconcileImagePins,
    handlers,
    log,
    maintenanceGate,
    syncFleetIngress: syncEdgeIngressForGateways,
    ensureGatewayWorkloadIdentity: gatewayWorkloadIdentityEnsurer,
    ensureGatewayServiceAccount: serviceAccountEnsurer.ensureServiceAccount,
    convergeEmpty,
    convergeRoll,
    operatorReadyRefreshMs: OPERATOR_READY_REFRESH_MS_DEFAULT,
    chartFingerprint,
    resolveApiServerEgressCidrs,
  };

  return { deps, fleetControllerPrivateKey, chartFingerprint };
}

async function main(): Promise<void> {
  initializeApp({
    credential: applicationDefault(),
    storageBucket: resolveDefaultStorageBucket(process.env.GOOGLE_CLOUD_PROJECT),
  });
  const db = getFirestore();
  const maintenanceGate = createFirestoreMaintenanceGate(db);
  if (await maintenanceGateFrozen(maintenanceGate, log, "startup")) {
    holdFrozenController(maintenanceGate, log);
    return;
  }
  const { deps, fleetControllerPrivateKey, chartFingerprint } = await createControllerRuntime(
    db,
    maintenanceGate,
  );

  log(
    `[glm-controller] boot sha=${process.env.BUILD_SHA ?? "unknown"} oc=${process.env.OPENCLAW_VERSION ?? "n/a"} fork=${process.env.OPENCLAW_FORK_SHA ?? "n/a"} node=${process.version} — namespace=${NAMESPACE} gatewayChart=${GATEWAY_CHART} chartFingerprint=${chartFingerprint.slice(0, 12)} chartDriftAutoRoll=${AUTO_ROLL_ON_CHART_DRIFT} valuesFile=${GATEWAY_VALUES_FILE}`,
  );

  await bootstrapGlmGateways(deps);
  await bootstrapDefaultGateway(deps);

  if (await controllerWorkFrozen(deps, "orphan-op resume")) {
    holdFrozenController(maintenanceGate, log);
    return;
  }

  // Resume any op the previous instance left `running` when it exited mid-op (a
  // deploy/restart redeploys this single-replica controller routinely). Re-driving
  // the rollout idempotently is what keeps a redeploy from stranding a half-migrated
  // pool; it runs before the stuck-op reaper's first tick so the re-adopt heartbeat
  // protects the resumed run from being reaped.
  resumeOrphanedRunningOps({
    db,
    log,
    resumableKinds: RESUMABLE_OP_KINDS,
    redrive: async (op, ref) => {
      if (await controllerWorkFrozen(deps, "orphan-op resume")) return;
      await reAdoptAndRunOperation(op, ref, deps);
    },
  }).catch((err) =>
    log(
      `[glm-controller] ⚠ resume-orphaned-ops sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );

  if (await controllerWorkFrozen(deps, "background startup")) {
    holdFrozenController(maintenanceGate, log);
    return;
  }

  const stoppers = startControllerBackgroundTasks({
    db,
    deps,
    helm: deps.helm,
    fleetControllerPrivateKey,
  });
  stoppers.push(
    startMaintenanceRestartWatcher({
      gate: maintenanceGate,
      log,
      restart: () => {
        log("[glm-controller] maintenance freeze observed; exiting fail-closed");
        process.exit(0);
      },
      restartWhenFrozen: true,
      intervalMs: MAINTENANCE_GATE_POLL_MS,
    }),
  );
  const shutdown = createControllerShutdown(stoppers, log);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export async function bootstrapGlmGateways(deps: ControllerDeps): Promise<void> {
  if (await controllerWorkFrozen(deps, "glm gateway bootstrap")) return;
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
  const [snap, gatewaySnap] = await Promise.all([
    deps.db.collection(GLM_GATEWAYS_COLLECTION).get(),
    deps.db.collection(GATEWAYS_COLLECTION).get(),
  ]);
  const known = new Set(snap.docs.map((d) => d.id));
  for (const revisionId of collectKnownRevisionIds({
    revisionDocs: snap.docs.map((d) => d.data()),
    gatewayDocs: gatewaySnap.docs.map((d) => d.data()),
  })) {
    known.add(revisionId);
  }
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
  const orchSnap = await deps.db.doc(ORCHESTRATOR_CONFIG_DOC_PATH).get();
  const existing = (orchSnap.data() as { defaultGatewayId?: unknown } | undefined)
    ?.defaultGatewayId;
  if (typeof existing === "string") return existing;

  const derived = deriveDefaultGatewayIdFromNamespace(NAMESPACE);
  if (derived === null) return null;

  try {
    await deps.db
      .doc(ORCHESTRATOR_CONFIG_DOC_PATH)
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
  if (await controllerWorkFrozen(deps, "default gateway bootstrap")) return;
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
  const [snap, durableSnap] = await Promise.all([
    deps.db.collection(GLM_GATEWAYS_COLLECTION).get(),
    deps.db.collection(GATEWAYS_COLLECTION).get(),
  ]);
  const existingGatewayIds = new Set(snap.docs.map((d) => d.id));
  const durableGatewayIds = new Set(
    durableSnap.docs
      .filter((d) => isGatewayDesiredDoc(d.data()))
      .map((d) => d.id),
  );
  const defaultGatewayId = await resolveDefaultGatewayId(deps);

  const decision = computeDefaultGatewayBootstrap({
    actualMap,
    existingGatewayIds,
    durableGatewayIds,
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
export async function readMigrationUserSnapshot(
  db: Firestore,
  uid: string,
): Promise<FleetBrokerUserSnapshot | null> {
  const userSnap = await db.collection("users").doc(uid).get();
  const data = userSnap.data() as Record<string, unknown> | undefined;
  if (!userSnap.exists || !data || data.approved !== true) return null;
  const slug = slugFromAssignedUser(data);
  if (!slug) return null;
  const workspaceRef = db.collection("workspaces").doc(slug);
  const [workspaceChannels, projectSnap, coachSecret, agentSnap, sysConfig] = await Promise.all([
    workspaceRef.collection("channels").get(),
    workspaceRef.collection("projects").get(),
    db.collection("users").doc(uid).collection("secrets").doc("coachMattermost").get(),
    db.collection("agents").doc(uid).get(),
    db.collection("users").doc(uid).collection("system").doc("config").get(),
  ]);
  const projectDocs = projectSnap.docs;
  const channels = await collectMigrationChannelBindings(workspaceChannels.docs, projectDocs);
  const projects = collectMigrationProjects(projectDocs);
  const coachData = coachSecret.data() as Record<string, unknown> | undefined;
  const agentData = agentSnap.data() as Record<string, unknown> | undefined;
  const name = typeof agentData?.name === "string" ? agentData.name : "";
  const emoji = typeof agentData?.avatarEmoji === "string" ? agentData.avatarEmoji : "";
  const status = stringAt(data, "provisioning.openclaw.status");
  // byotActive + the system/config byot subdoc must ride along so the migration target's
  // mount re-assert (reassertByot) sees the customer's real BYOT state — without it a
  // non-anthropic BYOK customer's models.json is not re-written on the new pod.
  const systemConfig = byotSystemConfigFromDoc(
    sysConfig.data() as Record<string, unknown> | undefined,
  );
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
    byotActive: data.byotActive === true,
    ...(systemConfig ? { systemConfig } : {}),
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
    modelKeySourceIssuer: GatewayModelKeySourceIssuer;
  },
): Promise<OperationHandlers> {
  const { privateKey, modelKeySourceIssuer } = fleetOps;
  if (!privateKey) {
    throw new Error(
      "FLEET_CONTROLLER_PRIVATE_KEY is not set — required for migrate-customer. Refusing to start with stub handlers.",
    );
  }

  const revisionTombstoneWriter = createRevisionTombstoneWriter({
    db,
    now: () => Date.now(),
    log: logFn,
  });

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
    // The ATOMIC cutover: mirror move (flipMirror) + assignment revision commit
    // in ONE Firestore transaction (commitCutoverAtomic), so a crash leaves
    // neither — never a mirror→target / assignment→source half-state. A legacy
    // migration (revision == null) still flips only the mirror.
    commitCutover: async (commit) => {
      await commitCutoverAtomic(
        {
          db: db as unknown as FleetStateFirestore,
          serverTimestamp: () => FieldValue.serverTimestamp(),
          log: logFn,
        },
        {
          uid: commit.uid,
          slug: commit.slug,
          toGatewayId: commit.toGatewayId,
          fromGatewayId: commit.fromGatewayId,
          flipMirror: commit.flipMirror,
          assignment: commit.revision
            ? {
                revisionId: commit.revision.revisionId,
                release: commit.revision.release,
                source: commit.fromGatewayId === commit.toGatewayId ? "rollout" : "migrate-customer",
                updatedByOperationId: null,
              }
            : null,
        },
      );
    },
    resolveGatewayUrl: (transportId) => resolveGatewayUrlFromFirestore(db, transportId),
    buildClient: createMigrationClientBuilder(
      db,
      privateKey,
      logFn,
    ),
    // Step 2 revision resolution at claim time. resolveFromRevision reads the
    // customer's assignment doc, falling back to the source gateway's live
    // revision when there is none (so a same-gateway drain RUNS instead of
    // no-op'ing); resolvePlacement applies the placement rule to the destination
    // gateway. Both no-op (null) until the backfill (PR6) puts gateways on the
    // assignment layer — the legacy path stays live.
    resolveFromRevision: async (uid, currentGatewayId) => {
      const assignment = await readAssignmentDoc(db, currentGatewayId, uid);
      if (assignment) return { revisionId: assignment.revisionId, release: assignment.release };
      return resolveLiveRevisionAsSource(db, currentGatewayId);
    },
    resolvePlacement: (toGatewayId) => resolvePlacementFromFirestore(db, toGatewayId),
    // The roster quiesce gate: written "quiescing" before the source quiesce
    // RPC, restored "serving" on a pre-cutover rollback (fleet-migration-runner).
    setAssignmentState: async (input) => {
      await markAssignmentState(
        {
          db: db as unknown as FleetStateFirestore,
          serverTimestamp: () => FieldValue.serverTimestamp(),
          log: logFn,
        },
        input,
      );
    },
    genMigrationId: () => `mig-${Date.now()}-${randomUUID().slice(0, 8)}`,
    now: () => Date.now(),
    log: logFn,
  });

  const retireGateway = createRetireGatewayHandler({
    helm,
    readGatewayLiveState: async (gatewayId) => {
      // Mounted-customer telemetry relocated to glmGateways/{id}.heartbeat; the
      // retire "refuse if mounted" guard must read the LIVE location, not the
      // stale legacy flat doc. Dual-read prefers glm during expand.
      const [glmSnap, legacySnap] = await Promise.all([
        db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get(),
        db.collection("gateways").doc(gatewayId).get(),
      ]);
      if (!glmSnap.exists && !legacySnap.exists) return null;
      const mounted = readMountedCustomers(
        glmSnap.exists ? (glmSnap.data() as Record<string, unknown>) : undefined,
        legacySnap.exists ? (legacySnap.data() as Record<string, unknown>) : undefined,
      );
      return { mountedCustomers: mounted };
    },
    readAssignmentsForGateway: async (gatewayId) => {
      const assignments = await readAssignmentDocsForGateway(db, gatewayId);
      return assignments.map((a) => ({ uid: a.uid, slug: a.slug }));
    },
    readNonRetiredRevisions: async (gatewayId) => {
      const snap = await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .where("gateway", "==", gatewayId)
        .get();
      const out: Array<{ revisionId: string; release: number }> = [];
      for (const d of snap.docs) {
        const data = d.data();
        if (!isRevisionRealizationDoc(data)) continue;
        if (data.lifecycle === "retired") continue;
        out.push({ revisionId: data.revisionId, release: data.release });
      }
      return out;
    },
    helmUninstallRevision: async (revisionId) => {
      await helm.removeInstance({ namespace: NAMESPACE, gatewayId: revisionId });
    },
    retireRevisionDoc: async (revisionId, reason) => {
      await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .doc(revisionId)
        .set(
          { lifecycle: "retired", retiredAt: Date.now(), retireReason: reason },
          { merge: true },
        );
    },
    readGlmGatewayId: async (gatewayId) => {
      const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as GatewayDesiredState | undefined;
      return data?.gatewayId ?? null;
    },
    writeRevisionTombstone: async (revisionId) => {
      // Only a new-model revision doc carries the release/gateway needed to key a
      // tombstone; a legacy bare gateway has no /r/<n> addressing, so no-op.
      const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
      const data = snap.data();
      if (!isRevisionRealizationDoc(data)) return;
      const gwSnap = await db.collection("gateways").doc(data.gateway).get();
      const gwData = gwSnap.exists ? (gwSnap.data() as GatewayDoc) : undefined;
      const live = gwData && isGatewayDesiredDoc(gwData) ? gwData.liveRevisionId ?? null : null;
      // Never point a retired revision at itself; a full gateway retire may still
      // list this revision as live.
      const currentRevisionId = live === revisionId ? null : live;
      await revisionTombstoneWriter.writeTombstone({
        gatewayId: data.gateway,
        revision: data.release,
        currentRevisionId,
      });
    },
    deleteGlmGateway: async (gatewayId) => {
      await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).delete();
    },
    deleteGatewayHeartbeat: async (gatewayId) => {
      // gateways/{id} may now be the durable GatewayDoc (+ release subcollection).
      // NEVER delete it during retire — PR2's DELETE endpoint marks it
      // desiredStatus:retired and the release history is retained. Clear only the
      // legacy dual-written heartbeat fields; a plain legacy heartbeat doc is
      // deleted as before.
      const ref = db.collection("gateways").doc(gatewayId);
      const doc = await ref.get();
      if (doc.exists && heartbeatTeardownAction(doc.data()) === "clear") {
        await ref.set(clearedHeartbeatFieldsPatch(), { merge: true });
        return;
      }
      await ref.delete();
    },
    readGatewayHeartbeatExists: async (gatewayId) => {
      const doc = await db.collection("gateways").doc(gatewayId).get();
      // A durable GatewayDoc is not a resurrected heartbeat — report it absent so
      // the quiesce step doesn't try to re-delete it.
      return doc.exists && !isGatewayDesiredDoc(doc.data());
    },
    deleteGatewayPersistentVolumeClaim: createGatewayPersistentVolumeClaimDeleter(kubeOps),
    deleteGatewayKubeSecret: async (gatewayId) =>
      kubeOps.deleteSecret({ namespace: NAMESPACE, name: `gateway-auth-token-${gatewayId}` }),
    deleteAuthTokenSecret: async (gatewayId) => {
      await deleteSecret(`gateway-auth-token-${gatewayId}`);
    },
    deleteGatewayServiceAccount: async (gatewayId) =>
      kubeOps.deleteServiceAccount({
        namespace: NAMESPACE,
        name: operatorGatewayServiceAccountName(gatewayId),
      }),
    deleteGatewayEdgeService: async (gatewayId) =>
      kubeOps.deleteService({ namespace: NAMESPACE, name: gatewayEdgeServiceName(gatewayId) }),
    deleteGatewayModelKeyKubeSecret: async (gatewayId) =>
      kubeOps.deleteSecret({ namespace: NAMESPACE, name: gatewayModelKeySecretName(gatewayId) }),
    deleteGatewayModelKeySource: async (gatewayId) => {
      await modelKeySourceIssuer.syncGatewayModelKeySource({
        gatewayId,
        gatewayClass: "builder",
        desiredStatus: "retired",
      });
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
    readGatewayDoc: async (gatewayId) => {
      const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
      if (!snap.exists) return null;
      const data = snap.data();
      return isGatewayDesiredDoc(data) ? data : null;
    },
    readReleasePayload: (gatewayId, release) =>
      readReleasePayloadFromFirestore(db, gatewayId, release),
    requestReconcileTick: () => requestReconcileTickRef.fire?.(),
    releaseRecordTimeoutMs: 60_000,
    convergeTimeoutMs: 45 * 60_000,
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

// A revision is placement-ready once its realization doc reports lifecycle
// "serving" (Cowboy sets this after Deployment availability + heartbeat match).
async function isRevisionServing(db: Firestore, revisionId: string): Promise<boolean> {
  const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
  if (!snap.exists) return false;
  const data = snap.data() as { lifecycle?: unknown } | undefined;
  return data?.lifecycle === "serving";
}

// Placement resolution at migration CLAIM time (GATEWAY-RELEASES-SPEC). Returns
// null when the destination gateway is not yet on the Step 2 assignment layer
// (no durable gateways/{id} desired doc) — the migration then runs the legacy
// bare-gateway path. Otherwise it applies the placement rule against the live
// revision (or the roll target once it is accepting) and its readiness.
async function resolvePlacementFromFirestore(
  db: Firestore,
  toGatewayId: string,
): Promise<PlacementResolution | null> {
  const snap = await db.collection(GATEWAYS_COLLECTION).doc(toGatewayId).get();
  if (!snap.exists) return null;
  const gateway = snap.data();
  if (!isGatewayDesiredDoc(gateway)) return null;
  const candidate =
    gateway.roll && gateway.roll.acceptingNewAssignments
      ? gateway.roll.targetRevisionId
      : gateway.liveRevisionId;
  const ready = candidate ? await isRevisionServing(db, candidate) : false;
  return resolvePlacementRevision({
    gateway,
    isRevisionReady: (revisionId) => revisionId === candidate && ready,
  });
}

// The source revision for a customer with no assignment doc: the gateway's live
// revision (P1-3 — so a same-gateway drain runs instead of no-op'ing as "already
// on target"). Null when the gateway is not on the assignment layer (legacy),
// preserving the bare-gateway comparison.
async function resolveLiveRevisionAsSource(
  db: Firestore,
  gatewayId: string,
): Promise<{ revisionId: string; release: number } | null> {
  const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  if (!snap.exists) return null;
  const gateway = snap.data();
  if (!isGatewayDesiredDoc(gateway) || !gateway.liveRevisionId) return null;
  return { revisionId: gateway.liveRevisionId, release: gateway.liveRelease ?? 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
