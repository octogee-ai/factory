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
  deriveGatewayIdentity,
  operatorGatewayServiceAccountName,
  resolveGatewayClass,
  type GatewayClass,
  type GatewayProfile,
  type Operation,
} from "@octogee/shared/types/glm";
import {
  parseHealthResponse,
  startOperatorHeartbeatPoller,
  type OperatorHeartbeatPollerDeps,
} from "./operator-heartbeat-poller.js";
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
import { createGatewayServiceAccountEnsurer } from "./gateway-service-account-ensurer.js";
import {
  createGatewayAliasServiceEnsurer,
  type GatewayAliasServiceEnsurer,
} from "./gateway-alias-service-ensurer.js";
import {
  revisionHeartbeatMerge,
  readHeartbeatLiveness,
  readMountedCustomers,
  heartbeatTeardownAction,
  LEGACY_HEARTBEAT_FIELDS,
} from "./heartbeat-relocation.js";
import {
  runConvergeEmptyPass,
  type GatewayRuntimeRoot,
  type ConvergeEmptyDeps,
} from "./converge-empty.js";
import { commitRollTrafficFlipAtomic } from "./roll-traffic-flip.js";
import {
  DurableRootDirtyTracker,
  isDurableRootConfigDoc,
  runDurableRootRenderPass,
  type DurableRootRenderDeps,
  type DurableRootRenderRequest,
  type DurableRootRenderResult,
} from "./durable-root-config-renderer.js";
import { createGatewayRuntimeConfigPreparer } from "./gateway-runtime-config.js";
import {
  gatewayEdgeServiceName,
  gatewayPodServiceName,
  isGatewayDesiredDoc,
  isGatewayLegacyBackfill,
  isRevisionRealizationDoc,
  revisionIdForRelease,
  GATEWAY_ASSIGNMENTS_SUBCOLLECTION,
  type AssignmentDoc,
  W9_GATEWAY_EDGE_IMAGE_REPOSITORY,
  type GatewayDoc,
  type GatewayRollSystemConfigState,
  type ReleasePayload,
  type RevisionRealizationDoc,
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
import {
  guardedCreateRevisionDoc,
  guardedPatchGatewayRoot,
} from "./revision-creation.js";
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
import {
  buildOperationCompletionUpdate,
  shouldPersistClaimedOperationCompletion,
  supersededRollMigrationAction,
} from "./operation-retry.js";
import { completeOperatorReservationAfterMigration } from "./operator-reservation-completion.js";
import { createAddGatewayHandler } from "./handlers/add-gateway.js";
import { createMigrateCustomerHandler } from "./handlers/migrate-customer.js";
import type { MigrationRollFence } from "@octogee/core/fleet-migration-runner";
import {
  attestGatewayRetirementAfterWakeAtomic,
  bindGatewayRetirementConfigCheckpointAtomic,
  verifyGatewayRetirementConfigCheckpointAtomic,
  verifyGatewayRetirementClaimAtomic,
} from "@octogee/core/gateway-retirement-claim";
import { createRetireGatewayHandler } from "./handlers/retire-gateway.js";
import { createRetirementConfigFenceManager } from "./retirement-config-fence.js";
import { createRetireRevisionHandler } from "./handlers/retire-revision.js";
import { createGatewayServiceAccountTeardown } from "./lib/gateway-gsa.js";
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
  parseAssignmentDoc,
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
  systemConfigMigrationMode,
} from "@octogee/shared/types/fleet-controller";
import {
  readGatewayArtifact,
} from "@octogee/core/gateway-live-release";
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
import { recordConfigRoll, recordReconcile } from "./metrics.js";
import { createLogger } from "./lib/logger.js";
import { startOrphanHeartbeatReaper } from "./orphan-heartbeat-reaper.js";
import { startStuckOpReaper } from "./stuck-op-reaper.js";
import {
  assertRecoverableConfigFreezeOwner,
  assertRecoverableRollCheckpointOwner,
} from "./config-freeze-recovery.js";
import {
  assertMigrationSystemConfigProtocol,
  servingIsolatedProtocolGaps,
} from "./system-config-protocol-gate.js";
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
const RETIREMENT_ATTESTATION_TIMEOUT_MS = parseNonNegativeInt(
  process.env.RETIREMENT_ATTESTATION_TIMEOUT_MS,
  10 * 60 * 1000,
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
): (revisionId: string) => Promise<void> {
  return async (revisionId) => {
    const name = deploymentNameForInstance(revisionId);
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
  restartGatewayDeployment?: (revisionId: string) => Promise<void>;
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

  // Additive converge-EMPTY pass (GATEWAY-RELEASES-SPEC). Gated to gateways that
  // carry the new gateways/{id} desired docs; dormant until the backfill creates
  // them. Runs after the legacy reconcile and never alters the legacy path.
  convergeEmpty?: (gatewayIds?: readonly string[]) => Promise<void>;

  // The release-roll arm (converge-roll.ts) — runs after convergeEmpty each
  // tick, deriving all progress from durable state.
  convergeRoll?: () => Promise<void>;

  renderDurableRootConfigs?: (
    request: DurableRootRenderRequest,
  ) => Promise<DurableRootRenderResult>;

  reconcileRetryMs?: number;

  operatorReadyRefreshMs?: number;

  chartFingerprint?: string;
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

function hasLegacyBackfillMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).legacyBackfill != null
  );
}

async function legacyBackfillRecoveryActive(db: Firestore): Promise<boolean> {
  const roots = await db.collection(GATEWAYS_COLLECTION).get();
  return roots.docs.some((root) => hasLegacyBackfillMarker(root.data()));
}

function deploymentNameForInstance(gatewayId: string): string {
  return `octogee-gateway-${gatewayId}`;
}

function gatewayServiceInternalUrl(gatewayId: string): string {
  return `http://${deploymentNameForInstance(gatewayId)}.${NAMESPACE}.svc.cluster.local:18789`;
}

export function versionFromImageTag(imageTag: string | undefined): string {
  if (!imageTag) return "unknown";
  const [reference] = imageTag.split("@", 1);
  const [buildSha] = reference.split("-oc");
  return buildSha || reference;
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

async function publishPlatformGatewayReady(
  db: Firestore,
  input: {
    gatewayId: string;
    revisionId: string;
    imageTag?: string;
    now: number;
  },
): Promise<void> {
  // Readiness telemetry lives ONLY at glmGateways/{id}.heartbeat (collision fix,
  // GATEWAY-RELEASES-SPEC cutover step 2). The legacy flat gateways/{id}
  // dual-write is CONTRACTED: it recreated the runtime fields the identity
  // backfill refuses on, so leaving it live made the backfill precondition
  // unsatisfiable on a real fleet. Preserved fields (startedAt,
  // mountedCustomers, lastError) are read from — and written back to — the
  // relocated heartbeat sub-doc.
  const rootRef = db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  const glmRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.revisionId);
  // eslint-disable-next-line complexity
  await db.runTransaction(async (txn) => {
    const rootSnap = await txn.get(rootRef);
    const root = rootSnap.exists ? rootSnap.data() : undefined;
    if (!isDurableRootConfigDoc(root, input.gatewayId)) {
      throw new Error(`cannot publish readiness: gateways/${input.gatewayId} is not a valid durable root`);
    }
    const glmSnap = await txn.get(glmRef);
    const glmData = glmSnap.exists ? (glmSnap.data() as Record<string, unknown> | undefined) : undefined;
    if (
      !isRevisionRealizationDoc(glmData) ||
      glmData.gateway !== input.gatewayId ||
      glmData.revisionId !== input.revisionId ||
      input.revisionId !== revisionIdForRelease(input.gatewayId, glmData.release)
    ) {
      throw new Error(
        `cannot publish readiness: glmGateways/${input.revisionId} is not ${input.gatewayId}'s revision`,
      );
    }
    const existingHb =
      glmData?.heartbeat && typeof glmData.heartbeat === "object" && !Array.isArray(glmData.heartbeat)
        ? (glmData.heartbeat as unknown as Record<string, unknown>)
        : undefined;
    const patch: Record<string, unknown> = {
      status: "ready",
      version: versionFromImageTag(input.imageTag),
      internalUrl: gatewayServiceInternalUrl(input.revisionId),
      startedAt: typeof existingHb?.startedAt === "number" ? existingHb.startedAt : input.now,
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
  revisionId: string,
): Promise<{ lastHeartbeatAt: number; version?: string | null } | null> {
  const glmSnap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
  const revision = glmSnap.exists ? glmSnap.data() : undefined;
  if (
    !isRevisionRealizationDoc(revision) ||
    revision.revisionId !== revisionId ||
    revisionId !== revisionIdForRelease(revision.gateway, revision.release)
  ) {
    return null;
  }
  return readHeartbeatLiveness(revision as unknown as Record<string, unknown>, undefined);
}

interface DurableGatewayRevision {
  gatewayId: string;
  revisionId: string;
  imageTag: string;
  gatewayClass: GatewayClass;
  profile: GatewayProfile;
}

async function readDurableGatewayRevision(
  db: Firestore,
  gatewayId: string,
  purpose: "desired" | "serving",
): Promise<DurableGatewayRevision | null> {
  const rootSnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  const root = rootSnap.exists ? rootSnap.data() : undefined;
  if (!isDurableRootConfigDoc(root, gatewayId)) return null;
  const revisionId =
    purpose === "desired"
      ? revisionIdForRelease(gatewayId, root.desiredRelease)
      : root.trafficRevisionId ?? root.liveRevisionId;
  if (!revisionId) return null;
  const revisionSnap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
  const revision = revisionSnap.exists ? revisionSnap.data() : undefined;
  if (
    !isRevisionRealizationDoc(revision) ||
    revision.gateway !== gatewayId ||
    revision.revisionId !== revisionId ||
    revisionId !== revisionIdForRelease(gatewayId, revision.release) ||
    (purpose === "serving" && revision.lifecycle !== "serving") ||
    !revision.helm.imageTag
  ) {
    return null;
  }
  return {
    gatewayId,
    revisionId,
    imageTag: revision.helm.imageTag,
    gatewayClass: root.gatewayClass,
    profile: root.imageProfile,
  };
}

export async function isRecoverableHelmRevision(
  db: Firestore,
  revisionId: string,
): Promise<boolean> {
  const revisionSnap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
  const revision = revisionSnap.exists ? revisionSnap.data() : undefined;
  if (
    !isRevisionRealizationDoc(revision) ||
    revision.revisionId !== revisionId ||
    revision.lifecycle === "retired" ||
    revision.lifecycle === "failed" ||
    revisionId !== revisionIdForRelease(revision.gateway, revision.release)
  ) {
    return false;
  }
  const rootSnap = await db.collection(GATEWAYS_COLLECTION).doc(revision.gateway).get();
  const root = rootSnap.exists ? rootSnap.data() : undefined;
  return isDurableRootConfigDoc(root, revision.gateway) && root.desiredStatus === "running";
}

type FailedBridgeRevisionReopenInput = Parameters<
  ConvergeEmptyDeps["reopenFailedBridgeRevision"]
>[0];

function bridgeMetadataMatchesRecoveryPlan(
  bridge: unknown,
  expected: FailedBridgeRevisionReopenInput["legacyBackfill"],
): boolean {
  if (!isGatewayLegacyBackfill(bridge)) return false;
  if (bridge.startedAt !== expected.startedAt) return false;
  if (bridge.sourceGlmGatewayIds.length !== expected.sourceGlmGatewayIds.length) return false;
  return !bridge.sourceGlmGatewayIds.some(
    (sourceId) => !expected.sourceGlmGatewayIds.includes(sourceId),
  );
}

function durableRootMatchesFailedBridgeRevisionReopen(
  gateway: GatewayRuntimeRoot,
  input: FailedBridgeRevisionReopenInput,
): boolean {
  const rootStateMatches = [
    gateway.desiredStatus === "running",
    gateway.desiredRelease === input.release,
    gateway.liveRevisionId == null,
    gateway.trafficRevisionId == null,
    gateway.liveRelease == null,
    gateway.roll == null,
  ].every(Boolean);
  if (!rootStateMatches) return false;
  return bridgeMetadataMatchesRecoveryPlan(gateway.legacyBackfill, input.legacyBackfill);
}

function assertFailedBridgeRevisionReopenRoot(
  gateway: unknown,
  input: FailedBridgeRevisionReopenInput,
): asserts gateway is GatewayRuntimeRoot {
  if (!isDurableRootConfigDoc(gateway, input.gatewayId)) {
    throw new Error(`cannot reopen ${input.revisionId}: durable root is missing or invalid`);
  }
  if (!durableRootMatchesFailedBridgeRevisionReopen(gateway, input)) {
    throw new Error(
      `cannot reopen ${input.revisionId}: bridge root no longer matches recovery plan`,
    );
  }
}

function revisionMatchesFailedBridgeRevisionReopen(
  revision: unknown,
  input: FailedBridgeRevisionReopenInput,
): boolean {
  if (!isRevisionRealizationDoc(revision)) return false;
  return [
    revision.gateway === input.gatewayId,
    revision.revisionId === input.revisionId,
    revision.release === input.release,
    input.revisionId === revisionIdForRelease(input.gatewayId, input.release),
    revision.lifecycle === "failed",
    revision.retiredAt == null,
  ].every(Boolean);
}

async function reopenFailedBridgeRevision(
  db: Firestore,
  input: FailedBridgeRevisionReopenInput,
): Promise<void> {
  const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  const revisionRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.revisionId);
  await db.runTransaction(async (txn) => {
    const [gatewaySnap, revisionSnap] = await Promise.all([
      txn.get(gatewayRef),
      txn.get(revisionRef),
    ]);
    const gateway = gatewaySnap.exists ? gatewaySnap.data() : undefined;
    assertFailedBridgeRevisionReopenRoot(gateway, input);
    const revision = revisionSnap.exists ? revisionSnap.data() : undefined;
    if (!revisionMatchesFailedBridgeRevisionReopen(revision, input)) {
      throw new Error(
        `cannot reopen ${input.revisionId}: failed revision no longer matches recovery plan`,
      );
    }
    txn.set(
      revisionRef,
      {
        lifecycle: "provisioning",
        helm: { lastAppliedAt: null },
        lastError: { message: null, at: null },
      },
      { merge: true },
    );
  });
}

// Production wiring for the converge-EMPTY pass. Gated on gateways/{id} docs
// that pass isGatewayDesiredDoc — legacy heartbeat docs dual-written to
// gateways/{id} lack desiredRelease and are filtered out, so the pass is
// dormant until the backfill creates real desired docs.
function buildConvergeEmptyDeps(args: {
  db: Firestore;
  helm: HelmRunner;
  kubeOps: KubeOps;
  gatewayAliasServiceEnsurer: GatewayAliasServiceEnsurer;
  chartFingerprint?: string;
  prepareGatewayConfig: (config: GatewayRuntimeRoot) => Promise<GatewayRuntimeRoot>;
  log: (msg: string) => void;
}, gatewayIds?: readonly string[]): ConvergeEmptyDeps {
  const {
    db,
    helm,
    kubeOps,
    gatewayAliasServiceEnsurer,
    chartFingerprint,
    prepareGatewayConfig,
    log,
  } = args;
  const selectedGatewayIds = gatewayIds ? new Set(gatewayIds) : null;
  return {
    namespace: NAMESPACE,
    chartPath: GATEWAY_CHART,
    valuesFile: GATEWAY_VALUES_FILE,
    chartFingerprint,
    prepareGatewayConfig,
    readinessTimeoutMs: CONVERGE_EMPTY_READINESS_TIMEOUT_MS,
    log,
    now: () => Date.now(),
    readGatewayDesiredDocs: async () => {
      const snap = await db.collection(GATEWAYS_COLLECTION).get();
      return snap.docs.flatMap((doc) => {
        if (selectedGatewayIds && !selectedGatewayIds.has(doc.id)) return [];
        const data = doc.data();
        return isDurableRootConfigDoc(data, doc.id) ? [data] : [];
      });
    },
    readReleasePayload: (gatewayId, release) =>
      readReleasePayloadFromFirestore(db, gatewayId, release),
    readServingRevisions: async (gateway) => {
      const snap = await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .where("gateway", "==", gateway.gatewayId)
        .get();
      return servingRevisionsForGatewayQuery(snap.docs, gateway).map((revision) => ({
        gatewayId: revision.gateway,
        revisionId: revision.revisionId,
        release: revision.release,
      }));
    },
    readExistingRevision: async (revisionId) => {
      const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
      if (!doc.exists) return null;
      const data = doc.data();
      if (!isRevisionRealizationDoc(data)) return null;
      if (
        data.revisionId !== revisionId ||
        revisionId !== revisionIdForRelease(data.gateway, data.release)
      ) {
        throw new Error(`glmGateways/${revisionId} has an invalid revision identity`);
      }
      return {
        createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
        lifecycle: data.lifecycle,
        helmApplied: data.helm.lastAppliedAt != null,
        helmAppliedAt:
          typeof data.helm.lastAppliedAt === "number" ? data.helm.lastAppliedAt : null,
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
    ensurePerGatewayAliasServices: async ({ gatewayId, revisionId }) => {
      await gatewayAliasServiceEnsurer.ensurePerGatewayAliasServices({
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
    reopenFailedBridgeRevision: (input) => reopenFailedBridgeRevision(db, input),
    writeConvergeCompletion: async (gatewayId, patch) => {
      await db
        .collection("gateways")
        .doc(gatewayId)
        .set({ ...patch, updatedAt: Date.now(), updatedBy: "cowboy" }, { merge: true });
    },
  };
}

// The revision heartbeat reports the build SHA (version); the release image tag
// is `<sha>-oc<ocVersion>`, optionally digest-pinned with `@sha256:<digest>`.
// Match the full tag, the digest-stripped tag name, or the SHA prefix.
export function convergeHeartbeatMatchesImageTag(
  version: string | null,
  imageTag: string,
): boolean {
  if (!version) return false;
  if (version === imageTag) return true;
  const at = imageTag.indexOf("@");
  if (at > 0 && version === imageTag.slice(0, at)) return true;
  return version === versionFromImageTag(imageTag);
}

async function readReleasePayloadFromFirestore(
  db: Firestore,
  gatewayId: string,
  release: number,
): Promise<ReleasePayload | null> {
  return readGatewayArtifact(db, gatewayId, release);
}

function readCanonicalRevisionForGatewayQuery(
  doc: { id: string; data(): unknown },
  gatewayId: string,
): RevisionRealizationDoc {
  const data = doc.data();
  if (!isRevisionRealizationDoc(data)) {
    throw new Error(
      `glmGateways/${doc.id} returned by ${gatewayId} revision query is not a revision realization`,
    );
  }
  if (data.gateway !== gatewayId) {
    throw new Error(
      `glmGateways/${doc.id} returned by ${gatewayId} revision query belongs to ${data.gateway}`,
    );
  }
  if (
    data.lifecycle !== "retired" &&
    (doc.id !== data.revisionId ||
      data.revisionId !== revisionIdForRelease(gatewayId, data.release))
  ) {
    throw new Error(
      `glmGateways/${doc.id} has invalid non-retired revision identity ${data.revisionId}`,
    );
  }
  return data;
}

function isMarkerAuthorizedLegacySourceForGatewayQuery(
  doc: { id: string; data(): unknown },
  gateway: GatewayRuntimeRoot,
): boolean {
  const bridge = gateway.legacyBackfill;
  return (
    isGatewayLegacyBackfill(bridge) &&
    bridge.sourceGlmGatewayIds.includes(doc.id) &&
    isLegacyBackfillSource(doc.data(), doc.id, gateway.gatewayId)
  );
}

export function servingRevisionExistsForGatewayQuery(
  docs: ReadonlyArray<{ id: string; data(): unknown }>,
  gateway: GatewayRuntimeRoot,
): boolean {
  return servingRevisionsForGatewayQuery(docs, gateway).length > 0;
}

export function servingRevisionsForGatewayQuery(
  docs: ReadonlyArray<{ id: string; data(): unknown }>,
  gateway: GatewayRuntimeRoot,
): RevisionRealizationDoc[] {
  const serving: RevisionRealizationDoc[] = [];
  for (const doc of docs) {
    if (isMarkerAuthorizedLegacySourceForGatewayQuery(doc, gateway)) continue;
    const revision = readCanonicalRevisionForGatewayQuery(doc, gateway.gatewayId);
    if (revision.lifecycle === "serving" && revision.retiredAt == null) serving.push(revision);
  }
  return serving;
}

function buildDurableRootRenderDeps(args: {
  db: Firestore;
  helm: HelmRunner;
  chartFingerprint?: string;
  prepareGatewayConfig: (config: GatewayRuntimeRoot) => Promise<GatewayRuntimeRoot>;
  log: (msg: string) => void;
}): DurableRootRenderDeps {
  const {
    db,
    helm,
    chartFingerprint,
    prepareGatewayConfig,
    log,
  } = args;
  return {
    namespace: NAMESPACE,
    chartPath: GATEWAY_CHART,
    valuesFile: GATEWAY_VALUES_FILE,
    chartFingerprint,
    prepareGatewayConfig,
    listGatewayIds: async () => {
      const snap = await db.collection(GATEWAYS_COLLECTION).get();
      return snap.docs
        .flatMap((doc) => (isDurableRootConfigDoc(doc.data(), doc.id) ? [doc.id] : []))
        .sort();
    },
    readGateway: async (gatewayId) => {
      const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
      return snap.exists ? snap.data() : null;
    },
    readRevisions: async (gatewayId) => {
      const snap = await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .where("gateway", "==", gatewayId)
        .get();
      return snap.docs
        .map((doc) => ({
          id: doc.id,
          revision: readCanonicalRevisionForGatewayQuery(doc, gatewayId),
        }))
        .sort((left, right) =>
          left.revision.release === right.revision.release
            ? left.revision.revisionId.localeCompare(right.revision.revisionId)
            : left.revision.release - right.revision.release,
        );
    },
    readArtifact: (gatewayId, release) => readGatewayArtifact(db, gatewayId, release),
    helmUpsertRevision: async (opts) => {
      await helm.upsertInstance({ ...opts, chartFingerprint });
    },
    markRevisionHelmApplied: async (revisionId, at) => {
      await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .doc(revisionId)
        .set({ helm: { lastAppliedAt: at } }, { merge: true });
    },
    now: () => Date.now(),
    log,
  };
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
  privateKey: string;
  helm: HelmRunner;
  kubeOps: KubeOps;
  gatewayAliasServiceEnsurer: GatewayAliasServiceEnsurer;
  chartFingerprint?: string;
  prepareGatewayConfig: (config: GatewayRuntimeRoot) => Promise<GatewayRuntimeRoot>;
  log: (msg: string) => void;
}): RollPassDeps {
  const {
    db,
    privateKey,
    helm,
    kubeOps,
    gatewayAliasServiceEnsurer,
    chartFingerprint,
    prepareGatewayConfig,
    log,
  } = args;
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
    prepareGatewayConfig,
    readinessTimeoutMs: CONVERGE_EMPTY_READINESS_TIMEOUT_MS,
    sourceForwarderTtlMs: ROLL_SOURCE_FORWARDER_TTL_MS,
    migrateRetryBackoffMs: ROLL_MIGRATE_RETRY_BACKOFF_MS,
    readGatewayDesiredDocs: async () => {
      const snap = await db.collection(GATEWAYS_COLLECTION).get();
      return snap.docs.flatMap((doc) => {
        const data = doc.data();
        return isDurableRootConfigDoc(data, doc.id) ? [data] : [];
      });
    },
    readReleasePayload: (gatewayId, release) =>
      readReleasePayloadFromFirestore(db, gatewayId, release),
    readRevisionDoc: async (revisionId) => {
      const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
      if (!doc.exists) return null;
      const data = doc.data();
      if (!isRevisionRealizationDoc(data)) return null;
      if (
        data.revisionId !== revisionId ||
        revisionId !== revisionIdForRelease(data.gateway, data.release)
      ) {
        throw new Error(`glmGateways/${revisionId} has an invalid revision identity`);
      }
      return data;
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
      await guardedPatchGatewayRoot(
        db,
        gatewayId,
        patch as Record<string, unknown>,
        {
          requireRunning: true,
          updatedAt: Date.now(),
          updatedBy: "cowboy",
        },
      );
    },
    commitTrafficFlip: (input) => commitRollTrafficFlipAtomic(db, input),
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
    enqueueRollMigration: async ({
      uid,
      slug,
      gatewayId,
      rollOperationId,
      systemConfigMigrationMode,
      preAcquiredConfigCheckpoint,
    }) => {
      const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
      await opRef.set(
        buildRollMigrateOpDoc({
          uid,
          builderSlug: slug,
          gatewayId,
          rollOperationId,
          createdAt: Date.now(),
          systemConfigMigrationMode,
          ...(preAcquiredConfigCheckpoint ? { preAcquiredConfigCheckpoint } : {}),
        }),
      );
      return opRef.id;
    },
    cancelRollMigrations: async ({ gatewayId, rollOperationId, reason }) => {
      const snap = await db
        .collection(GLM_OPERATIONS_COLLECTION)
        .where("kind", "==", "migrate-customer")
        .get();
      const candidates = snap.docs.filter((doc) => {
        const data = doc.data() as Operation;
        return data.input?.toGatewayId === gatewayId &&
          data.input?.source === ROLL_MIGRATE_SOURCE &&
          data.input?.rollOperationId === rollOperationId;
      });
      const stopped = await Promise.all(candidates.map((doc) => db.runTransaction(async (txn) => {
        const fresh = await txn.get(doc.ref);
        if (!fresh.exists) return true;
        const data = fresh.data() as Operation;
        const input = data.input;
        if (
          input?.toGatewayId !== gatewayId ||
          input?.source !== ROLL_MIGRATE_SOURCE ||
          input?.rollOperationId !== rollOperationId
        ) {
          return true;
        }
        const action = supersededRollMigrationAction(data);
        if (action === "done") return true;
        if (action === "wait") {
          txn.update(doc.ref, {
            cancellationRequestedAt: Date.now(),
            cancellationReason: reason,
          });
          return false;
        }
        txn.update(doc.ref, {
          status: "rolled-back",
          completedAt: Date.now(),
          error: `release-roll cancelled: ${reason}`,
          rolledBack: true,
          waitingOn: FieldValue.delete(),
          nextAttemptAt: FieldValue.delete(),
        });
        return true;
      })));
      return stopped.every(Boolean);
    },
    isSystemConfigProtocolFleetReady: () => isFleetConfigProtocolReady(db),
    checkpointConfigFreeze: async ({ gatewayId, revisionId, migrationId, slug }) => {
      const sourceUrl = await resolveGatewayUrlFromFirestore(db, revisionId);
      const client = createMigrationClient({
        privateKey,
        resolveGatewayUrl: () => sourceUrl,
        log,
      });
      const checkpoint = await client.freezeConfig({
        migrationId,
        gatewayId,
        transportId: revisionId,
        slug,
      });
      return {
        checkpointCommit: checkpoint.checkpointCommit,
        configHash: checkpoint.configHash,
      };
    },
    checkpointConfigFreezeV2: async ({
      gatewayId,
      sourceRevisionId,
      targetRevisionId,
      migrationId,
      slug,
    }) => {
      const sourceUrl = await resolveGatewayUrlFromFirestore(db, sourceRevisionId);
      const client = createMigrationClient({
        privateKey,
        resolveGatewayUrl: () => sourceUrl,
        log,
      });
      return client.freezeConfigV2({
        migrationId,
        gatewayId,
        transportId: sourceRevisionId,
        slug,
        sourceRevisionId,
        targetRevisionId,
      });
    },
    proveConfigCandidate: async ({ gatewayId, state }) => {
      const targetUrl = await resolveGatewayUrlFromFirestore(db, state.targetRevisionId);
      const client = createMigrationClient({
        privateKey,
        resolveGatewayUrl: () => targetUrl,
        log,
      });
      return client.proveConfigCandidate({
        migrationId: state.migrationId,
        gatewayId,
        transportId: state.targetRevisionId,
        slug: state.builderSlug,
        sourceRevisionId: state.sourceRevisionId,
        targetRevisionId: state.targetRevisionId,
        checkpointCommit: state.checkpointCommit,
        freezeObject: state.freezeObject,
      });
    },
    promoteConfigCandidate: async ({ gatewayId, state }) => {
      if (!state.candidateCommit || !state.candidateHash) {
        throw new Error("protocol-v2 promotion state lacks candidate bindings");
      }
      const targetUrl = await resolveGatewayUrlFromFirestore(db, state.targetRevisionId);
      const client = createMigrationClient({ privateKey, resolveGatewayUrl: () => targetUrl, log });
      await client.promoteConfigCandidate({
        migrationId: state.migrationId,
        gatewayId,
        transportId: state.targetRevisionId,
        slug: state.builderSlug,
        sourceRevisionId: state.sourceRevisionId,
        targetRevisionId: state.targetRevisionId,
        checkpointCommit: state.checkpointCommit,
        candidateCommit: state.candidateCommit,
        candidateHash: state.candidateHash,
        freezeObject: state.freezeObject,
      });
    },
    abortConfigV2: async ({ gatewayId, state }) => {
      const sourceUrl = await resolveGatewayUrlFromFirestore(db, state.sourceRevisionId);
      const client = createMigrationClient({ privateKey, resolveGatewayUrl: () => sourceUrl, log });
      await client.abortConfigV2({
        migrationId: state.migrationId,
        gatewayId,
        transportId: state.sourceRevisionId,
        slug: state.builderSlug,
        sourceRevisionId: state.sourceRevisionId,
        targetRevisionId: state.targetRevisionId,
        checkpointCommit: state.checkpointCommit,
        candidateCommit: state.candidateCommit ?? null,
        freezeObject: state.freezeObject,
      });
    },
    finalizeConfigV2: async ({ gatewayId, state }) => {
      if (!state.candidateCommit || !state.candidateHash) {
        throw new Error("protocol-v2 finalize state lacks candidate bindings");
      }
      const targetUrl = await resolveGatewayUrlFromFirestore(db, state.targetRevisionId);
      const client = createMigrationClient({ privateKey, resolveGatewayUrl: () => targetUrl, log });
      await client.finalizeConfigV2({
        migrationId: state.migrationId,
        gatewayId,
        transportId: state.targetRevisionId,
        slug: state.builderSlug,
        sourceRevisionId: state.sourceRevisionId,
        targetRevisionId: state.targetRevisionId,
        checkpointCommit: state.checkpointCommit,
        candidateCommit: state.candidateCommit,
        candidateHash: state.candidateHash,
        freezeObject: state.freezeObject,
      });
    },
    recoverConfigFreezeOwner: async ({
      ownerMigrationId,
      requestedMigrationId,
      gatewayId,
      sourceRevisionId,
      rollOperationId,
      slug,
    }) => {
      const ownerOpId = ownerMigrationId.startsWith("mig-")
        ? ownerMigrationId.slice(4)
        : "";
      if (!ownerOpId) {
        throw new Error("config freeze owner is not operation-bound");
      }
      const [ownerSnap, rootSnap] = await Promise.all([
        db.collection(GLM_OPERATIONS_COLLECTION).doc(ownerOpId).get(),
        db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get(),
      ]);
      const owner = ownerSnap.exists
        ? ({ id: ownerSnap.id, ...ownerSnap.data() } as Operation)
        : null;
      assertRecoverableRollCheckpointOwner({
        ownerMigrationId,
        slug,
        sourceGatewayId: gatewayId,
      }, owner);
      const root = rootSnap.data();
      const checkpoint = isDurableRootConfigDoc(root, gatewayId)
        ? root.roll?.systemConfigCheckpoint
        : null;
      if (
        root?.roll?.operationId !== rollOperationId ||
        checkpoint?.migrationId !== requestedMigrationId ||
        checkpoint.sourceRevisionId !== sourceRevisionId ||
        checkpoint.builderSlug !== slug ||
        checkpoint.sourceUnfrozenAt !== null
      ) {
        throw new Error("config checkpoint recovery roll lease is no longer current");
      }
      const sourceUrl = await resolveGatewayUrlFromFirestore(db, sourceRevisionId);
      const client = createMigrationClient({
        privateKey,
        resolveGatewayUrl: () => sourceUrl,
        log,
      });
      await client.unfreezeConfig({
        migrationId: ownerMigrationId,
        gatewayId,
        transportId: sourceRevisionId,
        slug,
      });
      return true;
    },
    proveConfigRestore: async ({
      gatewayId,
      rollOperationId,
      sourceRevisionId,
      targetRevisionId,
      migrationId,
      slug,
      checkpointCommit,
    }) => {
      try {
        const targetUrl = await resolveGatewayUrlFromFirestore(db, targetRevisionId);
        const client = createMigrationClient({
          privateKey,
          resolveGatewayUrl: () => targetUrl,
          log,
        });
        const proof = await client.proveConfigRestore({
          migrationId,
          gatewayId,
          transportId: targetRevisionId,
          slug,
          checkpointCommit,
        });
        if (proof.restoredCommit !== checkpointCommit) {
          throw new Error(
            `target ${targetRevisionId} restored ${proof.restoredCommit} instead of ${checkpointCommit}`,
          );
        }
        const observedAt = Date.now();
        await db.runTransaction(async (txn) => {
          const rootRef = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
          const rootSnap = await txn.get(rootRef);
          const root = rootSnap.data();
          const checkpoint = isDurableRootConfigDoc(root, gatewayId)
            ? root.roll?.systemConfigCheckpoint
            : null;
          if (
            root?.roll?.operationId !== rollOperationId ||
            root.roll.targetRevisionId !== targetRevisionId ||
            checkpoint?.migrationId !== migrationId ||
            checkpoint.sourceRevisionId !== sourceRevisionId ||
            checkpoint.checkpointCommit !== checkpointCommit ||
            checkpoint.sourceUnfrozenAt !== null
          ) {
            throw new Error(`target ${targetRevisionId} config proof no longer matches the active roll`);
          }
          txn.set(db.collection(GLM_GATEWAYS_COLLECTION).doc(targetRevisionId), {
            systemConfig: {
              migrationId,
              builderSlug: slug,
              sourceRevisionId,
              checkpointCommit,
              restoredCommit: proof.restoredCommit,
              acceptedCommit: proof.acceptedCommit,
              configHash: proof.configHash,
              configReady: proof.configReady,
              observedRevisionId: proof.observedRevisionId,
              restoreProvenAt: proof.restoreProvenAt,
              configReadyAt: proof.configReadyAt,
              runtimeConfigHash: proof.runtimeConfigHash,
              observedAt,
            },
          }, { merge: true });
        });
        recordConfigRoll({
          stage: "proof",
          result: "ok",
          gatewayId,
          revisionId: targetRevisionId,
        });
      } catch (error) {
        recordConfigRoll({
          stage: "proof",
          result: "fail",
          gatewayId,
          revisionId: targetRevisionId,
        });
        throw error;
      }
    },
    reproveConfigRestore: async ({ gatewayId, targetRevisionId, priorProof }) => {
      try {
        const targetUrl = await resolveGatewayUrlFromFirestore(db, targetRevisionId);
        const client = createMigrationClient({
          privateKey,
          resolveGatewayUrl: () => targetUrl,
          log,
        });
        const proof = await client.reproveConfigRestore({
          migrationId: priorProof.migrationId,
          gatewayId,
          transportId: targetRevisionId,
          slug: priorProof.builderSlug,
          checkpointCommit: priorProof.checkpointCommit,
        });
        if (
          proof.restoredCommit !== priorProof.checkpointCommit ||
          proof.acceptedCommit !== priorProof.acceptedCommit ||
          proof.configHash !== priorProof.configHash
        ) {
          throw new Error(`target ${targetRevisionId} changed durable config before restart reproof`);
        }
        const observedAt = Date.now();
        await db.collection(GLM_GATEWAYS_COLLECTION).doc(targetRevisionId).set({
          systemConfig: {
            ...priorProof,
            restoreProvenAt: proof.restoreProvenAt,
            configReadyAt: proof.configReadyAt,
            runtimeConfigHash: proof.runtimeConfigHash,
            observedAt,
          },
        }, { merge: true });
        recordConfigRoll({
          stage: "proof",
          result: "ok",
          gatewayId,
          revisionId: targetRevisionId,
        });
      } catch (error) {
        recordConfigRoll({
          stage: "proof",
          result: "fail",
          gatewayId,
          revisionId: targetRevisionId,
        });
        throw error;
      }
    },
    releaseConfigFreeze: async ({ gatewayId, revisionId, migrationId, slug }) => {
      const sourceUrl = await resolveGatewayUrlFromFirestore(db, revisionId);
      const client = createMigrationClient({
        privateKey,
        resolveGatewayUrl: () => sourceUrl,
        log,
      });
      await client.unfreezeConfig({
        migrationId,
        gatewayId,
        transportId: revisionId,
        slug,
      });
    },
    markConfigFreezeReleased: async ({
      gatewayId,
      rollOperationId,
      migrationId,
      releasedAt,
    }) => {
      const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(gatewayRef);
        const gateway = snap.data();
        if (!isDurableRootConfigDoc(gateway, gatewayId)) {
          throw new Error(`gateway ${gatewayId} durable root disappeared during config release`);
        }
        if (
          gateway.roll?.operationId !== rollOperationId ||
          gateway.roll.systemConfigCheckpoint?.migrationId !== migrationId
        ) {
          throw new Error(`gateway ${gatewayId} config release no longer matches the active roll`);
        }
        txn.update(gatewayRef, {
          "roll.systemConfigCheckpoint.sourceUnfrozenAt": releasedAt,
          "roll.updatedAt": releasedAt,
          updatedAt: releasedAt,
          updatedBy: "cowboy",
        });
      });
    },
    recordConfigRollMetric: recordConfigRoll,
    hasActiveShell: async (gatewayId) =>
      (await readShellLiveness(db, gatewayId, Date.now())).reallyActive,
    ensurePerGatewayAliasServices: async ({ gatewayId, revisionId }) => {
      await gatewayAliasServiceEnsurer.ensurePerGatewayAliasServices({
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

async function syncGatewayModelKeySecrets(
  deps: ControllerDeps,
  gateways: readonly GatewayRuntimeRoot[],
): Promise<Set<string>> {
  const ensurer = deps.modelKeySecretEnsurer;
  const changedBrokerGateways = new Set<string>();
  if (!ensurer) return changedBrokerGateways;

  for (const gateway of gateways) {
    const gatewayClass =
      gateway.desiredStatus === "retired" ? "shared" : gateway.gatewayClass;
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
  gateways: readonly GatewayRuntimeRoot[],
): Promise<void> {
  const issuer = deps.modelKeySourceIssuer;
  if (!issuer) return;

  for (const gateway of gateways) {
    const gatewayClass = gateway.gatewayClass;
    try {
      await issuer.syncGatewayModelKeySource({
        gatewayId: gateway.gatewayId,
        gatewayClass,
        desiredStatus: gateway.desiredStatus,
        ownerUid: gateway.ownerUid ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`(source=model-key-source) ${gateway.gatewayId}: ${message}`);
    }
  }
}

async function restartGatewayDeploymentsForModelKeyChanges(
  deps: ControllerDeps,
  gateways: readonly GatewayRuntimeRoot[],
  changedGatewayIds: Set<string>,
): Promise<void> {
  if (!deps.restartGatewayDeployment || changedGatewayIds.size === 0) return;
  const roots = new Map(gateways.map((gateway) => [gateway.gatewayId, gateway]));
  for (const gatewayId of changedGatewayIds) {
    const root = roots.get(gatewayId);
    const revisionId = root?.trafficRevisionId ?? root?.liveRevisionId;
    if (!revisionId) {
      deps.log(
        `[glm-controller] model-key secret changed for ${gatewayId}, but no serving revision exists yet`,
      );
      continue;
    }
    try {
      await deps.restartGatewayDeployment(revisionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`(source=model-key-secret) ${gatewayId}/${revisionId}: rollout restart failed: ${message}`);
    }
  }
}

async function syncFleetIngressIfConfigured(
  deps: ControllerDeps,
): Promise<void> {
  const syncFleetIngress = deps.syncFleetIngress;
  if (!syncFleetIngress) return;
  try {
    await syncFleetIngress(await readDurableServingFleetGateways(deps.db));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`(source=fleet-ingress) ${message}`);
  }
}

interface DurableRuntimeState {
  gateways: GatewayRuntimeRoot[];
  revisions: RevisionRealizationDoc[];
  invalidRootIds: string[];
  legacyBackfillGatewayIds: string[];
  missingLegacyBackfillSourceIds: string[];
  legacyGlmDocIds: string[];
  unsafeRevisionIds: string[];
}

function isLegacyBackfillSource(
  data: unknown,
  documentId: string,
  gatewayId: string,
): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const source = data as Record<string, unknown>;
  return (
    source.gatewayId === documentId &&
    deriveGatewayIdentity(documentId, source.gateway) === gatewayId &&
    typeof source.imageRepository === "string" &&
    source.imageRepository.length > 0 &&
    typeof source.imageTag === "string" &&
    source.imageTag.length > 0 &&
    typeof source.createdBy === "string" &&
    (source.desiredStatus === "running" ||
      source.desiredStatus === "paused" ||
      source.desiredStatus === "draining" ||
      source.desiredStatus === "retired")
  );
}

interface RuntimeQueryDoc {
  id: string;
  data(): unknown;
}

function collectDurableRuntimeRoots(docs: ReadonlyArray<RuntimeQueryDoc>): {
  gateways: GatewayRuntimeRoot[];
  invalidRootIds: string[];
} {
  const gateways: GatewayRuntimeRoot[] = [];
  const invalidRootIds: string[] = [];
  for (const doc of docs) {
    const data = doc.data();
    if (isDurableRootConfigDoc(data, doc.id)) {
      gateways.push(data);
    } else {
      invalidRootIds.push(doc.id);
    }
  }
  return { gateways, invalidRootIds };
}

function legacyBackfillSourceOwners(
  gateways: readonly GatewayRuntimeRoot[],
): Map<string, string | null> {
  const owners = new Map<string, string | null>();
  for (const gateway of gateways) {
    if (!isGatewayLegacyBackfill(gateway.legacyBackfill)) continue;
    for (const sourceId of gateway.legacyBackfill.sourceGlmGatewayIds) {
      const owner = owners.get(sourceId);
      owners.set(sourceId, owner === undefined ? gateway.gatewayId : null);
    }
  }
  return owners;
}

function classifyDurableRuntimeGlmDocs(
  docs: ReadonlyArray<RuntimeQueryDoc>,
  gateways: readonly GatewayRuntimeRoot[],
): {
  revisions: RevisionRealizationDoc[];
  legacyBackfillGatewayIds: string[];
  missingLegacyBackfillSourceIds: string[];
  legacyGlmDocIds: string[];
  unsafeRevisionIds: string[];
} {
  const revisions: RevisionRealizationDoc[] = [];
  const bridgeGateways = gateways.filter((gateway) =>
    isGatewayLegacyBackfill(gateway.legacyBackfill),
  );
  const legacyGlmDocIds: string[] = [];
  const unsafeRevisionIds: string[] = [];
  const recognizedLegacyBackfillSourceIds = new Set<string>();
  const gatewaysById = new Map(gateways.map((gateway) => [gateway.gatewayId, gateway]));
  const legacySourceOwners = legacyBackfillSourceOwners(bridgeGateways);
  for (const doc of docs) {
    const data = doc.data();
    if (isRevisionRealizationDoc(data)) {
      revisions.push(data);
      const canonical =
        doc.id === data.revisionId &&
        gatewaysById.has(data.gateway) &&
        data.revisionId === revisionIdForRelease(data.gateway, data.release);
      if (data.lifecycle !== "retired" && !canonical) unsafeRevisionIds.push(doc.id);
      continue;
    }
    const owner = legacySourceOwners.get(doc.id);
    if (owner !== undefined && owner !== null && isLegacyBackfillSource(data, doc.id, owner)) {
      recognizedLegacyBackfillSourceIds.add(doc.id);
    } else {
      legacyGlmDocIds.push(doc.id);
    }
  }
  const missingLegacyBackfillSourceIds = bridgeGateways.flatMap((gateway) => {
    const bridge = gateway.legacyBackfill;
    if (!isGatewayLegacyBackfill(bridge)) return [];
    return bridge.sourceGlmGatewayIds
      .filter((sourceId) => !recognizedLegacyBackfillSourceIds.has(sourceId))
      .map((sourceId) => `${gateway.gatewayId}/${sourceId}`);
  });
  return {
    revisions,
    legacyBackfillGatewayIds: bridgeGateways.map((gateway) => gateway.gatewayId).sort(),
    missingLegacyBackfillSourceIds: missingLegacyBackfillSourceIds.sort(),
    legacyGlmDocIds,
    unsafeRevisionIds,
  };
}

async function readDurableRuntimeGateways(db: Firestore): Promise<DurableRuntimeState> {
  const [rootSnap, glmSnap] = await Promise.all([
    db.collection(GATEWAYS_COLLECTION).get(),
    db.collection(GLM_GATEWAYS_COLLECTION).get(),
  ]);
  const roots = collectDurableRuntimeRoots(rootSnap.docs);
  const glm = classifyDurableRuntimeGlmDocs(glmSnap.docs, roots.gateways);
  return {
    ...roots,
    ...glm,
  };
}

function assertDurableRuntimeState(
  state: DurableRuntimeState,
  allowLegacyBackfill = false,
): void {
  if (state.invalidRootIds.length > 0) {
    throw new Error(
      `invalid durable root document(s): ${state.invalidRootIds.slice().sort().join(", ")}; refusing fleet mutation`,
    );
  }
  if (state.missingLegacyBackfillSourceIds.length > 0) {
    throw new Error(
      `legacy backfill bridge source document(s) missing or invalid: ${state.missingLegacyBackfillSourceIds.join(", ")}; refusing fleet mutation`,
    );
  }
  if (state.legacyGlmDocIds.length > 0) {
    throw new Error(
      `legacy glmGateway document(s): ${state.legacyGlmDocIds.slice().sort().join(", ")}; refusing fleet mutation until compaction`,
    );
  }
  if (!allowLegacyBackfill && state.legacyBackfillGatewayIds.length > 0) {
    throw new Error(
      `legacy backfill bridge active for gateway(s): ${state.legacyBackfillGatewayIds.join(", ")}; refusing normal fleet mutation until guarded compaction`,
    );
  }
  if (state.unsafeRevisionIds.length > 0) {
    throw new Error(
      `non-retired revision(s) without a valid durable root: ${state.unsafeRevisionIds.slice().sort().join(", ")}; refusing fleet mutation`,
    );
  }
}

function exactRuntimeRevision(
  gateway: GatewayRuntimeRoot,
  revision: RevisionRealizationDoc | undefined,
): RevisionRealizationDoc {
  const revisionId = gateway.liveRevisionId;
  if (!revisionId || gateway.liveRelease === null || !revision) {
    throw new Error(`gateway ${gateway.gatewayId} has no exact live serving revision`);
  }
  if (
    revision.gateway !== gateway.gatewayId ||
    revision.revisionId !== revisionId ||
    revision.revisionId !== revisionIdForRelease(gateway.gatewayId, revision.release) ||
    revision.release !== gateway.liveRelease ||
    revision.lifecycle !== "serving"
  ) {
    throw new Error(`gateway ${gateway.gatewayId} has an invalid live revision ${revisionId}`);
  }
  return revision;
}

async function readDurableServingFleetGateways(db: Firestore): Promise<FleetGateway[]> {
  const state = await readDurableRuntimeGateways(db);
  assertDurableRuntimeState(state);
  const revisions = new Map(state.revisions.map((revision) => [revision.revisionId, revision]));
  const serving: FleetGateway[] = [];
  for (const gateway of state.gateways) {
    if (gateway.desiredStatus === "retired" || gateway.liveRevisionId === null) continue;
    exactRuntimeRevision(gateway, revisions.get(gateway.liveRevisionId));
    serving.push({ gatewayId: gateway.gatewayId });
  }
  return serving;
}

async function readDurableRevisionArtifacts(
  db: Firestore,
  state: DurableRuntimeState,
): Promise<Array<{ imageRepository: string; imageTag: string }>> {
  const gateways = new Map(state.gateways.map((gateway) => [gateway.gatewayId, gateway]));
  const artifacts: Array<{ imageRepository: string; imageTag: string }> = [];
  for (const revision of state.revisions) {
    if (revision.lifecycle === "retired") continue;
    const gateway = gateways.get(revision.gateway);
    if (
      !gateway ||
      revision.revisionId !== revisionIdForRelease(revision.gateway, revision.release)
    ) {
      throw new Error(`revision ${revision.revisionId} has no valid durable gateway identity`);
    }
    const artifact = await readGatewayArtifact(db, revision.gateway, revision.release);
    if (!artifact) {
      throw new Error(`revision ${revision.revisionId} has no valid release artifact`);
    }
    artifacts.push({ imageRepository: artifact.imageRepository, imageTag: artifact.imageTag });
    // The chart always renders the gateway-edge sidecar (tag defaults to the
    // gateway imageTag), so its image must be pinned even when the release
    // payload carries no explicit gatewayEdgeImage.
    const gatewayEdgeImage = artifact.gatewayEdgeImage ?? {
      imageRepository: W9_GATEWAY_EDGE_IMAGE_REPOSITORY,
      imageTag: artifact.imageTag,
    };
    artifacts.push({
      imageRepository: gatewayEdgeImage.imageRepository,
      imageTag: gatewayEdgeImage.imageTag,
    });
  }
  return artifacts;
}

async function syncDurableImagePins(
  deps: ControllerDeps,
  state: DurableRuntimeState,
): Promise<void> {
  if (!deps.reconcileImagePins) return;
  let artifacts: Array<{ imageRepository: string; imageTag: string }>;
  try {
    artifacts = await readDurableRevisionArtifacts(deps.db, state);
  } catch (err) {
    deps.log(
      `[image-pins] ⚠ preserved existing pins: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  try {
    await deps.reconcileImagePins(PIN_ENV, artifacts, deps.log);
  } catch (err) {
    deps.log(`[image-pins] ⚠ reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function syncDurableRuntimeDependencies(
  deps: ControllerDeps,
  gateways: readonly GatewayRuntimeRoot[],
): Promise<void> {
  await syncGatewayModelKeySources(deps, gateways);
  const changedModelKeyGateways = await syncGatewayModelKeySecrets(deps, gateways);
  await restartGatewayDeploymentsForModelKeyChanges(deps, gateways, changedModelKeyGateways);
}

async function convergeEmptyIfConfigured(
  deps: ControllerDeps,
  gatewayIds?: readonly string[],
): Promise<void> {
  if (!deps.convergeEmpty) return;
  try {
    if (gatewayIds) {
      await deps.convergeEmpty(gatewayIds);
    } else {
      await deps.convergeEmpty();
    }
  } catch (err) {
    deps.log(`[converge-empty] ⚠ pass failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function reconcileOnce(deps: ControllerDeps): Promise<void> {
  if (await controllerWorkFrozen(deps, "reconcile")) return;
  const runtime = await readDurableRuntimeGateways(deps.db);
  assertDurableRuntimeState(runtime, true);
  if (runtime.legacyBackfillGatewayIds.length > 0) {
    deps.log(
      `[legacy-backfill] materializing canonical revisions for ${runtime.legacyBackfillGatewayIds.join(", ")}; normal fleet mutations remain held until guarded compaction`,
    );
    const bridgeGatewayIds = new Set(runtime.legacyBackfillGatewayIds);
    const bridgeGateways = runtime.gateways.filter((gateway) =>
      bridgeGatewayIds.has(gateway.gatewayId),
    );
    await syncDurableRuntimeDependencies(deps, bridgeGateways);
    await convergeEmptyIfConfigured(deps, runtime.legacyBackfillGatewayIds);
    return;
  }
  await syncDurableImagePins(deps, runtime);
  await syncDurableRuntimeDependencies(deps, runtime.gateways);
  await convergeEmptyIfConfigured(deps);
  // The roll arm derives from the same desired docs; after convergeEmpty so a
  // fresh gateway lands its first revision before any roll is considered.
  if (deps.convergeRoll) {
    try {
      await deps.convergeRoll();
    } catch (err) {
      deps.log(`[converge-roll] ⚠ pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await syncFleetIngressIfConfigured(deps);
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

function durableRootRenderFingerprint(
  gatewayId: string,
  data: Record<string, unknown>,
): string {
  if (!isDurableRootConfigDoc(data, gatewayId)) {
    return `invalid:${reconcileFingerprintStableStringify(data)}`;
  }
  return `valid:${reconcileFingerprintStableStringify({
    desiredStatus: data.desiredStatus,
    desiredRelease: data.desiredRelease,
    legacyBackfill: data.legacyBackfill,
    configSchemaVersion: data.configSchemaVersion,
    profile: data.profile,
    gatewayClass: data.gatewayClass,
    imageProfile: data.imageProfile,
    sizingTier: data.sizingTier,
    computeClass: data.computeClass,
    gcpProject: data.gcpProject,
    gatewayContainerSecurityContext: data.gatewayContainerSecurityContext,
    serviceAccountName: data.serviceAccountName,
    serviceAccount: data.serviceAccount,
    operatorAccess: data.operatorAccess,
    ownerUid: data.ownerUid,
    coOwnerUids: data.coOwnerUids,
    builderSlug: data.builderSlug,
    openclawOverrides: data.openclawOverrides,
    modelBrokerLimits: data.modelBrokerLimits,
    preemption: data.preemption,
  })}`;
}

export interface DurableRootRenderSnapshotChanges {
  shouldSchedule: boolean;
  gatewayIds: string[];
}

export function durableRootRenderSnapshotChanges(
  changes: ReadonlyArray<ReconcileSnapshotDocChange>,
  fingerprints: Map<string, string>,
): DurableRootRenderSnapshotChanges {
  let shouldSchedule = false;
  const gatewayIds = new Set<string>();
  for (const change of changes) {
    if (change.type === "removed") {
      fingerprints.delete(change.doc.id);
      shouldSchedule = true;
      continue;
    }
    const fingerprint = durableRootRenderFingerprint(change.doc.id, change.doc.data());
    if (fingerprints.get(change.doc.id) !== fingerprint) {
      shouldSchedule = true;
      gatewayIds.add(change.doc.id);
    }
    fingerprints.set(change.doc.id, fingerprint);
  }
  return { shouldSchedule, gatewayIds: [...gatewayIds].sort(compareFingerprintKeys) };
}

export function snapshotHasDurableRootRenderChange(
  changes: ReadonlyArray<ReconcileSnapshotDocChange>,
  fingerprints: Map<string, string>,
): boolean {
  return durableRootRenderSnapshotChanges(changes, fingerprints).shouldSchedule;
}

export function startReconciler(deps: ControllerDeps): () => void {
  let debounceTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let pendingTick = false;
  let stopped = false;
  const retryMs = deps.reconcileRetryMs ?? RECONCILE_RETRY_MS_DEFAULT;
  const durableRootDirty = new DurableRootDirtyTracker();

  const scheduleRetryTick = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => void tick(), retryMs);
  };

  const scheduleDebouncedTick = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void tick(), RECONCILE_DEBOUNCE_MS);
  };
  requestReconcileTickRef.fire = scheduleDebouncedTick;

  const renderDirtyDurableRoots = async () => {
    if (!deps.renderDurableRootConfigs) return;
    const request = durableRootDirty.take();
    if (!request) return;
    if (await controllerWorkFrozen(deps, "durable root render")) {
      durableRootDirty.markAllDirty();
      scheduleRetryTick();
      return;
    }
    try {
      if (await legacyBackfillRecoveryActive(deps.db)) {
        durableRootDirty.markAllDirty();
        return;
      }
    } catch (err) {
      durableRootDirty.markAllDirty();
      deps.log(
        `[durable-root-render] legacy backfill recovery gate read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      scheduleRetryTick();
      return;
    }
    try {
      const result = await deps.renderDurableRootConfigs(request);
      durableRootDirty.retry(result.failedGatewayIds);
      if (result.failedGatewayIds.length > 0) scheduleRetryTick();
    } catch (err) {
      if (request.all) {
        durableRootDirty.markAllDirty();
      } else {
        durableRootDirty.retry(request.gatewayIds);
      }
      deps.log(
        `[durable-root-render] ⚠ pass failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      scheduleRetryTick();
    }
  };

  const tick = async () => {
    if (inFlight) {
      pendingTick = true;
      return;
    }
    debounceTimer = clearTimer(debounceTimer);
    retryTimer = clearTimer(retryTimer);
    inFlight = true;
    await renderDirtyDurableRoots();
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
      scheduleRetryTick();
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
  const rootFingerprints = new Map<string, string>();
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

  const rootUnsub = deps.renderDurableRootConfigs
    ? deps.db.collection(GATEWAYS_COLLECTION).onSnapshot(
        (snap?: { docChanges?: () => ReconcileSnapshotDocChange[] }) => {
          if (stopped) return;
          const changes = snap?.docChanges?.();
          if (!changes) {
            durableRootDirty.markAllDirty();
            scheduleDebouncedTick();
            return;
          }
          const rootChanges = durableRootRenderSnapshotChanges(changes, rootFingerprints);
          if (rootChanges.shouldSchedule) {
            for (const gatewayId of rootChanges.gatewayIds) {
              durableRootDirty.markGatewayDirty(gatewayId);
            }
            scheduleDebouncedTick();
          }
        },
        (err) => {
          durableRootDirty.markAllDirty();
          deps.log(`[durable-root-render] ⚠ gateways snapshot error: ${String(err)}`);
          scheduleDebouncedTick();
        },
      )
    : undefined;

  if (deps.operatorReadyRefreshMs && deps.operatorReadyRefreshMs > 0) {
    refreshTimer = setInterval(() => void tick(), deps.operatorReadyRefreshMs);
  }

  return () => {
    stopped = true;
    unsub();
    rootUnsub?.();
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
  const persisted = await deps.db.runTransaction(async (txn) => {
    const fresh = await txn.get(ref);
    if (!fresh.exists) return false;
    const status = (fresh.data() as Operation | undefined)?.status ?? "missing";
    if (!shouldPersistClaimedOperationCompletion(status)) return false;
    txn.update(ref, completion);
    return true;
  });
  if (!persisted) {
    deps.log(`[glm-controller] op=${op.id} completion discarded because the operation was cancelled`);
    return;
  }

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

function buildHeartbeatPollerCoreDeps(
  db: Firestore,
  log: (msg: string) => void,
  listGatewayIds: () => Promise<string[]>,
): Omit<OperatorHeartbeatPollerDeps, "evictSlug"> {
  return {
    listGatewayIds,
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
      if (!target) return [];
      return readAssignedSlugsForGateway(db, target.gatewayId, {
        revisionId: target.revisionId,
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
    log,
  };
}

export function buildOperatorHeartbeatPollerDeps(
  db: Firestore,
  log: (msg: string) => void,
  privateKey: string,
): OperatorHeartbeatPollerDeps {
  return {
    ...buildHeartbeatPollerCoreDeps(db, log, async () => {
      const snap = await db.collection(GLM_GATEWAYS_COLLECTION).get();
      return heartbeatPollInstanceIds(snap.docs);
    }),
    evictSlug: async (gatewayId: string, slug: string) => {
      const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      const revision = snap.exists ? snap.data() : undefined;
      if (
        !isRevisionRealizationDoc(revision) ||
        revision.revisionId !== gatewayId ||
        gatewayId !== revisionIdForRelease(revision.gateway, revision.release)
      ) {
        return;
      }
      await callUnmountRpc(db, {
        privateKey,
        gatewayId: revision.gateway,
        revisionId: revision.revisionId,
        slug,
        log,
        tag: "evict",
      });
    },
  };
}

interface HeartbeatPollDocLike {
  id: string;
  data(): Record<string, unknown> | undefined;
}

export function heartbeatPollInstanceIds(docs: HeartbeatPollDocLike[]): string[] {
  const ids: string[] = [];
  for (const doc of docs) {
    const data = doc.data() ?? {};
    if (
      isRevisionRealizationDoc(data) &&
      doc.id === data.revisionId &&
      data.revisionId === revisionIdForRelease(data.gateway, data.release) &&
      data.lifecycle !== "retired" &&
      data.lifecycle !== "failed"
    ) {
      ids.push(data.revisionId);
    }
  }
  return ids;
}

export function legacyBackfillRecoveryHeartbeatInstanceIds(
  roots: HeartbeatPollDocLike[],
  runtimeDocs: HeartbeatPollDocLike[],
): string[] {
  const bridgeRevisionIds = new Set<string>();
  for (const rootDoc of roots) {
    const root = rootDoc.data();
    if (
      !isGatewayDesiredDoc(root) ||
      root.gatewayId !== rootDoc.id ||
      root.desiredStatus !== "running" ||
      !isGatewayLegacyBackfill(root.legacyBackfill)
    ) {
      continue;
    }
    bridgeRevisionIds.add(revisionIdForRelease(root.gatewayId, root.desiredRelease));
  }
  return heartbeatPollInstanceIds(runtimeDocs).filter((revisionId) =>
    bridgeRevisionIds.has(revisionId),
  );
}

export function buildLegacyBackfillRecoveryHeartbeatPollerDeps(
  db: Firestore,
  log: (msg: string) => void,
): OperatorHeartbeatPollerDeps {
  return buildHeartbeatPollerCoreDeps(db, log, async () => {
    const [roots, runtime] = await Promise.all([
      db.collection(GATEWAYS_COLLECTION).get(),
      db.collection(GLM_GATEWAYS_COLLECTION).get(),
    ]);
    return legacyBackfillRecoveryHeartbeatInstanceIds(roots.docs, runtime.docs);
  });
}

export function startLegacyBackfillRecoveryHeartbeatPoller(
  db: Firestore,
  log: (msg: string) => void,
): ControllerStopper {
  return startOperatorHeartbeatPoller(
    buildLegacyBackfillRecoveryHeartbeatPollerDeps(db, log),
    OPERATOR_HEARTBEAT_POLL_MS,
  );
}

export function heartbeatRosterTarget(
  instanceId: string,
  data: Record<string, unknown> | undefined,
): { gatewayId: string; revisionId: string } | null {
  if (
    isRevisionRealizationDoc(data) &&
    data.revisionId === instanceId &&
    instanceId === revisionIdForRelease(data.gateway, data.release)
  ) {
    return { gatewayId: data.gateway, revisionId: data.revisionId };
  }
  return null;
}

type ControllerStopper = () => void;

export interface LegacyBackfillRecoveryTaskStarters {
  startReconciler: () => ControllerStopper;
  startHeartbeatPoller: () => ControllerStopper;
  startHttp: () => ControllerStopper;
  stopRecoveryWatcher: ControllerStopper;
  startRestartWatcher: () => ControllerStopper;
}

export function startLegacyBackfillRecoveryTasks(
  starters: LegacyBackfillRecoveryTaskStarters,
): ControllerStopper[] {
  return [
    starters.startReconciler(),
    starters.startHeartbeatPoller(),
    starters.startHttp(),
    starters.stopRecoveryWatcher,
    starters.startRestartWatcher(),
  ];
}

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
    isRecoverableRevision: (revisionId) => isRecoverableHelmRevision(db, revisionId),
    recover: (revisionId) => helm.recoverRelease({ namespace: NAMESPACE, gatewayId: revisionId }),
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

function holdLegacyBackfillRecoveryController(
  deps: ControllerDeps,
  db: Firestore,
  maintenanceGate: ControllerMaintenanceGate,
  log: (msg: string) => void,
): void {
  let stopped = false;
  let checking = false;
  const checkForCompletion = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      if (!await legacyBackfillRecoveryActive(db)) {
        log("[glm-controller] guarded legacy backfill compaction completed; restarting into normal controller mode");
        process.exit(0);
      }
    } catch (err) {
      log(
        `[glm-controller] legacy backfill recovery gate read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      checking = false;
    }
  };
  const recoveryTimer = setInterval(() => void checkForCompletion(), MAINTENANCE_GATE_POLL_MS);
  const stopRecoveryWatcher = () => {
    stopped = true;
    clearInterval(recoveryTimer);
  };
  const shutdown = createControllerShutdown(
    startLegacyBackfillRecoveryTasks({
      startReconciler: () => startReconciler(deps),
      startHeartbeatPoller: () => startLegacyBackfillRecoveryHeartbeatPoller(db, log),
      startHttp: () => startMaintenanceHttpServer({ port: HTTP_PORT, log }),
      stopRecoveryWatcher,
      startRestartWatcher: () =>
        startMaintenanceRestartWatcher({
          gate: maintenanceGate,
          log,
          restart: () => {
            log("[glm-controller] maintenance freeze observed during legacy backfill recovery; exiting fail-closed");
            process.exit(0);
          },
          restartWhenFrozen: true,
          intervalMs: MAINTENANCE_GATE_POLL_MS,
        }),
    }),
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
  const gatewayAliasServiceEnsurer = createGatewayAliasServiceEnsurer({
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
  const prepareGatewayConfig =
    createGatewayRuntimeConfigPreparer(resolveApiServerEgressCidrs);

  const handlerSyncFleetIngress = async () => {
    await syncEdgeIngressForGateways(await readDurableServingFleetGateways(db));
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

  const convergeEmpty = (gatewayIds?: readonly string[]) =>
    runConvergeEmptyPass(
      buildConvergeEmptyDeps({
        db,
        helm,
        kubeOps,
        gatewayAliasServiceEnsurer,
        chartFingerprint,
        prepareGatewayConfig,
        log,
      }, gatewayIds),
    );

  const convergeRoll = () =>
    runRollPass(
      buildRollPassDeps({
        db,
        privateKey: fleetControllerPrivateKey,
        helm,
        kubeOps,
        gatewayAliasServiceEnsurer,
        chartFingerprint,
        prepareGatewayConfig,
        log,
      }),
    );

  const durableRootRenderDeps = buildDurableRootRenderDeps({
    db,
    helm,
    chartFingerprint,
    prepareGatewayConfig,
    log,
  });
  const renderDurableRootConfigs = (request: DurableRootRenderRequest) =>
    runDurableRootRenderPass(durableRootRenderDeps, request);

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
    convergeEmpty,
    convergeRoll,
    renderDurableRootConfigs,
    operatorReadyRefreshMs: OPERATOR_READY_REFRESH_MS_DEFAULT,
    chartFingerprint,
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

  if (await legacyBackfillRecoveryActive(db)) {
    log("[glm-controller] explicit legacy backfill bridge detected; starting recovery-only controller mode");
    holdLegacyBackfillRecoveryController(deps, db, maintenanceGate, log);
    return;
  }

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
  deps.log("[glm-controller] legacy Helm bootstrap disabled; durable roots and revisions own recovery");
}

export async function bootstrapDefaultGateway(deps: ControllerDeps): Promise<void> {
  if (await controllerWorkFrozen(deps, "default gateway bootstrap")) return;
  deps.log("[glm-controller] legacy default gateway bootstrap disabled; create a durable root explicitly");
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

function protocolV2PromotionMatchesFence(
  configRoll: GatewayRollSystemConfigState | null | undefined,
  fence: MigrationRollFence,
): boolean {
  if (!configRoll) return false;
  return [
    configRoll.phase === "promoted",
    configRoll.migrationId === `roll-config-${fence.rollOperationId}`,
    configRoll.sourceRevisionId === fence.sourceRevisionId,
    configRoll.targetRevisionId === fence.targetRevisionId,
    configRoll.freezeRef === `refs/octogee/system-config/freeze/${fence.sourceRevisionId}`,
    /^[0-9a-f]{40}$/.test(configRoll.freezeObject),
    /^[0-9a-f]{40}$/.test(configRoll.checkpointCommit),
    /^[0-9a-f]{64}$/.test(configRoll.configHash),
    configRoll.candidateRef ===
      `refs/octogee/system-config/candidate/${fence.targetRevisionId}`,
    typeof configRoll.candidateCommit === "string" &&
      /^[0-9a-f]{40}$/.test(configRoll.candidateCommit),
    typeof configRoll.candidateHash === "string" &&
      /^[0-9a-f]{64}$/.test(configRoll.candidateHash),
    typeof configRoll.runtimeConfigHash === "string" &&
      /^[0-9a-f]{64}$/.test(configRoll.runtimeConfigHash),
    configRoll.observedRevisionId === fence.targetRevisionId,
    typeof configRoll.targetStartedAt === "number",
    typeof configRoll.imageTag === "string" && configRoll.imageTag.length > 0,
    typeof configRoll.buildSha === "string" && configRoll.buildSha.length > 0,
    typeof configRoll.openclawVersion === "string" && configRoll.openclawVersion.length > 0,
    typeof configRoll.provenAt === "number",
    configRoll.promotedCommit === configRoll.candidateCommit,
    typeof configRoll.promotedAt === "number" &&
      typeof configRoll.provenAt === "number" &&
      configRoll.promotedAt >= configRoll.provenAt,
  ].every(Boolean);
}

function assertCurrentMigrationRollFence(
  rootValue: unknown,
  assignment: AssignmentDoc | null,
  fence: MigrationRollFence,
): void {
  if (!isDurableRootConfigDoc(rootValue, fence.gatewayId)) {
    throw new Error("stale release-roll fence: gateway root unavailable");
  }
  const roll = rootValue.roll;
  const protocolV2Roll = roll?.systemConfigRoll !== undefined;
  if (
    (!protocolV2Roll && rootValue.desiredRelease !== fence.targetRelease) ||
    roll?.operationId !== fence.rollOperationId ||
    roll.targetRevisionId !== fence.targetRevisionId ||
    roll.toRelease !== fence.targetRelease
  ) {
    throw new Error("stale release-roll fence: roll target changed");
  }
  if (protocolV2Roll) {
    const configRoll = roll.systemConfigRoll;
    if (!protocolV2PromotionMatchesFence(configRoll, fence)) {
      throw new Error("stale release-roll fence: protocol-v2 candidate is not durably promoted");
    }
  }
  if (fence.sourceConfigCheckpoint) {
    const checkpoint = roll.systemConfigCheckpoint;
    if (
      checkpoint?.migrationId !== fence.sourceConfigCheckpoint.migrationId ||
      checkpoint.checkpointCommit !== fence.sourceConfigCheckpoint.checkpointCommit ||
      checkpoint.configHash !== fence.sourceConfigCheckpoint.configHash ||
      checkpoint.sourceUnfrozenAt !== null
    ) {
      throw new Error("stale release-roll fence: source config checkpoint changed");
    }
  }
  const sourceAssignmentIsCurrent =
    assignment?.revisionId === fence.sourceRevisionId &&
    assignment.epoch === fence.sourceEpoch;
  const sourceIsUnassignedLiveRevision =
    assignment === null &&
    fence.sourceEpoch === 0 &&
    rootValue.liveRevisionId === fence.sourceRevisionId;
  if (!sourceAssignmentIsCurrent && !sourceIsUnassignedLiveRevision) {
    throw new Error("stale release-roll fence: source assignment epoch changed");
  }
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
  if (!userSnap.exists || !data) return null;
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

async function readRevisionForConfigProtocol(
  db: Firestore,
  revisionId: string,
): Promise<RevisionRealizationDoc | null> {
  const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
  const value = snap.exists ? snap.data() : undefined;
  return isRevisionRealizationDoc(value) && value.revisionId === revisionId ? value : null;
}

async function assertFleetConfigProtocolForMigration(
  db: Firestore,
  input: {
    mode: import("@octogee/shared/types/fleet-controller").SystemConfigMigrationMode;
    sourceRevisionId: string;
    targetRevisionId: string;
  },
): Promise<void> {
  if (input.mode === "none") return;
  const rootsSnap = await db.collection(GATEWAYS_COLLECTION).get();
  const roots = rootsSnap.docs.flatMap((doc) => {
    const value = doc.data();
    return isDurableRootConfigDoc(value, doc.id) ? [value] : [];
  });
  const revisionIds = new Set<string>([input.sourceRevisionId, input.targetRevisionId]);
  for (const root of roots) {
    if (root.liveRevisionId) revisionIds.add(root.liveRevisionId);
  }
  const entries = await Promise.all([...revisionIds].map(async (revisionId) => [
    revisionId,
    await readRevisionForConfigProtocol(db, revisionId),
  ] as const));
  const revisions = new Map(entries.filter(
    (entry): entry is readonly [string, RevisionRealizationDoc] => entry[1] !== null,
  ));
  const now = Date.now();
  assertMigrationSystemConfigProtocol({
    mode: input.mode,
    sourceRevisionId: input.sourceRevisionId,
    sourceRevision: revisions.get(input.sourceRevisionId) ?? null,
    targetRevisionId: input.targetRevisionId,
    targetRevision: revisions.get(input.targetRevisionId) ?? null,
    fleetGaps: servingIsolatedProtocolGaps(roots, revisions, now),
    now,
  });
}

async function isFleetConfigProtocolReady(db: Firestore): Promise<boolean> {
  const rootsSnap = await db.collection(GATEWAYS_COLLECTION).get();
  const roots = rootsSnap.docs.flatMap((doc) => {
    const value = doc.data();
    return isDurableRootConfigDoc(value, doc.id) ? [value] : [];
  });
  const liveRevisionIds = roots.flatMap((root) => root.liveRevisionId ? [root.liveRevisionId] : []);
  const entries = await Promise.all(liveRevisionIds.map(async (revisionId) => [
    revisionId,
    await readRevisionForConfigProtocol(db, revisionId),
  ] as const));
  const revisions = new Map(entries.filter(
    (entry): entry is readonly [string, RevisionRealizationDoc] => entry[1] !== null,
  ));
  return servingIsolatedProtocolGaps(roots, revisions, Date.now()).length === 0;
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
    resolveGatewayRevision: (gatewayId) =>
      readDurableGatewayRevision(db, gatewayId, "desired"),
    readGatewayHeartbeat: (revisionId) =>
      readGatewayHeartbeatFromFirestore(db, revisionId),
    publishGatewayReady: async ({ gatewayId, revisionId, imageTag }) => {
      await publishPlatformGatewayReady(db, {
        gatewayId,
        revisionId,
        imageTag,
        now: Date.now(),
      });
    },
    syncFleetIngress: fleetOps.syncFleetIngress,
    revisionMaterializationTimeoutMs: 120_000,
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
          ...(commit.rollFence
            ? {
                rollFence: {
                  operationId: commit.rollFence.rollOperationId,
                  targetRevisionId: commit.rollFence.targetRevisionId,
                  targetRelease: commit.rollFence.targetRelease,
                  sourceRevisionId: commit.rollFence.sourceRevisionId,
                  sourceEpoch: commit.rollFence.sourceEpoch,
                  ...(commit.rollFence.sourceConfigCheckpoint
                    ? { sourceConfigCheckpoint: commit.rollFence.sourceConfigCheckpoint }
                    : {}),
                  ...(commit.rollFence.configReady
                    ? { configReady: commit.rollFence.configReady }
                    : {}),
                },
              }
            : {}),
        },
      );
    },
    resolveGatewayUrl: (transportId) => resolveGatewayUrlFromFirestore(db, transportId),
    buildClient: createMigrationClientBuilder(
      db,
      privateKey,
      logFn,
    ),
    resolveFromRevision: (uid, currentGatewayId) =>
      resolveSourceRevisionFromFirestore(db, uid, currentGatewayId),
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
    assertRollFence: async (fence) => {
      const [rootSnap, assignment] = await Promise.all([
        db.collection(GATEWAYS_COLLECTION).doc(fence.gatewayId).get(),
        readAssignmentDoc(db, fence.gatewayId, fence.uid),
      ]);
      assertCurrentMigrationRollFence(rootSnap.data(), assignment, fence);
    },
    recordConfigProof: async (targetRevisionId, proof, rollFence) => {
      if (!rollFence) {
        await db
          .collection(GLM_GATEWAYS_COLLECTION)
          .doc(targetRevisionId)
          .set({ systemConfig: proof }, { merge: true });
        return;
      }
      await db.runTransaction(async (txn) => {
        const rootRef = db.collection(GATEWAYS_COLLECTION).doc(rollFence.gatewayId);
        const assignmentRef = rootRef
          .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
          .doc(rollFence.uid);
        const [rootSnap, assignmentSnap] = await Promise.all([
          txn.get(rootRef),
          txn.get(assignmentRef),
        ]);
        const assignment = assignmentSnap.exists
          ? parseAssignmentDoc(rollFence.uid, assignmentSnap.data())
          : null;
        assertCurrentMigrationRollFence(rootSnap.data(), assignment, rollFence);
        txn.set(
          db.collection(GLM_GATEWAYS_COLLECTION).doc(targetRevisionId),
          { systemConfig: proof },
          { merge: true },
        );
      });
    },
    recordConfigRollMetric: recordConfigRoll,
    resolveSystemConfigMigrationMode: async (fromGatewayId, toGatewayId) => {
      const [source, target] = await Promise.all([
        db.collection(GATEWAYS_COLLECTION).doc(fromGatewayId).get(),
        db.collection(GATEWAYS_COLLECTION).doc(toGatewayId).get(),
      ]);
      const sourceData = source.data();
      const targetData = target.data();
      if (!isDurableRootConfigDoc(sourceData, fromGatewayId)) {
        throw new Error(`source gateway ${fromGatewayId} has no durable root`);
      }
      if (!isDurableRootConfigDoc(targetData, toGatewayId)) {
        throw new Error(`target gateway ${toGatewayId} has no durable root`);
      }
      const gatewayClass = (data: typeof sourceData) => resolveGatewayClass({
        gatewayClass: data.gatewayClass ?? undefined,
        profile: data.profile ?? undefined,
        imageProfile: data.imageProfile ?? undefined,
      });
      return systemConfigMigrationMode(
        gatewayClass(sourceData),
        gatewayClass(targetData),
      );
    },
    assertSystemConfigProtocolReady: ({ mode, sourceRevisionId, targetRevisionId }) =>
      assertFleetConfigProtocolForMigration(db, {
        mode,
        sourceRevisionId,
        targetRevisionId,
      }),
    recoverConfigFreezeOwner: async (input) => {
      if (!input.rollOperationId) {
        throw new Error("config freeze owner recovery requires a release-roll lease");
      }
      const ownerOpId = input.ownerMigrationId.startsWith("mig-")
        ? input.ownerMigrationId.slice(4)
        : "";
      const requesterOpId = input.requestedMigrationId.startsWith("mig-")
        ? input.requestedMigrationId.slice(4)
        : "";
      if (!ownerOpId || !requesterOpId) {
        throw new Error("config freeze recovery migration id is not operation-bound");
      }
      const [ownerSnap, requesterSnap, rootSnap] = await Promise.all([
        db.collection(GLM_OPERATIONS_COLLECTION).doc(ownerOpId).get(),
        db.collection(GLM_OPERATIONS_COLLECTION).doc(requesterOpId).get(),
        db.collection(GATEWAYS_COLLECTION).doc(input.sourceGatewayId).get(),
      ]);
      const owner = ownerSnap.exists
        ? ({ id: ownerSnap.id, ...ownerSnap.data() } as Operation)
        : null;
      assertRecoverableConfigFreezeOwner(input, owner);
      const requester = requesterSnap.exists ? requesterSnap.data() as Operation : null;
      if (
        !requester ||
        requester.status !== "running" ||
        requester.input?.uid !== input.uid ||
        requester.input?.builderSlug !== input.slug ||
        requester.input?.rollOperationId !== input.rollOperationId
      ) {
        throw new Error("config freeze requester no longer owns the active operation lease");
      }
      const root = rootSnap.data();
      if (
        !isDurableRootConfigDoc(root, input.sourceGatewayId) ||
        root.roll?.operationId !== input.rollOperationId ||
        root.roll.sourceRevisionId !== input.sourceTransportId ||
        root.roll.targetRevisionId !== input.targetTransportId
      ) {
        throw new Error("config freeze recovery roll lease is no longer current");
      }
      const sourceUrl = await resolveGatewayUrlFromFirestore(db, input.sourceTransportId);
      const client = createMigrationClient({
        privateKey,
        resolveGatewayUrl: () => sourceUrl,
        log: logFn,
      });
      await client.unfreezeConfig({
        migrationId: input.ownerMigrationId,
        gatewayId: input.sourceGatewayId,
        transportId: input.sourceTransportId,
        slug: input.slug,
      });
      return true;
    },
    genMigrationId: (operationId) => `mig-${operationId}`,
    now: () => Date.now(),
    log: logFn,
  });

  const retireRevisionDocByMerge = async (revisionId: string, reason: string): Promise<void> => {
    await db
      .collection(GLM_GATEWAYS_COLLECTION)
      .doc(revisionId)
      .set(
        { lifecycle: "retired", retiredAt: Date.now(), retireReason: reason },
        { merge: true },
      );
  };
  // Only a new-model revision doc carries the release/gateway needed to key a
  // tombstone; a legacy bare gateway has no /r/<n> addressing, so no-op.
  const writeRevisionTombstoneFromDoc = async (revisionId: string): Promise<void> => {
    const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
    const data = snap.data();
    if (!isRevisionRealizationDoc(data)) return;
    if (
      data.revisionId !== revisionId ||
      revisionId !== revisionIdForRelease(data.gateway, data.release)
    ) {
      throw new Error(`glmGateways/${revisionId} has an invalid revision identity`);
    }
    const gwSnap = await db.collection("gateways").doc(data.gateway).get();
    const gwData = gwSnap.exists ? gwSnap.data() : undefined;
    const live = isDurableRootConfigDoc(gwData, data.gateway)
      ? gwData.liveRevisionId ?? null
      : null;
    // Never point a retired revision at itself; a full gateway retire may still
    // list this revision as live.
    const currentRevisionId = live === revisionId ? null : live;
    await revisionTombstoneWriter.writeTombstone({
      gatewayId: data.gateway,
      revision: data.release,
      currentRevisionId,
    });
  };

  const retireRevision = createRetireRevisionHandler({
    readGatewayRoot: async (gatewayId) => {
      const rootSnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
      const root = rootSnap.exists ? rootSnap.data() : undefined;
      return isDurableRootConfigDoc(root, gatewayId) ? root : null;
    },
    readRevisionRealization: async (revisionId) => {
      const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
      const data = snap.exists ? snap.data() : undefined;
      if (!isRevisionRealizationDoc(data)) return null;
      return {
        revisionId: data.revisionId,
        gateway: data.gateway,
        release: data.release,
        lifecycle: data.lifecycle,
        mountedCustomers: readMountedCustomers(
          data as unknown as Record<string, unknown>,
          undefined,
        ),
      };
    },
    readAssignmentUidsOnRevision: async (gatewayId, revisionId) => {
      const assignments = await readAssignmentDocsForGateway(db, gatewayId);
      return assignments.filter((a) => a.revisionId === revisionId).map((a) => a.uid);
    },
    helmUninstallRevision: async (revisionId) => {
      await helm.removeInstance({ namespace: NAMESPACE, gatewayId: revisionId });
    },
    writeRevisionTombstone: writeRevisionTombstoneFromDoc,
    retireRevisionDoc: retireRevisionDocByMerge,
    log: logFn,
  });

  const retirementConfigFence = createRetirementConfigFenceManager({
    readGatewayContext: async (gatewayId) => {
      const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
      const root = snap.exists ? snap.data() : undefined;
      if (!isDurableRootConfigDoc(root, gatewayId)) {
        throw new Error(`gateway ${gatewayId} durable root is unavailable`);
      }
      if (root.gatewayClass === "shared") return { kind: "shared" as const };
      if (
        (root.gatewayClass !== "builder" && root.gatewayClass !== "operator") ||
        typeof root.builderSlug !== "string" ||
        root.builderSlug.length === 0 ||
        typeof root.liveRevisionId !== "string" ||
        root.liveRevisionId.length === 0
      ) {
        throw new Error(`gateway ${gatewayId} dedicated config identity is unavailable`);
      }
      return {
        kind: "dedicated" as const,
        slug: root.builderSlug,
        sourceRevisionId: root.liveRevisionId,
      };
    },
    freezeConfigV2: async (request) => {
      const sourceUrl = await resolveGatewayUrlFromFirestore(db, request.sourceRevisionId);
      const client = createMigrationClient({
        privateKey,
        resolveGatewayUrl: () => sourceUrl,
        log: logFn,
      });
      return client.freezeConfigV2({
        ...request,
        transportId: request.sourceRevisionId,
      });
    },
    bindCheckpoint: (input) =>
      bindGatewayRetirementConfigCheckpointAtomic({
        db,
        ...input,
        now: Date.now(),
        updatedBy: "cowboy-retire-gateway",
      }),
    verifyCheckpoint: (input) =>
      verifyGatewayRetirementConfigCheckpointAtomic({
        db,
        ...input,
        now: Date.now(),
      }),
    verifySharedClaim: ({ gatewayId, operationId, version }) =>
      verifyGatewayRetirementClaimAtomic({
        db,
        gatewayId,
        operationId,
        version,
        now: Date.now(),
        updatedBy: "cowboy-retire-gateway",
      }),
  });

  const retireGateway = createRetireGatewayHandler({
    attestRetirementClaim: ({ gatewayId, operationId, version }) =>
      attestGatewayRetirementAfterWakeAtomic({
        db,
        gatewayId,
        operationId,
        version,
        now: Date.now(),
        updatedBy: "cowboy-retire-gateway",
      }),
    acquireRetirementConfigFence: retirementConfigFence.acquire,
    verifyRetirementConfigFence: retirementConfigFence.verify,
    readAssignmentsForGateway: async (gatewayId) => {
      const assignments = await readAssignmentDocsForGateway(db, gatewayId);
      return assignments.map((a) => ({ uid: a.uid, slug: a.slug }));
    },
    readNonRetiredRevisions: async (gatewayId) => {
      const snap = await db
        .collection(GLM_GATEWAYS_COLLECTION)
        .where("gateway", "==", gatewayId)
        .get();
      const out: Array<{
        revisionId: string;
        release: number;
        mountedCustomers: string[];
      }> = [];
      for (const d of snap.docs) {
        const revision = readCanonicalRevisionForGatewayQuery(d, gatewayId);
        if (revision.lifecycle === "retired") continue;
        out.push({
          revisionId: revision.revisionId,
          release: revision.release,
          mountedCustomers: readMountedCustomers(
            revision as unknown as Record<string, unknown>,
            undefined,
          ),
        });
      }
      return out;
    },
    helmUninstallRevision: async (revisionId) => {
      await helm.removeInstance({ namespace: NAMESPACE, gatewayId: revisionId });
    },
    retireRevisionDoc: retireRevisionDocByMerge,
    writeRevisionTombstone: writeRevisionTombstoneFromDoc,
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
    deleteGatewayAliasServices: async (gatewayId) => {
      await kubeOps.deleteService({ namespace: NAMESPACE, name: gatewayEdgeServiceName(gatewayId) });
      await kubeOps.deleteService({ namespace: NAMESPACE, name: gatewayPodServiceName(gatewayId) });
    },
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
    pollIntervalMs: 5_000,
    retirementAttestationTimeoutMs: RETIREMENT_ATTESTATION_TIMEOUT_MS,
    now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logFn,
  });

  const rollout = createRolloutHandler({
    readGatewayDoc: async (gatewayId) => {
      const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
      if (!snap.exists) return null;
      return durableRolloutGateway(snap.data(), gatewayId);
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
    resolveLiveRevisionId: async (gatewayId) =>
      (await readDurableGatewayRevision(db, gatewayId, "serving"))?.revisionId ?? null,
    now: () => Date.now(),
    log: logFn,
  });

  const recycleGateway = createRecycleGatewayHandler({
    readDesiredStatus: async (gatewayId) => {
      const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
      const root = snap.exists ? snap.data() : undefined;
      return isDurableRootConfigDoc(root, gatewayId) ? root.desiredStatus : null;
    },
    setDesiredStatus: async (gatewayId, status) => {
      await guardedPatchGatewayRoot(
        db,
        gatewayId,
        { desiredStatus: status },
        {
          requireRunning: false,
          updatedAt: Date.now(),
          updatedBy: "cowboy-recycle-gateway",
        },
      );
    },
    readServingRevisionId: async (gatewayId) =>
      (await readDurableGatewayRevision(db, gatewayId, "serving"))?.revisionId ?? null,
    readAvailableReplicas: (revisionId) =>
      kubeOps.readAvailableReplicas({
        namespace: NAMESPACE,
        name: deploymentNameForInstance(revisionId),
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
    "retire-revision": retireRevision,
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
      resolveGatewayUnmountTarget: async (gatewayId) => {
        const target = await readDurableGatewayRevision(db, gatewayId, "serving");
        if (!target) return null;
        return {
          gatewayId: target.gatewayId,
          revisionId: target.revisionId,
          profile: target.profile,
        };
      },
      readAvailableReplicas: (revisionId) =>
        kubeOps.readAvailableReplicas({
          namespace: NAMESPACE,
          name: deploymentNameForInstance(revisionId),
        }),
      unmountRpc: ({ gatewayId, revisionId, slug }) =>
        callUnmountRpc(db, { privateKey, gatewayId, revisionId, slug, log: logFn }),
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
    revisionId: string;
    slug: string;
    log: (msg: string) => void;
    tag?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const {
    privateKey,
    gatewayId,
    revisionId,
    slug,
    log,
    tag = "deprov",
    timeoutMs = MIGRATION_UNMOUNT_TIMEOUT_MS,
  } = opts;

  const url = await resolveGatewayUrlFromFirestore(db, revisionId);
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
        `unmount timed out after ${timeoutMs}ms gatewayId=${gatewayId} revisionId=${revisionId} slug=${slug}`,
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
  log(`[${tag}] unmount RPC ok gatewayId=${gatewayId} revisionId=${revisionId} slug=${slug}`);
}

async function resolveGatewayUrlFromFirestore(
  db: Firestore,
  revisionId: string,
): Promise<string> {
  const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
  const revision = doc.exists ? doc.data() : undefined;
  if (
    !isRevisionRealizationDoc(revision) ||
    revision.revisionId !== revisionId ||
    revisionId !== revisionIdForRelease(revision.gateway, revision.release)
  ) {
    throw new Error(`revision not registered in glmGateways: ${revisionId}`);
  }
  return `http://octogee-gateway-${revisionId}.${NAMESPACE}.svc.cluster.local:${FLEET_CONTROLLER_PORT}`;
}

function revisionForGateway(input: {
  value: unknown;
  gatewayId: string;
  revisionId: string;
  release: number;
}): RevisionRealizationDoc | null {
  const { value, gatewayId, revisionId, release } = input;
  if (
    isRevisionRealizationDoc(value) &&
    value.revisionId === revisionId &&
    value.gateway === gatewayId &&
    value.release === release &&
    revisionId === revisionIdForRelease(gatewayId, release)
  ) {
    return value;
  }
  return null;
}

async function isServingRevisionForGateway(
  db: Firestore,
  gatewayId: string,
  revisionId: string,
  release: number,
): Promise<boolean> {
  const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId).get();
  const value = snap.exists ? snap.data() : undefined;
  return revisionForGateway({ value, gatewayId, revisionId, release })?.lifecycle === "serving";
}

export function durableRolloutGateway(
  value: unknown,
  gatewayId: string,
): GatewayDoc | null {
  return isDurableRootConfigDoc(value, gatewayId) ? value : null;
}

export async function resolvePlacementFromFirestore(
  db: Firestore,
  toGatewayId: string,
): Promise<PlacementResolution | null> {
  const snap = await db.collection(GATEWAYS_COLLECTION).doc(toGatewayId).get();
  if (!snap.exists) return null;
  const gateway = snap.data();
  if (!isDurableRootConfigDoc(gateway, toGatewayId)) return null;
  if (gateway.desiredStatus !== "running") {
    return { ok: false, reason: "revision-not-ready" };
  }
  const candidate =
    gateway.roll && gateway.roll.acceptingNewAssignments
      ? gateway.roll.targetRevisionId
      : gateway.liveRevisionId;
  const release =
    gateway.roll && gateway.roll.acceptingNewAssignments
      ? gateway.roll.toRelease
      : gateway.liveRelease;
  const ready =
    candidate && typeof release === "number"
      ? await isServingRevisionForGateway(db, toGatewayId, candidate, release)
      : false;
  return resolvePlacementRevision({
    gateway,
    isRevisionReady: (revisionId) => revisionId === candidate && ready,
  });
}

export async function resolveLiveRevisionAsSource(
  db: Firestore,
  gatewayId: string,
): Promise<{ revisionId: string; release: number; epoch?: number } | null> {
  const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  if (!snap.exists) return null;
  const gateway = snap.data();
  if (
    !isDurableRootConfigDoc(gateway, gatewayId) ||
    gateway.desiredStatus !== "running" ||
    !gateway.liveRevisionId ||
    typeof gateway.liveRelease !== "number"
  ) {
    return null;
  }
  const ready = await isServingRevisionForGateway(
    db,
    gatewayId,
    gateway.liveRevisionId,
    gateway.liveRelease,
  );
  return ready
    ? { revisionId: gateway.liveRevisionId, release: gateway.liveRelease }
    : null;
}

export async function resolveSourceRevisionFromFirestore(
  db: Firestore,
  uid: string,
  gatewayId: string,
): Promise<{ revisionId: string; release: number; epoch?: number } | null> {
  const assignment = await readAssignmentDoc(db, gatewayId, uid);
  if (!assignment) return resolveLiveRevisionAsSource(db, gatewayId);
  const rootSnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  const root = rootSnap.exists ? rootSnap.data() : undefined;
  if (
    !isDurableRootConfigDoc(root, gatewayId) ||
    root.desiredStatus !== "running" ||
    assignment.gatewayId !== gatewayId
  ) {
    return null;
  }
  const revisionSnap = await db
    .collection(GLM_GATEWAYS_COLLECTION)
    .doc(assignment.revisionId)
    .get();
  const revision = revisionForGateway({
    value: revisionSnap.exists ? revisionSnap.data() : undefined,
    gatewayId,
    revisionId: assignment.revisionId,
    release: assignment.release,
  });
  if (
    !revision ||
    (revision.lifecycle !== "serving" && revision.lifecycle !== "draining")
  ) {
    return null;
  }
  return {
    revisionId: assignment.revisionId,
    release: assignment.release,
    epoch: assignment.epoch,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
