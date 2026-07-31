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
  isOperatorManaged,
  isOperationAuditRow,
  operatorGatewayServiceAccountName,
  resolveOperationOrigin,
  resolveGatewayClass,
  isGatewayClass,
  isGatewayProfile,
  type HelmInstancesMap,
  type OperationAuditRecord,
  type Operation,
} from "@octogee/shared/types/glm";
import {
  GATEWAY_CONFIG_SCHEMA_VERSION,
  type GatewayMutableConfig,
} from "@octogee/shared/types/gateway-mutable-config";
import {
  gatewayHeartbeatMatchesImageTag,
  isGatewayImageTag,
} from "@octogee/shared/types/image-tag";
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
  type AuthSecretEnsurer,
} from "./auth-secret-ensurer.js";
import { createGatewayServiceAccountEnsurer } from "./gateway-service-account-ensurer.js";
import { resolveGatewayImageRepository } from "./gateway-profiles.js";
import {
  revisionHeartbeatMerge,
  readHeartbeatLiveness,
  readMountedCustomers,
  heartbeatTeardownAction,
  LEGACY_HEARTBEAT_FIELDS,
} from "./heartbeat-relocation.js";
import { createGatewayRuntimeConfigPreparer } from "./gateway-runtime-config.js";
import {
  isGatewayDesiredDoc,
  isGatewayEdgeImage,
  isGatewayRuntimeDoc,
  projectGatewayDesiredRootForGateway,
  GATEWAY_RELEASES_SUBCOLLECTION,
  type GatewayDoc,
  type GatewayCapacityRebalanceIntent,
  type GatewayRuntimeDoc,
  type ReleasePayload,
  type AssignmentState,
} from "@octogee/shared/types/gateway-releases";
import {
  cowboyMayMarkGatewayLive,
  cowboyMayMutateGateway,
  gatewayImageFor,
  gatewayReleaseAuthorizesChartDrift,
  gatewayUpsertOptsFromRelease,
  markLiveRuntimePatch,
  deploymentIntentFingerprintForComparison,
  planGatewayConvergence,
  provisioningRuntimeDoc,
  requiresSurgeCustomerMigration,
  type DurableGateway,
  type GatewayConvergenceAction,
  type GatewayUpsertOpts,
  type ObservedHelmInstance,
} from "./converge-gateway.js";
import {
  assertSurgeAssignmentCoverage,
  reconcileSurgeCustomerHandoff,
} from "./surge-customer-handoff.js";
import {
  createSurgePodTransport,
  listSurgePods,
  readPodDurableSessionDigest,
} from "./surge-customer-handoff-runtime.js";
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
  operationNeedsDurableRestartResume,
  shouldPersistClaimedOperationCompletion,
  verifiedDeletionCompletion,
} from "./operation-retry.js";
import { createAddGatewayHandler } from "./handlers/add-gateway.js";
import { createMigrateCustomerHandler } from "./handlers/migrate-customer.js";
import {
  verifyGatewayRetirementClaimAtomic,
} from "@octogee/core/gateway-retirement-claim";
import { createRetireGatewayHandler } from "./handlers/retire-gateway.js";
import { createGatewayServiceAccountTeardown } from "./lib/gateway-gsa.js";
import { createRestartGatewayHandler } from "./handlers/restart-gateway.js";
import { createRecycleGatewayHandler } from "./handlers/recycle-gateway.js";
import { createCapacityRebalanceGatewayHandler } from "./handlers/capacity-rebalance-gateway.js";
import {
  createRolloutHandler,
  planDesiredReleaseActivation,
} from "./handlers/rollout.js";
import {
  createDeprovisionCustomerHandler,
  type CustomerCleanupContext,
} from "./handlers/deprovision-customer.js";
import { createSuspendCustomerHandler } from "./handlers/suspend-customer.js";
import { createEraseCustomerHandler } from "./handlers/erase-customer.js";
import {
  deleteCustomerStorageObjects,
  verifyCustomerStorageErasure,
} from "./lib/customer-ops/avatars.js";
import { loadCustomerCleanupContext } from "./lib/customer-ops/cleanup-context.js";
import { createGiteaCleanupClient } from "./lib/customer-ops/gitea.js";
import { createMmCleanupClient } from "./lib/customer-ops/mattermost.js";
import { createUnmountFromGateway } from "./lib/customer-ops/unmount-gateway.js";
import { nukeUserCloudSide } from "./lib/customer-ops/nuke-cloud.js";
import { buildAnonymousOperationalArchive } from "./lib/customer-ops/deletion-archive.js";
import {
  eraseCustomerFirestore,
  verifyCustomerFirestoreErasure,
} from "./lib/customer-ops/customer-firestore-erasure.js";
import { resolveDefaultStorageBucket } from "./gcp-project.js";
import { signFleetRequest } from "@octogee/core/fleet-signature";
import {
  readAssignedSlugsForGateway,
  slugFromAssignedUser,
} from "@octogee/core/assigned-roster";
import {
  readAssignmentDoc,
  readAssignmentDocsForGateway,
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
import {
  InitialGatewayReleaseConflictError,
  gatewayAuthorizationFromRootDocument,
  readGatewayArtifact,
  writeInitialGatewayRelease,
  type GatewayArtifact,
} from "@octogee/core/gateway-live-release";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";
import { createMigrationClient } from "@octogee/core/fleet-migration-client";
import {
  customerMigrationV2GatewayRootFence,
  isCustomerMigrationV2Transition,
} from "@octogee/core/customer-migration-v2";
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
import {
  deploymentSettingsForRuntime,
} from "@octogee/core/deployment-environment";
import { reconcileImagePins } from "./reconcile-image-pins.js";
import { workspaceSlugsForUser } from "@octogee/core/workspace-slugs";
import {
  deleteAuthUserTolerantOfMissing,
  disableAuthUserAndRevokeSessions,
} from "@octogee/core/firebase-auth-helpers";
import { revokeAllConnectorGrantsForUser } from "@octogee/core/connector-revocation";
import { CONNECTOR_OAUTH_REVOCATION_TARGETS } from "@octogee/shared/types/connectors";
import { deleteHostingSitesForCustomer } from "@octogee/core/firebase-hosting";
import { GoogleAuth } from "google-auth-library";
import { startHttpServer, startMaintenanceHttpServer } from "./http-server.js";
import { createConnectorSecretDecryptor } from "./connector-secret-decryption.js";
import {
  cancelStripeSubscription,
  cancelCustomerMigrationsForSuspension,
  deactivateCustomerVisibility,
  deleteStripeCustomer,
  disableCreditAutoTopUp,
  expireStripeCheckoutSession,
  invalidatePendingCredentialFlows,
  listLiveStripeSubscriptionIds,
  listOpenStripeCheckoutSessionIds,
  listStripeCustomerIdsForUid,
  revokeOwnerModelBrokerTokens,
} from "./lib/customer-ops/customer-suspension-runtime.js";
import {
  ensureOwnedGatewaysRetired,
} from "./lib/customer-ops/customer-gateway-retirement.js";
import {
  ANONYMOUS_OPERATIONAL_ARCHIVES_COLLECTION,
  CUSTOMER_DELETION_JOBS_COLLECTION,
} from "@octogee/shared/types/account-lifecycle";
import { MODEL_BROKER_USAGE_ROLLUPS_COLLECTION } from "@octogee/shared/types/model-broker-usage";
import { recordReconcile } from "./metrics.js";
import { createLogger } from "./lib/logger.js";
import { startOrphanHeartbeatReaper } from "./orphan-heartbeat-reaper.js";
import { startStuckOpReaper } from "./stuck-op-reaper.js";
import { startHelmRecoverySweeper } from "./helm-recovery-sweeper.js";
import { resumeOrphanedRunningOps } from "./resume-orphaned-ops.js";
import { completeHealthyBootstrapAddGatewayOperations } from "./bootstrap-add-gateway-recovery.js";
import { computeChartFingerprint } from "./chart-fingerprint.js";
import {
  parseDeclaredSharedGatewayIds,
  runSharedGatewayPoolReconcile,
  startSharedGatewayPoolReconciler,
} from "./shared-gateway-pool-bootstrap.js";
import {
  startSharedGatewayCapacityReconciler,
} from "./shared-gateway-capacity-reconciler.js";
import { parseSharedGatewayPoolConfig } from "@octogee/shared/types/shared-gateway-pool";
import { createCachedApiServerEgressResolver } from "./apiserver-egress.js";
import {
  createFirestoreMaintenanceGate,
  startMaintenanceRestartWatcher,
  type ControllerMaintenanceGate,
} from "./maintenance-gate.js";
import {
  PLACEMENT_POLICY_RECONCILE_MS_DEFAULT,
  createFirestorePlacementPolicyReconcilerDeps,
  startPlacementPolicyReconciler,
} from "./placement-policy-reconciler.js";
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
const MIGRATE_CUSTOMER_KIND = "migrate-customer";
const CAPACITY_REBALANCE_GATEWAY_KIND = "rebalance-gateway-capacity";
const RECONCILE_RETRY_MS_DEFAULT = 30_000;
const SHARED_GATEWAY_POOL_RECONCILE_MS = 30_000;
const SHARED_GATEWAY_CAPACITY_RECONCILE_MS = 30_000;
const OPERATOR_READY_REFRESH_MS_DEFAULT = 60_000;
const MAINTENANCE_GATE_POLL_MS = 5_000;

const GATEWAY_CHART = process.env.GATEWAY_CHART ?? "/charts/octogee-gateway";
const NAMESPACE = (function () {
  const namespace = process.env.K8S_NAMESPACE;
  if (!namespace) {
    throw new Error("K8S_NAMESPACE is required for glm-controller");
  }
  return namespace;
})();
const ENVIRONMENT_SETTINGS = deploymentSettingsForRuntime({
  namespace: NAMESPACE,
  targetId: process.env.DEPLOYMENT_TARGET_ID,
});

const GATEWAY_VALUES_FILE = (function () {
  const explicit = process.env.GATEWAY_VALUES_FILE;
  if (explicit) return explicit;
  return `${GATEWAY_CHART}/${ENVIRONMENT_SETTINGS.gatewayValuesFile}`;
})();
const PIN_ENV = ENVIRONMENT_SETTINGS.pinEnvironment;

const FLEET_CONTROLLER_PORT = process.env.FLEET_CONTROLLER_PORT ?? "3003";
const OPERATOR_HEARTBEAT_POLL_MS = 15_000;
const OPERATOR_HEALTH_TIMEOUT_MS = 5_000;
export const ADD_GATEWAY_DEPLOYMENT_READY_TIMEOUT_MS = 30 * 60_000;
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? "8080", 10);

// Lets out-of-loop callers (the roll arm's pacing, the rollout op handler)
// nudge the reconciler without holding a reference to its closure; installed by
// startReconciler.
const requestReconcileTickRef: { fire?: () => void } = {};
const PLACEMENT_POLICY_RECONCILE_MS = parseNonNegativeInt(
  process.env.PLACEMENT_POLICY_RECONCILE_MS,
  PLACEMENT_POLICY_RECONCILE_MS_DEFAULT,
);
const DISPOSABLE_GATEWAY_IDLE_MS = parseNonNegativeInt(
  process.env.DISPOSABLE_GATEWAY_IDLE_MS,
  30 * 60 * 1000,
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

  // The simple-roll convergence arm (converge-gateway.ts): one stable-name
  // Helm release per gateway, applied whenever desired state drifts.
  convergeGateways?: (gatewayIds?: readonly string[]) => Promise<void>;

  reconcileRetryMs?: number;

  operatorReadyRefreshMs?: number;

  chartFingerprint?: string;

  ensureGatewayAuthSecret: AuthSecretEnsurer["ensureAuthSecret"];
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

export function versionFromImageTag(imageTag: string | undefined): string {
  if (!imageTag) return "unknown";
  const [reference] = imageTag.split("@", 1);
  return reference;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function publishPlatformGatewayReady(
  db: Firestore,
  input: {
    gatewayId: string;
    imageTag?: string;
    now: number;
  },
): Promise<void> {
  const glmRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.gatewayId);
  await db.runTransaction(async (txn) => {
    const glmSnap = await txn.get(glmRef);
    const glmData = glmSnap.exists ? (glmSnap.data() as Record<string, unknown> | undefined) : undefined;
    if (!isGatewayRuntimeDoc(glmData) || glmData.gatewayId !== input.gatewayId) {
      throw new Error(
        `cannot publish readiness: glmGateways/${input.gatewayId} is not the gateway's runtime doc`,
      );
    }
    const existingHb =
      glmData.heartbeat && typeof glmData.heartbeat === "object" && !Array.isArray(glmData.heartbeat)
        ? (glmData.heartbeat as unknown as Record<string, unknown>)
        : undefined;
    const patch: Record<string, unknown> = {
      status: "ready",
      version: versionFromImageTag(input.imageTag),
      internalUrl: gatewayServiceInternalUrl(input.gatewayId),
      startedAt: typeof existingHb?.startedAt === "number" ? existingHb.startedAt : input.now,
    };
    if (!Array.isArray(existingHb?.mountedCustomers)) {
      patch.mountedCustomers = [];
    }
    if (!("lastError" in (existingHb ?? {}))) {
      patch.lastError = null;
    }
    txn.set(glmRef, { lifecycle: "serving", heartbeat: patch }, { merge: true });
  });
}

async function readGatewayHeartbeatFromFirestore(
  db: Firestore,
  gatewayId: string,
): Promise<{ lastHeartbeatAt: number; version?: string | null } | null> {
  const glmSnap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
  const runtime = glmSnap.exists ? glmSnap.data() : undefined;
  if (!isGatewayRuntimeDoc(runtime) || runtime.gatewayId !== gatewayId) {
    return null;
  }
  return readHeartbeatLiveness(runtime as unknown as Record<string, unknown>, undefined);
}

async function readReleasePayloadFromFirestore(
  db: Firestore,
  gatewayId: string,
  release: number,
): Promise<ReleasePayload | null> {
  return readGatewayArtifact(db, gatewayId, release);
}

function clearedHeartbeatFieldsPatch(): Record<string, unknown> {
  const del = FieldValue.delete();
  const out: Record<string, unknown> = {};
  for (const field of LEGACY_HEARTBEAT_FIELDS) out[field] = del;
  return out;
}

async function syncGatewayModelKeySecrets(
  deps: ControllerDeps,
  gateways: readonly DurableGateway[],
): Promise<Set<string>> {
  const ensurer = deps.modelKeySecretEnsurer;
  const changedBrokerGateways = new Set<string>();
  if (!ensurer) return changedBrokerGateways;

  for (const gateway of gateways) {
    if (!(await cowboyMayMutateGatewayNow(deps.db, gateway.gatewayId))) continue;
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
  gateways: readonly DurableGateway[],
): Promise<void> {
  const issuer = deps.modelKeySourceIssuer;
  if (!issuer) return;

  for (const gateway of gateways) {
    if (!(await cowboyMayMutateGatewayNow(deps.db, gateway.gatewayId))) continue;
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
  gateways: readonly DurableGateway[],
  changedGatewayIds: Set<string>,
): Promise<void> {
  if (!deps.restartGatewayDeployment || changedGatewayIds.size === 0) return;
  const roots = new Map(gateways.map((gateway) => [gateway.gatewayId, gateway]));
  for (const gatewayId of changedGatewayIds) {
    const root = roots.get(gatewayId);
    if (!root || root.liveRelease == null) {
      deps.log(
        `[glm-controller] model-key secret changed for ${gatewayId}, but no realization exists yet`,
      );
      continue;
    }
    if (!(await cowboyMayMutateGatewayNow(deps.db, gatewayId))) continue;
    try {
      await deps.restartGatewayDeployment(gatewayId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`(source=model-key-secret) ${gatewayId}: rollout restart failed: ${message}`);
    }
  }
}

async function cowboyMayMutateGatewayNow(db: Firestore, gatewayId: string): Promise<boolean> {
  const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  const root = projectGatewayDesiredRootForGateway(
    snap.exists ? snap.data() : undefined,
    gatewayId,
  );
  return root !== null && cowboyMayMutateGateway(root);
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
  gateways: DurableGateway[];
  runtimeDocs: GatewayRuntimeDoc[];
  invalidRootIds: string[];
  strayGlmDocIds: string[];
}

interface RuntimeQueryDoc {
  id: string;
  data(): unknown;
}

function collectDurableRuntimeRoots(docs: ReadonlyArray<RuntimeQueryDoc>): {
  gateways: DurableGateway[];
  invalidRootIds: string[];
} {
  const gateways: DurableGateway[] = [];
  const invalidRootIds: string[] = [];
  for (const doc of docs) {
    const authorization = gatewayAuthorizationFromRootDocument(doc.data(), doc.id);
    if (authorization) {
      gateways.push(authorization.gateway as DurableGateway);
    } else {
      invalidRootIds.push(doc.id);
    }
  }
  return { gateways, invalidRootIds };
}

// glmGateways holds ONLY bare-id runtime docs under the simple-roll model. Any
// other doc (legacy desired doc, revision realization) is a stray the cutover
// script must clean — the controller refuses fleet mutation until it does.
function classifyDurableRuntimeGlmDocs(
  docs: ReadonlyArray<RuntimeQueryDoc>,
  gateways: readonly DurableGateway[],
): {
  runtimeDocs: GatewayRuntimeDoc[];
  strayGlmDocIds: string[];
} {
  const runtimeDocs: GatewayRuntimeDoc[] = [];
  const strayGlmDocIds: string[] = [];
  const gatewayIds = new Set(gateways.map((gateway) => gateway.gatewayId));
  for (const doc of docs) {
    const data = doc.data();
    if (isGatewayRuntimeDoc(data) && data.gatewayId === doc.id && gatewayIds.has(doc.id)) {
      runtimeDocs.push(data);
    } else {
      strayGlmDocIds.push(doc.id);
    }
  }
  return { runtimeDocs, strayGlmDocIds };
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

function assertDurableRuntimeState(state: DurableRuntimeState): void {
  if (state.invalidRootIds.length > 0) {
    throw new Error(
      `invalid durable root document(s): ${state.invalidRootIds.slice().sort().join(", ")}; refusing fleet mutation`,
    );
  }
  if (state.strayGlmDocIds.length > 0) {
    throw new Error(
      `stray glmGateway document(s): ${state.strayGlmDocIds.slice().sort().join(", ")}; ` +
        `run scripts/ops/cutover-simple-roll.ts before fleet mutation`,
    );
  }
}

async function readDurableServingFleetGateways(db: Firestore): Promise<FleetGateway[]> {
  const state = await readDurableRuntimeGateways(db);
  assertDurableRuntimeState(state);
  return state.gateways
    .filter((gateway) => gateway.desiredStatus !== "retired")
    .map((gateway) => ({ gatewayId: gateway.gatewayId }));
}

async function readDurableReleaseArtifacts(
  db: Firestore,
  state: DurableRuntimeState,
): Promise<Array<{ imageRepository: string; imageTag: string }>> {
  const artifacts: Array<{ imageRepository: string; imageTag: string }> = [];
  for (const gateway of state.gateways) {
    if (gateway.desiredStatus === "retired") continue;
    const releases = new Set([gateway.desiredRelease]);
    if (gateway.liveRelease != null) releases.add(gateway.liveRelease);
    for (const release of releases) {
      const artifact = await readGatewayArtifact(db, gateway.gatewayId, release);
      if (!artifact) {
        throw new Error(
          `gateway ${gateway.gatewayId} release ${release} has no valid release artifact`,
        );
      }
      artifacts.push({
        imageRepository: resolveGatewayImageRepository({
          gatewayClass: gateway.gatewayClass,
          imageProfile: gateway.imageProfile,
          profile: gateway.profile ?? undefined,
          imageRepository: artifact.imageRepository,
        }),
        imageTag: artifact.imageTag,
      });
      if (!artifact.gatewayEdgeImage) {
        throw new Error(
          `gateway ${gateway.gatewayId} release ${release} is missing its immutable gateway-edge image reference`,
        );
      }
      const gatewayEdgeImage = artifact.gatewayEdgeImage;
      artifacts.push({
        imageRepository: gatewayEdgeImage.imageRepository,
        imageTag: gatewayEdgeImage.imageTag,
      });
    }
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
    artifacts = await readDurableReleaseArtifacts(deps.db, state);
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
  gateways: readonly DurableGateway[],
): Promise<void> {
  await syncGatewayModelKeySources(deps, gateways);
  const changedModelKeyGateways = await syncGatewayModelKeySecrets(deps, gateways);
  await restartGatewayDeploymentsForModelKeyChanges(deps, gateways, changedModelKeyGateways);
}

interface GatewayConvergencePassDeps {
  db: Firestore;
  helm: HelmRunner;
  kubeOps: KubeOps;
  chartFingerprint: string;
  prepareGatewayConfig: <T extends GatewayMutableConfig & { gatewayId: string }>(
    config: T,
  ) => Promise<T>;
  reconcileSurgeHandoff: (input: {
    gatewayId: string;
    desiredImageTag: string;
    requiresCustomerMigration: boolean;
    ownerlessOperatorPrewarm: boolean;
    requiredTargetCapacity?: "spot";
  }) => Promise<{ ready: boolean }>;
  log: (msg: string) => void;
}

// The pod's own self-reported build (heartbeat.version, written by the
// heartbeat plumbing) is the readiness proof: mark-live only once the runtime
// is heartbeating the desired release's build. Deployment availability alone
// would count the old pod during a surge overlap.
function runtimeReportsDesiredBuild(
  runtime: GatewayRuntimeDoc | undefined,
  desiredImageTag: string,
): boolean {
  if (!runtime) return false;
  return (
    runtime.heartbeat.status === "ready" &&
    gatewayHeartbeatMatchesImageTag(runtime.heartbeat.version, desiredImageTag)
  );
}

export async function refineGatewayConvergenceAction(input: {
  passDeps: Pick<GatewayConvergencePassDeps, "db" | "reconcileSurgeHandoff">;
  gateway: DurableGateway;
  artifact: ReleasePayload | null;
  runtime: GatewayRuntimeDoc | undefined;
  helmObserved: ObservedHelmInstance | null;
  desiredChartFingerprint?: string;
  desiredDeploymentIntentFingerprint?: string;
  action: GatewayConvergenceAction;
}): Promise<GatewayConvergenceAction> {
  const {
    passDeps,
    gateway,
    artifact,
    runtime,
    helmObserved,
    desiredChartFingerprint,
    desiredDeploymentIntentFingerprint,
    action,
  } = input;
  if (!cowboyMayMutateGateway(gateway)) return { kind: "steady" };
  if (action.kind !== "steady" || !artifact || gateway.desiredStatus !== "running") {
    return action;
  }
  if (!(await cowboyMayMutateGatewayNow(passDeps.db, gateway.gatewayId))) {
    return { kind: "steady" };
  }
  const desiredImage = gatewayImageFor(gateway, artifact);
  const handoff = await passDeps.reconcileSurgeHandoff({
    gatewayId: gateway.gatewayId,
    desiredImageTag: desiredImage.imageTag,
    requiresCustomerMigration: requiresSurgeCustomerMigration(gateway),
    ownerlessOperatorPrewarm: false,
    ...(gateway.capacityRebalance?.active === true
      ? { requiredTargetCapacity: "spot" as const }
      : {}),
  });
  return planGatewayConvergence({
    gateway,
    artifact,
    helm: helmObserved,
    desiredChartFingerprint,
    desiredDeploymentIntentFingerprint,
    deploymentReady: handoff.ready && runtimeReportsDesiredBuild(runtime, desiredImage.imageTag),
  });
}

async function runGatewayConvergencePass(
  passDeps: GatewayConvergencePassDeps,
  gatewayIds?: readonly string[],
): Promise<void> {
  const { db, helm, log } = passDeps;
  const state = await readDurableRuntimeGateways(db);
  assertDurableRuntimeState(state);
  const instances = await helm.readDeployedInstances({ namespace: NAMESPACE });
  const runtimeById = new Map(state.runtimeDocs.map((doc) => [doc.gatewayId, doc]));
  const failures: string[] = [];
  const selected = gatewayIds ? new Set(gatewayIds) : null;
  for (const gateway of state.gateways) {
    if (selected && !selected.has(gateway.gatewayId)) continue;
    try {
      await convergeOneGateway(passDeps, gateway, instances, runtimeById);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${gateway.gatewayId}: ${message}`);
      log(`[converge-gateway] ⚠ ${gateway.gatewayId}: ${message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`(source=converge-gateway) ${failures.join("; ")}`);
  }
}

async function convergeOneGateway(
  passDeps: GatewayConvergencePassDeps,
  gateway: DurableGateway,
  instances: HelmInstancesMap,
  runtimeById: Map<string, GatewayRuntimeDoc>,
): Promise<void> {
  const { db } = passDeps;
  const instance = instances[gateway.gatewayId];
  const helmObserved = observedHelmInstance(instance);
  const artifact =
    gateway.desiredStatus === "retired"
      ? null
      : await readGatewayArtifact(db, gateway.gatewayId, gateway.desiredRelease);
  const runtime = runtimeById.get(gateway.gatewayId);
  const desiredIntent = await prepareDesiredGatewayIntent({
    passDeps,
    gateway,
    artifact,
    instance,
  });
  const desiredOpts = desiredIntent?.opts ?? null;
  const desiredChartFingerprint = desiredOpts?.chartFingerprint;
  const desiredDeploymentIntentFingerprint = desiredIntent?.comparisonFingerprint;
  const initialAction = planGatewayConvergence({
    gateway,
    artifact,
    helm: helmObserved,
    desiredChartFingerprint,
    desiredDeploymentIntentFingerprint,
    deploymentReady: false,
  });
  const action = await refineGatewayConvergenceAction({
    passDeps,
    gateway,
    artifact,
    runtime,
    helmObserved,
    desiredChartFingerprint,
    desiredDeploymentIntentFingerprint,
    action: initialAction,
  });
  switch (action.kind) {
    case "steady":
      return;
    case "hold-missing-release":
    case "hold-unreleased-chart":
      throw new Error(action.error);
    case "uninstall":
      await uninstallGateway(passDeps, gateway);
      return;
    case "upsert":
      await upsertGateway(passDeps, {
        gateway,
        artifact,
        runtime,
        desiredOpts,
        replicas: action.replicas,
      });
      return;
    case "mark-live":
      await markGatewayLive(passDeps, gateway);
      return;
  }
}

async function uninstallGateway(
  passDeps: GatewayConvergencePassDeps,
  gateway: DurableGateway,
): Promise<void> {
  const { db, helm, log } = passDeps;
  if (!(await cowboyMayMutateGatewayNow(db, gateway.gatewayId))) return;
  log(`[converge-gateway] ${gateway.gatewayId} retired — uninstalling stable release`);
  await helm.removeInstance({ namespace: NAMESPACE, gatewayId: gateway.gatewayId });
  if (!(await cowboyMayMutateGatewayNow(db, gateway.gatewayId))) return;
  await db.collection(GLM_GATEWAYS_COLLECTION).doc(gateway.gatewayId).delete();
}

async function upsertGateway(
  passDeps: GatewayConvergencePassDeps,
  input: {
    gateway: DurableGateway;
    artifact: ReleasePayload | null;
    runtime: GatewayRuntimeDoc | undefined;
    desiredOpts: GatewayUpsertOpts | null;
    replicas: number;
  },
): Promise<void> {
  const { db, helm, log } = passDeps;
  const { gateway, artifact, runtime, desiredOpts, replicas } = input;
  if (!desiredOpts) throw new Error(`gateway ${gateway.gatewayId} has no deployable intent`);
  if (!(await cowboyMayMutateGatewayNow(db, gateway.gatewayId))) return;
  log(
    `[converge-gateway] ${gateway.gatewayId} → release ${gateway.desiredRelease} ` +
      `(${desiredOpts.imageTag}, replicas=${replicas})`,
  );
  await db
    .collection(GLM_GATEWAYS_COLLECTION)
    .doc(gateway.gatewayId)
    .set(
      provisioningRuntimeDoc({
        gateway,
        artifact: artifact as ReleasePayload,
        existing: runtime ?? null,
        now: Date.now(),
      }) as unknown as Record<string, unknown>,
      { merge: true },
    );
  if (!(await cowboyMayMutateGatewayNow(db, gateway.gatewayId))) return;
  await helm.upsertInstance(desiredOpts);
}

async function markGatewayLive(
  passDeps: GatewayConvergencePassDeps,
  gateway: DurableGateway,
): Promise<void> {
  const { db, log } = passDeps;
  log(`[converge-gateway] ${gateway.gatewayId} release ${gateway.desiredRelease} is live`);
  await db.runTransaction(async (txn) => {
    const rootRef = db.collection(GATEWAYS_COLLECTION).doc(gateway.gatewayId);
    const glmRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(gateway.gatewayId);
    const rootSnap = await txn.get(rootRef);
    const root = projectGatewayDesiredRootForGateway(
      rootSnap.exists ? rootSnap.data() : undefined,
      gateway.gatewayId,
    );
    if (!cowboyMayMarkGatewayLive(root, gateway.desiredRelease)) return;
    txn.set(
      rootRef,
      { liveRelease: gateway.desiredRelease, updatedAt: Date.now(), updatedBy: "converge-gateway" },
      { merge: true },
    );
    const runtimePatch = markLiveRuntimePatch(gateway);
    if (runtimePatch) txn.set(glmRef, runtimePatch, { merge: true });
  });
}

function observedHelmInstance(
  instance: HelmInstancesMap[string] | undefined,
): ObservedHelmInstance | null {
  if (!instance) return null;
  return {
    imageRepository: instance.image.repository ?? null,
    imageTag: instance.image.tag ?? null,
    replicas: typeof instance.replicas === "number" ? instance.replicas : 1,
    ownerUid: instance.ownerUid,
    builderSlug: instance.builderSlug,
    chartFingerprint: instance.chartFingerprint,
    deploymentIntentFingerprint: instance.deploymentIntentFingerprint ?? null,
  };
}

async function prepareDesiredGatewayIntent(input: {
  passDeps: GatewayConvergencePassDeps;
  gateway: DurableGateway;
  artifact: ReleasePayload | null;
  instance: HelmInstancesMap[string] | undefined;
}): Promise<{ opts: GatewayUpsertOpts; comparisonFingerprint?: string } | null> {
  const { passDeps, gateway, artifact, instance } = input;
  if (!artifact || gateway.desiredStatus === "retired") return null;
  const prepared = await passDeps.prepareGatewayConfig(gateway);
  const opts = gatewayUpsertOptsFromRelease({
    namespace: NAMESPACE,
    gateway: prepared,
    artifact,
    replicas: gateway.desiredStatus === "paused" ? 0 : 1,
    chartPath: GATEWAY_CHART,
    valuesFile: GATEWAY_VALUES_FILE,
    chartFingerprint: passDeps.chartFingerprint,
    kmsKeyName: ENVIRONMENT_SETTINGS.kmsKeyName,
    deploymentTargetId: ENVIRONMENT_SETTINGS.targetId,
    deploymentProjectId: ENVIRONMENT_SETTINGS.firebaseProjectId,
    gatewayServiceAccount:
      `octogee-gateway@${ENVIRONMENT_SETTINGS.firebaseProjectId}.iam.gserviceaccount.com`,
  });
  return {
    opts,
    comparisonFingerprint: deploymentIntentFingerprintForComparison({
      desired: opts,
      observedChartFingerprint: instance?.chartFingerprint,
      observedDeploymentIntentFingerprint: instance?.deploymentIntentFingerprint,
      applyChartDrift: gatewayReleaseAuthorizesChartDrift(gateway),
    }),
  };
}

async function convergeGatewaysIfConfigured(
  deps: ControllerDeps,
  gatewayIds?: readonly string[],
): Promise<void> {
  if (!deps.convergeGateways) return;
  try {
    await deps.convergeGateways(gatewayIds);
  } catch (err) {
    deps.log(`[converge-gateway] ⚠ pass failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function serializeGatewayConvergence(
  convergeGateways: (gatewayIds?: readonly string[]) => Promise<void>,
): (gatewayIds?: readonly string[]) => Promise<void> {
  let tail = Promise.resolve();
  return (gatewayIds) => {
    const work = tail.then(() => convergeGateways(gatewayIds));
    tail = work.catch(() => undefined);
    return work;
  };
}

async function runReconcilePhase<T>(
  deps: ControllerDeps,
  phase: string,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  deps.log(`[glm-controller] reconcile phase=${phase} started`);
  try {
    return await work();
  } finally {
    deps.log(
      `[glm-controller] reconcile phase=${phase} completed durationMs=${Math.max(0, Date.now() - startedAt)}`,
    );
  }
}

async function reconcileOnce(deps: ControllerDeps): Promise<void> {
  if (await controllerWorkFrozen(deps, "reconcile")) return;
  const runtime = await runReconcilePhase(deps, "durable-state", async () => {
    const state = await readDurableRuntimeGateways(deps.db);
    assertDurableRuntimeState(state);
    return state;
  });
  await runReconcilePhase(deps, "image-pins", () => syncDurableImagePins(deps, runtime));
  await runReconcilePhase(deps, "runtime-dependencies", () =>
    syncDurableRuntimeDependencies(
      deps,
      runtime.gateways.filter(cowboyMayMutateGateway),
    )
  );
  await runReconcilePhase(deps, "convergence", () => convergeGatewaysIfConfigured(deps));
  await runReconcilePhase(deps, "fleet-ingress", () => syncFleetIngressIfConfigured(deps));
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

  const scheduleRetryTick = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => void tick(), retryMs);
  };

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

  const rootUnsub = deps.db.collection(GATEWAYS_COLLECTION).onSnapshot(
    (snap?: { docChanges?: () => ReconcileSnapshotDocChange[] }) => {
      if (stopped) return;
      const changes = snap?.docChanges?.();
      if (!changes || snapshotHasReconcileRelevantChange(changes, rootFingerprints)) {
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
    rootUnsub();
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
          const data = change.doc.data();
          if (isOperationAuditRow(data)) continue;
          const op = { ...(data as Operation), id: change.doc.id };
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

// Restart re-drive candidates. The predicate below admits only migrations with
// the durable V2 state machine; legacy rollout sub-operations remain rollout-owned.
const RESUMABLE_OP_KINDS: ReadonlySet<string> = new Set([
  "rollout",
  CAPACITY_REBALANCE_GATEWAY_KIND,
  MIGRATE_CUSTOMER_KIND,
  "suspend-customer",
  "erase-customer",
]);

const AUTOMATIC_GATEWAY_MUTATION_KINDS: ReadonlySet<string> = new Set([
  "add-gateway",
  "retire-gateway",
  "restart-gateway",
  "recycle-gateway",
  "rollout",
  CAPACITY_REBALANCE_GATEWAY_KIND,
  MIGRATE_CUSTOMER_KIND,
]);

const AUTOMATIC_BUILDER_MUTATION_KINDS: ReadonlySet<string> = new Set([
  MIGRATE_CUSTOMER_KIND,
  "deprovision-customer",
  "suspend-customer",
  "erase-customer",
]);

function operationIsAutomatic(op: Operation): boolean {
  return resolveOperationOrigin(op.origin) === "automatic";
}

function automaticOperationGatewayIds(op: Operation): string[] {
  if (!AUTOMATIC_GATEWAY_MUTATION_KINDS.has(op.kind)) return [];
  return [...new Set([
    op.input.gatewayId,
    op.input.fromGatewayId,
    op.input.toGatewayId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0))];
}

async function automaticOperationFenceReason(
  txn: FirebaseFirestore.Transaction,
  db: Firestore,
  op: Operation,
): Promise<string | null> {
  if (!operationIsAutomatic(op)) return null;
  const gatewayIds = automaticOperationGatewayIds(op);
  const uid = AUTOMATIC_BUILDER_MUTATION_KINDS.has(op.kind) &&
    typeof op.input.uid === "string" && op.input.uid.length > 0
    ? op.input.uid
    : null;
  const snapshots = await Promise.all([
    ...gatewayIds.map((gatewayId) => txn.get(db.collection(GATEWAYS_COLLECTION).doc(gatewayId))),
    ...(uid ? [txn.get(db.collection("users").doc(uid))] : []),
  ]);
  for (let index = 0; index < gatewayIds.length; index += 1) {
    const snapshot = snapshots[index];
    if (snapshot.exists && isOperatorManaged(snapshot.data()?.managedBy)) {
      return `automatic ${op.kind} operation fenced: gateway ${gatewayIds[index]} is operator-managed`;
    }
  }
  if (uid) {
    const user = snapshots.at(-1);
    if (isOperatorManaged(readPath(
      user?.exists ? user.data() as Record<string, unknown> : undefined,
      "provisioning.openclaw.managedBy",
    ))) {
      return `automatic ${op.kind} operation fenced: builder ${uid} is operator-managed`;
    }
  }
  return null;
}

function failFencedOperation(
  txn: FirebaseFirestore.Transaction,
  ref: FirebaseFirestore.DocumentReference,
  reason: string,
  now: number,
): void {
  txn.update(ref, {
    status: "failed",
    completedAt: now,
    error: reason,
    waitingOn: FieldValue.delete(),
    nextAttemptAt: FieldValue.delete(),
  });
}

function operationIsRestartResumable(op: Operation): boolean {
  if (op.kind === "rollout" || op.kind === CAPACITY_REBALANCE_GATEWAY_KIND) return true;
  return operationNeedsDurableRestartResume(op);
}

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
): Promise<{ outcome: "claimed" | "queued" | "skipped" | "fenced"; fresh?: Operation }> {
  try {
    return await deps.db.runTransaction(async (txn) => {
      if (deps.maintenanceGate) {
        const gate = await deps.maintenanceGate.stateInTransaction(txn);
        if (gate.frozen) return { outcome: "skipped" as const };
      }
      const fresh = await txn.get(ref);
      if (!fresh.exists) return { outcome: "skipped" as const };
      const data = fresh.data() as unknown;
      if (!data || isOperationAuditRow(data)) return { outcome: "skipped" as const };
      const freshOperation = data as Operation;
      const fenceReason = await automaticOperationFenceReason(txn, deps.db, freshOperation);
      if (fenceReason) {
        failFencedOperation(txn, ref, fenceReason, Date.now());
        return { outcome: "fenced" as const };
      }
      let runningOpsSameKind: OperationRef[] = [];
      let pendingOpsSameKind: PendingOperationRef[] = [];
      if (isSeriallyExclusiveKind(op.kind)) {
        const operations = deps.db.collection(GLM_OPERATIONS_COLLECTION);
        const [runningSnap, pendingSnap] = await Promise.all([
          txn.get(operations.where("status", "==", "running")),
          txn.get(operations.where("status", "==", "pending")),
        ]);
        runningOpsSameKind = runningSnap.docs.flatMap((d) => {
          const runningData = d.data() as unknown;
          if (isOperationAuditRow(runningData)) return [];
          const runningOperation = runningData as Operation;
          return isSeriallyExclusiveKind(runningOperation.kind) ? [{
            id: d.id,
            kind: runningOperation.kind,
            input: runningOperation.input,
            customerMigrationV2: runningOperation.customerMigrationV2,
          }] : [];
        });
        pendingOpsSameKind = pendingSnap.docs.flatMap((d) => {
          const pendingData = d.data() as unknown;
          if (isOperationAuditRow(pendingData)) return [];
          const pendingOperation = pendingData as Operation;
          return isSeriallyExclusiveKind(pendingOperation.kind) ? [{
            id: d.id,
            kind: pendingOperation.kind,
            origin: pendingOperation.origin,
            input: pendingOperation.input,
            output: pendingOperation.output,
            createdAt: pendingOperation.createdAt,
            nextAttemptAt: pendingOperation.nextAttemptAt,
            customerMigrationV2: pendingOperation.customerMigrationV2,
          }] : [];
        });
      }

      const decision = decideOperationClaim({
        op: {
          id: op.id,
          kind: op.kind,
          status: freshOperation.status,
          createdAt: freshOperation.createdAt,
          nextAttemptAt: freshOperation.nextAttemptAt,
          input: freshOperation.input,
          customerMigrationV2: freshOperation.customerMigrationV2,
        },
        now: Date.now(),
        runningOpsSameKind,
        pendingOpsSameKind,
      });

      if (decision.outcome === "skip") return { outcome: "skipped" as const };
      if (decision.outcome === "queue") {
        if (freshOperation.waitingOn !== decision.waitingOn) {
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
      return { outcome: "claimed" as const, fresh: { ...freshOperation, id: op.id, startedAt: now } };
    });
  } catch (err) {
    deps.log(
      `[glm-controller] claim transaction failed op=${op.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { outcome: "skipped" };
  }
}

export async function processOperation(
  op: Operation | OperationAuditRecord,
  ref: FirebaseFirestore.DocumentReference,
  deps: ControllerDeps,
): Promise<void> {
  if (isOperationAuditRow(op)) return;
  const operation = op as Operation;
  const claim = await attemptClaimOrQueueOperation(operation, ref, deps);
  if (claim.outcome === "queued") {
    deps.log(`[glm-controller] op=${operation.id} kind=${operation.kind} queued — waiting on a conflicting op`);
    return;
  }
  if (claim.outcome === "fenced") {
    deps.log(`[glm-controller] op=${op.id} failed — operator-managed target`);
    return;
  }
  if (claim.outcome !== "claimed" || !claim.fresh) return;

  deps.log(`[glm-controller] claim op=${operation.id} kind=${operation.kind}`);
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
    .flatMap((doc) => {
      const data = doc.data();
      if (isOperationAuditRow(data)) return [];
      return [{ op: { ...(data as Operation), id: doc.id }, ref: doc.ref }];
    })
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
      const data = fresh.data() as unknown;
      if (!data || isOperationAuditRow(data)) return null;
      const freshOperation = data as Operation;
      if (freshOperation.status !== "running") return null;
      const now = Date.now();
      txn.update(ref, {
        startedAt: now,
        lastProgressAt: now,
        resumeCount: (typeof freshOperation.resumeCount === "number" ? freshOperation.resumeCount : 0) + 1,
      });
      return { ...freshOperation, id: op.id, startedAt: now };
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
  const fenced = await deps.db.runTransaction(async (txn) => {
    const fresh = await txn.get(ref);
    if (!fresh.exists) return false;
    const current = fresh.data() as Operation | undefined;
    if (!current || current.status !== "running") return false;
    const reason = await automaticOperationFenceReason(txn, deps.db, current);
    if (!reason) return false;
    failFencedOperation(txn, ref, reason, Date.now());
    return true;
  });
  if (fenced) {
    deps.log(`[glm-controller] op=${op.id} failed before execution — operator-managed target`);
    return;
  }
  const { ctx, steps } = createOperationContext({
    persist: async (next) => {
      await ref.update({ steps: next, lastProgressAt: Date.now() });
    },
    persistCustomerMigrationV2: async (state) => {
      await deps.db.runTransaction(async (txn) => {
        const fresh = await txn.get(ref);
        const data = fresh.exists ? fresh.data() as Operation : null;
        if (data?.status !== "running") {
          throw new Error("customer migration V2 operation is no longer running");
        }
        const current = data.customerMigrationV2;
        if (current) {
          if (
            current.operationId !== state.operationId ||
            current.migrationId !== state.migrationId ||
            !isCustomerMigrationV2Transition(current.phase, state.phase)
          ) {
            throw new Error(
              `customer migration V2 state conflict: ${current.phase} -> ${state.phase}`,
            );
          }
        } else if (state.phase !== "initialized" || state.operationId !== op.id) {
          throw new Error("customer migration V2 must start with its operation-bound initialized state");
        }
        txn.update(ref, {
          customerMigrationV2: state,
          lastProgressAt: Date.now(),
        });
      });
    },
    cancellationRequested: async () => {
      const fresh = await ref.get();
      const data = fresh.exists ? fresh.data() as Record<string, unknown> : null;
      return data?.cancellationRequestedAt !== undefined;
    },
    log: deps.log,
    opId: op.id,
  });

  const result = await routeOperation(op, deps.handlers, ctx);
  const completion = await deps.db.runTransaction(async (txn) => {
    const fresh = await txn.get(ref);
    if (!fresh.exists) return null;
    const freshOp = fresh.data() as Operation | undefined;
    const status = freshOp?.status ?? "missing";
    if (!shouldPersistClaimedOperationCompletion(status)) return null;
    const completion = buildOperationCompletionUpdate({
      op: {
        id: ref.id,
        kind: freshOp?.kind,
        origin: freshOp?.origin,
        input: freshOp?.input,
        attempts: freshOp?.attempts,
        attemptHistory: freshOp?.attemptHistory,
        startedAt: freshOp?.startedAt,
        customerMigrationV2: freshOp?.customerMigrationV2,
      },
      result,
      steps,
      now: Date.now(),
    });
    const verifiedDeletion = verifiedDeletionCompletion(result);
    if (verifiedDeletion) {
      txn.set(
        deps.db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(verifiedDeletion.deletionId),
        {
          status: "verified",
          archiveId: verifiedDeletion.archiveId,
          completedAt: Date.now(),
          uid: FieldValue.delete(),
          slug: FieldValue.delete(),
          requestedBy: FieldValue.delete(),
          currentGatewayId: FieldValue.delete(),
          stripeCustomerIds: FieldValue.delete(),
          stripeSubscriptionIds: FieldValue.delete(),
          cleanupContext: FieldValue.delete(),
          suspensionOperationId: FieldValue.delete(),
          erasureOperationId: FieldValue.delete(),
        },
        { merge: true },
      );
    }
    txn.update(ref, completion);
    return completion;
  });
  if (!completion) {
    deps.log(`[glm-controller] op=${op.id} completion discarded because the operation was cancelled`);
    return;
  }

  if (result.success) {
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
      return readAssignedSlugsForGateway(db, target.gatewayId);
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
      const runtime = snap.exists ? snap.data() : undefined;
      if (!isGatewayRuntimeDoc(runtime) || runtime.gatewayId !== gatewayId) {
        return;
      }
      await callUnmountRpc(db, {
        privateKey,
        gatewayId,
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
      isGatewayRuntimeDoc(data) &&
      doc.id === data.gatewayId &&
      data.lifecycle !== "failed"
    ) {
      ids.push(data.gatewayId);
    }
  }
  return ids;
}

export function heartbeatRosterTarget(
  instanceId: string,
  data: Record<string, unknown> | undefined,
): { gatewayId: string } | null {
  if (isGatewayRuntimeDoc(data) && data.gatewayId === instanceId) {
    return { gatewayId: data.gatewayId };
  }
  return null;
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
  if (!deps.kubeOps) {
    throw new Error("controller background tasks require Kubernetes operations");
  }
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
    isRecoverableRevision: (gatewayId) => isRecoverableGatewayRelease(db, gatewayId),
    recover: (revisionId) => helm.recoverRelease({ namespace: NAMESPACE, gatewayId: revisionId }),
    now: () => Date.now(),
    staleMs: HELM_RECOVERY_STALE_MS,
    intervalMs: HELM_RECOVERY_SWEEP_MS,
    log,
  });
  const stopPlacementPolicyReconciler = startPlacementPolicyReconciler(
    createFirestorePlacementPolicyReconcilerDeps({
      db,
      namespace: NAMESPACE,
      idleMs: DISPOSABLE_GATEWAY_IDLE_MS,
      now: () => Date.now(),
      log,
      ensureAuthSecret: deps.ensureGatewayAuthSecret,
      readGatewayPodDiagnostics: deps.kubeOps.readGatewayPodDiagnostics,
      readGatewayPodDiagnosticsBatch: deps.kubeOps.readGatewayPodDiagnosticsBatch,
      maintenanceGate: deps.maintenanceGate,
    }),
    PLACEMENT_POLICY_RECONCILE_MS,
  );
  const httpKubeOps = deps.kubeOps;
  const decryptConnectorSecret = createConnectorSecretDecryptor();
  const stopHttp = startHttpServer({
    db,
    log,
    port: HTTP_PORT,
    verifyIdToken: async (token) => {
      const decoded = await getAuth().verifyIdToken(token, true);
      return { uid: decoded.uid };
    },
    workspaceSlugsForUser,
    provisionGatewayAuthSecret,
    listGatewayBuilds,
    ...(httpKubeOps
      ? {
          readGatewayPodDiagnostics: (gatewayId: string) =>
            httpKubeOps.readGatewayPodDiagnostics({ namespace: NAMESPACE, gatewayId }),
          readGatewayPodDiagnosticsBatch: (gatewayIds: readonly string[]) =>
            httpKubeOps.readGatewayPodDiagnosticsBatch({ namespace: NAMESPACE, gatewayIds }),
        }
      : {}),
    suspendAuthUser: (uid) => disableAuthUserAndRevokeSessions(uid, getAuth()),
    revokeConnectorGrantsForUser: (uid) =>
      revokeAllConnectorGrantsForUser(uid, CONNECTOR_OAUTH_REVOCATION_TARGETS, {
        db,
        decryptSecret: decryptConnectorSecret,
        logger: { warn: log },
      }),
  });
  return [
    stopReconciler,
    stopWorker,
    stopOperationQueueDrain,
    stopPoller,
    stopReaper,
    stopStuckOpReaper,
    stopHelmRecoverySweeper,
    stopPlacementPolicyReconciler,
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
      prepareGatewayConfig,
      chartFingerprint,
    },
  );

  const surgeTransport = createSurgePodTransport({
    privateKey: fleetControllerPrivateKey,
    log,
  });
  const surgeHandoffDeps = {
    ...surgeTransport,
    listPods: (gatewayId: string) => listSurgePods(runKubectl, NAMESPACE, gatewayId),
    readAssignments: async (gatewayId: string) => {
      const [assignments, userSnapshot] = await Promise.all([
        readAssignmentDocsForGateway(db, gatewayId),
        db.collection("users")
          .where("provisioning.openclaw.gatewayId", "==", gatewayId)
          .get(),
      ]);
      const projected = assignments.map((assignment) => ({
        uid: assignment.uid,
        slug: assignment.slug,
        state: assignment.state,
        epoch: assignment.epoch,
        updatedByOperationId: assignment.updatedByOperationId,
      }));
      const assignedUsers = userSnapshot.docs.map((doc) => {
        const slug = slugFromAssignedUser(doc.data() as Record<string, unknown>);
        if (!slug) throw new Error(`assigned user ${doc.id} has no gateway slug`);
        return { uid: doc.id, slug };
      });
      assertSurgeAssignmentCoverage(projected, assignedUsers);
      return projected;
    },
    readDurableSessionDigest: ({ pod, slug }: {
      pod: { uid: string; name: string; podIP: string; ready: boolean };
      slug: string;
    }) => readPodDurableSessionDigest(runKubectl, NAMESPACE, pod, slug),
    targetHasRequiredCapacity: async ({
      gatewayId,
      targetPodUid,
      requiredCapacity,
    }: {
      gatewayId: string;
      targetPodUid: string;
      requiredCapacity: "spot";
    }) => {
      const observation = await kubeOps.readGatewaySpotCapacity({
        namespace: NAMESPACE,
        gatewayId,
      });
      return observation.pods.some((pod) =>
        pod.uid === targetPodUid && pod.capacityClass === requiredCapacity);
    },
    markAssignment: (input: {
      gatewayId: string;
      uid: string;
      slug: string;
      epoch: number;
      state: "serving" | "quiescing";
      updatedByOperationId: string;
      expected: {
        state: AssignmentState;
        updatedByOperationId: string | null;
      };
    }) => markAssignmentState(
      {
        db: db as unknown as FleetStateFirestore,
        serverTimestamp: () => FieldValue.serverTimestamp(),
        log,
      },
      input,
    ),
    log,
  };

  const runGatewayConvergence = (gatewayIds?: readonly string[]) =>
    runGatewayConvergencePass({
      db,
      helm,
      kubeOps,
      chartFingerprint,
      prepareGatewayConfig,
      reconcileSurgeHandoff: (input) => reconcileSurgeCustomerHandoff(surgeHandoffDeps, input),
      log,
    }, gatewayIds);
  const convergeGateways = serializeGatewayConvergence(runGatewayConvergence);

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
    convergeGateways,
    operatorReadyRefreshMs: OPERATOR_READY_REFRESH_MS_DEFAULT,
    chartFingerprint,
    ensureGatewayAuthSecret: authSecretEnsurer.ensureAuthSecret,
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
    `[glm-controller] boot sha=${process.env.BUILD_SHA ?? "unknown"} oc=${process.env.OPENCLAW_VERSION ?? "n/a"} fork=${process.env.OPENCLAW_FORK_SHA ?? "n/a"} node=${process.version} — namespace=${NAMESPACE} gatewayChart=${GATEWAY_CHART} chartFingerprint=${chartFingerprint.slice(0, 12)} chartDriftPolicy=release-gated valuesFile=${GATEWAY_VALUES_FILE}`,
  );

  await bootstrapGlmGateways(deps);
  await bootstrapDefaultGateway(deps);
  const sharedGatewayPoolDeps = {
    db,
    namespace: NAMESPACE,
    declaredSharedGatewayIds: parseDeclaredSharedGatewayIds(process.env.SHARED_GATEWAY_IDS),
    ensureGatewayAuthSecret: deps.ensureGatewayAuthSecret,
    convergeGateways: deps.convergeGateways,
    workFrozen: () => controllerWorkFrozen(deps, "shared pool reconcile"),
    log: deps.log,
    now: () => Date.now(),
  };
  await runSharedGatewayPoolReconcile(sharedGatewayPoolDeps, "startup");
  const sharedGatewayCapacityDeps = {
    listSharedGatewayIds: async () => {
      const snapshot = await db.doc("config/orchestrator").get();
      const config = parseSharedGatewayPoolConfig(snapshot.exists ? snapshot.data() : undefined);
      if (!config) throw new Error("config/orchestrator must contain a valid sharedGatewayIds pool");
      return config.sharedGatewayIds;
    },
    readGateway: async (gatewayId: string) => {
      const snapshot = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
      const gateway = projectGatewayDesiredRootForGateway(
        snapshot.exists ? snapshot.data() : undefined,
        gatewayId,
      );
      return gateway
        ? {
            gatewayId: gateway.gatewayId,
            gatewayClass: gateway.gatewayClass,
            desiredStatus: gateway.desiredStatus,
            managedBy: gateway.managedBy,
          }
        : null;
    },
    readSpotCapacity: (gatewayId: string) => deps.kubeOps!.readGatewaySpotCapacity({
      namespace: NAMESPACE,
      gatewayId,
    }),
    hasActiveCapacityRebalance: () => hasActiveCapacityRebalanceOperation(db),
    enqueueCapacityRebalance: (input: {
      gatewayId: string;
      sourcePodUid: string;
      operationId: string;
    }) => enqueueSharedGatewayCapacityRebalance(db, input),
    workFrozen: () => controllerWorkFrozen(deps, "shared capacity reconcile"),
    log: deps.log,
  };

  if (await controllerWorkFrozen(deps, "orphan-op resume")) {
    holdFrozenController(maintenanceGate, log);
    return;
  }

  try {
    await completeHealthyBootstrapAddGatewayOperations({
      db,
      log,
      now: () => Date.now(),
    });
  } catch (err) {
    log(
      `[glm-controller] ⚠ bootstrap add-gateway recovery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
    resumableOperation: operationIsRestartResumable,
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
    startSharedGatewayPoolReconciler(sharedGatewayPoolDeps, SHARED_GATEWAY_POOL_RECONCILE_MS),
  );
  stoppers.push(
    startSharedGatewayCapacityReconciler(
      sharedGatewayCapacityDeps,
      SHARED_GATEWAY_CAPACITY_RECONCILE_MS,
    ),
  );
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

async function hasActiveCapacityRebalanceOperation(db: Firestore): Promise<boolean> {
  const operations = db.collection(GLM_OPERATIONS_COLLECTION);
  const snapshots = await Promise.all([
    operations.where("status", "==", "pending").get(),
    operations.where("status", "==", "running").get(),
  ]);
  return snapshots.some((snapshot) => snapshot.docs.some((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return data.kind === CAPACITY_REBALANCE_GATEWAY_KIND;
  }));
}

async function enqueueSharedGatewayCapacityRebalance(
  db: Firestore,
  input: { gatewayId: string; sourcePodUid: string; operationId: string },
): Promise<{ kind: "created" | "existing" | "blocked"; operationId: string }> {
  const operations = db.collection(GLM_OPERATIONS_COLLECTION);
  const queueRef = db.doc("config/capacity-rebalance-queue");
  return db.runTransaction(async (transaction) => {
    let operationId = input.operationId;
    let operationRef = operations.doc(operationId);
    const [operationSnapshot, queueSnapshot] = await Promise.all([
      transaction.get(operationRef),
      transaction.get(queueRef),
    ]);
    const existingStatus = operationSnapshot.exists ? operationSnapshot.data()?.status : undefined;
    if (existingStatus === "pending" || existingStatus === "running" || existingStatus === "succeeded") {
      return { kind: "existing" as const, operationId };
    }
    if (operationSnapshot.exists) {
      operationId = `${input.operationId}-retry-${Date.now()}`;
      operationRef = operations.doc(operationId);
      const retrySnapshot = await transaction.get(operationRef);
      if (retrySnapshot.exists) return { kind: "existing" as const, operationId };
    }
    const queuedOperationId = queueSnapshot.data()?.operationId;
    if (typeof queuedOperationId === "string" && queuedOperationId !== operationId) {
      const queuedOperation = await transaction.get(operations.doc(queuedOperationId));
      const queuedStatus = queuedOperation.exists ? queuedOperation.data()?.status : undefined;
      if (queuedStatus === "pending" || queuedStatus === "running") {
        return { kind: "blocked" as const, operationId: queuedOperationId };
      }
    }
    const now = Date.now();
    transaction.set(operationRef, {
      kind: CAPACITY_REBALANCE_GATEWAY_KIND,
      status: "pending",
      origin: "automatic",
      createdBy: "glm-controller-shared-capacity",
      createdAt: now,
      startedAt: null,
      completedAt: null,
      gatewayId: input.gatewayId,
      input: {
        gatewayId: input.gatewayId,
        sourcePodUid: input.sourcePodUid,
      },
      steps: [],
    });
    transaction.set(queueRef, {
      operationId,
      gatewayId: input.gatewayId,
      sourcePodUid: input.sourcePodUid,
      updatedAt: now,
    });
    return { kind: "created" as const, operationId };
  });
}

export async function bootstrapGlmGateways(deps: ControllerDeps): Promise<void> {
  if (await controllerWorkFrozen(deps, "glm gateway bootstrap")) return;
  deps.log("[glm-controller] legacy Helm bootstrap disabled; durable roots and revisions own recovery");
}

function bootstrapGatewayArtifactFromEnvironment(): GatewayArtifact {
  const imageRepository = process.env.BOOTSTRAP_IMAGE_REPOSITORY?.trim();
  if (!imageRepository) {
    throw new Error("BOOTSTRAP_IMAGE_REPOSITORY is required when default gateway bootstrap is enabled");
  }
  const imageTag = process.env.BOOTSTRAP_IMAGE_TAG?.trim();
  if (!imageTag || !isGatewayImageTag(imageTag)) {
    throw new Error("BOOTSTRAP_IMAGE_TAG must be an immutable gateway image tag");
  }
  const gatewayEdgeImageRepository = process.env.BOOTSTRAP_GATEWAY_EDGE_IMAGE_REPOSITORY?.trim();
  if (!gatewayEdgeImageRepository) {
    throw new Error(
      "BOOTSTRAP_GATEWAY_EDGE_IMAGE_REPOSITORY is required when default gateway bootstrap is enabled",
    );
  }
  const gatewayEdgeImageTag = process.env.BOOTSTRAP_GATEWAY_EDGE_IMAGE_TAG?.trim();
  if (!gatewayEdgeImageTag || !isGatewayImageTag(gatewayEdgeImageTag)) {
    throw new Error("BOOTSTRAP_GATEWAY_EDGE_IMAGE_TAG must be an immutable gateway-edge image tag");
  }
  const gatewayEdgeImage = {
    imageRepository: gatewayEdgeImageRepository,
    imageTag: gatewayEdgeImageTag,
  };
  if (!isGatewayEdgeImage(gatewayEdgeImage, imageRepository)) {
    throw new Error(
      "BOOTSTRAP_GATEWAY_EDGE_IMAGE_REPOSITORY and BOOTSTRAP_GATEWAY_EDGE_IMAGE_TAG must identify the paired immutable gateway-edge image",
    );
  }
  return { imageRepository, imageTag, gatewayEdgeImage };
}

export async function bootstrapDefaultGateway(deps: ControllerDeps): Promise<void> {
  if (await controllerWorkFrozen(deps, "default gateway bootstrap")) return;
  if (process.env.BOOTSTRAP_DEFAULT_GATEWAY !== "true") {
    deps.log("[glm-controller] durable default gateway bootstrap disabled");
    return;
  }

  const gatewayId = "default";
  const gatewayRef = deps.db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
  const durableDefaultExists = async (): Promise<boolean> => {
    const gateway = await gatewayRef.get();
    if (!gateway.exists) return false;
    const gatewayData = gateway.data() as { desiredRelease?: unknown } | undefined;
    const desiredRelease = gatewayData?.desiredRelease;
    if (typeof desiredRelease !== "number") {
      throw new Error(
        `default gateway bootstrap found durable root gateways/${gatewayId} with a non-numeric desiredRelease`,
      );
    }
    const release = await gatewayRef
      .collection(GATEWAY_RELEASES_SUBCOLLECTION)
      .doc(String(desiredRelease))
      .get();
    if (!release.exists) {
      throw new Error(
        `default gateway bootstrap found durable root gateways/${gatewayId} referencing missing release ${desiredRelease}`,
      );
    }
    return true;
  };

  if (await durableDefaultExists()) {
    deps.log("[glm-controller] durable default gateway already exists");
    return;
  }

  const artifact = bootstrapGatewayArtifactFromEnvironment();
  const imageTag = artifact.imageTag;

  await deps.ensureGatewayAuthSecret({
    namespace: NAMESPACE,
    gatewayId,
  });
  const now = Date.now();
  const createdBy = "glm-controller-bootstrap";
  const operationRef = deps.db.collection(GLM_OPERATIONS_COLLECTION).doc();
  try {
    await writeInitialGatewayRelease(deps.db, {
      gatewayId,
      createdBy,
      now,
      desiredStatus: "running",
      config: {
        configSchemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
        profile: null,
        gatewayClass: "shared",
        imageProfile: "standard",
        sizingTier: null,
        gcpProject: null,
        gatewayContainerSecurityContext: null,
        serviceAccountName: null,
        serviceAccount: null,
        operatorAccess: null,
        ownerUid: null,
        builderSlug: null,
        openclawOverrides: null,
        modelBrokerLimits: null,
      },
      artifact,
      writeAdditional: (transaction) => {
        transaction.set(operationRef, {
          kind: "add-gateway",
          status: "pending",
          origin: "automatic",
          createdBy,
          createdAt: now,
          startedAt: null,
          completedAt: null,
          gatewayId,
          input: {
            gatewayId,
            imageTag,
            gatewayClass: "shared",
            source: "default-gateway-bootstrap",
          },
          steps: [],
        });
      },
    });
  } catch (error) {
    if (
      error instanceof InitialGatewayReleaseConflictError &&
      await durableDefaultExists()
    ) {
      deps.log("[glm-controller] durable default gateway already exists");
      return;
    }
    throw error;
  }
  deps.log(
    `[glm-controller] queued durable default gateway release 1 (${imageTag})`,
  );
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
        fleetControllerPort: FLEET_CONTROLLER_PORT,
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

type CapacityRebalanceNonceClaim =
  | { kind: "claimed"; sourcePodUids: readonly string[] }
  | { kind: "completed" }
  | { kind: "rejected"; error: string };

type CapacityRebalanceGatewayRoot = NonNullable<
  ReturnType<typeof projectGatewayDesiredRootForGateway>
>;

function capacityRebalanceClaimRoot(
  root: CapacityRebalanceGatewayRoot | null,
  gatewayId: string,
): { root: CapacityRebalanceGatewayRoot } | { error: string } {
  if (!root) return { error: `gateway ${gatewayId} has no durable desired state` };
  if (root.gatewayClass !== "shared") return { error: `gateway ${gatewayId} is not a shared gateway` };
  if (root.desiredStatus !== "running") {
    return { error: `gateway ${gatewayId} is ${root.desiredStatus}, not running` };
  }
  if (isOperatorManaged(root.managedBy)) return { error: `gateway ${gatewayId} is operator-managed` };
  return { root };
}

function existingCapacityRebalanceClaim(
  root: CapacityRebalanceGatewayRoot,
  gatewayId: string,
  operationId: string,
): CapacityRebalanceNonceClaim | null {
  const current = gatewayCapacityRebalanceIntent(root.capacityRebalance);
  if (root.capacityRebalance !== undefined && !current) {
    return { kind: "rejected", error: `gateway ${gatewayId} has malformed capacity rebalance state` };
  }
  if (!current?.active) {
    return current?.operationId === operationId && root.capacityRebalanceNonce === operationId
      ? { kind: "completed" }
      : null;
  }
  if (root.capacityRebalanceNonce !== current.nonce) {
    return { kind: "rejected", error: `gateway ${gatewayId} has malformed active capacity rebalance state` };
  }
  if (current.operationId !== operationId) {
    return {
      kind: "rejected",
      error: `gateway ${gatewayId} capacity rebalance is owned by ${current.operationId}`,
    };
  }
  return { kind: "claimed", sourcePodUids: current.sourcePodUids };
}

async function claimCapacityRebalanceNonce(
  db: Firestore,
  input: { gatewayId: string; operationId: string; sourcePodUids: readonly string[] },
): Promise<CapacityRebalanceNonceClaim> {
  return db.runTransaction(async (txn) => {
    const ref = db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
    const snapshot = await txn.get(ref);
    const root = projectGatewayDesiredRootForGateway(
      snapshot.exists ? snapshot.data() : undefined,
      input.gatewayId,
    );
    const checked = capacityRebalanceClaimRoot(root, input.gatewayId);
    if ("error" in checked) return { kind: "rejected", error: checked.error };
    const existing = existingCapacityRebalanceClaim(
      checked.root,
      input.gatewayId,
      input.operationId,
    );
    if (existing) return existing;
    const existingNonce = checked.root.capacityRebalanceNonce;
    if (existingNonce !== undefined && typeof existingNonce !== "string") {
      return {
        kind: "rejected",
        error: `gateway ${input.gatewayId} has malformed capacity rebalance nonce`,
      };
    }
    const now = Date.now();
    txn.set(ref, {
      capacityRebalanceNonce: input.operationId,
      capacityRebalance: {
        nonce: input.operationId,
        active: true,
        operationId: input.operationId,
        previousNonce: existingNonce ?? null,
        sourcePodUids: [...input.sourcePodUids],
        requestedAt: now,
      },
      updatedAt: now,
      updatedBy: `capacity-rebalance:${input.operationId}`,
    }, { merge: true });
    return { kind: "claimed", sourcePodUids: [...input.sourcePodUids] };
  });
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
    prepareGatewayConfig: <T extends GatewayMutableConfig & { gatewayId: string }>(
      config: T,
    ) => Promise<T>;
    chartFingerprint: string;
  },
): Promise<OperationHandlers> {
  const { privateKey, modelKeySourceIssuer } = fleetOps;
  if (!privateKey) {
    throw new Error(
      "FLEET_CONTROLLER_PRIVATE_KEY is not set — required for migrate-customer. Refusing to start with stub handlers.",
    );
  }

  const addGateway = createAddGatewayHandler({
    helm,
    kubeOps,
    resolveGatewayRevision: async (gatewayId) => {
      const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
      const authorization = gatewayAuthorizationFromRootDocument(
        snap.exists ? snap.data() : undefined,
        gatewayId,
      );
      if (!authorization) return null;
      const gateway = authorization.gateway as DurableGateway;
      const artifact = await readGatewayArtifact(db, gatewayId, gateway.desiredRelease);
      if (!artifact) return null;
      return {
        gatewayId,
        revisionId: gatewayId,
        imageTag: artifact.imageTag,
        gatewayClass: resolveGatewayClass({
          gatewayClass: gateway.gatewayClass ?? undefined,
          profile: gateway.profile ?? undefined,
          imageProfile: gateway.imageProfile ?? undefined,
        }),
      };
    },
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
    revisionMaterializationTimeoutMs: 120_000,
    helmRenderTimeoutMs: 600_000,
    deploymentReadyTimeoutMs: ADD_GATEWAY_DEPLOYMENT_READY_TIMEOUT_MS,
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
          assignment: {
            source: MIGRATE_CUSTOMER_KIND,
            updatedByOperationId: null,
          },
          automatic: commit.automatic,
        },
      );
    },
    resolveGatewayUrl: (gatewayId) => resolveGatewayUrlFromFirestore(db, gatewayId),
    buildClient: createMigrationClientBuilder(
      db,
      privateKey,
      logFn,
    ),
    resolveSourcePlacement: async (uid, currentGatewayId) => {
      const source = await resolveSourceRevisionFromFirestore(db, uid, currentGatewayId);
      if (!source) return null;
      return {
        release: source.release,
        ...(source.epoch !== undefined ? { epoch: source.epoch } : {}),
        assignmentMode: source.assignmentMode,
      };
    },
    resolveTargetPlacement: async (toGatewayId) => {
      const placement = await resolvePlacementFromFirestore(db, toGatewayId);
      if (!placement) return null;
      return placement.ok
        ? { ok: true, release: placement.release }
        : { ok: false, reason: placement.reason };
    },
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
    readGatewayRootFence: async (gatewayId) => {
      const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
      return customerMigrationV2GatewayRootFence(
        snap.exists ? snap.data() : undefined,
        gatewayId,
      );
    },
    commitV2Cutover: async (input) => {
      await commitCutoverAtomic(
        {
          db: db as unknown as FleetStateFirestore,
          serverTimestamp: () => FieldValue.serverTimestamp(),
          log: logFn,
        },
        {
          uid: input.uid,
          slug: input.slug,
          toGatewayId: input.targetGatewayId,
          fromGatewayId: input.sourceGatewayId,
          flipMirror: input.sourceGatewayId !== input.targetGatewayId,
          assignment: {
            source: MIGRATE_CUSTOMER_KIND,
            updatedByOperationId: input.operationId,
          },
          customerMigrationV2Fence: {
            operationId: input.operationId,
            migrationId: input.migrationId,
            uid: input.uid,
            slug: input.slug,
            sourceGatewayId: input.sourceGatewayId,
            sourceEpoch: input.sourceEpoch,
            sourceRelease: input.sourceRelease,
            sourceAssignmentMode: input.sourceAssignmentMode,
            sourceRootFence: input.sourceRootFence,
            targetGatewayId: input.targetGatewayId,
            targetRelease: input.targetRelease,
            targetRootFence: input.targetRootFence,
          },
          automatic: input.automatic,
        },
      );
    },
    // Durable (V2) migration when neither side is shared-class; roots must be
    // converged (no in-flight release roll) for every class.
    useDurableMigration: async (fromGatewayId, toGatewayId) => {
      const [source, target] = await Promise.all([
        db.collection(GATEWAYS_COLLECTION).doc(fromGatewayId).get(),
        db.collection(GATEWAYS_COLLECTION).doc(toGatewayId).get(),
      ]);
      const sourceAuthorization = gatewayAuthorizationFromRootDocument(
        source.data(),
        fromGatewayId,
      );
      const targetAuthorization = gatewayAuthorizationFromRootDocument(
        target.data(),
        toGatewayId,
      );
      if (!sourceAuthorization) {
        throw new Error(`source gateway ${fromGatewayId} has no durable root`);
      }
      if (!targetAuthorization) {
        throw new Error(`target gateway ${toGatewayId} has no durable root`);
      }
      const sourceData = sourceAuthorization.gateway as DurableGateway;
      const targetData = targetAuthorization.gateway as DurableGateway;
      const rootIsStable = (data: DurableGateway) =>
        data.desiredStatus === "running" &&
        data.liveRelease !== null &&
        data.desiredRelease === data.liveRelease;
      if (!rootIsStable(sourceData)) {
        throw new Error(`source gateway ${fromGatewayId} has an active or unconverged release roll`);
      }
      if (!rootIsStable(targetData)) {
        throw new Error(`target gateway ${toGatewayId} has an active or unconverged release roll`);
      }
      const gatewayClass = (data: typeof sourceData) => resolveGatewayClass({
        gatewayClass: data.gatewayClass ?? undefined,
        profile: data.profile ?? undefined,
        imageProfile: data.imageProfile ?? undefined,
      });
      return gatewayClass(sourceData) !== "shared" && gatewayClass(targetData) !== "shared";
    },
    genMigrationId: (operationId) => `mig-${operationId}`,
    now: () => Date.now(),
    log: logFn,
  });

  const retireGateway = createRetireGatewayHandler({
    verifyRetirementClaim: ({ gatewayId, operationId, version }) =>
      verifyGatewayRetirementClaimAtomic({
        db,
        gatewayId,
        operationId,
        version,
        now: Date.now(),
        updatedBy: "cowboy-retire-gateway",
      }),
    assertAutomaticRetirementMayMutate: async (gatewayId) => {
      await db.runTransaction(async (txn) => {
        const rootRef = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
        const rootSnap = await txn.get(rootRef);
        const root = projectGatewayDesiredRootForGateway(
          rootSnap.exists ? rootSnap.data() : undefined,
          gatewayId,
        );
        if (root === null) throw new Error(`gateway ${gatewayId} durable root is unavailable`);
        if (isOperatorManaged(root.managedBy)) {
          throw new Error(`gateway ${gatewayId} is operator-managed`);
        }
        if (!root.ownerUid) return;
        const userSnap = await txn.get(db.collection("users").doc(root.ownerUid));
        if (isOperatorManaged(readPath(
          userSnap.exists ? userSnap.data() as Record<string, unknown> : undefined,
          "provisioning.openclaw.managedBy",
        ))) {
          throw new Error(`builder ${root.ownerUid} is operator-managed`);
        }
      });
    },
    readMountedCustomers: async (gatewayId) => {
      const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      const runtime = snap.exists ? snap.data() : undefined;
      if (!isGatewayRuntimeDoc(runtime)) return [];
      return readMountedCustomers(runtime as unknown as Record<string, unknown>, undefined);
    },
    helmUninstallGateway: async (gatewayId) => {
      await helm.removeInstance({ namespace: NAMESPACE, gatewayId });
    },
    readAssignmentsForGateway: async (gatewayId) => {
      const assignments = await readAssignmentDocsForGateway(db, gatewayId);
      return assignments.map((a) => ({ uid: a.uid, slug: a.slug }));
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
    activateDesiredRelease: async ({ gatewayId, targetRelease, operationId }) =>
      db.runTransaction(async (transaction) => {
        const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
        const snapshot = await transaction.get(gatewayRef);
        const gateway = durableRolloutGateway(
          snapshot.exists ? snapshot.data() : undefined,
          gatewayId,
        );
        if (!gateway) {
          return {
            success: false as const,
            error: `gateway ${gatewayId} durable root is unavailable`,
          };
        }
        const activation = planDesiredReleaseActivation(
          gateway,
          targetRelease,
          Date.now(),
          operationId,
        );
        if (!activation.success || activation.patch === null) return activation;
        transaction.update(gatewayRef, activation.patch);
        return { success: true as const };
      }),
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
  const suspendCustomer = buildSuspendCustomerHandler(
    db,
    privateKey,
    logFn,
    kubeOps,
  );
  const eraseCustomer = buildEraseCustomerHandler(db, logFn);

  const restartGateway = createRestartGatewayHandler({
    kubeOps,
    namespace: NAMESPACE,
    resolveLiveRevisionId: async (gatewayId) => {
      const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      const runtime = snap.exists ? snap.data() : undefined;
      return isGatewayRuntimeDoc(runtime) && runtime.lifecycle === "serving"
        ? gatewayId
        : null;
    },
    now: () => Date.now(),
    log: logFn,
  });

  const recycleGateway = createRecycleGatewayHandler({
    readDesiredStatus: async (gatewayId) => {
      const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
      const authorization = gatewayAuthorizationFromRootDocument(
        snap.exists ? snap.data() : undefined,
        gatewayId,
      );
      return authorization ? authorization.gateway.desiredStatus : null;
    },
    setDesiredStatus: async (gatewayId, status) => {
      await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).set(
        { desiredStatus: status, updatedAt: Date.now(), updatedBy: "cowboy-recycle-gateway" },
        { merge: true },
      );
    },
    readServingRevisionId: async (gatewayId) => {
      const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      const runtime = snap.exists ? snap.data() : undefined;
      return isGatewayRuntimeDoc(runtime) && runtime.lifecycle === "serving"
        ? gatewayId
        : null;
    },
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

  const capacityRebalanceGateway = createCapacityRebalanceGatewayHandler({
    readGateway: async (gatewayId) => {
      const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
      const root = projectGatewayDesiredRootForGateway(
        snap.exists ? snap.data() : undefined,
        gatewayId,
      );
      return root
        ? {
            gatewayClass: root.gatewayClass,
            desiredStatus: root.desiredStatus,
            managedBy: root.managedBy,
            capacityRebalance: gatewayCapacityRebalanceIntent(root.capacityRebalance),
            capacityRebalanceNonce: root.capacityRebalanceNonce,
          }
        : null;
    },
    claimNonce: (input) => claimCapacityRebalanceNonce(db, input),
    completeNonce: async ({ gatewayId, operationId }) =>
      db.runTransaction(async (txn) => {
        const ref = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
        const snap = await txn.get(ref);
        const root = projectGatewayDesiredRootForGateway(
          snap.exists ? snap.data() : undefined,
          gatewayId,
        );
        const current = gatewayCapacityRebalanceIntent(root?.capacityRebalance);
        if (!root || !current || current.operationId !== operationId) {
          return {
            kind: "rejected" as const,
            error: `gateway ${gatewayId} capacity rebalance ownership changed before completion`,
          };
        }
        if (!current.active && root.capacityRebalanceNonce === operationId) {
          return { kind: "completed" as const };
        }
        if (!current.active || root.capacityRebalanceNonce !== operationId) {
          return {
            kind: "rejected" as const,
            error: `gateway ${gatewayId} capacity rebalance nonce changed before completion`,
          };
        }
        const now = Date.now();
        txn.set(ref, {
          capacityRebalance: { ...current, active: false },
          updatedAt: now,
          updatedBy: `capacity-rebalance:${operationId}`,
        }, { merge: true });
        return { kind: "completed" as const };
      }),
    revertNonce: async ({ gatewayId, operationId }) => {
      await db.runTransaction(async (txn) => {
        const ref = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
        const snap = await txn.get(ref);
        const root = projectGatewayDesiredRootForGateway(
          snap.exists ? snap.data() : undefined,
          gatewayId,
        );
        const current = gatewayCapacityRebalanceIntent(root?.capacityRebalance);
        if (!root || !current || current.operationId !== operationId) {
          throw new Error(`gateway ${gatewayId} capacity rebalance ownership changed before revert`);
        }
        if (!current.active) return;
        if (root.capacityRebalanceNonce !== current.nonce) {
          throw new Error(`gateway ${gatewayId} capacity rebalance nonce changed before revert`);
        }
        const now = Date.now();
        txn.set(ref, {
          ...(current.previousNonce === null
            ? { capacityRebalanceNonce: FieldValue.delete() }
            : { capacityRebalanceNonce: current.previousNonce }),
          capacityRebalance: { ...current, active: false },
          updatedAt: now,
          updatedBy: `capacity-rebalance:${operationId}`,
        }, { merge: true });
      });
    },
    readSpotCapacity: (gatewayId) => kubeOps.readGatewaySpotCapacity({
      namespace: NAMESPACE,
      gatewayId,
    }),
    requestReconcileTick: () => requestReconcileTickRef.fire?.(),
    now: () => Date.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: logFn,
    readyTimeoutMs: 9 * 60_000,
    rollbackTimeoutMs: 4 * 60_000,
    progressIntervalMs: 60_000,
    pollIntervalMs: 5_000,
  });

  return {
    "add-gateway": addGateway,
    [MIGRATE_CUSTOMER_KIND]: migrateCustomer,
    "retire-gateway": retireGateway,
    "restart-gateway": restartGateway,
    "recycle-gateway": recycleGateway,
    [CAPACITY_REBALANCE_GATEWAY_KIND]: capacityRebalanceGateway,
    rollout,
    "deprovision-customer": deprovisionCustomer,
    "suspend-customer": suspendCustomer,
    "erase-customer": eraseCustomer,
  };
}

function timestampMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    const result = (value as { toMillis: () => unknown }).toMillis();
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  }
  return null;
}

export function gatewayCapacityRebalanceIntent(
  value: unknown,
): GatewayCapacityRebalanceIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.nonce !== "string" ||
    typeof record.active !== "boolean" ||
    typeof record.operationId !== "string" ||
    (record.previousNonce !== null && typeof record.previousNonce !== "string") ||
    record.nonce !== record.operationId ||
    !Array.isArray(record.sourcePodUids) ||
    record.sourcePodUids.length === 0 ||
    !record.sourcePodUids.every((podUid) => typeof podUid === "string" && podUid.length > 0) ||
    typeof record.requestedAt !== "number" ||
    !Number.isFinite(record.requestedAt)
  ) {
    return null;
  }
  return {
    nonce: record.nonce,
    active: record.active,
    operationId: record.operationId,
    previousNonce: record.previousNonce,
    sourcePodUids: record.sourcePodUids,
    requestedAt: record.requestedAt,
  };
}

function deletionEnvironment(): string {
  return (process.env.GOOGLE_CLOUD_PROJECT ?? "").endsWith("-test")
    ? "test"
    : "prod";
}

function deletionPlanTier(user: Record<string, unknown> | undefined): string | null {
  if (typeof user?.selectedTier === "string") return user.selectedTier;
  const subscription = user?.subscription as Record<string, unknown> | undefined;
  return typeof subscription?.tier === "string" ? subscription.tier : null;
}

function deletionGatewayClass(gateway: Record<string, unknown> | undefined): string | null {
  if (!gateway) return null;
  const gatewayClass = isGatewayClass(gateway.gatewayClass) ? gateway.gatewayClass : undefined;
  const profile = isGatewayProfile(gateway.profile) ? gateway.profile : undefined;
  const imageProfile = isGatewayProfile(gateway.imageProfile) ? gateway.imageProfile : undefined;
  return resolveGatewayClass({ gatewayClass, profile, imageProfile });
}

async function deletionGateway(
  db: Firestore,
  currentGatewayId: unknown,
): Promise<Record<string, unknown> | undefined> {
  if (typeof currentGatewayId !== "string") return undefined;
  const snapshot = await db.collection(GATEWAYS_COLLECTION).doc(currentGatewayId).get();
  return snapshot.data() as Record<string, unknown> | undefined;
}

async function ensureAnonymousDeletionArchive(
  db: Firestore,
  deletionId: string,
): Promise<string> {
  const jobRef = db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) throw new Error(`deletion job missing: ${deletionId}`);
  const job = jobSnap.data() as Record<string, unknown>;
  if (typeof job.archiveId === "string" && job.archiveId.length > 0) {
    return job.archiveId;
  }
  if (typeof job.uid !== "string") throw new Error(`deletion job ${deletionId} has no uid`);
  const uid = job.uid;
  const [userSnap, rollupSnap, gateway] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection(MODEL_BROKER_USAGE_ROLLUPS_COLLECTION).doc(uid).get(),
    deletionGateway(db, job.currentGatewayId),
  ]);
  const user = userSnap.data() as Record<string, unknown> | undefined;
  const archiveRef = db.collection(ANONYMOUS_OPERATIONAL_ARCHIVES_COLLECTION).doc();
  const archive = buildAnonymousOperationalArchive({
    archivedAt: Date.now(),
    createdAt: timestampMillis(user?.createdAt),
    deletionRequestedAt: timestampMillis(job.requestedAt) ?? Date.now(),
    environment: deletionEnvironment(),
    planTier: deletionPlanTier(user),
    gatewayClass: deletionGatewayClass(gateway),
    rollup: (rollupSnap.data() ?? {}) as Record<string, unknown>,
  });
  const batch = db.batch();
  batch.create(archiveRef, archive);
  batch.set(jobRef, { archiveId: archiveRef.id, updatedAt: Date.now() }, { merge: true });
  await batch.commit();
  return archiveRef.id;
}

function buildEraseCustomerHandler(db: Firestore, logFn: (msg: string) => void) {
  const cloudCleanup = buildCustomerCloudCleanupDeps(db, logFn);
  return createEraseCustomerHandler({
    loadDeletionJob: async (deletionId) => {
      const snap = await db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId).get();
      if (!snap.exists) return null;
      const data = snap.data() as Record<string, unknown>;
      if (
        typeof data.uid !== "string" ||
        typeof data.eraseAfter !== "number"
      ) {
        throw new Error(`deletion job ${deletionId} is malformed`);
      }
      return {
        uid: data.uid,
        status: typeof data.status === "string" ? data.status : "malformed",
        eraseAfter: data.eraseAfter,
        stripeCustomerIds: Array.isArray(data.stripeCustomerIds)
          ? data.stripeCustomerIds.filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            )
          : [],
        archiveId: typeof data.archiveId === "string" ? data.archiveId : null,
        cleanupContext:
          data.cleanupContext && typeof data.cleanupContext === "object"
            ? data.cleanupContext as CustomerCleanupContext
            : null,
      };
    },
    ensureAnonymousArchive: (deletionId) => ensureAnonymousDeletionArchive(db, deletionId),
    deleteStripeCustomer: (customerId) =>
      deleteStripeCustomer(
        fetch,
        requireEnv("STRIPE_SECRET_KEY", "customer erasure must delete Stripe PII"),
        customerId,
      ),
    discoverStripeCustomerIds: (uid) =>
      listStripeCustomerIdsForUid(
        fetch,
        requireEnv("STRIPE_SECRET_KEY", "customer erasure must discover Stripe PII"),
        uid,
      ),
    persistStripeCustomerIds: async (deletionId, customerIds) => {
      await db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId).set({
        stripeCustomerIds: customerIds,
        updatedAt: Date.now(),
      }, { merge: true });
    },
    ensureOwnedGatewayRetired: (cleanup, deletionId) =>
      ensureOwnedGatewaysRetired({
        db,
        uid: cleanup.uid,
        deletionId,
        now: Date.now(),
      }),
    findUndrainedArtifactIds: async (artifactIds) => {
      const snapshots = await Promise.all(
        artifactIds.map((artifactId) => db.collection("chatArtifactJobs").doc(artifactId).get()),
      );
      const now = Date.now();
      return snapshots.flatMap((snapshot, index) => {
        if (!snapshot.exists) return [];
        const data = snapshot.data() as Record<string, unknown>;
        if (!data.lease || typeof data.lease !== "object") return [];
        const expiresAt = (data.lease as Record<string, unknown>).expiresAt;
        if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) {
          throw new Error(`chat artifact lease is malformed: ${snapshot.ref.path}`);
        }
        return Date.parse(expiresAt) + 60_000 > now ? [artifactIds[index]] : [];
      });
    },
    cloudErase: (cleanup, currentOperationId) =>
      nukeUserCloudSide({ ...cleanup, currentOperationId }, cloudCleanup),
    verifyErasure: async (cleanup, currentOperationId) => {
      const remaining = await verifyCustomerFirestoreErasure(
        db,
        cleanup.uid,
        cleanup.slug,
        cleanup.email,
        currentOperationId,
      );
      remaining.push(...await verifyCustomerStorageErasure(
        getStorage().bucket(),
        cleanup.uid,
        cleanup.slug,
        cleanup.chatArtifactIds,
        cleanup.agentImportIds,
      ));
      for (const userId of [
        cleanup.mmUserId,
        cleanup.mmCoachUserId,
        ...cleanup.projectAgentMmUserIds,
      ]) {
        if (userId && await cloudCleanup.mattermost.userExists(userId)) {
          remaining.push(`mattermost/users/${userId}`);
        }
      }
      try {
        await getAuth().getUser(cleanup.uid);
        remaining.push(`firebaseAuth/${cleanup.uid}`);
      } catch (err) {
        const code = (err as { code?: string } | null | undefined)?.code;
        if (code !== "auth/user-not-found") throw err;
      }
      return remaining;
    },
    finalizeVerifiedErasure: async (deletionId, archiveId) => {
      const jobRef = db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId);
      const archiveRef = db.collection(ANONYMOUS_OPERATIONAL_ARCHIVES_COLLECTION).doc(archiveId);
      const batch = db.batch();
      batch.set(archiveRef, { cleanupOutcomeCodes: ["verified_erasure"] }, { merge: true });
      batch.set(jobRef, {
        status: "verified_pending_completion",
        archiveId,
        verifiedAt: Date.now(),
      }, { merge: true });
      await batch.commit();
    },
    now: () => Date.now(),
  });
}

function buildSuspendCustomerHandler(
  db: Firestore,
  privateKey: string,
  logFn: (msg: string) => void,
  kubeOps: Pick<KubeOps, "readAvailableReplicas">,
) {
  const decryptConnectorSecret = createConnectorSecretDecryptor();
  return createSuspendCustomerHandler({
    loadDeletionJob: async (deletionId) => {
      const snap = await db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId).get();
      if (!snap.exists) return null;
      const data = snap.data() as Record<string, unknown>;
      return {
        uid: typeof data.uid === "string" ? data.uid : "",
        slug: typeof data.slug === "string" ? data.slug : null,
        currentGatewayId:
          typeof data.currentGatewayId === "string" ? data.currentGatewayId : null,
        stripeCustomerIds: Array.isArray(data.stripeCustomerIds)
          ? data.stripeCustomerIds.filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            )
          : [],
        stripeSubscriptionIds: Array.isArray(data.stripeSubscriptionIds)
          ? data.stripeSubscriptionIds.filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            )
          : [],
        cleanupContext:
          data.cleanupContext && typeof data.cleanupContext === "object"
            ? data.cleanupContext as CustomerCleanupContext
            : null,
      };
    },
    loadCleanupContext: (uid) => loadCustomerCleanupContext({ db }, uid),
    persistCleanupContext: async (deletionId, cleanupContext) => {
      await db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId).set(
        { cleanupContext, status: "suspending", updatedAt: Date.now() },
        { merge: true },
      );
    },
    suspendAuthUser: (uid) => disableAuthUserAndRevokeSessions(uid, getAuth()),
    cancelCustomerMigrations: (uid) =>
      cancelCustomerMigrationsForSuspension(db, uid, Date.now()),
    deactivateCustomerVisibility: (uid) => deactivateCustomerVisibility(db, uid),
    invalidatePendingCredentialFlows: (uid) => invalidatePendingCredentialFlows(db, uid),
    unmountFromGateway: createCustomerDeletionUnmount(db, privateKey, logFn, kubeOps),
    cancelStripeSubscription: (subscriptionId) =>
      cancelStripeSubscription(
        fetch,
        requireEnv("STRIPE_SECRET_KEY", "customer suspension must cancel Stripe billing"),
        subscriptionId,
      ),
    listStripeCustomerIdsForUid: (uid) =>
      listStripeCustomerIdsForUid(
        fetch,
        requireEnv("STRIPE_SECRET_KEY", "customer suspension must discover Stripe billing"),
        uid,
      ),
    listLiveStripeSubscriptionIds: (customerId) =>
      listLiveStripeSubscriptionIds(
        fetch,
        requireEnv("STRIPE_SECRET_KEY", "customer suspension must verify Stripe billing"),
        customerId,
      ),
    listOpenStripeCheckoutSessionIds: (customerId) =>
      listOpenStripeCheckoutSessionIds(
        fetch,
        requireEnv("STRIPE_SECRET_KEY", "customer suspension must close Stripe checkout"),
        customerId,
      ),
    expireStripeCheckoutSession: (sessionId) =>
      expireStripeCheckoutSession(
        fetch,
        requireEnv("STRIPE_SECRET_KEY", "customer suspension must close Stripe checkout"),
        sessionId,
      ),
    persistStripeBillingRefs: async (deletionId, customerIds, subscriptionIds) => {
      await db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId).set({
        stripeCustomerIds: customerIds,
        stripeSubscriptionIds: subscriptionIds,
        updatedAt: Date.now(),
      }, { merge: true });
    },
    revokeConnectorGrants: (uid) =>
      revokeAllConnectorGrantsForUser(uid, CONNECTOR_OAUTH_REVOCATION_TARGETS, {
        db,
        decryptSecret: decryptConnectorSecret,
        logger: { warn: logFn },
      }),
    revokeModelBrokerAccess: (uid) =>
      revokeOwnerModelBrokerTokens(db, uid, Date.now()),
    disableAutoTopUp: (uid) => disableCreditAutoTopUp(db, uid, Date.now()),
    deleteCredentialSecrets: async (secretNames) => {
      for (const secretName of secretNames) await deleteSecret(secretName);
    },
    retireProjectAgentMattermostUsers: async (userIds) => {
      const mattermost = createMmCleanupClient({
        baseUrl: requireEnv("MM_URL", "project-agent suspension requires Mattermost"),
        adminToken: requireEnv("MM_ADMIN_TOKEN", "project-agent suspension requires Mattermost"),
        log: logFn,
      });
      for (const userId of userIds) await mattermost.destroyUser(userId);
    },
    deleteProjectAgentCredentialDocs: async (docPaths) => {
      const batch = db.batch();
      for (const docPath of docPaths) batch.delete(db.doc(docPath));
      await batch.commit();
    },
    ensureOwnedGatewaysRetired: (uid, deletionId) =>
      ensureOwnedGatewaysRetired({
        db,
        uid,
        deletionId,
        now: Date.now(),
      }),
    markSuspended: async (deletionId) => {
      await db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId).set(
        { status: "hibernating", suspendedAt: Date.now(), updatedAt: Date.now() },
        { merge: true },
      );
    },
    now: () => Date.now(),
  });
}

function createCustomerDeletionUnmount(
  db: Firestore,
  privateKey: string,
  logFn: (msg: string) => void,
  kubeOps: Pick<KubeOps, "readAvailableReplicas">,
) {
  return createUnmountFromGateway({
    resolveGatewayUnmountTarget: async (gatewayId) => {
      const rootSnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
      const authorization = gatewayAuthorizationFromRootDocument(
        rootSnap.exists ? rootSnap.data() : undefined,
        gatewayId,
      );
      if (!authorization) return null;
      const runtimeSnap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      const runtime = runtimeSnap.exists ? runtimeSnap.data() : undefined;
      if (!isGatewayRuntimeDoc(runtime) || runtime.lifecycle !== "serving") return null;
      return {
        gatewayId,
        revisionId: gatewayId,
        profile: authorization.config.profile ?? "standard",
      };
    },
    readAvailableReplicas: (revisionId) =>
      kubeOps.readAvailableReplicas({
        namespace: NAMESPACE,
        name: deploymentNameForInstance(revisionId),
      }),
    unmountRpc: ({ gatewayId, slug }) =>
      callUnmountRpc(db, { privateKey, gatewayId, slug, log: logFn }),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: logFn,
  });
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
  return createDeprovisionCustomerHandler({
    loadCleanupContext: (uid) => loadCustomerCleanupContext({ db }, uid),
    unmountFromGateway: createCustomerDeletionUnmount(db, privateKey, logFn, kubeOps),
    cloudCleanup: buildCustomerCloudCleanupDeps(db, logFn),
    now: () => Date.now(),
    log: logFn,
  });
}

function buildCustomerCloudCleanupDeps(db: Firestore, logFn: (msg: string) => void) {
  const cleanupEnv = (name: string) =>
    requireEnv(name, "customer erasure cloud cleanup requires it");
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
  return {
    gitea,
    mattermost,
    nukeUserFirestore: (
      uid: string,
      slug: string,
      email: string | null,
      currentOperationId: string,
    ) => eraseCustomerFirestore(db, uid, slug, email, currentOperationId),
    deleteCustomerStorage: (
      uid: string,
      slug: string,
      chatArtifactIds: string[],
      agentImportIds: string[],
    ) => deleteCustomerStorageObjects(
      getStorage().bucket(),
      uid,
      slug,
      chatArtifactIds,
      agentImportIds,
    ),
    deleteCredentialSecrets: async (secretNames: string[]) => {
      for (const secretName of secretNames) await deleteSecret(secretName);
    },
    deleteAuthUser: (uid: string) => deleteAuthUserTolerantOfMissing(uid, getAuth()),
    deleteHostingSites: async (slug: string, projectSlugs: string[]) => {
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
            if (!token) throw new Error("firebase-hosting: no access token from ADC");
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
  };
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
  const runtime = doc.exists ? doc.data() : undefined;
  if (!isGatewayRuntimeDoc(runtime) || runtime.gatewayId !== gatewayId) {
    throw new Error(`gateway not registered in glmGateways: ${gatewayId}`);
  }
  return `http://octogee-gateway-${gatewayId}.${NAMESPACE}.svc.cluster.local:${FLEET_CONTROLLER_PORT}`;
}

// A pending Helm release is auto-recoverable only for a RUNNING durable root
// whose runtime is not marked failed — a paused root's pending state may be an
// intentional scale-to-zero mid-flight, and a failed runtime needs an operator.
export async function isRecoverableGatewayRelease(
  db: Firestore,
  gatewayId: string,
): Promise<boolean> {
  const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  const authorization = gatewayAuthorizationFromRootDocument(
    snap.exists ? snap.data() : undefined,
    gatewayId,
  );
  if (!authorization || authorization.gateway.desiredStatus !== "running") return false;
  const runtimeSnap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
  const runtime = runtimeSnap.exists ? runtimeSnap.data() : undefined;
  if (isGatewayRuntimeDoc(runtime) && runtime.lifecycle === "failed") return false;
  return true;
}

async function isServingGateway(
  db: Firestore,
  gatewayId: string,
): Promise<boolean> {
  const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
  const value = snap.exists ? snap.data() : undefined;
  return isGatewayRuntimeDoc(value) && value.gatewayId === gatewayId &&
    value.lifecycle === "serving";
}

export function durableRolloutGateway(
  value: unknown,
  gatewayId: string,
): GatewayDoc | null {
  const authorization = gatewayAuthorizationFromRootDocument(value, gatewayId);
  return authorization ? authorization.gateway : null;
}

export async function resolvePlacementFromFirestore(
  db: Firestore,
  toGatewayId: string,
): Promise<
  | { ok: true; revisionId: string; release: number | null }
  | { ok: false; reason: "no-live-revision" | "revision-not-ready" }
  | null
> {
  const snap = await db.collection(GATEWAYS_COLLECTION).doc(toGatewayId).get();
  if (!snap.exists) return null;
  const authorization = gatewayAuthorizationFromRootDocument(snap.data(), toGatewayId);
  if (!authorization) return null;
  const gateway = authorization.gateway as DurableGateway;
  if (gateway.desiredStatus !== "running") {
    return { ok: false, reason: "revision-not-ready" };
  }
  if (gateway.liveRelease == null) return { ok: false, reason: "no-live-revision" };
  const ready = await isServingGateway(db, toGatewayId);
  if (!ready) return { ok: false, reason: "revision-not-ready" };
  return { ok: true, revisionId: toGatewayId, release: gateway.liveRelease };
}

export async function resolveLiveRevisionAsSource(
  db: Firestore,
  gatewayId: string,
): Promise<{
  revisionId: string;
  release: number;
  epoch?: number;
  assignmentMode: "unassigned-live";
  rootUpdatedAt: number;
} | null> {
  const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  if (!snap.exists) return null;
  const authorization = gatewayAuthorizationFromRootDocument(snap.data(), gatewayId);
  if (!authorization) return null;
  const gateway = authorization.gateway as DurableGateway;
  if (
    gateway.desiredStatus !== "running" ||
    typeof gateway.liveRelease !== "number" ||
    gateway.desiredRelease !== gateway.liveRelease ||
    typeof gateway.updatedAt !== "number"
  ) {
    return null;
  }
  const ready = await isServingGateway(db, gatewayId);
  return ready
    ? {
        revisionId: gatewayId,
        release: gateway.liveRelease,
        assignmentMode: "unassigned-live",
        rootUpdatedAt: gateway.updatedAt,
      }
    : null;
}

export async function resolveSourceRevisionFromFirestore(
  db: Firestore,
  uid: string,
  gatewayId: string,
): Promise<{
  revisionId: string;
  release: number;
  epoch?: number;
  assignmentMode: "assigned" | "unassigned-live";
  rootUpdatedAt?: number;
} | null> {
  const assignment = await readAssignmentDoc(db, gatewayId, uid);
  if (!assignment) return resolveLiveRevisionAsSource(db, gatewayId);
  const rootSnap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  const authorization = gatewayAuthorizationFromRootDocument(
    rootSnap.exists ? rootSnap.data() : undefined,
    gatewayId,
  );
  if (!authorization) return null;
  const gateway = authorization.gateway as DurableGateway;
  if (gateway.desiredStatus !== "running" || assignment.gatewayId !== gatewayId) {
    return null;
  }
  if (typeof gateway.liveRelease !== "number") return null;
  const ready = await isServingGateway(db, gatewayId);
  if (!ready) return null;
  return {
    revisionId: gatewayId,
    release: gateway.liveRelease,
    epoch: assignment.epoch,
    assignmentMode: "assigned",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
