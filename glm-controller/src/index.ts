import { installDefaultUserEntitlements } from "@octogee/shared/types/user-entitlements";
import { createBuilderActivationRollRecoveryOwner } from './builder-activation-roll-recovery-owner.js';
import { hasBuilderActivationTargetRollback, readBuilderActivationRollRecoveryCustody } from './builder-activation-roll-recovery.js';
import { createMigrationAgentStorePreparer, readBuilderAgentStoreInventory, type PrepareMigrationAgentStores } from "./migration-agent-stores.js";
import { prepareBuilderRecoveryTarget } from "./builder-recovery-target.js";
import { createGatewayCredentialEnsurers } from "./gateway-credential-ensurers.js";
import { createAgentStoreCredentialProvisioner, createAgentStoreCredentialRevoker, createAgentStoreCredentialRetirementVerifier, createAgentStoreOwnershipTransferer, assertNoBuilderAgentStores, eraseBuilderAgentStores } from "@octogee/core/agent-store-credentials";
import { createCustomerAgentStoreErasure, preserveCustomerGatewayRetirement, type SharedAgentErasureSource } from "./lib/customer-ops/agent-store-erasure.js";
import { eraseBuilderHomeMigrationStorage } from "./lib/builder-home-erasure.js";
import { createBuilderHomeMigrator } from "./builder-home-migration.js";
import { createBuilderHomeProvider } from "./lib/builder-home-provider.js";
import { createHomeCopyClient } from "./lib/compute-home-copy.js";
import type { ComputeRequest } from "./lib/compute-vm.js";
import { assertBuilderRuntimeStorage } from "./builder-runtime-storage.js";
import { runNormalFleetMutation } from "@octogee/core/normal-fleet-mutation";
import { createFirestorePlatformStateStore, platformStateStoreFromEnvironment, MissingRecordError, type WorkspaceProject, type CustomerDeletionJob, type FleetRegistryRecord, type GatewayRoot, type OpaqueMap, type GatewayRootFields, type GatewayRootPatch, type OperationRecord, type PlatformStateStore, type Stored, type WatchChange, type WatchEvent, type FleetRegistryInventory, type PlacementAdmissionPolicy } from "@octogee/core/platform-state";
import { restartGatewayProcess, restartGatewayDeployment } from './lib/runtime-restart-transport.js';
import { assertMigrationRestartUnfenced } from './lib/runtime-restart-coordinator.js';
import { assertOwnerOperationUnfenced } from './lib/computer-recovery-fence.js';
import { runGatewayRuntimeExclusive, withGatewayRuntimeMutation } from './lib/gateway-runtime-mutation.js';
import { createRetainedSourceTransfer, type RetainedSourceContext } from './lib/retained-source-transfer.js';
import { sourceTransferBlocksRelease } from './lib/source-transfer-execution.js';
import { reportMigrationProgress } from "@octogee/core/fleet-migration-client";
import { fleetOperationLockResources } from "@octogee/core/fleet-operation-lock";
import { journalHandoffProgress, journalOperationProgress, type ProgressJournalDeps } from "./migration-progress-journal.js";
import { operationScopedLog } from "./operation-log-scope.js";
import { createNativeReturnSourceRecoveryOwner } from "./native-return-source-recovery.js";
import { createNativeReturnTargetRetirementVerifier } from "./lib/native-return-target-retirement.js";
import { prepareNativeComputerReturn, releaseNativeReturnSourceRecoveryHold } from "./lib/native-computer-return.js";
import { retireNativeSchedulerBeforeStage } from "./lib/native-scheduler-retirement.js";
import { createAbandonedNativeSchedulerRecovery } from "./lib/native-return-scheduler-recovery.js";
import { DEFAULT_DISPOSABLE_GATEWAY_IDLE_MS } from "@octogee/shared/types/platform-config";
import { randomUUID } from "node:crypto";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import {
  getFirestore,
  type Firestore,
} from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
  resolveGatewayRuntime,
  isOperationAuditRow,
  builderGatewayServiceAccountName,
  resolveGatewayClass,
  isGatewayClass,
  isGatewayProfile,
  type GatewayClass,
  type HelmInstancesMap,
  type OperationAuditRecord,
  type Operation,
  type RuntimeBuilderIdentity,
} from "@octogee/shared/types/glm";
import {
  type GatewayMutableConfig,
} from "@octogee/shared/types/gateway-mutable-config";
import {
  gatewayHeartbeatMatchesImageTag,
} from "@octogee/shared/types/image-tag";
import {
  createBackgroundGatewayRecovery,
  startGatewayHeartbeatPoller,
  type GatewayHeartbeatPollerDeps,
} from "./gateway-heartbeat-poller.js";
import { createFleetStateFetcher, readPrivateProjectCoachWorkspace, requestFleetState } from "./fleet-state-client.js";
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
import { MIGRATE_CUSTOMER_KIND } from "./operation-kinds.js";
import { createGatewayServiceAccountEnsurer } from "./gateway-service-account-ensurer.js";
import {
  pollerHeartbeatReport,
  readHeartbeatLiveness,
  readMountedCustomers,
  heartbeatReportIsRedundant,
} from "./heartbeat-relocation.js";
import { createGatewayRuntimeConfigPreparer } from "./gateway-runtime-config.js";
import {
  projectGatewayDesiredRootForGateway,
  type GatewayRuntimeDoc,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import {
  cowboyMayMarkGatewayLive,
  gatewayImageFor,
  gatewayReleaseAuthorizesChartDrift,
  gatewayUpsertOptsFromRelease,
  markLiveRuntimePatch,
  deploymentIntentFingerprintForComparison,
  planGatewayConvergence,
  provisioningRuntimeDoc,
  requiresSurgeCustomerMigration,
  supersedingGatewayImageTag,
  type DurableGateway,
  type GatewayConvergenceAction,
  type GatewayUpsertOpts,
  type ObservedHelmInstance,
} from "./converge-gateway.js";
import { disposableBuilderPrelaunchReserved, readDisposableBuilderPrelaunchRefresh, runtimeMatchesPrelaunchRelease } from "./disposable-builder-prelaunch.js";

import {
  assertSurgeAssignmentCoverage,
  reconcileSurgeCustomerHandoff,
  SurgeAssignmentBusyError,
  type SurgeCustomerHandoffDeps,
  type SurgeCustomerHandoffResult,
} from "./surge-customer-handoff.js";

import { pruneSurgeOrphanAssignments } from "./surge-orphan-assignment.js";
import {
  createSurgePodTransport,
  deleteSurgePod,
  deleteCancelledSurgePod,
  listSurgePods,
  readPodSystemConfigCommit,
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
import { assertActiveOperationClaim, assertCustomerRestoreSettled, createOperationContext, operationElapsed } from "./operation-context.js";
import {
  compareOperationQueueOrder,
  decideOperationClaim,
  isSeriallyExclusiveKind,
  isUnstartedBuilderReturn,
  type OperationRef,
  type PendingOperationRef,
} from "./operation-queue.js";
import { readOperationRolloutLanes, withOperationRolloutLane } from "./operation-rollout-lanes.js";
import {
  buildOperationCompletionUpdate,
  operationFirstStartedAt,
  operationNeedsDurableRestartResume,
  shouldPersistClaimedOperationCompletion,
  verifiedDeletionCompletion,
} from "./operation-retry.js";
import { createAddGatewayHandler } from "./handlers/add-gateway.js";
import { createMigrateCustomerHandler } from "./handlers/migrate-customer.js";
import {
  migrationSourceReady,
  migrationTargetRootIsStable,
} from "./migration-root-stability.js";
import {
  verifyGatewayRetirementClaimAtomic,
} from "@octogee/core/gateway-retirement-claim";
import { createRetireGatewayHandler } from "./handlers/retire-gateway.js";
import { readFileSync } from "node:fs";
import { createGatewayServiceAccountTeardown } from "./lib/gateway-gsa.js";
import { gatewayFleetBaseUrl, gatewayVmAddress } from "./lib/gateway-address.js";
import { createComputerReadinessProbe, createSurgeEndpointLister } from "./vm-computer-endpoints.js";
import {
  createRuntimeDispatchingHelmRunner,
  createVmGatewayRuntime,
  type VmGatewayRuntime,
  type VmGatewayRuntimeDeps,
  parseGatewayVmSpec,
  resolveDisposableBuilderParking,
  stampGatewayRuntime,
} from "./vm-gateway-runtime.js";
import { createRestartGatewayHandler } from "./handlers/restart-gateway.js";
import { recoverSharedSourceRuntime } from "./lib/shared-source-runtime.js";
import { recoverSharedRestoreRuntime } from "./lib/shared-restore-runtime.js";
import { schedulerHandoffAwaitingRelease, startSchedulerHandoffRelease } from "./scheduler-handoff-release.js";
import { createRecycleGatewayHandler } from "./handlers/recycle-gateway.js";
import { createGatewayVmHandler } from "./handlers/gateway-vm.js";
import { createGatewayVmClient } from "./lib/compute-vm.js";
import { pausedNativeRetirementSourceFencedOff } from "./lib/native-retirement-telemetry.js";
import { clearHomeCheckpointRequest, readHomeCheckpointCompletedAt, requestHomeCheckpoint } from "./lib/home-checkpoint.js";
import { clearParkedComputer, readParkedComputer } from "./lib/parked-computer.js";
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
import { createMattermostChannelHost } from "@octogee/core/channel-host";
import { createGiteaGitHost } from "@octogee/core/git-host";
import { firestoreBuilderAccountReader } from "@octogee/core/builder-account";
import { createUnmountFromGateway } from "./lib/customer-ops/unmount-gateway.js";
import { isRetiredSharedGateway, retiredSharedGatewayRuntimeAbsent } from "./lib/customer-ops/retired-shared-gateway.js";
import { nukeUserCloudSide, type NukeCloudDeps } from "./lib/customer-ops/nuke-cloud.js";
import { markSuspendedAndReleaseErasure } from "./lib/customer-ops/erasure-release.js";
import {
  createPostHogErasureClient,
  postHogErasureConfigFromEnvironment,
  type PostHogErasureRequest,
  type PostHogErasureState,
} from "./lib/customer-ops/posthog-erasure.js";
import {
  postHogMappingOnlyJobPatch,
  readPostHogErasureState,
  verifiedDeletionJobPatch,
} from "./lib/customer-ops/deletion-job.js";
import { buildAnonymousOperationalArchive } from "./lib/customer-ops/deletion-archive.js";
import {
  eraseCustomerFirestore,
  verifyCustomerFirestoreErasure,
} from "./lib/customer-ops/customer-firestore-erasure.js";
import { resolveDefaultStorageBucket } from "./gcp-project.js";
import { createS3UserBlobErasure } from "./lib/customer-ops/s3-blob-erasure.js";
import { deleteComputerHomeObjects } from "./lib/customer-ops/computer-home.js";
import { gatewayScopedJobId, signFleetRequest } from "@octogee/core/fleet-signature";
import {
} from "@octogee/core/assigned-roster";
import {
  byotSystemConfigFromDoc,
  collectStoredProjectAgentStates,
} from "@octogee/core/customer-snapshot-mapping";
import {
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  SIGNATURE_HEADER,
} from "@octogee/shared/types/fleet-controller";
import {
  gatewayAuthorizationFromRootDocument,
  readGatewayArtifactInStore,
  readGatewayAuthorizationInStore,
  type GatewayArtifact,
  type GatewayRootReader,
  type GatewayRuntimeReader,
  type GatewayStateReader,
} from "@octogee/core/gateway-live-release";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";
import { combineIdentityProviders, googleIdentityFromEnvironment, type IdentityProvider } from "@octogee/core/identity-provider";
import { createMigrationClient } from "@octogee/core/fleet-migration-client";
import {
  customerMigrationV2GatewayRootFence,
  isCustomerMigrationV2Transition,
} from "@octogee/core/customer-migration-v2";
import { abortRetainedSourceImport, createRsyncMigrationTransfer, createSubprocessCommandRunner, resolveMigrationRecoveryUrl } from "./lib/migration-rsync-transfer.js";
import { readTransferAttemptForCleanup } from "./lib/migration-transfer-lease.js";
import {
  beginCustomerRestore,
  acknowledgeCustomerRestore,
  commitCutoverAtomic,
  markAssignmentState,
  markSharedSurgeForwardRecovery,
  rebindSharedSurgeForwardRecovery,
  setWorkspaceMigrationPhase,
  clearWorkspaceMigrationPreparation,
  completeWorkspaceMigrationRecovery,
  assertWorkspaceMigrationRecoveryAuthority,
  assertWorkspaceMigrationSourcePreparationAuthority,
  type CutoverDeps,
  type FleetStateDeps,
} from "@octogee/core/fleet-state";
import { firestoreBuilderTierReader } from "@octogee/core/builder-activation-lease";
import {
  provisionGatewayAuthSecret,
  deleteSecret,
  readSecretWithLabels,
  isSecretNotFound,
  writeSecret,
} from "@octogee/core/secret-store";
import {
  createCentralReleaseAuthority,
  listGatewayBuilds,
} from "@octogee/core/artifact-registry";
import {
  deploymentSettingsForRuntime,
  requireHostedDeploymentSettings,
} from "@octogee/core/deployment-environment";
import {
  deleteAuthUserTolerantOfMissing,
  disableAuthUserAndRevokeSessions,
} from "@octogee/core/firebase-auth-helpers";
import { revokeAllConnectorGrantsForUser } from "@octogee/core/connector-revocation";
import { CONNECTOR_OAUTH_REVOCATION_TARGETS } from "@octogee/shared/types/connectors";
import { projectRepoSourceFromDoc } from "@octogee/shared/types/project";
import { GoogleAuth } from "google-auth-library";
import { startHttpServer, type ProductAdminRoutes } from "./http-server.js";
import { createConnectorSecretDecryptor } from "./connector-secret-decryption.js";
import {
  assertCustomerRestoreNotInProgress,
  cancelCustomerMigrationsForSuspension,
  cancelStripeSubscription,
  deactivateCustomerVisibility,
  deleteStripeCustomer,
  disableCreditAutoTopUp,
  expireStripeCheckoutSession,
  invalidatePendingCredentialFlows,
  listLiveStripeSubscriptionIds,
  listOpenStripeCheckoutSessionIds,
  listStripeCustomerIdsForUid,
  releaseCustomerPlacement,
  revokeOwnerModelBrokerTokens,
} from "./lib/customer-ops/customer-suspension-runtime.js";
import {
  ensureOwnedGatewaysRetired,
} from "./lib/customer-ops/customer-gateway-retirement.js";
import { MODEL_BROKER_USAGE_ROLLUPS_COLLECTION } from "@octogee/shared/types/model-broker-usage";
import {
  recordReconcile,
  recordSharedGatewayMaxCapacity,
  recordSharedPoolReplicaBounds,
  recordVmDiskUsage,
} from "./metrics.js";
import { applyVmDiskDelivery, type VmDiskSample } from "./lib/vm-disk-usage.js";
import { startDisruptionObserver } from "./disruption-observer.js";
import { createLogger, debugFromEnv } from "./lib/logger.js";
import {
  assignedSlugsFromBuilderMirror,
  createFleetInformer,
  type FleetInformer,
  type MirrorDelivery,
} from "./fleet-informer.js";
import { recoverControllerOrphanedOperations, startStuckOpReaper } from "./stuck-op-reaper.js";
import { claimCrashLoopEviction } from "./surge-crashloop-eviction.js";
import { startNativeReturnHoldReaper } from "./native-return-hold-reaper.js";
import {
  parseGiteaGatewayKeyGcMode,
  readFleetLiveKeyHolders,
  startGiteaGatewayKeyGc,
} from "./gitea-gateway-key-gc.js";
import { startHelmRecoverySweeper } from "./helm-recovery-sweeper.js";
import { resumeOrphanedRunningOps } from "./resume-orphaned-ops.js";
import { completeHealthySharedPoolAddGatewayOperations } from "./shared-pool-add-gateway-recovery.js";
import { computeChartFingerprint } from "./chart-fingerprint.js";
import { startSharedPoolScaler } from "./shared-pool-scaler.js";
import {
  platformGatewayArtifactFromEnvironment,
  writePlatformReleaseRecord,
  sharedPoolReplicaBoundsFromEnvironment,
} from "./platform-release.js";
import { ComputerCreationPendingError, FinalHomeCheckpointPendingError, clearReplacedComputer } from "./vm-computer-lifecycle.js";
import { createCachedApiServerEgressResolver } from "./apiserver-egress.js";
import {
  PLACEMENT_ACTIVE_OPERATION_STATUSES,
  PLACEMENT_POLICY_RECONCILE_MS_DEFAULT,
  createFirestorePlacementPolicyReconcilerDeps,
  reconcilePlacementPolicyOnce,
  startPlacementPolicyReconciler,
} from "./placement-policy-reconciler.js";
import { placementPassOptions, type BuilderAdmissionSourceFactory } from "./builder-admission.js";
import { openPlacementAdmission } from "./initial-placement.js";
import { noBuilderPolicyInputs, type BuilderPolicyInputsSource } from "./builder-placement-document.js";
import type {
  FleetBrokerChannelBinding,
  FleetBrokerProjectCheckoutScope,
  FleetBrokerProjectRestore,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";

const logger = createLogger({
  debug: debugFromEnv(),
});
const log = operationScopedLog((msg: string) => logger.legacy(msg));
const RECONCILE_DEBOUNCE_MS = 1_000;
const RECONCILE_RETRY_MS_DEFAULT = 30_000;
const SHARED_POOL_SCALER_MS = parseNonNegativeInt(
  process.env.SHARED_POOL_SCALER_MS,
  30_000,
);
const DISRUPTION_OBSERVER_MS = parseNonNegativeInt(
  process.env.DISRUPTION_OBSERVER_MS,
  15_000,
);
const RECONCILE_SAFETY_REFRESH_MS_DEFAULT = 10 * 60_000;

const GATEWAY_CHART = process.env.GATEWAY_CHART ?? "/charts/octogee-gateway";
const BUILDER_VM_SPEC = process.env.GATEWAY_VM_SPEC_JSON ? parseGatewayVmSpec(process.env.GATEWAY_VM_SPEC_JSON) : null;
const GATEWAY_VM_HOST_ALIASES = ["octogee-api", "mattermost", "octogee-gitea-http", "octogee-gitea-ssh", "llm-broker", "octogee-npm-cache-proxy"] as const;
const vmGatewayRuntimeRef: { current?: VmGatewayRuntime } = {};
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
const environmentName = ENVIRONMENT_SETTINGS.name;
const hostedRelease = ENVIRONMENT_SETTINGS.clusterProjectId
  ? requireHostedDeploymentSettings(ENVIRONMENT_SETTINGS)
  : null;
const CENTRAL_RELEASE_ROUTE_DEPS = hostedRelease && (environmentName === "test" || environmentName === "prod")
  ? {
      releaseEnvironment: environmentName,
      releaseAuthority: createCentralReleaseAuthority({
        project: hostedRelease.artifactRegistryProjectId,
        location: hostedRelease.artifactRegistryLocation,
        repository: hostedRelease.artifactRegistryName,
      }),
    } as const
  : { releaseEnvironment: null };

const GATEWAY_VALUES_FILE = (function () {
  const explicit = process.env.GATEWAY_VALUES_FILE;
  if (explicit) return explicit;
  return `${GATEWAY_CHART}/${ENVIRONMENT_SETTINGS.gatewayValuesFile}`;
})();
const COMPUTER_ENVIRONMENT = NAMESPACE.endsWith("-test") ? "test" : "prod";

const FLEET_CONTROLLER_PORT = process.env.FLEET_CONTROLLER_PORT ?? "3003";
const GATEWAY_HEARTBEAT_POLL_MS = 15_000;
const GATEWAY_HEALTH_TIMEOUT_MS = 5_000;
export const ADD_GATEWAY_DEPLOYMENT_READY_TIMEOUT_MS = 30 * 60_000;
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? "8080", 10);

// Lets out-of-loop callers (the roll arm's pacing, the rollout op handler)
// nudge the reconciler without holding a reference to its closure; installed by
// startReconciler.
const requestReconcileTickRef: { fire?: (gatewayId?: string) => void } = {};
const PLACEMENT_POLICY_RECONCILE_MS = parseNonNegativeInt(
  process.env.PLACEMENT_POLICY_RECONCILE_MS,
  PLACEMENT_POLICY_RECONCILE_MS_DEFAULT,
);
const DISPOSABLE_GATEWAY_IDLE_MS = parseNonNegativeInt(
  process.env.DISPOSABLE_GATEWAY_IDLE_MS,
  DEFAULT_DISPOSABLE_GATEWAY_IDLE_MS,
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
  store: PlatformStateStore,
  runKubectl: KubectlSubprocess,
  logFn: (msg: string) => void,
): (revisionId: string) => Promise<void> {
  return async gatewayId => {
    await restartGatewayDeployment({store,namespace:NAMESPACE,runKubectl},gatewayId);
    logFn(`[glm-controller] deployment restart completed gateway=${gatewayId}`);
  };
}

interface ControllerDeps {
  store: PlatformStateStore;
  helm: HelmRunner;
  kubeOps?: KubeOps;
  modelKeySourceIssuer?: GatewayModelKeySourceIssuer;
  modelKeySecretEnsurer?: GatewayModelKeySecretEnsurer;
  restartGatewayDeployment?: (revisionId: string) => Promise<void>;
  handlers: OperationHandlers;
  requestNativeReturnSourceRecovery?: ReturnType<typeof createNativeReturnSourceRecoveryOwner>["request"];
  log: (msg: string) => void;
  syncFleetIngress?: (
    gateways: ReadonlyArray<{ gatewayId: string }>,
  ) => Promise<void>;

  // The simple-roll convergence arm (converge-gateway.ts): one stable-name
  // Helm release per gateway, applied whenever desired state drifts.
  convergeGateways?: (gatewayIds?: readonly string[]) => Promise<void>;

  reconcileRetryMs?: number;

  reconcileSafetyRefreshMs?: number;

  chartFingerprint?: string;

  ensureGatewayAuthSecret: AuthSecretEnsurer["ensureAuthSecret"];

  startDisruptionObserver?: () => ControllerStopper;
}

function deploymentNameForInstance(gatewayId: string): string {
  return `octogee-gateway-${gatewayId}`;
}

function gatewayServiceInternalUrl(gatewayId: string): string {
  return `http://${deploymentNameForInstance(gatewayId)}.${NAMESPACE}.svc.cluster.local:18789`;
}

export function gatewayComputeProjectId(env: Record<string, string | undefined> = process.env): string {
  const project = env.GATEWAY_COMPUTE_PROJECT_ID?.trim() || env.GKE_WORKLOAD_IDENTITY_PROJECT?.trim();
  if (!project) throw new Error("GATEWAY_COMPUTE_PROJECT_ID (or GKE_WORKLOAD_IDENTITY_PROJECT) is required: gateway VMs live in the cluster's VPC project");
  return project;
}

function createGatewayComputeClient(store: PlatformStateStore, logFn: (msg: string) => void) {
  return createGatewayVmClient({
    projectId: gatewayComputeProjectId(),
    journalHomeResize: (input, action) => runNormalFleetMutation(store, {
      actor: "cowboy", forced: false, what: "expand-builder-home", why: "Apply the Builder tier home allowance", target: { ownerUid: input.ownerUid, disk: input.home.name, zone: input.home.zone, projectId: input.home.projectId }, preActionStatus: { diskId: input.home.id, sizeGb: input.home.sizeGb }, mutation: { sizeGb: input.sizeGb }, action,
    }),
    journalMachineType: (input, action) => runNormalFleetMutation(store, {
      actor: "cowboy", forced: false, what: "resize-builder-computer", why: "Apply the Builder tier capacity before starting its parked computer", target: { instanceName: input.instanceName, zone: input.zone, projectId: gatewayComputeProjectId() }, preActionStatus: {}, mutation: { machineType: input.machineType }, action,
    }),
    journalProvisioningModel: (input, action) => runNormalFleetMutation(store, {
      actor: "cowboy", forced: false, what: "reprovision-builder-computer", why: "Apply the Builder tier provisioning model before starting its parked computer", target: { instanceName: input.instanceName, zone: input.zone, projectId: gatewayComputeProjectId() }, preActionStatus: {}, mutation: { provisioningModel: input.provisioningModel }, action,
    }),
    log: logFn,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    request: async ({ url, method, body }) => {
      const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
      const client = await auth.getClient();
      const res = await client.request<unknown>({ url, method, ...(body === undefined ? {} : { data: body }) });
      return { status: res.status, data: res.data };
    },
  });
}

async function isVmGateway(state: GatewayRuntimeReader, gatewayId: string): Promise<boolean> {
  const runtime = await state.fleetRegistry.get(gatewayId);
  return runtime !== null && resolveGatewayRuntime(runtime.runtime) === "gce-vm";
}

async function readGatewayVmAddress(state: GatewayRuntimeReader, gatewayId: string) {
  return gatewayVmAddress(await state.fleetRegistry.get(gatewayId));
}

async function readDesiredRoot(state: GatewayRootReader, gatewayId: string) {
  const root = await state.gateways.roots.get(gatewayId);
  if (root === null) return null;
  const { revision: _revision, ...record } = root;
  return projectGatewayDesiredRootForGateway(record, gatewayId);
}

async function isServingRuntime(state: GatewayRuntimeReader, gatewayId: string): Promise<boolean> {
  return (await state.fleetRegistry.get(gatewayId))?.lifecycle === "serving";
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

export async function publishPlatformGatewayReady(
  store: PlatformStateStore,
  input: {
    gatewayId: string;
    imageTag?: string;
    now: number;
  },
): Promise<void> {
  await store.transaction({ label: "add-gateway.publish-ready" }, async (tx) => {
    const runtime = await tx.fleetRegistry.get(input.gatewayId);
    if (runtime === null) {
      throw new Error(
        `cannot publish readiness: glmGateways/${input.gatewayId} is not the gateway's runtime doc`,
      );
    }
    const existing: Partial<FleetRegistryRecord["heartbeat"]> = runtime.heartbeat ?? {};
    await tx.fleetRegistry.patch(input.gatewayId, {
      lifecycle: "serving",
      heartbeat: {
        ...existing,
        status: "ready",
        version: versionFromImageTag(input.imageTag),
        internalUrl: gatewayServiceInternalUrl(input.gatewayId),
        startedAt: typeof existing.startedAt === "number" ? existing.startedAt : input.now,
        mountedCustomers: Array.isArray(existing.mountedCustomers) ? existing.mountedCustomers : [],
        ...("lastError" in existing ? {} : { lastError: null }),
      } as FleetRegistryRecord["heartbeat"],
    }, { revision: runtime.revision });
  });
}

async function readGatewayHeartbeat(
  state: GatewayRuntimeReader,
  gatewayId: string,
): Promise<{ lastHeartbeatAt: number; version?: string | null } | null> {
  const runtime = await state.fleetRegistry.get(gatewayId);
  return runtime === null ? null : readHeartbeatLiveness(runtime as unknown as Record<string, unknown>);
}

async function readGatewaySystemConfigCommit(
  state: GatewayRuntimeReader,
  gatewayId: string,
): Promise<string | null> {
  const configStatus = (await state.fleetRegistry.get(gatewayId))?.heartbeat?.configStatus as { acceptedCommit?: unknown } | undefined;
  const acceptedCommit = configStatus?.acceptedCommit;
  return typeof acceptedCommit === "string" ? acceptedCommit : null;
}

async function syncGatewayModelKeySecrets(
  deps: ControllerDeps,
  gateways: readonly DurableGateway[],
): Promise<Set<string>> {
  const ensurer = deps.modelKeySecretEnsurer;
  const changedBrokerGateways = new Set<string>();
  if (!ensurer) return changedBrokerGateways;

  for (const gateway of gateways) {
    if (!(await gatewayDesiredRootPresent(deps.store, gateway.gatewayId))) continue;
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
        gatewayClass === "builder" &&
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
    if (!(await gatewayDesiredRootPresent(deps.store, gateway.gatewayId))) continue;
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
    if (!(await gatewayDesiredRootPresent(deps.store, gatewayId))) continue;
    try {
      await deps.restartGatewayDeployment(gatewayId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`(source=model-key-secret) ${gatewayId}: rollout restart failed: ${message}`);
    }
  }
}

async function gatewayDesiredRootPresent(state: GatewayRootReader, gatewayId: string): Promise<boolean> {
  const root = await readDesiredRoot(state, gatewayId);
  return root !== null && (root as GatewayRootFields).runtimeRestartFence === undefined;
}

async function gatewayRuntimeMutationAllowed(store: PlatformStateStore, gatewayId: string): Promise<boolean> {
  return withGatewayRuntimeMutation(store, gatewayId, async transaction =>
    (await readGatewayAuthorizationInStore(transaction, gatewayId)) !== null);
}

async function syncFleetIngressIfConfigured(
  deps: ControllerDeps,
): Promise<void> {
  const syncFleetIngress = deps.syncFleetIngress;
  if (!syncFleetIngress) return;
  try {
    await syncFleetIngress(await readDurableServingFleetGateways(deps.store));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`(source=fleet-ingress) ${message}`);
  }
}

interface DurableRuntimeState {
  gateways: DurableGateway[];
  runtimeDocs: GatewayRuntimeDoc[];
  invalidRootIds: string[];
  strayGlmDocs: StrayGlmDoc[];
}

interface StrayGlmDoc {
  id: string;
  remedy: string;
}

function collectDurableRuntimeRoots(stored: Iterable<Stored<GatewayRoot>>): {
  gateways: DurableGateway[];
  invalidRootIds: string[];
} {
  const gateways: DurableGateway[] = [];
  const invalidRootIds: string[] = [];
  for (const { revision: _revision, ...root } of stored) {
    const authorization = gatewayAuthorizationFromRootDocument(root, root.gatewayId);
    if (authorization) {
      gateways.push(authorization.gateway as DurableGateway);
    } else {
      invalidRootIds.push(root.gatewayId);
    }
  }
  return { gateways, invalidRootIds };
}

const REVISION_GLM_DOC_ID = /-r\d+$/u;

function strayGlmDocRemedy(gatewayId: string, fields: readonly string[]): string {
  if (REVISION_GLM_DOC_ID.test(gatewayId)) return "revision doc; run scripts/ops/cutover-simple-roll.ts";
  return `not a runtime doc of a durable gateway, fields: ${fields.join(", ") || "none"}; delete ${GLM_GATEWAYS_COLLECTION}/${gatewayId}`;
}

function classifyFleetRegistryInventory(
  inventory: FleetRegistryInventory,
  gateways: readonly DurableGateway[],
): {
  runtimeDocs: GatewayRuntimeDoc[];
  strayGlmDocs: StrayGlmDoc[];
} {
  const gatewayIds = new Set(gateways.map((gateway) => gateway.gatewayId));
  const runtimeDocs: GatewayRuntimeDoc[] = [];
  const strayGlmDocs: StrayGlmDoc[] = inventory.foreign.map(({ gatewayId, fields }) => ({
    id: gatewayId,
    remedy: strayGlmDocRemedy(gatewayId, fields),
  }));
  for (const { revision: _revision, ...record } of inventory.records) {
    const runtime: GatewayRuntimeDoc = { docKind: "runtime", ...record };
    if (gatewayIds.has(record.gatewayId)) {
      runtimeDocs.push(runtime);
    } else {
      strayGlmDocs.push({ id: record.gatewayId, remedy: strayGlmDocRemedy(record.gatewayId, Object.keys(runtime).sort()) });
    }
  }
  return { runtimeDocs, strayGlmDocs };
}

async function readDurableRuntimeGateways(store: PlatformStateStore): Promise<DurableRuntimeState> {
  const [roots, inventory] = await Promise.all([store.gateways.roots.list(), store.fleetRegistry.inventory()]);
  const durable = collectDurableRuntimeRoots(roots);
  return { ...durable, ...classifyFleetRegistryInventory(inventory, durable.gateways) };
}

export async function readTargetedDurableRuntimeGateways(
  store: PlatformStateStore,
  gatewayIds: readonly string[],
): Promise<DurableRuntimeState> {
  const ids = [...new Set(gatewayIds)];
  if (ids.length === 0) {
    return { gateways: [], runtimeDocs: [], invalidRootIds: [], strayGlmDocs: [] };
  }
  const [roots, inventory] = await Promise.all([store.gateways.roots.getMany(ids), store.fleetRegistry.inventory(ids)]);
  const durable = collectDurableRuntimeRoots(roots.values());
  return { ...durable, ...classifyFleetRegistryInventory(inventory, durable.gateways) };
}

function assertDurableRuntimeState(state: DurableRuntimeState): void {
  if (state.invalidRootIds.length > 0) {
    throw new Error(
      `invalid durable root document(s): ${state.invalidRootIds.slice().sort().join(", ")}; refusing fleet mutation`,
    );
  }
  if (state.strayGlmDocs.length > 0) {
    const listed = state.strayGlmDocs
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((doc) => `${doc.id} (${doc.remedy})`)
      .join(", ");
    throw new Error(`stray glmGateway document(s): ${listed}; refusing fleet mutation`);
  }
}

async function readDurableServingFleetGateways(store: PlatformStateStore): Promise<FleetGateway[]> {
  const state = await readDurableRuntimeGateways(store);
  assertDurableRuntimeState(state);
  return state.gateways
    .filter((gateway) => gateway.desiredStatus !== "retired")
    .map((gateway) => ({ gatewayId: gateway.gatewayId }));
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
  store: PlatformStateStore;
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
    disposableBuilderGateway: boolean;
    ownerlessOperatorPrewarm: boolean;
  }) => Promise<SurgeCustomerHandoffResult>;
  log: (msg: string) => void;
}

function isDisposableBuilderGateway(gateway: DurableGateway): boolean {
  return gateway.gatewayClass === "builder" &&
    gateway.allocation?.kind === "disposable-builder";
}

function isInitialDisposableBuilderPrelaunch(gateway: DurableGateway): boolean {
  return isDisposableBuilderGateway(gateway) && gateway.liveRelease === null;
}

export async function shouldReconcileDisposablePrelaunch(
  store: PlatformStateStore,
  gateway: DurableGateway | null,
): Promise<boolean> {
  if (gateway === null) return false;
  if (isInitialDisposableBuilderPrelaunch(gateway)) return true;
  if (gateway.liveRelease === null || gateway.liveRelease > gateway.desiredRelease ||
    !(await disposableBuilderPrelaunchReserved({ reader: store, gateway }))) return false;
  const runtime = await store.fleetRegistry.get(gateway.gatewayId);
  return runtime?.runtime === "gce-vm" &&
    (gateway.liveRelease !== gateway.desiredRelease || runtime.lifecycle === "provisioning");
}

function runtimeReportsDesiredBuild(
  runtime: GatewayRuntimeDoc | undefined,
  desiredImageTag: string,
  allowBooting = false,
): boolean {
  if (!runtime) return false;
  return (
    (runtime.heartbeat.status === "ready" ||
      (allowBooting && runtime.heartbeat.status === "booting")) &&
    gatewayHeartbeatMatchesImageTag(runtime.heartbeat.version, desiredImageTag)
  );
}

function reportsDesiredBuildOrVerifiedInitialPrelaunch(input: {
  runtime: GatewayRuntimeDoc | undefined;
  desiredImageTag: string;
  gateway: DurableGateway;
  handoffReady: boolean;
}): boolean {
  const { runtime, desiredImageTag, gateway, handoffReady } = input;
  const initialDisposablePrelaunch = isInitialDisposableBuilderPrelaunch(gateway);
  return runtimeReportsDesiredBuild(runtime, desiredImageTag, initialDisposablePrelaunch) || (
    initialDisposablePrelaunch && handoffReady
  );
}

function reconcileGatewaySurgeHandoff(input: {
  passDeps: Pick<GatewayConvergencePassDeps, "reconcileSurgeHandoff">;
  gateway: DurableGateway;
  runtime: GatewayRuntimeDoc | undefined;
  desiredImage: { imageRepository: string; imageTag: string };
  pendingArtifact: ReleasePayload | null;
  helmObserved: ObservedHelmInstance | null;
  prelaunchRefresh: boolean;
}): Promise<SurgeCustomerHandoffResult> {
  const {
    passDeps,
    gateway,
    desiredImage,
    pendingArtifact,
    helmObserved,
  } = input;
  const supersedingImageTag = supersedingGatewayImageTag({
    gateway,
    desiredImage,
    pendingArtifact,
    observedImage: helmObserved?.imageRepository && helmObserved.imageTag
      ? { imageRepository: helmObserved.imageRepository, imageTag: helmObserved.imageTag }
      : null,
  });
  return passDeps.reconcileSurgeHandoff({
    gatewayId: gateway.gatewayId,
    desiredImageTag: desiredImage.imageTag,
    requiresCustomerMigration: !input.prelaunchRefresh && requiresSurgeCustomerMigration(gateway),
    disposableBuilderGateway: isDisposableBuilderGateway(gateway),
    ownerlessOperatorPrewarm: false,
    ...(supersedingImageTag ? { supersedingImageTag } : {}),
  });
}

function gatewayNeedsLiveVerification(gateway: DurableGateway, runtime: GatewayRuntimeDoc | undefined): boolean {
  if (gateway.desiredStatus === "running") return true;
  return gateway.desiredStatus === "draining" &&
    (gateway.liveRelease !== gateway.desiredRelease || runtime?.lifecycle !== "serving");
}

export async function refineGatewayConvergenceAction(input: {
  passDeps: Pick<GatewayConvergencePassDeps, "store" | "reconcileSurgeHandoff">;
  gateway: DurableGateway;
  artifact: ReleasePayload | null;
  pendingArtifact?: ReleasePayload | null;
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
    pendingArtifact = null,
    runtime,
    helmObserved,
    desiredChartFingerprint,
    desiredDeploymentIntentFingerprint,
    action,
  } = input;
  if (action.kind !== "steady" || !artifact) return action;
  if (!gatewayNeedsLiveVerification(gateway, runtime)) return action;
  if (!(await gatewayDesiredRootPresent(passDeps.store, gateway.gatewayId))) {
    return { kind: "steady" };
  }
  const desiredImage = gatewayImageFor(gateway, artifact);
  const prelaunchRefresh = await readDisposableBuilderPrelaunchRefresh({
    reader: passDeps.store, gateway, runtime, image: desiredImage, observedImage: helmObserved,
  });
  const handoff = await reconcileGatewaySurgeHandoff({
    passDeps,
    gateway,
    runtime,
    desiredImage,
    pendingArtifact,
    helmObserved,
    prelaunchRefresh,
  });
  if (prelaunchRefresh && handoff.prelaunchHeld) {
    return { kind: "mark-live", prelaunchRefresh: true };
  }
  const desiredBuildReported = reportsDesiredBuildOrVerifiedInitialPrelaunch({
    runtime,
    desiredImageTag: desiredImage.imageTag,
    gateway,
    handoffReady: handoff.ready,
  });
  if (
    handoff.ready &&
    desiredBuildReported &&
    runtime?.lifecycle !== "serving"
  ) {
    return { kind: "mark-live" };
  }
  return planGatewayConvergence({
    gateway,
    artifact,
    helm: helmObserved,
    desiredChartFingerprint,
    desiredDeploymentIntentFingerprint,
    deploymentReady: handoff.ready && desiredBuildReported,
  });
}

const GATEWAY_CONVERGENCE_CONCURRENCY = 4;

export async function runGatewayConvergencePass(
  passDeps: GatewayConvergencePassDeps,
  gatewayIds?: readonly string[],
): Promise<void> {
  const { store, helm, log } = passDeps;
  const state = gatewayIds
    ? await readTargetedDurableRuntimeGateways(store, gatewayIds)
    : await readDurableRuntimeGateways(store);
  assertDurableRuntimeState(state);
  const runtimeById = new Map(state.runtimeDocs.map((doc) => [doc.gatewayId, doc]));
  const failures: string[] = [];
  const selected = gatewayIds ? new Set(gatewayIds) : null;
  const gateways = selected
    ? state.gateways.filter((gateway) => selected.has(gateway.gatewayId))
    : state.gateways;
  const instances = await readGatewayConvergenceInstances(
    helm,
    NAMESPACE,
    selected ? gateways.map((gateway) => gateway.gatewayId) : undefined,
  );
  const priority = (gateway: DurableGateway): number => {
    const runtime = runtimeById.get(gateway.gatewayId);
    if (gatewayNeedsLiveVerification(gateway, runtime) &&
      (gateway.liveRelease !== gateway.desiredRelease || runtime?.lifecycle !== "serving") &&
      runtime?.heartbeat?.status === "ready") return 0;
    return instances[gateway.gatewayId] ? 2 : 1;
  };
  const pending = [...gateways].sort((a, b) => priority(a) - priority(b))[Symbol.iterator]();
  await Promise.all(Array.from({ length: Math.min(GATEWAY_CONVERGENCE_CONCURRENCY, gateways.length) }, async () => {
    for (const gateway of pending) {
      try {
        await convergeOneGateway(passDeps, gateway, instances, runtimeById);
      } catch (err) {
        if (err instanceof FinalHomeCheckpointPendingError || err instanceof ComputerCreationPendingError) continue;
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof SurgeAssignmentBusyError) {
          log(`[converge-gateway] ${gateway.gatewayId} deferred: ${message}`);
          continue;
        }
        failures.push(`${gateway.gatewayId}: ${message}`);
        log(`[converge-gateway] ⚠ ${gateway.gatewayId}: ${message}`);
      }
    }
  }));
  if (failures.length > 0) {
    throw new Error(`(source=converge-gateway) ${failures.join("; ")}`);
  }
}

export async function readGatewayConvergenceInstances(
  helm: Pick<HelmRunner, "readDeployedInstance" | "readDeployedInstances">,
  namespace: string,
  gatewayIds?: readonly string[],
): Promise<HelmInstancesMap> {
  if (!gatewayIds) return helm.readDeployedInstances({ namespace });
  const entries: Array<[string, HelmInstancesMap[string]]> = [];
  for (const gatewayId of gatewayIds) {
    const instance = await helm.readDeployedInstance({ namespace, gatewayId });
    if (instance) entries.push([gatewayId, instance]);
  }
  return Object.fromEntries(entries);
}

async function convergeOneGateway(
  passDeps: GatewayConvergencePassDeps,
  gateway: DurableGateway,
  instances: HelmInstancesMap,
  runtimeById: Map<string, GatewayRuntimeDoc>,
): Promise<void> {
  if (isDisposableBuilderGateway(gateway) && gateway.liveRelease !== null && gateway.liveRelease < gateway.desiredRelease) {
    const recovery = await readBuilderActivationRollRecoveryCustody({ state: passDeps.store, gatewayId: gateway.gatewayId });
    if (recovery && hasBuilderActivationTargetRollback(recovery.operation, recovery.recovery)) {
      passDeps.log(`[converge-gateway] ${gateway.gatewayId} retained target rollout while source recovery ${recovery.recovery.operationId} owns custody`);
      return;
    }
  }
  await convergeAvailableGateway(passDeps, gateway, instances, runtimeById);
}

async function convergeAvailableGateway(
  passDeps: GatewayConvergencePassDeps,
  gateway: DurableGateway,
  instances: HelmInstancesMap,
  runtimeById: Map<string, GatewayRuntimeDoc>,
): Promise<void> {
  const { store } = passDeps;
  const instance = instances[gateway.gatewayId];
  const helmObserved = observedHelmInstance(instance);
  const artifact =
    gateway.desiredStatus === "retired"
      ? null
      : await readGatewayArtifactInStore(store, gateway.gatewayId, gateway.desiredRelease);
  const pendingArtifact =
    artifact && gateway.latestRelease > gateway.desiredRelease
      ? await readGatewayArtifactInStore(store, gateway.gatewayId, gateway.latestRelease)
      : null;
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
    pendingArtifact,
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
      if (!artifact) throw new Error(`gateway ${gateway.gatewayId} cannot mark a missing release live`);
      await markGatewayLive(passDeps, gateway, artifact, action.prelaunchRefresh);
      return;
  }
}

async function uninstallGateway(
  passDeps: GatewayConvergencePassDeps,
  gateway: DurableGateway,
): Promise<void> {
  const { store, helm, log } = passDeps;
  if (!(await gatewayRuntimeMutationAllowed(store, gateway.gatewayId))) return;
  log(`[converge-gateway] ${gateway.gatewayId} retired — uninstalling stable release`);
  await helm.removeInstance({ namespace: NAMESPACE, gatewayId: gateway.gatewayId });
  if (!(await gatewayRuntimeMutationAllowed(store, gateway.gatewayId))) return;
  await store.fleetRegistry.delete(gateway.gatewayId);
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
  const { store, helm, log } = passDeps;
  const { gateway, artifact, runtime, desiredOpts, replicas } = input;
  if (!desiredOpts) throw new Error(`gateway ${gateway.gatewayId} has no deployable intent`);
  if (!(await gatewayRuntimeMutationAllowed(store, gateway.gatewayId))) return;
  log(
    `[converge-gateway] ${gateway.gatewayId} → release ${gateway.desiredRelease} ` +
      `(${desiredOpts.imageTag}, replicas=${replicas})`,
  );
  const { docKind: _docKind, ...initialRuntime } = provisioningRuntimeDoc({
    gateway,
    artifact: artifact as ReleasePayload,
    existing: runtime ?? null,
    now: Date.now(),
  });
  await stampGatewayRuntime({
    store,
    gatewayId: gateway.gatewayId,
    initial: initialRuntime,
    gatewayClass: gateway.gatewayClass,
    sizingTier: gateway.sizingTier,
    vmSpec: BUILDER_VM_SPEC,
    assertStorage: gateway.gatewayClass === "builder" && replicas > 0
      ? (runtime) => assertBuilderRuntimeStorage({ store, runtime, ownerUid: gateway.ownerUid })
      : undefined,
    log,
  });
  await store.transaction({ label: "converge-gateway.upsert-runtime" }, async (transaction) => {
    const current = await transaction.fleetRegistry.get(gateway.gatewayId);
    if (!current) throw new MissingRecordError({ aggregate: "fleet-registry", key: gateway.gatewayId });
    const { docKind: _docKind, gatewayId: _gatewayId, createdAt: _createdAt, ...runtimePatch } = provisioningRuntimeDoc({
      gateway,
      artifact: artifact as ReleasePayload,
      existing: current,
      now: Date.now(),
    });
    await transaction.fleetRegistry.patch(gateway.gatewayId, runtimePatch, { revision: current.revision });
  });
  if (!(await gatewayRuntimeMutationAllowed(store, gateway.gatewayId))) return;
  await helm.upsertInstance({ ...desiredOpts, ...runtimeBuilderIdentity(gateway) });
}

function runtimeBuilderIdentity(gateway: DurableGateway): { builderIdentity?: RuntimeBuilderIdentity } {
  return gateway.ownerUid && gateway.builderSlug
    ? { builderIdentity: { ownerUid: gateway.ownerUid, builderSlug: gateway.builderSlug } }
    : {};
}

export async function markGatewayLive(
  passDeps: Pick<GatewayConvergencePassDeps, "store" | "log">,
  gateway: DurableGateway,
  artifact: ReleasePayload,
  prelaunchRefresh = false,
): Promise<void> {
  const { store, log } = passDeps;
  const initialDisposablePrelaunch = isInitialDisposableBuilderPrelaunch(gateway);
  const imageTag = gatewayImageFor(gateway, artifact).imageTag;
  const now = Date.now();
  const markedLive = await store.transaction({ label: "converge-gateway.mark-live" }, async (transaction) => {
    const root = await transaction.gateways.roots.get(gateway.gatewayId);
    if (!root || !cowboyMayMarkGatewayLive(root, gateway.desiredRelease) ||
      root.desiredStatus !== gateway.desiredStatus || root.runtimeRestartFence !== undefined ||
      root.retirementClaim != null) return false;
    const runtimePatch = markLiveRuntimePatch(gateway);
    const runtime = prelaunchRefresh || runtimePatch ? await transaction.fleetRegistry.get(gateway.gatewayId) : null;
    if (prelaunchRefresh && (!runtimeMatchesPrelaunchRelease(root, runtime, gatewayImageFor(root, artifact)) ||
      !(await disposableBuilderPrelaunchReserved({ reader: transaction, gateway: root, expectedGateway: gateway })))) {
      log(`[converge-gateway] ${gateway.gatewayId} prelaunch reservation changed; deferring release`);
      return false;
    }
    await transaction.gateways.roots.patch(
      gateway.gatewayId,
      { liveRelease: gateway.desiredRelease, updatedAt: now, updatedBy: "converge-gateway" },
      { updatedAt: root.updatedAt },
    );
    if (runtimePatch) {
      if (!runtime) throw new MissingRecordError({ aggregate: "fleet-registry", key: gateway.gatewayId });
      await transaction.fleetRegistry.patch(gateway.gatewayId, {
        ...runtimePatch,
        ...(initialDisposablePrelaunch
          ? {
              heartbeat: {
                ...runtime.heartbeat,
                status: "booting",
                version: versionFromImageTag(imageTag),
                internalUrl: gatewayServiceInternalUrl(gateway.gatewayId),
                startedAt: now,
                lastHeartbeatAt: now,
                mountedCustomers: [],
              },
            }
          : {}),
      });
    }
    return true;
  });
  if (markedLive) log(`[converge-gateway] ${gateway.gatewayId} release ${gateway.desiredRelease} is live`);
}

function observedHelmInstance(
  instance: HelmInstancesMap[string] | undefined,
): ObservedHelmInstance | null {
  if (!instance) return null;
  return {
    imageRepository: instance.image.repository ?? null,
    imageTag: instance.image.tag ?? null,
    replicas: typeof instance.replicas === "number" ? instance.replicas : 1,
    chartFingerprint: instance.chartFingerprint,
    deploymentIntentFingerprint: instance.deploymentIntentFingerprint ?? null,
  };
}

async function prepareDesiredGatewayIntent(input: {
  passDeps: Pick<GatewayConvergencePassDeps, "prepareGatewayConfig" | "chartFingerprint">;
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
    gatewayServiceAccount: ENVIRONMENT_SETTINGS.firebaseProjectId
      ? `octogee-gateway@${ENVIRONMENT_SETTINGS.firebaseProjectId}.iam.gserviceaccount.com`
      : undefined,
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

function convergeAfterComputerCreation(
  convergeGateways: (gatewayIds: readonly string[]) => Promise<void>,
  log: (msg: string) => void,
): (gatewayId: string) => void {
  return (gatewayId) => {
    void convergeGateways([gatewayId]).catch((err: unknown) => {
      log(`[converge-gateway] ⚠ ${gatewayId}: converge after its computer creation settled failed: ${err instanceof Error ? err.message : String(err)}; requeued`);
      requestReconcileTickRef.fire?.(gatewayId);
    });
  };
}

export function serializeGatewayConvergence(
  convergeGateways: (gatewayIds?: readonly string[]) => Promise<void>,
): ((gatewayIds?: readonly string[]) => Promise<void>) & { runExclusive: typeof runGatewayRuntimeExclusive } {
  return Object.assign((gatewayIds?: readonly string[]) => runGatewayRuntimeExclusive(() => convergeGateways(gatewayIds)), {
    runExclusive: runGatewayRuntimeExclusive,
  });
}

async function runReconcilePhase<T>(
  deps: ControllerDeps,
  phase: string,
  work: () => Promise<T>,
  scope?: string,
): Promise<T> {
  const label = scope ? `phase=${phase} ${scope}` : `phase=${phase}`;
  const startedAt = Date.now();
  deps.log(`[glm-controller] reconcile ${label} started`);
  try {
    return await work();
  } finally {
    deps.log(
      `[glm-controller] reconcile ${label} completed durationMs=${Math.max(0, Date.now() - startedAt)}`,
    );
  }
}

async function reconcileOnce(
  deps: ControllerDeps,
  dependenciesSyncedGatewayIds: ReadonlySet<string>,
): Promise<void> {
  const runtime = await runReconcilePhase(deps, "durable-state", async () => {
    const state = await readDurableRuntimeGateways(deps.store);
    assertDurableRuntimeState(state);
    return state;
  });
  await runReconcilePhase(deps, "runtime-dependencies", () =>
    syncDurableRuntimeDependencies(
      deps,
      runtime.gateways.filter((gateway) => !dependenciesSyncedGatewayIds.has(gateway.gatewayId)),
    )
  );
  await runReconcilePhase(deps, "convergence", () => convergeGatewaysIfConfigured(deps));
  await runReconcilePhase(deps, "fleet-ingress", () => syncFleetIngressIfConfigured(deps));
}

async function reconcileGatewayChanges(
  deps: ControllerDeps,
  gatewayIds: readonly string[],
): Promise<void> {
  const scope = `gateways=${gatewayIds.length}`;
  const runtime = await runReconcilePhase(deps, "durable-state", async () => {
    const state = await readTargetedDurableRuntimeGateways(deps.store, gatewayIds);
    assertDurableRuntimeState(state);
    return state;
  }, scope);
  await runReconcilePhase(deps, "runtime-dependencies", () =>
    syncDurableRuntimeDependencies(deps, runtime.gateways), scope);
  await runReconcilePhase(deps, "convergence", () =>
    convergeGatewaysIfConfigured(deps, gatewayIds), scope);
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

function reconcileRelevantFingerprint(record: object): string {
  const { heartbeat, kubernetes, helm, revision: _revision, ...rest } = record as Record<string, unknown>;
  delete rest.podReplacements;
  delete rest.vmDisk;
  delete rest.vmImages;
  delete rest.vmEgress;
  const heartbeatRecord =
    heartbeat !== null && typeof heartbeat === "object" && !Array.isArray(heartbeat)
      ? heartbeat as Record<string, unknown>
      : {};
  const kubernetesRecord =
    kubernetes !== null && typeof kubernetes === "object" && !Array.isArray(kubernetes)
      ? { ...kubernetes as Record<string, unknown> }
      : {};
  delete kubernetesRecord.observedAt;
  delete kubernetesRecord.pods;
  const helmRecord =
    helm !== null && typeof helm === "object" && !Array.isArray(helm)
      ? { ...helm as Record<string, unknown> }
      : {};
  delete helmRecord.lastAppliedAt;
  delete helmRecord.availableReplicas;
  return reconcileFingerprintStableStringify({
    ...rest,
    heartbeat: {
      status: heartbeatRecord.status,
      version: heartbeatRecord.version,
    },
    kubernetes: kubernetesRecord,
    helm: helmRecord,
  });
}

// Root lastError is a gateway pod's self-report, not desired state, and it churns
// for as long as a customer mount keeps failing. updatedAt/updatedBy stay in the
// fingerprint: they are the durable migration fence (rootUpdatedAt).
function rootReconcileRelevantFingerprint(record: object): string {
  const { lastError: _lastError, ...rest } = record as Record<string, unknown>;
  return reconcileRelevantFingerprint(rest);
}

function changedGatewayIds<A extends "gateways" | "fleetRegistry">(
  changes: readonly WatchChange<A>[],
  fingerprints: Map<string, string>,
  fingerprint: (record: object) => string,
): string[] {
  const gatewayIds = new Set<string>();
  for (const change of changes) {
    if (change.record === null) {
      fingerprints.delete(change.key);
      gatewayIds.add(change.key);
      continue;
    }
    const fp = fingerprint(change.record);
    if (fingerprints.get(change.key) !== fp) gatewayIds.add(change.key);
    fingerprints.set(change.key, fp);
  }
  return [...gatewayIds].sort(compareFingerprintKeys);
}

function deliveryChanges<A extends "gateways" | "fleetRegistry">(
  delivery: MirrorDelivery<A>,
  fingerprints: ReadonlyMap<string, string>,
): WatchChange<A>[] {
  if (delivery.kind === "changes") return [...delivery.changes];
  const present = new Set(delivery.records.map((record) => record.gatewayId));
  return [
    ...delivery.records.map((record): WatchChange<A> => ({ type: "added", key: record.gatewayId, record })),
    ...[...fingerprints.keys()]
      .filter((gatewayId) => !present.has(gatewayId))
      .map((gatewayId): WatchChange<A> => ({ type: "removed", key: gatewayId, record: null })),
  ];
}

export function reconcileRelevantDeliveryGatewayIds(
  delivery: MirrorDelivery<"fleetRegistry">,
  fingerprints: Map<string, string>,
): string[] {
  return changedGatewayIds(deliveryChanges(delivery, fingerprints), fingerprints, reconcileRelevantFingerprint);
}

export function reconcileRelevantRootDeliveryGatewayIds(
  delivery: MirrorDelivery<"gateways">,
  fingerprints: Map<string, string>,
): string[] {
  return changedGatewayIds(deliveryChanges(delivery, fingerprints), fingerprints, rootReconcileRelevantFingerprint);
}

export function startReconciler(deps: ControllerDeps & { informer: FleetInformer }): () => void {
  let debounceTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let pendingFullReconcile = false;
  const pendingGatewayIds = new Set<string>();
  let stopped = false;
  const retryMs = deps.reconcileRetryMs ?? RECONCILE_RETRY_MS_DEFAULT;

  const scheduleRetryTick = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => void tick(), retryMs);
  };

  const armDebouncedTick = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void tick(), RECONCILE_DEBOUNCE_MS);
  };
  const scheduleDebouncedTick = (gatewayId?: string) => {
    if (gatewayId) pendingGatewayIds.add(gatewayId);
    else pendingFullReconcile = true;
    armDebouncedTick();
  };
  requestReconcileTickRef.fire = scheduleDebouncedTick;

  const scheduleChangedGateways = (gatewayIds: readonly string[], firstDelivery: boolean) => {
    if (gatewayIds.length === 0) return;
    if (firstDelivery) {
      scheduleDebouncedTick();
      return;
    }
    for (const gatewayId of gatewayIds) scheduleDebouncedTick(gatewayId);
  };

  const requeueReconcile = (fullReconcile: boolean, gatewayIds: readonly string[]) => {
    if (fullReconcile) pendingFullReconcile = true;
    for (const gatewayId of gatewayIds) pendingGatewayIds.add(gatewayId);
  };

  const hasPendingReconcile = () =>
    pendingFullReconcile || pendingGatewayIds.size > 0;

  const tick = async () => {
    if (inFlight) return;
    debounceTimer = clearTimer(debounceTimer);
    retryTimer = clearTimer(retryTimer);
    const fullReconcile = pendingFullReconcile;
    const gatewayIds = [...pendingGatewayIds].sort(compareFingerprintKeys);
    if (!fullReconcile && gatewayIds.length === 0) return;
    pendingFullReconcile = false;
    pendingGatewayIds.clear();
    inFlight = true;
    try {
      if (gatewayIds.length > 0) await reconcileGatewayChanges(deps, gatewayIds);
      if (fullReconcile) await reconcileOnce(deps, new Set(gatewayIds));
      recordReconcile("ok");
    } catch (err) {
      requeueReconcile(fullReconcile, gatewayIds);
      recordReconcile("fail");
      const message = err instanceof Error ? err.message : String(err);
      const source = message.startsWith("(source=") ? "" : "(source=helm) ";
      deps.log(
        `[glm-controller] ⚠ reconcile tick failed: ${source}${message} — retry in ${retryMs}ms`,
      );
      scheduleRetryTick();
    } finally {
      inFlight = false;
      if (!stopped && hasPendingReconcile() && !retryTimer) {
        armDebouncedTick();
      }
    }
  };

  const reconcileFingerprints = new Map<string, string>();
  const rootFingerprints = new Map<string, string>();
  const vmDiskSamples = new Map<string, VmDiskSample>();

  const unsubscribeRuntimes = deps.informer.subscribe("fleetRegistry", (delivery) => {
    if (stopped) return;
    recordVmDiskUsage(applyVmDiskDelivery(vmDiskSamples, delivery));
    scheduleChangedGateways(
      reconcileRelevantDeliveryGatewayIds(delivery, reconcileFingerprints),
      delivery.kind === "reset",
    );
  });

  const unsubscribeRoots = deps.informer.subscribe("gateways", (delivery) => {
    if (stopped) return;
    const changedGatewayIds = reconcileRelevantRootDeliveryGatewayIds(delivery, rootFingerprints);
    scheduleChangedGateways(changedGatewayIds, delivery.kind === "reset");
    if (changedGatewayIds.length > 0) scheduleDebouncedTick();
  });

  if (deps.reconcileSafetyRefreshMs && deps.reconcileSafetyRefreshMs > 0) {
    refreshTimer = setInterval(
      () => scheduleDebouncedTick(),
      deps.reconcileSafetyRefreshMs,
    );
  }

  return () => {
    stopped = true;
    unsubscribeRuntimes();
    unsubscribeRoots();
    if (requestReconcileTickRef.fire === scheduleDebouncedTick) {
      requestReconcileTickRef.fire = undefined;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    pendingFullReconcile = false;
    pendingGatewayIds.clear();
  };
}

function operationFromRecord(record: Stored<OperationRecord>): Operation {
  const { revision: _revision, ...operation } = record;
  return operation;
}

function addedPendingOperations(event: WatchEvent<"operations">): readonly Stored<OperationRecord>[] {
  if (event.kind === "snapshot") return event.records;
  if (event.kind === "resync") return [];
  return event.changes.flatMap((change) => change.type === "added" && change.record !== null ? [change.record] : []);
}

export function startOperationWorker(deps: ControllerDeps): () => void {
  const processInOrder = async (records: readonly Stored<OperationRecord>[]) => {
    for (const record of records) await processOperation(operationFromRecord(record), deps);
  };
  const subscription = deps.store.watch({ aggregate: "operations", filter: { statuses: ["pending"] } }, {
    onEvent: (event) => {
      void processInOrder(addedPendingOperations(event)).catch((err) => {
        deps.log(`[glm-controller] ⚠ pending operation run failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    onError: (err) => deps.log(`[glm-controller] ⚠ operations snapshot error: ${String(err)}`),
  });
  return () => {
    void subscription.close();
  };
}

// How often the queue drain re-scans pending ops. It exists for two cases the
// onSnapshot listener above can't see: an op queued behind a conflicting rollout
// (unblocked when the OTHER doc changes, not this one) and a retry whose backoff
// has elapsed (unblocked by time passing, not a Firestore event). Cadence mirrors
// the stuck-op-reaper's level-triggered pattern.
export const OPERATION_QUEUE_DRAIN_MS_DEFAULT = 20_000;

// Restart re-drive candidates. The predicate below admits only migrations with
// durable migration or recovery state; legacy rollout sub-operations remain rollout-owned.
const RESUMABLE_OP_KINDS: ReadonlySet<string> = new Set([
  "rollout",
  "restart-gateway",
  MIGRATE_CUSTOMER_KIND,
  "suspend-customer",
  "erase-customer",
]);

function operationIsRestartResumable(op: Operation): boolean {
  if (op.kind === "rollout") return true;
  return operationNeedsDurableRestartResume(op);
}

async function attemptClaimOrQueueOperation(
  op: Operation,
  deps: ControllerDeps,
): Promise<{ outcome: "claimed" | "queued" | "skipped"; fresh?: Operation }> {
  try {
    return await deps.store.transaction({ label: "operation-worker.claim" }, async (tx) => {
      const stored = await tx.journal.operations.get(op.id);
      if (stored === null) return { outcome: "skipped" as const };
      const freshOperation = operationFromRecord(stored);
      await assertOwnerOperationUnfenced(tx, op.id, freshOperation.input);
      if (freshOperation.kind === 'migrate-customer') await assertMigrationRestartUnfenced(tx, freshOperation.input);
      let runningOpsSameKind: OperationRef[] = [];
      let pendingOpsSameKind: PendingOperationRef[] = [];
      if (isSeriallyExclusiveKind(op.kind)) {
        const [running, pending] = await Promise.all([
          tx.journal.operations.listByStatus(["running"]),
          tx.journal.operations.listByStatus(["pending"]),
        ]);
        runningOpsSameKind = running.flatMap((runningOperation) =>
          isSeriallyExclusiveKind(runningOperation.kind) ? [{
            id: runningOperation.id,
            kind: runningOperation.kind,
            input: runningOperation.input,
            customerMigrationV2: runningOperation.customerMigrationV2,
            cutoverCommittedAt: runningOperation.cutoverCommittedAt,
          }] : []);
        pendingOpsSameKind = pending.flatMap((pendingOperation) =>
          isSeriallyExclusiveKind(pendingOperation.kind) ? [{
            id: pendingOperation.id,
            kind: pendingOperation.kind,
            origin: pendingOperation.origin,
            unstartedBuilderReturn: isUnstartedBuilderReturn(pendingOperation),
            gatewayCompatibilityPending: pendingOperation.output?.gatewayCompatibilityPending === true,
            input: pendingOperation.input,
            output: pendingOperation.output,
            schedulerHandoff: pendingOperation.schedulerHandoff,
            createdAt: pendingOperation.createdAt,
            queuedAt: pendingOperation.queuedAt,
            nextAttemptAt: pendingOperation.nextAttemptAt,
            customerMigrationV2: pendingOperation.customerMigrationV2,
            cutoverCommittedAt: pendingOperation.cutoverCommittedAt,
          }] : []);
      }

      const rolloutLanes = await readOperationRolloutLanes(
        tx,
        [{ id: op.id, kind: freshOperation.kind, input: freshOperation.input }, ...runningOpsSameKind, ...pendingOpsSameKind],
      );
      const decision = decideOperationClaim({
        op: withOperationRolloutLane({
          id: op.id,
          kind: op.kind,
          status: freshOperation.status,
          origin: freshOperation.origin,
          unstartedBuilderReturn: isUnstartedBuilderReturn(freshOperation),
          gatewayCompatibilityPending: freshOperation.output?.gatewayCompatibilityPending === true,
          createdAt: freshOperation.createdAt,
          queuedAt: freshOperation.queuedAt,
          nextAttemptAt: freshOperation.nextAttemptAt,
          input: freshOperation.input,
          schedulerHandoff: freshOperation.schedulerHandoff,
          customerMigrationV2: freshOperation.customerMigrationV2,
          cutoverCommittedAt: freshOperation.cutoverCommittedAt,
        }, rolloutLanes),
        now: Date.now(),
        runningOpsSameKind: runningOpsSameKind.map((operation) => withOperationRolloutLane(operation, rolloutLanes)),
        pendingOpsSameKind: pendingOpsSameKind.map((operation) => withOperationRolloutLane(operation, rolloutLanes)),
      });

      if (decision.outcome === "skip") return { outcome: "skipped" as const };
      if (decision.outcome === "queue") {
        if (freshOperation.waitingOn !== decision.waitingOn) {
          await tx.journal.operations.patch(op.id, { waitingOn: decision.waitingOn });
        }
        return { outcome: "queued" as const };
      }
      const now = Date.now();
      const firstStartedAt = operationFirstStartedAt(freshOperation, now);
      await tx.journal.operations.patch(op.id, {
        status: "running",
        startedAt: now,
        firstStartedAt,
        lastProgressAt: now,
        waitingOn: { clear: true },
        nextAttemptAt: { clear: true },
        queuedAt: { clear: true },
      });
      // The completion write derives attempts/attemptHistory from the op the
      // handler ran with — hand back the transaction's fresh read so a stale
      // worker snapshot can't reset the retry cap or drop history.
      return { outcome: "claimed" as const, fresh: { ...freshOperation, status: "running", startedAt: now, firstStartedAt } };
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
  deps: ControllerDeps,
): Promise<void> {
  if (isOperationAuditRow(op)) return;
  const operation = op as Operation;
  const claim = await attemptClaimOrQueueOperation(operation, deps);
  if (claim.outcome === "queued") {
    deps.log(`[glm-controller] op=${operation.id} kind=${operation.kind} queued — waiting on a conflicting op`);
    return;
  }
  if (claim.outcome !== "claimed" || !claim.fresh) return;

  deps.log(`[glm-controller] claim op=${operation.id} kind=${operation.kind}`);
  await runClaimedOperation(claim.fresh, deps);
}

// Re-scan every pending op and try to claim each. The
// correctness net for (a) an op queued behind a since-finished conflicting op,
// and (b) a retry whose backoff window has elapsed — see OPERATION_QUEUE_DRAIN_MS_DEFAULT.
export async function drainPendingOperationsOnce(deps: ControllerDeps): Promise<void> {
  // Equality-only query, FIFO sort in memory: status+createdAt has no
  // composite index and must never need one — an orderBy here throws
  // FAILED_PRECONDITION in the real Firestore and silently kills the drain.
  const ops = (await deps.store.journal.operations.listByStatus(["pending"]))
    .map(operationFromRecord)
    .sort(compareOperationQueueOrder);
  for (const op of ops) {
    await processOperation(op, deps);
  }
}

export async function claimOperationsUnblockedByCutover(
  cutOver: Operation,
  deps: ControllerDeps,
): Promise<void> {
  const released = fleetOperationLockResources(cutOver);
  if (released.size === 0) return;
  const unblocked = (await deps.store.journal.operations.listByStatus(["pending"]))
    .map(operationFromRecord)
    .filter((op) => [...fleetOperationLockResources(op)].some((resource) => released.has(resource)))
    .sort(compareOperationQueueOrder);
  for (const op of unblocked) {
    void processOperation(op, deps).catch((err) => {
      deps.log(
        `[glm-controller] ⚠ post-cutover claim failed op=${op.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
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
export async function reAdoptAndRunOperation(
  op: Operation,
  deps: ControllerDeps,
): Promise<void> {
  let adopted: Operation | null = null;
  try {
    adopted = await deps.store.transaction({ label: "operation-worker.re-adopt" }, async (tx) => {
      const stored = await tx.journal.operations.get(op.id);
      if (stored === null || stored.status !== "running") return null;
      const freshOperation = operationFromRecord(stored);
      const now = Date.now();
      const timing = {
        startedAt: now,
        firstStartedAt: operationFirstStartedAt(freshOperation, now),
        lastResumedAt: now,
        lastProgressAt: now,
        resumeCount: (typeof freshOperation.resumeCount === "number" ? freshOperation.resumeCount : 0) + 1,
      };
      await tx.journal.operations.patch(op.id, timing);
      return { ...freshOperation, ...timing };
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
  await runClaimedOperation(adopted, deps);
}

// Run an op whose status is already `running` (freshly claimed or re-adopted):
// invoke its handler, persist step progress (with a liveness heartbeat), then
// complete it — or, for a transient failure under the attempt cap, requeue it to
// `pending` with backoff (operation-retry.ts) instead of failing it terminally.
async function runClaimedOperation(
  op: Operation,
  deps: ControllerDeps,
): Promise<void> {
  const operations = deps.store.journal.operations;
  const { ctx, steps } = createOperationContext({
    assertActiveClaim: async (allowCancelled) => {
      assertActiveOperationClaim(op, await operations.get(op.id), allowCancelled);
    },
    customerRestore: {
      assertSettled: async () => {
        const fresh = await operations.get(op.id);
        assertActiveOperationClaim(op, fresh);
        assertCustomerRestoreSettled(op, fresh?.restoreAttempt);
      },
      begin: async (input) => {
        if (typeof op.startedAt !== "number") throw new Error("customer restore requires an active claim");
        const { resume, ...scope } = input;
        const restore = {
          ...scope, operationId: op.id, claimStartedAt: op.startedAt, attemptId: randomUUID(),
        };
        const stateDeps: FleetStateDeps = { store: deps.store };
        const owned = await runGatewayRuntimeExclusive(() => beginCustomerRestore(stateDeps, restore, { resume }));
        return () => acknowledgeCustomerRestore(stateDeps, owned);
      },
    },
    persist: async (next) => {
      await deps.store.transaction({ label: "operation-worker.persist-steps" }, async (tx) => {
        const data = await tx.journal.operations.get(op.id);
        if (data?.startedAt !== op.startedAt) {
          deps.log(`[glm-controller] op=${op.id} step progress discarded because the operation was re-claimed`);
          return;
        }
        await tx.journal.operations.patch(op.id, { steps: next, lastProgressAt: Date.now() });
      });
    },
    persistSchedulerHandoff: async (state) => {
      await deps.store.transaction({ label: "operation-worker.persist-scheduler-handoff" }, async (tx) => {
        const data = await tx.journal.operations.get(op.id);
        if (data?.status !== "running" || data.startedAt !== op.startedAt) {
          throw new Error("scheduler handoff operation is no longer owned by this attempt");
        }
        await tx.journal.operations.patch(op.id, { schedulerHandoff: state, schedulerHandoffReleased: false, lastProgressAt: Date.now() });
      });
    },
    persistCutoverCommitted: async (at) => {
      await deps.store.transaction({ label: "operation-worker.persist-cutover" }, async (tx) => {
        const data = await tx.journal.operations.get(op.id);
        if (data?.status !== "running" || data.startedAt !== op.startedAt) {
          throw new Error("cutover record operation is no longer owned by this attempt");
        }
        await tx.journal.operations.patch(op.id, { cutoverCommittedAt: at, lastProgressAt: Date.now() });
      });
      void claimOperationsUnblockedByCutover(op, deps).catch((err) => {
        deps.log(
          `[glm-controller] ⚠ post-cutover queue scan failed op=${op.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
    persistCustomerMigrationV2: async (state) => {
      await deps.store.transaction({ label: "operation-worker.persist-customer-migration" }, async (tx) => {
        const data = await tx.journal.operations.get(op.id);
        assertActiveOperationClaim(op,data,true);
        if (!data) throw new Error("customer migration V2 operation unavailable");
        if (sourceTransferBlocksRelease(data.sourceTransferExecution) && state.phase !== "sourceQuiesced") throw new Error("source transfer termination not observed");
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
        await tx.journal.operations.patch(op.id, {
          customerMigrationV2: state,
          lastProgressAt: Date.now(),
        });
      });
    },
    cancellationRequested: async () => (await operations.get(op.id))?.cancellationRequestedAt !== undefined,
    log: deps.log,
    opId: op.id,
  });

  const result = await routeOperation(op, deps.handlers, ctx);
  const completion = await deps.store.transaction({ label: "operation-worker.complete" }, async (tx) => {
    const freshOp = await tx.journal.operations.get(op.id);
    if (freshOp === null) return null;
    if (!shouldPersistClaimedOperationCompletion({ status: freshOp.status, startedAt: freshOp.startedAt, claimedStartedAt: op.startedAt })) return null;
    const completion = buildOperationCompletionUpdate({
      op: {
        id: op.id,
        kind: freshOp.kind,
        origin: freshOp.origin,
        input: freshOp.input,
        attempts: freshOp.attempts,
        attemptHistory: freshOp.attemptHistory,
        startedAt: freshOp.startedAt,
        customerMigrationV2: freshOp.customerMigrationV2,
        schedulerHandoff: freshOp.schedulerHandoff,
        schedulerHandoffReleased: freshOp.schedulerHandoffReleased,
        cutoverCommittedAt: freshOp.cutoverCommittedAt,
        sourceTransferExecution: freshOp.sourceTransferExecution,
      },
      result,
      steps,
      now: Date.now(),
    });
    const verifiedDeletion = verifiedDeletionCompletion(result);
    if (verifiedDeletion) {
      await tx.jobs.deletions.patch(verifiedDeletion.deletionId, verifiedDeletionJobPatch(verifiedDeletion.archiveId, Date.now()));
    }
    await tx.journal.operations.patch(op.id, completion);
    return completion;
  });
  if (!completion) {
    deps.log(`[glm-controller] op=${op.id} completion discarded because the operation was cancelled or re-claimed`);
    return;
  }

  if (result.success) {
    deps.log(`[glm-controller] op=${op.id} kind=${op.kind} → succeeded${operationElapsed(op, Date.now())}`);
    return;
  }

  if (completion.status === "pending") {
    deps.log(
      `[glm-controller] op=${op.id} attempt ${String(completion.attempts)} failed transiently — ${result.error ?? "unknown error"} — retrying`,
    );
    return;
  }

  deps.log(`[glm-controller] op=${op.id} kind=${op.kind} → failed${operationElapsed(op, Date.now())} (${result.error})`);
}

function buildHeartbeatPollerCoreDeps(
  { store, informer }: { store: PlatformStateStore; informer: FleetInformer },
  log: (msg: string) => void,
  privateKey: string,
): Omit<GatewayHeartbeatPollerDeps, "evictSlug" | "listActiveMigrations"> {
  const polledHeartbeats = new Map<string, unknown>();
  const polledRuntimes = new Map<string, unknown>();
  const fetchFleetState = createFleetStateFetcher({
    privateKey,
    resolveBaseUrl: (gatewayId) => gatewayFleetBaseUrl({
      runtimeDoc: polledRuntimes.get(gatewayId),
      gatewayId,
      namespace: NAMESPACE,
      port: FLEET_CONTROLLER_PORT,
    }),
    timeoutMs: GATEWAY_HEALTH_TIMEOUT_MS,
    log,
  });
  return {
    listGatewayIds: async () => {
      const mirrored = informer.fleetRegistryWithoutMalformed();
      if (mirrored !== null && mirrored.malformedKeys.length > 0) {
        log(`[glm-controller] ⚠ heartbeat poll skips malformed runtime record(s): ${mirrored.malformedKeys.join(", ")}`);
      }
      const records = mirrored?.records ?? await store.fleetRegistry.list();
      polledHeartbeats.clear();
      polledRuntimes.clear();
      for (const record of records) {
        polledHeartbeats.set(record.gatewayId, record.heartbeat);
        polledRuntimes.set(record.gatewayId, record);
      }
      return heartbeatPollInstanceIds(records);
    },
    fetchFleetState,
    readAssignedSlugs: async (instanceId) => {
      const runtime = informer.fleetRegistryWithoutMalformed()?.records.find((record) => record.gatewayId === instanceId) ??
        await store.fleetRegistry.get(instanceId);
      if (runtime === null) return [];
      const mirroredBuilders = informer.buildersWithoutMalformed()?.records;
      return assignedSlugsFromBuilderMirror(
        mirroredBuilders ?? await store.builders.records.listByGateway(runtime.gatewayId),
        runtime.gatewayId,
      );
    },
    writeHeartbeat: async (gatewayId, record) => {
      const heartbeat = pollerHeartbeatReport(record, gatewayServiceInternalUrl(gatewayId));
      if (heartbeatReportIsRedundant(polledHeartbeats.get(gatewayId), heartbeat, Date.now())) return;
      await store.fleetRegistry.recordHeartbeat(gatewayId, heartbeat);
    },
    log,
  };
}

export function buildGatewayHeartbeatPollerDeps(
  db: Firestore,
  store: PlatformStateStore,
  log: (msg: string) => void,
  privateKey: string,
  informer: FleetInformer,
): GatewayHeartbeatPollerDeps {
  const recoverComputer = createBackgroundGatewayRecovery(
    (gatewayId) => runGatewayRuntimeExclusive(async () => { await vmGatewayRuntimeRef.current?.recoverUnreachable(gatewayId); }),
    log,
  );
  return {
    ...buildHeartbeatPollerCoreDeps({ store, informer }, log, privateKey),
    listActiveMigrations: () => store.journal.operations.listByKind("migrate-customer", [...PLACEMENT_ACTIVE_OPERATION_STATUSES]),
    ownsEviction: async (gatewayId: string) => {
      const stored = informer.gateways()?.find((root) => root.gatewayId === gatewayId) ??
        await store.gateways.roots.get(gatewayId);
      const root = stored === null ? null : projectGatewayDesiredRootForGateway(stored, gatewayId);
      return root !== null && root.gatewayClass !== "shared";
    },
    evictSlug: async (gatewayId: string, slug: string) => {
      if ((await store.fleetRegistry.get(gatewayId)) === null) return;
      await callUnmountRpc(store, {
        privateKey,
        gatewayId,
        slug,
        log,
        tag: "evict",
      });
    },
    onUnreachable: async (gatewayId: string) => {
      const gateway = await readDesiredRoot(store, gatewayId) as DurableGateway | null;
      if (gateway?.desiredStatus === "running" && gateway.gatewayClass === "builder") recoverComputer(gatewayId);
      if (await shouldReconcileDisposablePrelaunch(store, gateway)) {
        requestReconcileTickRef.fire?.(gatewayId);
      }
    },
  };
}

export function heartbeatPollInstanceIds(records: readonly FleetRegistryRecord[]): string[] {
  return records.filter((record) => record.lifecycle !== "failed").map((record) => record.gatewayId);
}

type ControllerStopper = () => void;

interface ControllerBackgroundTasksDeps {
  addProductAdminRoutes?: ProductAdminRoutes;
  adminIdentity: IdentityProvider;
  placementAdmission: PlacementAdmissionPolicy;
  policyInputs: BuilderPolicyInputsSource;
  builderAdmission?: BuilderAdmissionSourceFactory | undefined;
  db: Firestore;
  deps: ControllerDeps;
  helm: HelmRunner;
  fleetControllerPrivateKey: string;
  platformArtifact: GatewayArtifact;
  controllerStartedAt: number;
}

const GITEA_GATEWAY_KEY_GC_INTERVAL_MS = 60_000;
const GITEA_GATEWAY_KEY_GC_MAX_CALLS_PER_TICK = 480;
const GITEA_GATEWAY_KEY_GC_MIN_CALL_INTERVAL_MS = 100;
const GITEA_GATEWAY_KEY_GC_GRACE_MS = 10 * 60 * 1000;

function startControllerBackgroundTasks({
  addProductAdminRoutes,
  adminIdentity,
  placementAdmission,
  policyInputs,
  builderAdmission,
  db,
  deps,
  helm,
  fleetControllerPrivateKey,
  platformArtifact,
  controllerStartedAt,
}: ControllerBackgroundTasksDeps): ControllerStopper[] {
  if (!deps.kubeOps) {
    throw new Error("controller background tasks require Kubernetes operations");
  }
  const informer = createFleetInformer({ store: deps.store, log });
  const stopReconciler = startReconciler({ ...deps, informer });
  const stopWorker = startOperationWorker(deps);
  const stopOperationQueueDrain = startOperationQueueDrain(deps);
  const stopPoller = startGatewayHeartbeatPoller(
    buildGatewayHeartbeatPollerDeps(db, deps.store, log, fleetControllerPrivateKey, informer),
    GATEWAY_HEARTBEAT_POLL_MS,
  );
  const stopStuckOpReaper = startStuckOpReaper({
    store: deps.store,
    log,
    intervalMs: 60_000,
    stalenessMs: 15 * 60 * 1000,
    now: () => Date.now(),
    controllerStartedAt,
  });
  const migrationClient = createMigrationClientBuilder(deps.store, fleetControllerPrivateKey, log);
  const stopSchedulerHandoffRelease = startSchedulerHandoffRelease({
    store: deps.store,
    log,
    intervalMs: 60_000,
    now: () => Date.now(),
    gatewayExists: async (gatewayId) => (await deps.store.fleetRegistry.get(gatewayId)) !== null,
    scheduler: async (gatewayId, request) => {
      const url = await resolveGatewayFleetUrl(deps.store, gatewayId);
      return migrationClient(() => url).scheduler({ ...request, gatewayId });
    },
  });
  const stopNativeReturnHoldReaper = startNativeReturnHoldReaper({
    store: deps.store,
    vm: createGatewayComputeClient(deps.store, log),
    informer,
    log,
    intervalMs: 60_000,
    now: () => Date.now(),
  });
  const kubeOps = deps.kubeOps;
  const keySweepApiUrl = requireEnv("GIT_API_URL", "the Gitea gateway key sweep requires it");
  const keySweepToken = requireEnv("GIT_API_TOKEN", "the Gitea gateway key sweep requires it");
  const stopGiteaGatewayKeyGc = startGiteaGatewayKeyGc({
    git: createGiteaGitHost({
      apiBaseUrl: keySweepApiUrl,
      token: () => keySweepToken,
    }),
    readLiveKeyHolders: () => readFleetLiveKeyHolders({
      informer,
      store: deps.store,
      readGatewayPodDiagnosticsBatch: (gatewayIds) =>
        kubeOps.readGatewayPodDiagnosticsBatch({ namespace: NAMESPACE, gatewayIds }),
    }),
    mode: parseGiteaGatewayKeyGcMode(process.env.GITEA_GATEWAY_KEY_GC_MODE),
    maxCallsPerTick: GITEA_GATEWAY_KEY_GC_MAX_CALLS_PER_TICK,
    minCallIntervalMs: GITEA_GATEWAY_KEY_GC_MIN_CALL_INTERVAL_MS,
    graceMs: GITEA_GATEWAY_KEY_GC_GRACE_MS,
    intervalMs: GITEA_GATEWAY_KEY_GC_INTERVAL_MS,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
  });
  const stopHelmRecoverySweeper = startHelmRecoverySweeper({
    listPending: () => helm.listPendingReleases({ namespace: NAMESPACE }),
    isRecoverableRevision: (gatewayId) => isRecoverableGatewayRelease(deps.store, gatewayId),
    recover: (gatewayId) => runGatewayRuntimeExclusive(async () => {
      if (!(await isRecoverableGatewayRelease(deps.store, gatewayId)) || !(await gatewayRuntimeMutationAllowed(deps.store, gatewayId))) {
        throw new Error('gateway Helm recovery authority unavailable');
      }
      return helm.recoverRelease({ namespace: NAMESPACE, gatewayId });
    }),
    now: () => Date.now(),
    staleMs: HELM_RECOVERY_STALE_MS,
    intervalMs: HELM_RECOVERY_SWEEP_MS,
    log,
  });
  const homeServices = BUILDER_VM_SPEC ? createBuilderHomeServices(deps.store, log) : undefined;
  const prepareBuilderHome = homeServices ? createBuilderHomeMigrator({
    store: deps.store, readBuilderTier: firestoreBuilderTierReader(db), environment: COMPUTER_ENVIRONMENT, now: Date.now, subnetwork: BUILDER_VM_SPEC!.subnetwork, nativeZones: BUILDER_VM_SPEC!.zones, log,
    ...homeServices.provider, copy: homeServices.copy,
  }) : undefined;
  const stopPlacementPolicyReconciler = startPlacementPolicyReconciler(
    createFirestorePlacementPolicyReconcilerDeps({
      store: deps.store,
      prepareBuilderHome,
      informer,
      policyInputs,
      namespace: NAMESPACE,
      idleMs: DISPOSABLE_GATEWAY_IDLE_MS,
      platformArtifact,
      now: () => Date.now(),
      log,
      readBuilderTier: firestoreBuilderTierReader(db),
      placementAdmission,
      debug: (message) => logger.debug(message),
      ensureAuthSecret: deps.ensureGatewayAuthSecret,
      readGatewayPodDiagnostics: deps.kubeOps.readGatewayPodDiagnostics,
      readGatewayPodDiagnosticsBatch: deps.kubeOps.readGatewayPodDiagnosticsBatch,
    }),
    PLACEMENT_POLICY_RECONCILE_MS,
    placementPassOptions({
      admission: builderAdmission ? { store: deps.store, source: builderAdmission(log), log } : null,
      runPlacementPass: reconcilePlacementPolicyOnce,
      subscribeUnassigned: informer.subscribeUnassignedUsers?.bind(informer),
    }),
  );
  const stopDisruptionObserver = deps.startDisruptionObserver?.() ?? (() => undefined);
  const httpKubeOps = deps.kubeOps;
  const decryptConnectorSecret = createConnectorSecretDecryptor();
  const stopHttp = startHttpServer({
    addProductAdminRoutes,
    db,
    store: deps.store,
    accounts: firestoreBuilderAccountReader(db),
    log,
    port: HTTP_PORT,
    identity: adminIdentity,
    provisionGatewayAuthSecret,
    listGatewayBuilds,
    ...CENTRAL_RELEASE_ROUTE_DEPS,
    ...(httpKubeOps
      ? {
          readGatewayPodDiagnostics: (gatewayId: string) =>
            httpKubeOps.readGatewayPodDiagnostics({ namespace: NAMESPACE, gatewayId }),
          readGatewayPodDiagnosticsBatch: (gatewayIds: readonly string[]) =>
            httpKubeOps.readGatewayPodDiagnosticsBatch({ namespace: NAMESPACE, gatewayIds }),
        }
      : {}),
    requestNativeReturnSourceRecovery: deps.requestNativeReturnSourceRecovery,
    suspendAuthUser: (uid) => disableAuthUserAndRevokeSessions(uid, getAuth()),
    revokeConnectorGrantsForUser: (uid) =>
      revokeAllConnectorGrantsForUser(uid, CONNECTOR_OAUTH_REVOCATION_TARGETS, {
        secrets: deps.store.secrets,
        decryptSecret: decryptConnectorSecret,
        logger: { warn: log },
      }),
  });
  return [
    stopReconciler,
    stopWorker,
    stopOperationQueueDrain,
    stopPoller,
    stopStuckOpReaper,
    stopSchedulerHandoffRelease,
    stopNativeReturnHoldReaper,
    stopGiteaGatewayKeyGc,
    stopHelmRecoverySweeper,
    stopPlacementPolicyReconciler,
    stopDisruptionObserver,
    stopHttp,
    informer.stop,
    policyInputs.stop,
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

interface ControllerRuntime {
  deps: ControllerDeps;
  fleetControllerPrivateKey: string;
  chartFingerprint: string;
}

function progressJournalDeps(store: PlatformStateStore, logFn: (message: string) => void): ProgressJournalDeps {
  return { store, log: logFn };
}

function buildSurgeHandoffDeps(input: {
  store: PlatformStateStore;
  runKubectl: KubectlSubprocess;
  privateKey: string;
}): SurgeCustomerHandoffDeps {
  const { store, runKubectl, privateKey } = input;
  return {
    ...createSurgePodTransport({
      privateKey,
      log,
    }),
    recordMigrationProgress: ({ gatewayId, uid, event }) =>
      journalHandoffProgress(progressJournalDeps(store, log), { gatewayId, uid }, event),
    listPods: createSurgeEndpointLister({
      readRuntimeDoc: (gatewayId) => store.fleetRegistry.get(gatewayId),
      listPods: (gatewayId) => listSurgePods(runKubectl, NAMESPACE, gatewayId),
      readComputerReady: createComputerReadinessProbe({
        port: FLEET_CONTROLLER_PORT,
        timeoutMs: GATEWAY_HEALTH_TIMEOUT_MS,
        log,
      }),
    }),
    deleteCancelledTarget: ({ pod }) => deleteCancelledSurgePod(runKubectl, NAMESPACE, pod),
    deleteCrashLoopingPod: ({ pod }) => deleteSurgePod(runKubectl, NAMESPACE, pod),
    claimCrashLoopEviction: ({ gatewayId, imageTag, pod }) =>
      claimCrashLoopEviction(store, { gatewayId, imageTag, pod, now: Date.now() }),
    readAssignments: async (gatewayId) => {
      const [assignments, builders] = await Promise.all([
        store.gateways.assignments.list(gatewayId),
        store.builders.records.listByGateway(gatewayId),
      ]);
      const projected = assignments.map((assignment) => ({
        uid: assignment.uid,
        slug: assignment.slug,
        state: assignment.state,
        epoch: assignment.epoch,
        updatedAt: assignment.updatedAt,
        updatedByOperationId: assignment.updatedByOperationId,
        ...(assignment.sharedSurgeForwardRecovery ? { sharedSurgeForwardRecovery: assignment.sharedSurgeForwardRecovery } : {}),
      }));
      const assignedUsers = builders.map((builder) => {
        if (!builder.slug) throw new Error(`assigned user ${builder.uid} has no gateway slug`);
        return { uid: builder.uid, slug: builder.slug };
      });
      const retained = await pruneSurgeOrphanAssignments({
        store,
        gatewayId,
        assignments: projected,
        users: assignedUsers,
        now: Date.now(),
        log,
      });
      assertSurgeAssignmentCoverage(retained, assignedUsers);
      return retained;
    },
    readSystemConfigCommit: (pod) => readPodSystemConfigCommit(runKubectl, NAMESPACE, pod),
    markSharedSurgeForwardRecovery: (assignment) => markSharedSurgeForwardRecovery({ store, log }, assignment),
    rebindSharedSurgeForwardRecovery: (assignment) => rebindSharedSurgeForwardRecovery({ store, log }, assignment),
    markAssignment: (assignment) => markAssignmentState({ store, log }, assignment),
    readOwnerOperation: async (operationId) => {
      const record = await store.journal.operations.get(operationId);
      if (record === null) return null;
      const operation = operationFromRecord(record);
      return { status: operation.status, sourceRecoveryPending: schedulerHandoffAwaitingRelease(operation) };
    },
    log,
  };
}

function buildNativeReturnTargetRetirementVerifier(store: PlatformStateStore, kubeOps: KubeOps) {
  return createNativeReturnTargetRetirementVerifier({
    store, credentialsRetired: createAgentStoreCredentialRetirementVerifier(requireEnv("OPENCLAW_AGENT_STORE_ADMIN_DSN", "native return recovery requires PostgreSQL retirement proof")),
    runtimeAbsent: async gatewayId => {
      if (!await retiredSharedGatewayRuntimeAbsent(kubeOps, NAMESPACE, gatewayId, deploymentNameForInstance(gatewayId))) return false;
      const pvc = await spawnKubectl(["-n", NAMESPACE, "get", `pvc/octogee-gateway-${gatewayId}-data`, "--ignore-not-found=true", "-o", "name"]);
      if (pvc.code !== 0) throw new Error("native return recovery could not inspect retired Shared home storage");
      return !pvc.stdout.trim();
    },
  });
}

function buildNativeReturnSourceRecoveryOwner(store: PlatformStateStore, kubeOps: KubeOps, privateKey: string, prepareMigrationAgentStores: PrepareMigrationAgentStores) {
  return createNativeReturnSourceRecoveryOwner({
    store, now: Date.now, log, prepareSourceStores: prepareMigrationAgentStores,
    verifyRetiredTarget: buildNativeReturnTargetRetirementVerifier(store, kubeOps),
    releaseSourceHold: input => releaseNativeReturnSourceRecoveryHold({ store, vm: createGatewayComputeClient(store, log), now: Date.now,
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)) }, input),
    sourceClient: async (gatewayId, authority) => {
      const url = await resolveGatewayFleetUrl(store, gatewayId);
      return createMigrationClientBuilder(store, privateKey, log,
        (id, slug) => prepareMigrationAgentStores(id, slug, authority))(id => {
          if (id !== gatewayId) throw new Error("native return recovery source transport changed");
          return url;
        });
    },
  });
}

function buildAbandonedNativeSchedulerRecovery(store: PlatformStateStore, kubeOps: KubeOps, logFn: (msg: string) => void) {
  const vm = createGatewayComputeClient(store, logFn);
  const { provider } = createBuilderHomeServices(store, logFn);
  return createAbandonedNativeSchedulerRecovery({
    store,
    verifyRetiredTarget: buildNativeReturnTargetRetirementVerifier(store, kubeOps),
    oldSourceAbsent: async gatewayId => {
      if (!await retiredSharedGatewayRuntimeAbsent(kubeOps, NAMESPACE, gatewayId, deploymentNameForInstance(gatewayId))) return false;
      return !await vm.findByLabels({ "octogee-gateway-id": gatewayId, "octogee-environment": COMPUTER_ENVIRONMENT });
    },
    verifyComputer: async (computer, input) => {
      const [instance, home] = await Promise.all([vm.describe(computer.instanceName, computer.zone), provider.readDisk(computer.homeSource)]);
      const instancePath = `projects/${home.projectId}/zones/${computer.zone}/instances/${computer.instanceName}`;
      return instance?.instanceId === computer.instanceId && instance.gatewayId === input.fromGatewayId &&
        instance.internalIp === computer.internalIp && instance.status === "RUNNING" &&
        instance.metadata["octogee-owner-uid"] === input.uid && home.ownerUid === input.uid.toLowerCase() &&
        home.id === computer.homeId && home.users?.length === 1 && home.users[0].endsWith(instancePath);
    },
  });
}

function createBootUpgradeJournal(store: PlatformStateStore): VmGatewayRuntimeDeps["journalBootUpgrade"] {
  return async (input, work) => {
    const assertAuthority = () => withGatewayRuntimeMutation(store, input.gatewayId, async (transaction) => {
      const authorization = await readGatewayAuthorizationInStore(transaction, input.gatewayId);
      if (authorization?.gateway.desiredStatus !== "running" || authorization.config.ownerUid !== input.ownerUid) throw new Error("gateway is no longer starting for this computer owner");
    });
    await runNormalFleetMutation(store, {
      actor: "cowboy", forced: false, what: "upgrade-builder-boot", why: "Use the current computer image on boot while retaining the Builder home",
      target: { gatewayId: input.gatewayId }, preActionStatus: { instanceId: input.instanceId }, mutation: { imageId: input.imageId },
      action: () => work(assertAuthority),
    });
  };
}

function agentStoreDsns(): { adminDsn: string; clientDsn: string } {
  return {
    adminDsn: requireEnv("OPENCLAW_AGENT_STORE_ADMIN_DSN", "agent-store administration requires the controller-only administration URL"),
    clientDsn: requireEnv("OPENCLAW_AGENT_STORE_CLIENT_DSN", "all Gateways require a reachable agent-store database endpoint"),
  };
}

async function createControllerRuntime(
  db: Firestore,
  store: PlatformStateStore,
  createHostingCleanup?: ControllerProduct["createHostingCleanup"],
): Promise<ControllerRuntime> {
  const runKubectl: KubectlSubprocess = (args, opts) => spawnKubectl(args, opts);
  const authSecretEnsurer = createAuthSecretEnsurer({
    runKubectl,
    randomTokenHex: defaultRandomTokenHex,
    log,
  });
  const agentStore = agentStoreDsns();
  const provisionAgentStoreCredentials = createAgentStoreCredentialProvisioner(agentStore.adminDsn, agentStore.clientDsn);
  const { ensureGatewayAuthSecret, ensureGatewayCredentials } = createGatewayCredentialEnsurers({
    auth: authSecretEnsurer,
    readGateway: (gatewayId) => readDesiredRoot(store, gatewayId),
    provisionAgentStore: provisionAgentStoreCredentials,
    runKubectl,
    agentStoreClientDsn: agentStore.clientDsn,
  });
  const prepareMigrationAgentStores = createMigrationAgentStorePreparer({
    readGateway: gatewayId => readDesiredRoot(store, gatewayId),
    readBuilder: async slug => {
      const builder = await store.builders.records.findBySlug(slug);
      if (builder === null) throw new Error(`Agent-store handoff requires one Builder for slug ${slug}`);
      return { uid: builder.uid, slug };
    },
    ensureCredentials: gatewayId => ensureGatewayCredentials({ namespace: NAMESPACE, gatewayId }),
    transferOwnership: createAgentStoreOwnershipTransferer(agentStore.adminDsn, builder => readBuilderAgentStoreInventory(store.builders.agentStores, builder.uid)),
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
        if (isSecretNotFound(err)) return null;
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
        if (isSecretNotFound(err)) return null;
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
  const clusterHelm =
    process.env.HELM_RUNNER_MODE === "stub"
      ? createLoggingHelmRunner(log)
      : createHelmSubprocessRunner({
          runHelm: spawnHelm,
          log,
          ensureAuthSecret: ensureGatewayCredentials,
          ensureServiceAccount: serviceAccountEnsurer.ensureServiceAccount,
          runKubectl,
        });
  const vmRuntime = BUILDER_VM_SPEC
    ? createVmGatewayRuntime({
      store,
      namespace: NAMESPACE,
      environment: COMPUTER_ENVIRONMENT,
      runHelm: spawnHelm,
      runKubectl,
      vm: createGatewayComputeClient(store, log),
      vmSpec: BUILDER_VM_SPEC,
      disposableParking: resolveDisposableBuilderParking(process.env),
      computeProjectId: gatewayComputeProjectId(),
      bridgeServiceName: process.env.GATEWAY_VM_BRIDGE_SERVICE ?? "octogee-vm-bridge",
      hostAliasNames: GATEWAY_VM_HOST_ALIASES.map((service) => `${service}.${NAMESPACE}.svc.cluster.local`),
      kubernetes: {
        apiHost: requireEnv("GATEWAY_VM_KUBERNETES_API_HOST", "gateway VMs need the cluster's private control-plane endpoint for TokenReview"),
        apiPort: process.env.GATEWAY_VM_KUBERNETES_API_PORT ?? "443",
        caCert: readFileSync(process.env.GATEWAY_VM_KUBERNETES_CA_PATH ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "utf8"),
      },
      routesConfigMap: process.env.GATEWAY_VM_ROUTES_CONFIGMAP ?? "octogee-vm-routes",
      ensureAuthSecret: ensureGatewayCredentials,
      readDesiredStatus: async (gatewayId) => (await readDesiredRoot(store, gatewayId))?.desiredStatus ?? null,
      journalBootUpgrade: createBootUpgradeJournal(store),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      onComputerCreationSettled: (gatewayId) => convergeSettledComputer(gatewayId),
      now: () => Date.now(),
      log,
    })
    : null;
  vmGatewayRuntimeRef.current = vmRuntime ?? undefined;
  const helm = vmRuntime
    ? createRuntimeDispatchingHelmRunner({
        cluster: clusterHelm,
        vm: vmRuntime,
        isVmGateway: (gatewayId) => isVmGateway(store, gatewayId),
      })
    : clusterHelm;
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
    await syncEdgeIngressForGateways(await readDurableServingFleetGateways(store));
  };

  const fleetControllerPrivateKey = requireEnv(
    "FLEET_CONTROLLER_PRIVATE_KEY",
    "migrate-customer, deprovision-customer, and operator eviction RPCs require the controller signing key",
  );
  const surgeHandoffDeps = buildSurgeHandoffDeps({
    store,
    runKubectl,
    privateKey: fleetControllerPrivateKey,
  });

  const runGatewayConvergence = (gatewayIds?: readonly string[]) =>
    runGatewayConvergencePass({
      store,
      helm,
      kubeOps,
      chartFingerprint,
      prepareGatewayConfig,
      reconcileSurgeHandoff: (input) => reconcileSurgeCustomerHandoff(surgeHandoffDeps, input),
      log,
    }, gatewayIds);
  const convergeGateways = serializeGatewayConvergence(runGatewayConvergence);
  const convergeSettledComputer = convergeAfterComputerCreation(convergeGateways, log);
  const nativeReturnRecovery = buildNativeReturnSourceRecoveryOwner(store, kubeOps, fleetControllerPrivateKey, prepareMigrationAgentStores);
  const handlers = await buildHandlers(db, log, helm, kubeOps, {
    syncFleetIngress: handlerSyncFleetIngress, privateKey: fleetControllerPrivateKey,
    modelKeySourceIssuer, prepareGatewayConfig, chartFingerprint,
    runRuntimeRecovery: convergeGateways.runExclusive,
    prepareMigrationAgentStores, nativeReturnRecovery, store,
    deleteHostingSites: createHostingCleanup?.(log),
  });

  const deps: ControllerDeps = {
    store,
    helm,
    kubeOps,
    modelKeySourceIssuer,
    modelKeySecretEnsurer,
    restartGatewayDeployment: createGatewayDeploymentRestarter(store,runKubectl, log),
    handlers,
    requestNativeReturnSourceRecovery: nativeReturnRecovery.request,
    log,
    syncFleetIngress: syncEdgeIngressForGateways,
    convergeGateways,
    reconcileSafetyRefreshMs: RECONCILE_SAFETY_REFRESH_MS_DEFAULT,
    chartFingerprint,
    ensureGatewayAuthSecret,
    startDisruptionObserver: () => startDisruptionObserver({
      store,
      runKubectl,
      environment: ENVIRONMENT_SETTINGS.name,
      cluster: ENVIRONMENT_SETTINGS.clusterName,
      namespace: NAMESPACE,
      intervalMs: DISRUPTION_OBSERVER_MS,
      log,
    }),
  };

  return { deps, fleetControllerPrivateKey, chartFingerprint };
}

type HostingCleanup = NonNullable<NukeCloudDeps["deleteHostingSites"]>;

export interface ControllerProduct {
  createHostingCleanup?: (log: (message: string) => void) => HostingCleanup;
  addAdminRoutes?: ProductAdminRoutes;
  adminIdentity?: IdentityProvider;
  placementAdmission?: PlacementAdmissionPolicy;
  builderAdmission?: BuilderAdmissionSourceFactory;
  builderPolicyInputs?: (db: Firestore, log: (message: string) => void) => BuilderPolicyInputsSource;
  startProjection?: (deps: {
    db: Firestore;
    store: PlatformStateStore;
    log: (message: string) => void;
  }) => ControllerStopper;
}

export async function main(product: ControllerProduct = {}): Promise<void> {
  installDefaultUserEntitlements();
  const controllerStartedAt = Date.now();
  initializeApp({
    credential: applicationDefault(),
    storageBucket: resolveDefaultStorageBucket(process.env.GOOGLE_CLOUD_PROJECT),
  });
  const db = getFirestore();
  const store = platformStateStoreFromEnvironment({
    applicationName: "glm-controller",
    createFirestoreStore: () => createFirestorePlatformStateStore({ db }),
    logger,
  });
  const { deps, fleetControllerPrivateKey, chartFingerprint } = await createControllerRuntime(db, store, product.createHostingCleanup);

  log(
    `[glm-controller] boot sha=${process.env.BUILD_SHA ?? "unknown"} oc=${process.env.OPENCLAW_VERSION ?? "n/a"} fork=${process.env.OPENCLAW_FORK_SHA ?? "n/a"} node=${process.version} — namespace=${NAMESPACE} gatewayChart=${GATEWAY_CHART} chartFingerprint=${chartFingerprint.slice(0, 12)} chartDriftPolicy=release-gated valuesFile=${GATEWAY_VALUES_FILE}`,
  );

  await bootstrapGlmGateways(deps);
  const sharedPoolBounds = sharedPoolReplicaBoundsFromEnvironment();
  const platformArtifact = platformGatewayArtifactFromEnvironment();
  await writePlatformReleaseRecord({
    store: deps.store,
    artifact: platformArtifact,
    now: () => Date.now(),
    log,
  });
  recordSharedPoolReplicaBounds(sharedPoolBounds);
  log(
    `[glm-controller] shared pool minReplicas=${sharedPoolBounds.minReplicas} maxReplicas=${sharedPoolBounds.maxReplicas} platformImage=${platformArtifact.imageTag}`,
  );
  try {
    await completeHealthySharedPoolAddGatewayOperations({
      store: deps.store,
      log,
      now: () => Date.now(),
    });
  } catch (err) {
    log(
      `[glm-controller] ⚠ shared pool add-gateway recovery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Resume any op the previous instance left `running` when it exited mid-op (a
  // deploy/restart redeploys this single-replica controller routinely). Re-driving
  // the rollout idempotently is what keeps a redeploy from stranding a half-migrated
  // pool; it runs before the stuck-op reaper's first tick so the re-adopt heartbeat
  // protects the resumed run from being reaped.
  resumeOrphanedRunningOps({
    store: deps.store,
    log,
    resumableKinds: RESUMABLE_OP_KINDS,
    resumableOperation: operationIsRestartResumable,
    redrive: (op) => reAdoptAndRunOperation(op, deps),
  }).catch((err) =>
    log(
      `[glm-controller] ⚠ resume-orphaned-ops sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );

  try {
    await recoverControllerOrphanedOperations({ store: deps.store, log, now: () => Date.now(), controllerStartedAt });
  } catch (err) {
    log(
      `[glm-controller] ⚠ boot orphan recovery failed; the stuck-op reaper recovers them after its budget: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const policyInputs = product.builderPolicyInputs?.(db, log) ?? noBuilderPolicyInputs;
  const adminIdentity = combineIdentityProviders([
    product.adminIdentity,
    googleIdentityFromEnvironment(process.env),
  ].filter((provider): provider is IdentityProvider => provider != null));
  const stoppers = startControllerBackgroundTasks({
    addProductAdminRoutes: product.addAdminRoutes,
    adminIdentity,
    placementAdmission: product.placementAdmission ?? openPlacementAdmission,
    policyInputs,
    builderAdmission: product.builderAdmission,
    db,
    deps,
    helm: deps.helm,
    fleetControllerPrivateKey,
    platformArtifact,
    controllerStartedAt,
  });
  stoppers.push(
    startSharedPoolScaler({
      store: deps.store,
      bounds: sharedPoolBounds,
      platformArtifact,
      log,
      now: () => Date.now(),
      recordMaxCapacity: recordSharedGatewayMaxCapacity,
    }, SHARED_POOL_SCALER_MS),
  );
  if (product.startProjection) stoppers.push(product.startProjection({ db, store: deps.store, log }));
  const shutdown = createControllerShutdown(stoppers, log);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export async function bootstrapGlmGateways(deps: ControllerDeps): Promise<void> {
  deps.log("[glm-controller] legacy Helm bootstrap disabled; durable roots and revisions own recovery");
}

function retainedSourceRunner(store: PlatformStateStore, context: RetainedSourceContext) {
  const artifact = platformGatewayArtifactFromEnvironment();
  const digest = artifact.imageTag.split('@')[1];
  if (!digest) throw new Error('retained source helper image has no digest');
  return createRetainedSourceTransfer({store,namespace:NAMESPACE,image:`${artifact.imageRepository}@${digest}`,runCommand:createSubprocessCommandRunner(),now:Date.now},context);
}

async function cleanupRetainedSource(store: PlatformStateStore, privateKey:string, context:RetainedSourceContext): Promise<void> {
  await abortRetainedSourceImport({store,namespace:NAMESPACE,privateKey,fleetControllerPort:FLEET_CONTROLLER_PORT,resolveGatewayUrl:()=>'',resolveGatewayVm:transportId=>readGatewayVmAddress(store,transportId),retainedSource:retainedSourceRunner(store,context)}, {migrationId:context.state.migrationId,slug:context.state.slug,toGatewayId:context.state.targetGatewayId});
}

function createMigrationClientBuilder(
  store: PlatformStateStore,
  privateKey: string,
  logFn: (msg: string) => void,
  prepareAgentStores?: PrepareMigrationAgentStores,
) {
  return (resolveSync: (gatewayId: string) => string, retainedSource?: RetainedSourceContext) => {
    return createMigrationClient({
      privateKey,
      resolveGatewayUrl: resolveSync,
      log: logFn,
      prepareAgentStores,
      resolveTransferAttemptForCleanup: input => readTransferAttemptForCleanup({ store, namespace: NAMESPACE, now: Date.now, runCommand: createSubprocessCommandRunner() }, input),
      transferState: async (request) => {
        if (request.mode === "final" && !prepareAgentStores) throw new Error("Final agent-store transfer requires ownership preparation");
        return createRsyncMigrationTransfer({
        prepareAgentStores,
        ...(retainedSource ? {retainedSource: retainedSourceRunner(store,retainedSource)} : {}),
        store,
        namespace: NAMESPACE,
        privateKey,
        fleetControllerPort: FLEET_CONTROLLER_PORT,
        resolveGatewayUrl: resolveSync,
        resolveGatewayVm: (transportId) => readGatewayVmAddress(store, transportId),
        log: logFn,
      })(request);
      },
    });
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

async function collectMigrationChannelBindings(
  store: Pick<PlatformStateStore, "workspaces">,
  slug: string,
  projects: readonly Stored<WorkspaceProject>[],
): Promise<FleetBrokerChannelBinding[]> {
  const [workspaceChannels, projectChannels] = await Promise.all([
    store.workspaces.channels.list({ workspaceSlug: slug, projectSlug: null }),
    Promise.all(projects.map((project) => store.workspaces.channels.list({ workspaceSlug: slug, projectSlug: project.projectSlug }))),
  ]);
  return [
    ...workspaceChannels.flatMap((channel) =>
      channel.mattermostChannelId === null
        ? []
        : [{ scope: "workspace" as const, kind: channel.kind ?? "general", channelId: channel.mattermostChannelId }]),
    ...projects.flatMap((project, index) =>
      projectChannels[index].flatMap((channel) =>
        channel.mattermostChannelId === null
          ? []
          : [{
              scope: "project" as const,
              projectId: project.projectSlug,
              kind: channel.kind ?? "default",
              channelId: channel.mattermostChannelId,
            }])),
  ];
}

function collectMigrationProjects(projects: readonly Stored<WorkspaceProject>[]): FleetBrokerProjectRestore[] {
  return projects.map((project) => {
    const out: FleetBrokerProjectRestore = { projectSlug: project.projectSlug, giteaRepoName: project.giteaRepoName };
    if (project.provisioningState !== null) out.provisioningState = project.provisioningState;
    const repoSource = projectRepoSourceFromDoc(project.repoSource);
    if (repoSource) out.repoSource = repoSource;
    return out;
  });
}

function migrationProjectCheckoutScope(
  stored: Stored<GatewayRoot> | null,
  gatewayId: string | undefined,
  uid: string,
  slug: string,
): FleetBrokerProjectCheckoutScope {
  if (!gatewayId || stored === null) return "workspace-only";
  const { revision: _revision, ...gatewayData } = stored;
  const root = projectGatewayDesiredRootForGateway(gatewayData, gatewayId);
  if (!root) return "workspace-only";
  if (root.gatewayClass === "shared") return "workspace-and-projects";
  if (root.ownerUid !== uid || root.builderSlug !== slug) {
    return "workspace-only";
  }
  if (
    root.gatewayClass === "builder" &&
    root.allocation?.kind === "disposable-builder" &&
    root.allocation.claimedByUid === uid
  ) {
    return "workspace-and-projects";
  }
  return "workspace-only";
}

// eslint-disable-next-line complexity -- Mirrors the octogee-api fleet broker snapshot shape.
export async function readMigrationUserSnapshot(
  db: Firestore,
  store: Pick<PlatformStateStore, "secrets" | "gateways" | "builders" | "workspaces">,
  uid: string,
  toGatewayId?: string,
): Promise<FleetBrokerUserSnapshot | null> {
  const [builder, userSnap] = await Promise.all([store.builders.records.get(uid), db.collection("users").doc(uid).get()]);
  const data = userSnap.data() as Record<string, unknown> | undefined;
  if (builder === null || !userSnap.exists || !data) return null;
  const slug = builder.slug;
  if (!slug) return null;
  const [workspaceProjects, coachSecret, agentSnap, sysConfig, targetGateway, projectAgents] = await Promise.all([
    store.workspaces.projects.list(slug),
    store.secrets.get(uid, "coachMattermost"),
    db.collection("agents").doc(uid).get(),
    db.collection("users").doc(uid).collection("system").doc("config").get(),
    toGatewayId ? store.gateways.roots.get(toGatewayId) : Promise.resolve(null),
    collectStoredProjectAgentStates(store, uid, slug),
  ]);
  const channels = await collectMigrationChannelBindings(store, slug, workspaceProjects);
  const projectCheckoutScope = migrationProjectCheckoutScope(
    targetGateway,
    toGatewayId,
    uid,
    slug,
  );
  const projects = projectCheckoutScope === "workspace-and-projects"
    ? collectMigrationProjects(workspaceProjects)
    : [];
  const coachCredential = coachSecret !== null && coachSecret.kind === "coach-mattermost" ? coachSecret : null;
  const agentData = agentSnap.data() as Record<string, unknown> | undefined;
  const name = typeof agentData?.name === "string" ? agentData.name : "";
  const emoji = typeof agentData?.avatarEmoji === "string" ? agentData.avatarEmoji : "";
  const status = builder.openclaw.status;
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
    gatewayId: builder.gateway?.gatewayId ?? "",
    status: status === "provisioning" || status === "complete" ? status : "",
    agentIds: [...builder.agents.agentIds],
    repoUrl: builder.provisioning.gitRepoUrl ?? "",
    mattermostUserId: builder.mattermostUserId,
    customerMmUserId: builder.mattermostUserId,
    channels,
    projectCheckoutScope,
    projects,
    projectAgents,
    ownerName: stringAt(data, "displayName") || slug,
    email: stringAt(data, "email"),
    displayName: stringAt(data, "displayName"),
    lastName: stringAt(data, "lastName"),
    photoURL: stringAt(data, "photoURL"),
    onboardingVibe:
      typeof readPath(data, "onboarding.vibe") === "string"
        ? (readPath(data, "onboarding.vibe") as string)
        : null,
    coachToken: coachCredential?.personalToken ?? null,
    coachMmUserId: coachCredential?.mattermostUserId ?? null,
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
    prepareGatewayConfig: <T extends GatewayMutableConfig & { gatewayId: string }>(
      config: T,
    ) => Promise<T>;
    chartFingerprint: string;
    runRuntimeRecovery: (work: () => Promise<void>) => Promise<void>;
    prepareMigrationAgentStores: PrepareMigrationAgentStores;
    nativeReturnRecovery: ReturnType<typeof createNativeReturnSourceRecoveryOwner>;
    store: PlatformStateStore;
    deleteHostingSites?: HostingCleanup;
  },
): Promise<OperationHandlers> {
  const { privateKey, modelKeySourceIssuer, store, deleteHostingSites } = fleetOps;
  if (!privateKey) {
    throw new Error(
      "FLEET_CONTROLLER_PRIVATE_KEY is not set — required for migrate-customer. Refusing to start with stub handlers.",
    );
  }
  const stateDeps: FleetStateDeps = { store, log: logFn };
  const cutoverDeps: CutoverDeps = { ...stateDeps, readBuilderTier: firestoreBuilderTierReader(db) };

  const addGateway = createAddGatewayHandler({
    helm,
    kubeOps,
    resolveGatewayRevision: async (gatewayId) => {
      const authorization = await readGatewayAuthorizationInStore(store, gatewayId);
      if (!authorization) return null;
      const gateway = authorization.gateway as DurableGateway;
      const artifact = await readGatewayArtifactInStore(store, gatewayId, gateway.desiredRelease);
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
    readGatewayHeartbeat: (gatewayId) => readGatewayHeartbeat(store, gatewayId),
    publishGatewayReady: async ({ gatewayId, imageTag }) => {
      await publishPlatformGatewayReady(store, {
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

  const recoveryTargetTransport = createSurgePodTransport({ privateKey, log: logFn });
  const recoveryTargetEndpoints = createSurgeEndpointLister({
    readRuntimeDoc: gatewayId => store.fleetRegistry.get(gatewayId),
    listPods: gatewayId => listSurgePods(spawnKubectl, NAMESPACE, gatewayId),
    readComputerReady: createComputerReadinessProbe({ port: FLEET_CONTROLLER_PORT, timeoutMs: GATEWAY_HEALTH_TIMEOUT_MS, log: logFn }),
  });
  const migrateCustomer = createMigrateCustomerHandler({
    prepareBuilderRecoveryTarget: input => prepareBuilderRecoveryTarget({
      assertAuthority: recovery => assertWorkspaceMigrationRecoveryAuthority(stateDeps, recovery),
      targetAssigned: async gatewayId => {
        const [unassigned, builders] = await Promise.all([
          store.gateways.assignments.isEmpty(gatewayId),
          store.builders.records.listByGateway(gatewayId, { limit: 1 }),
        ]);
        return !unassigned || builders.length > 0;
      },
      listPods: recoveryTargetEndpoints,
      holdTargetOpenClaw: recoveryTargetTransport.holdTargetOpenClaw!,
      unreserveTargetOpenClaw: recoveryTargetTransport.unreserveTargetOpenClaw!,
    }, input),
    assertMigrationRecoveryAuthority: (input) => assertWorkspaceMigrationRecoveryAuthority(stateDeps, input),
    assertMigrationSourcePreparationAuthority: (input) => assertWorkspaceMigrationSourcePreparationAuthority(stateDeps, input),
    completeMigrationRecovery: (input) => completeWorkspaceMigrationRecovery(stateDeps, input),
    clearMigrationPreparation: (input) => clearWorkspaceMigrationPreparation(stateDeps, input),
    setMigrationPhase: (input) => setWorkspaceMigrationPhase(stateDeps, input),
    reportMigrationProgress: async (gatewayId, event) => {
      const url = await resolveGatewayFleetUrl(store, gatewayId);
      await reportMigrationProgress({ privateKey, resolveGatewayUrl: () => url }, gatewayId, event);
    },
    recordMigrationProgress: ({ operation, event }) =>
      journalOperationProgress(progressJournalDeps(store, logFn), operation, event),
    recoverNativeReturnSource: fleetOps.nativeReturnRecovery.recover,
    recoverAbandonedNativeScheduler: buildAbandonedNativeSchedulerRecovery(store, kubeOps, logFn),
    prepareNativeComputerReturn: (input) => prepareNativeComputerReturn({
      store, vm: createGatewayComputeClient(store, logFn),
      now: Date.now, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }, input),
    retireNativeSchedulerBeforeStage: (input, scheduler) => retireNativeSchedulerBeforeStage({
      store, vm: createGatewayComputeClient(store, logFn), log: logFn,
    }, input, scheduler),
    readUser: async (uid) => {
      const builder = await store.builders.records.get(uid);
      const slug = builder?.slug;
      const currentGatewayId = builder?.gateway?.gatewayId;
      if (!slug || !currentGatewayId) return null;
      return { slug, currentGatewayId };
    },
    readUserSnapshot: (uid, toGatewayId) => readMigrationUserSnapshot(db, store, uid, toGatewayId),
    readPrivateProjectCoachWorkspace: async (gatewayId, slug) => readPrivateProjectCoachWorkspace({
      baseUrl: await resolveGatewayFleetUrl(store, gatewayId, { allowUnready: true }),
      gatewayId, privateKey, privateProjectCoachSlug: slug, timeoutMs: GATEWAY_HEALTH_TIMEOUT_MS,
      fetchImpl: fetch, newRequestId: randomUUID,
    }),
    readScheduleTransfer: (uid, migrationId) => store.builders.scheduleTransfers.get(uid, migrationId),
    saveScheduleTransfer: (uid, doc) => store.builders.scheduleTransfers.put(uid, doc),
    recordScheduleRestore: (uid, migrationId, restore) => store.builders.scheduleTransfers.patch(uid, migrationId, restore),
    readGatewaySystemConfigCommit: (gatewayId) => readGatewaySystemConfigCommit(store, gatewayId),
    readOpenClawBuild: async (gatewayId, release) =>
      (await readGatewayArtifactInStore(store, gatewayId, release))?.openclawSourceSha ?? null,
    commitCutover: async (commit) => {
      await commitCutoverAtomic(
        cutoverDeps,
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
    resolveGatewayUrl: (gatewayId, options) => resolveGatewayFleetUrl(store, gatewayId, options),
    observeSourceTransfer: async (op) => {
      const fresh = await store.journal.operations.get(op.id);
      if (!fresh?.customerMigrationV2) return undefined;
      const context={op,state:fresh.customerMigrationV2};
      const observed=await retainedSourceRunner(store,context).observe();
      if (observed?.status==='failed' && observed.targetCleanup==='pending') await cleanupRetainedSource(store,privateKey,context);
      return retainedSourceRunner(store,context).observe();
    },
    cleanupSourceTransfer: (op,state)=>cleanupRetainedSource(store,privateKey,{op,state}),
    buildClient: createMigrationClientBuilder(
      store,
      privateKey,
      logFn,
      fleetOps.prepareMigrationAgentStores,
    ),
    prepareMigrationAgentStores: fleetOps.prepareMigrationAgentStores,
    resolveSourcePlacement: async (uid, currentGatewayId) => {
      const source = await resolveSourceRevision(store, uid, currentGatewayId);
      if (!source) return null;
      return {
        release: source.release,
        ...(source.gatewayClass ? { gatewayClass: source.gatewayClass } : {}),
        ...(source.epoch !== undefined ? { epoch: source.epoch } : {}),
        assignmentMode: source.assignmentMode,
        ...(source.rootUpdatedAt !== undefined ? { rootUpdatedAt: source.rootUpdatedAt } : {}),
      };
    },
    resolveTargetPlacement: async (toGatewayId) => {
      const placement = await resolveGatewayPlacement(store, toGatewayId);
      if (!placement) return null;
      return placement.ok
        ? { ok: true, release: placement.release, gatewayClass: placement.gatewayClass }
        : { ok: false, reason: placement.reason };
    },
    // The roster quiesce gate: written "quiescing" before the source quiesce
    // RPC, restored "serving" on a pre-cutover rollback (fleet-migration-runner).
    setAssignmentState: async (input) => {
      await markAssignmentState(stateDeps, input);
    },
    readGatewayRootFence: async (gatewayId) => customerMigrationV2GatewayRootFence(await readDesiredRoot(store, gatewayId), gatewayId),
    commitV2Cutover: async (input) => {
      await commitCutoverAtomic(
        cutoverDeps,
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
            ...(input.claimStartedAt !== undefined ? {claimStartedAt:input.claimStartedAt} : {}),
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
    useDurableMigration: async (fromGatewayId, toGatewayId, retainedNativeRelease) => {
      const [sourceAuthorization, targetAuthorization] = await Promise.all([
        readGatewayAuthorizationInStore(store, fromGatewayId),
        readGatewayAuthorizationInStore(store, toGatewayId),
      ]);
      if (!sourceAuthorization) {
        throw new Error(`source gateway ${fromGatewayId} has no durable root`);
      }
      if (!targetAuthorization) {
        throw new Error(`target gateway ${toGatewayId} has no durable root`);
      }
      const sourceData = sourceAuthorization.gateway as DurableGateway;
      const targetData = targetAuthorization.gateway as DurableGateway;
      if (!migrationSourceReady(sourceData, retainedNativeRelease)) {
        throw new Error(
          `source gateway ${fromGatewayId} is not migration-ready ` +
          `(desiredStatus=${sourceData.desiredStatus}, desiredRelease=${sourceData.desiredRelease}, ` +
          `liveRelease=${sourceData.liveRelease}); requires running or draining with a converged release`,
        );
      }
      if (!migrationTargetRootIsStable(targetData)) {
        throw new Error(
          `target gateway ${toGatewayId} is not migration-ready ` +
          `(desiredStatus=${targetData.desiredStatus}, desiredRelease=${targetData.desiredRelease}, ` +
          `liveRelease=${targetData.liveRelease}); requires running with a converged release`,
        );
      }
      const gatewayClass = (data: typeof sourceData) => resolveGatewayClass({
        gatewayClass: data.gatewayClass ?? undefined,
        profile: data.profile ?? undefined,
        imageProfile: data.imageProfile ?? undefined,
      });
      return gatewayClass(sourceData) !== "shared" && gatewayClass(targetData) !== "shared";
    },
    findPreemptedComputer: async (gatewayId, sinceMs) => {
      const runtime = vmGatewayRuntimeRef.current;
      const instanceName = runtime ? await runtime.detectPreemption(gatewayId, sinceMs) : null;
      if (runtime && instanceName) {
        await runGatewayRuntimeExclusive(() => runtime.recoverUnreachable(gatewayId)).catch((error: unknown) => {
          logFn(`[migrate-customer] ⚠ ${gatewayId}: restart of preempted computer ${instanceName} deferred to the heartbeat recovery: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      return instanceName;
    },
    genMigrationId: (operationId) => `mig-${operationId}`,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: logFn,
  });

  const retireGateway = createRetireGatewayHandler({
    revokeAgentStoreCredentials: createAgentStoreCredentialRevoker(requireEnv("OPENCLAW_AGENT_STORE_ADMIN_DSN", "Gateway retirement requires the controller-only administration URL")),
    isPausedNativeSourceFencedOff: (input) => pausedNativeRetirementSourceFencedOff({
      store,
      describe: (name, zone) => createGatewayComputeClient(store, logFn).describe(name, zone),
    }, input),
    verifyRetirementClaim: ({ gatewayId, operationId, version }) =>
      verifyGatewayRetirementClaimAtomic({
        store,
        gatewayId,
        operationId,
        version,
        now: Date.now(),
        updatedBy: "cowboy-retire-gateway",
      }),
    readMountedCustomers: async (gatewayId) => {
      const runtime = await store.fleetRegistry.get(gatewayId);
      return runtime === null ? [] : readMountedCustomers(runtime as unknown as Record<string, unknown>);
    },
    helmUninstallGateway: async (gatewayId) => {
      await runGatewayRuntimeExclusive(async () => {
        if (!(await gatewayRuntimeMutationAllowed(store, gatewayId))) throw new Error('gateway retirement runtime unavailable');
        await helm.removeInstance({ namespace: NAMESPACE, gatewayId });
      });
    },
    readAssignmentsForGateway: async (gatewayId) => {
      const assignments = await store.gateways.assignments.list(gatewayId);
      return assignments.map((a) => ({ uid: a.uid, slug: a.slug }));
    },
    deleteGlmGateway: (gatewayId) => store.fleetRegistry.delete(gatewayId),
    deleteGatewayPersistentVolumeClaim: createGatewayPersistentVolumeClaimDeleter(kubeOps),
    deleteGatewayKubeSecret: async (gatewayId) =>
      kubeOps.deleteSecret({ namespace: NAMESPACE, name: `gateway-auth-token-${gatewayId}` }),
    deleteAuthTokenSecret: async (gatewayId) => {
      await deleteSecret(`gateway-auth-token-${gatewayId}`);
    },
    deleteGatewayServiceAccount: async (gatewayId) =>
      kubeOps.deleteServiceAccount({
        namespace: NAMESPACE,
        name: builderGatewayServiceAccountName(gatewayId),
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

  const rollbackTransport = createSurgePodTransport({ privateKey, log: logFn });
  const rollbackUnadmittedActivationTarget = createBuilderActivationRollRecoveryOwner({
    store, namespace: NAMESPACE, helm, chartFingerprint: fleetOps.chartFingerprint,
    runExclusive: fleetOps.runRuntimeRecovery,
    readRelease: (gatewayId, release) => readGatewayArtifactInStore(store, gatewayId, release),
    prepareIntent: async (gateway, artifact) => {
      const intent = await prepareDesiredGatewayIntent({ passDeps: fleetOps, gateway, artifact, instance: undefined });
      if (!intent) throw new Error('Builder rollback immutable live intent is unavailable');
      return intent.opts;
    },
    listPods: gatewayId => listSurgePods(spawnKubectl, NAMESPACE, gatewayId),
    readPodHealth: rollbackTransport.readPodHealth,
    holdTarget: rollbackTransport.holdTargetOpenClaw!, unreserveTarget: rollbackTransport.unreserveTargetOpenClaw!,
    readTemplateObjects: async gatewayId => {
      const result = await spawnKubectl(['-n', NAMESPACE, 'get', 'deployment,replicaset,pod', '-l', `app=octogee-gateway,gateway-instance=${gatewayId}`, '-o', 'json']);
      if (result.code !== 0) throw new Error(`Builder rollback template inspection failed: ${result.stderr.trim()}`);
      return JSON.parse(result.stdout) as unknown;
    },
    now: Date.now, wait: () => new Promise(resolve => setTimeout(resolve, 1000)), log: logFn,
  });
  const rollout = createRolloutHandler({
    rollbackUnadmittedActivationTarget,
    readGatewayDoc: (gatewayId) => readDesiredRoot(store, gatewayId),
    readReleasePayload: (gatewayId, release) => readGatewayArtifactInStore(store, gatewayId, release),
    readDeploymentPrerequisiteError: async (gatewayId) => {
      if (!(await isVmGateway(store, gatewayId))) return null;
      const vmRuntime = vmGatewayRuntimeRef.current;
      if (!vmRuntime) return `gateway ${gatewayId}: gce-vm deployment requires configured VM runtime`;
      return vmRuntime.readDeploymentPrerequisiteError(gatewayId);
    },
    activateDesiredRelease: async ({ gatewayId, targetRelease, operationId }) =>
      withGatewayRuntimeMutation(store,gatewayId,async (transaction) => {
        const gateway = (await readGatewayAuthorizationInStore(transaction, gatewayId))?.gateway;
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
        await transaction.gateways.roots.patch(gatewayId, activation.patch as GatewayRootPatch);
        return { success: true as const };
      }),
    requestReconcileTick: (gatewayId) => requestReconcileTickRef.fire?.(gatewayId),
    releaseRecordTimeoutMs: 60_000,
    convergeTimeoutMs: 45 * 60_000,
    pollIntervalMs: 5_000,
    now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logFn,
  });

  const removal = { db, store, logFn, kubeOps, privateKey, deleteHostingSites };
  const deprovisionCustomer = buildDeprovisionCustomerHandler(removal);
  const suspendCustomer = buildSuspendCustomerHandler(
    db,
    store,
    privateKey,
    logFn,
    kubeOps,
  );
  const eraseCustomer = buildEraseCustomerHandler(removal);

  const restartGateway = createRestartGatewayHandler({
    recoverRestore: (op, ctx) => fleetOps.runRuntimeRecovery(() => recoverSharedRestoreRuntime({ store, namespace: NAMESPACE, sourceSha: process.env.BUILD_SHA ?? '', runKubectl: spawnKubectl }, op, ctx)),
    recoverSource: (op, ctx) => fleetOps.runRuntimeRecovery(() => recoverSharedSourceRuntime({ store, namespace: NAMESPACE, sourceSha: process.env.BUILD_SHA ?? '', runKubectl: spawnKubectl }, op, ctx)),
    kubeOps: {...kubeOps,restartOpenClawInPlace: async ({name}) => {
      const gatewayId=name.slice('octogee-gateway-'.length);
      if(name!==deploymentNameForInstance(gatewayId))throw new Error('gateway restart deployment identity mismatch');
      await restartGatewayProcess({store,namespace:NAMESPACE,runKubectl:spawnKubectl},gatewayId);
    }},
    namespace: NAMESPACE,
    resolveLiveRevisionId: async (gatewayId) => (await isServingRuntime(store, gatewayId)) ? gatewayId : null,
    now: () => Date.now(),
    log: logFn,
  });

  const recycleGateway = createRecycleGatewayHandler({
    readDesiredStatus: async (gatewayId) => (await readDesiredRoot(store, gatewayId))?.desiredStatus ?? null,
    setDesiredStatus: async (gatewayId, status) => {
      await withGatewayRuntimeMutation(store,gatewayId,async transaction => {
        await transaction.gateways.roots.patch(gatewayId,
          { desiredStatus: status, updatedAt: Date.now(), updatedBy: "cowboy-recycle-gateway" });
      });
    },
    readServingRevisionId: async (gatewayId) => (await isServingRuntime(store, gatewayId)) ? gatewayId : null,
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

  const gatewayVm = createGatewayVmHandler({
    replaceStoppedComputer: async (gatewayId, operationId, assertAuthority, options) => {
      const runtime = vmGatewayRuntimeRef.current;
      if (!runtime) throw new Error("retained-home boot replacement requires configured GCE runtime");
      const assertCurrent = async () => {
        await assertAuthority();
        await withGatewayRuntimeMutation(store, gatewayId, async () => undefined, options?.forceOwnerUid ? operationId : undefined);
      };
      return runNormalFleetMutation(store, {
        actor: "cowboy", forced: !!options?.forceOwnerUid, what: "replace-builder-platform-boot", why: options?.forceOwnerUid ? "Operator accepted possible boot data loss for retained computer recovery" : "Replace a stopped platform image while retaining the exact Builder home and pinned recovery images",
        target: { gatewayId, operationId }, preActionStatus: {}, mutation: { retainedHome: true, ...(options?.forceOwnerUid ? { forceOwnerUid: options.forceOwnerUid } : {}) },
        action: () => runtime.replaceStoppedComputer(gatewayId, operationId, assertCurrent, options),
      });
    },
    vm: createGatewayComputeClient(store, logFn),
    readGateway: async (gatewayId) => {
      const runtime = await store.fleetRegistry.get(gatewayId);
      return runtime === null ? null : { runtime: runtime.runtime, vm: runtime.vm ?? null };
    },
    writeVmState: (gatewayId, vm) => store.fleetRegistry.patch(gatewayId, { vm }),
    requestHomeCheckpoint: (gatewayId, requestedAt) => requestHomeCheckpoint(store, gatewayId, requestedAt),
    readHomeCheckpointCompletedAt: (gatewayId) => readHomeCheckpointCompletedAt(store, gatewayId),
    clearHomeCheckpointRequest: (gatewayId) => clearHomeCheckpointRequest(store, gatewayId),
    clearVmForReplacement: async (gatewayId) => {
      await clearReplacedComputer({ store, log: logFn }, gatewayId);
    },
    readParkedComputer: (ownerUid) => readParkedComputer(store, ownerUid),
    clearParkedComputer: (ownerUid) => clearParkedComputer(store, ownerUid),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: logFn,
  });

  return {
    "add-gateway": addGateway,
    "gateway-vm": (op, ctx) => runGatewayRuntimeExclusive(() => gatewayVm(op, ctx)),
    [MIGRATE_CUSTOMER_KIND]: migrateCustomer,
    "retire-gateway": retireGateway,
    "restart-gateway": restartGateway,
    "recycle-gateway": recycleGateway,
    "scale-shared-member": async () => ({
      steps: [],
      success: false,
      error: "terminal Shared Barn autoscaler journals cannot be executed",
    }),
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

function deletionGatewayClass(gateway: Pick<GatewayRoot, "gatewayClass" | "profile" | "imageProfile"> | undefined): string | null {
  if (!gateway) return null;
  const gatewayClass = isGatewayClass(gateway.gatewayClass) ? gateway.gatewayClass : undefined;
  const profile = isGatewayProfile(gateway.profile) ? gateway.profile : undefined;
  const imageProfile = isGatewayProfile(gateway.imageProfile) ? gateway.imageProfile : undefined;
  return resolveGatewayClass({ gatewayClass, profile, imageProfile });
}

async function deletionGateway(
  store: PlatformStateStore,
  currentGatewayId: string | null | undefined,
): Promise<GatewayRoot | undefined> {
  if (typeof currentGatewayId !== "string") return undefined;
  return (await store.gateways.roots.get(currentGatewayId)) ?? undefined;
}

export async function ensureAnonymousDeletionArchive(
  db: Firestore,
  store: PlatformStateStore,
  deletionId: string,
): Promise<string> {
  const job = await store.jobs.deletions.get(deletionId);
  if (job === null) throw new Error(`deletion job missing: ${deletionId}`);
  if (job.archiveId) return job.archiveId;
  if (job.uid === undefined) throw new Error(`deletion job ${deletionId} has no uid`);
  const [userSnap, rollupSnap, gateway] = await Promise.all([
    db.collection("users").doc(job.uid).get(),
    db.collection(MODEL_BROKER_USAGE_ROLLUPS_COLLECTION).doc(job.uid).get(),
    deletionGateway(store, job.currentGatewayId),
  ]);
  const user = userSnap.data() as Record<string, unknown> | undefined;
  const { archivedAt, ...record } = buildAnonymousOperationalArchive({
    archivedAt: Date.now(),
    createdAt: timestampMillis(user?.createdAt),
    deletionRequestedAt: job.requestedAt,
    environment: deletionEnvironment(),
    planTier: deletionPlanTier(user),
    gatewayClass: deletionGatewayClass(gateway),
    rollup: (rollupSnap.data() ?? {}) as Record<string, unknown>,
  });
  return store.transaction({ label: "erase-customer.archive" }, async (tx) => {
    const current = await tx.jobs.deletions.get(deletionId);
    if (current === null) throw new Error(`deletion job missing: ${deletionId}`);
    if (current.archiveId) return current.archiveId;
    const archiveId = await tx.jobs.archives.create({ archivedAt, record });
    await tx.jobs.deletions.patch(deletionId, { archiveId, updatedAt: Date.now() });
    return archiveId;
  });
}

function productIds(productContext: CustomerDeletionJob["productContext"], field: "stripeCustomerIds" | "stripeSubscriptionIds"): string[] {
  const ids = productContext?.[field];
  return Array.isArray(ids) ? ids.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
}

export async function persistDeletionProductContext(
  store: PlatformStateStore,
  deletionId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await store.transaction({ label: "customer-deletion.persist-product-context" }, async (tx) => {
    const job = await tx.jobs.deletions.get(deletionId);
    if (job === null) throw new Error(`deletion job missing: ${deletionId}`);
    await tx.jobs.deletions.patch(deletionId, { productContext: { ...job.productContext, ...fields }, updatedAt: Date.now() });
  });
}

const PROJECT_AGENT_SECRET_PATH = /^users\/([^/]+)\/secrets\/([^/]+)$/u;

export async function deleteProjectAgentCredentialSecrets(store: PlatformStateStore, docPaths: readonly string[]): Promise<void> {
  const secrets = docPaths.map((docPath) => {
    const match = PROJECT_AGENT_SECRET_PATH.exec(docPath);
    if (match === null) throw new Error(`project-agent credential is not a Builder secret: ${docPath}`);
    return { uid: match[1], secretId: match[2] };
  });
  await store.transaction({ label: "suspend-customer.delete-project-agent-secrets" }, async (tx) => {
    for (const { uid, secretId } of secrets) await tx.secrets.delete(uid, secretId);
  });
}

const FIRESTORE_DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function persistPostHogErasureState(store: PlatformStateStore, deletionId: string, state: PostHogErasureState): Promise<void> {
  await store.transaction({ label: "erase-customer.persist-posthog-erasure" }, async (tx) => {
    const job = await tx.jobs.deletions.get(deletionId);
    if (job === null) throw new Error(`deletion job missing: ${deletionId}`);
    await tx.jobs.deletions.patch(deletionId, {
      productContext: { ...job.productContext, posthogErasure: state },
      updatedAt: Date.now(),
    });
  });
}

async function retainPostHogMappingOnly(store: PlatformStateStore, deletionId: string, archiveId: string): Promise<void> {
  await store.transaction({ label: "erase-customer.retain-posthog-mapping" }, async (tx) => {
    const job = await tx.jobs.deletions.get(deletionId);
    if (job === null) throw new Error(`deletion job missing: ${deletionId}`);
    await tx.jobs.deletions.patch(deletionId, postHogMappingOnlyJobPatch(job, archiveId, Date.now()));
  });
}

interface CustomerRemovalOptions {
  db: Firestore;
  store: PlatformStateStore;
  logFn: (message: string) => void;
  kubeOps: Pick<KubeOps, "readAvailableReplicas" | "readGatewayPodDiagnostics">;
  privateKey: string;
  deleteHostingSites?: HostingCleanup;
}

function buildEraseCustomerHandler({ db, store, logFn, kubeOps, privateKey, deleteHostingSites }: CustomerRemovalOptions) {
  const cloudCleanup = buildCustomerCloudCleanupDeps(db, store, logFn, deleteHostingSites);
  const clusterAbsent = async (gatewayId: string) => {
    if (!await retiredSharedGatewayRuntimeAbsent(kubeOps, NAMESPACE, gatewayId, deploymentNameForInstance(gatewayId))) return false;
    const pvc = await spawnKubectl(["-n", NAMESPACE, "get", `pvc/octogee-gateway-${gatewayId}-data`, "--ignore-not-found=true", "-o", "name"]);
    if (pvc.code !== 0) throw new Error("Customer PostgreSQL erasure could not inspect retained gateway home storage");
    return !pvc.stdout.trim();
  };
  const eraseAgentStores = createCustomerAgentStoreErasure({
    store, now: Date.now,
    eraseStores: (cleanup, custody) => eraseBuilderAgentStores(requireEnv("OPENCLAW_AGENT_STORE_ADMIN_DSN", "account erasure requires the PostgreSQL agent-store administration URL"), cleanup, custody),
    sharedGatewayRetired: gatewayId => isRetiredSharedGateway(store, gatewayId, clusterAbsent),
    runtimeAbsent: async (gatewayId, runtime) => runtime === "cluster" ? clusterAbsent(gatewayId) :
      !await createGatewayComputeClient(store, logFn).findByLabels({ "octogee-gateway-id": gatewayId.toLowerCase(), "octogee-environment": COMPUTER_ENVIRONMENT }),
    ownerHomeAbsent: async uid => {
      const instances = await createGatewayComputeClient(store, logFn).list({ labels: { "octogee-owner-uid": uid.toLowerCase(), "octogee-environment": COMPUTER_ENVIRONMENT } });
      const homes = await createBuilderHomeServices(store, logFn).provider.remainingOwnerHomes(uid);
      return instances.length === 0 && homes.length === 0;
    },
    eraseComputer: cloudCleanup.deleteComputer,
    readSharedSource: async gatewayId => {
      const gateway = await readDesiredRoot(store, gatewayId) as DurableGateway | null;
      if (!gateway || gateway.gatewayClass !== "shared" || gateway.ownerUid != null ||
          gateway.desiredStatus !== "running" || gateway.desiredRelease !== gateway.liveRelease) return null;
      const diagnostics = await kubeOps.readGatewayPodDiagnostics({ namespace: NAMESPACE, gatewayId });
      if (diagnostics.status !== "ready" || diagnostics.totalPods !== 1 || diagnostics.pods.length !== 1 ||
          diagnostics.pods[0]!.deleting || !diagnostics.pods[0]!.uid) return null;
      const response = await requestFleetState({ baseUrl: await resolveGatewayFleetUrl(store, gatewayId), gatewayId,
        privateKey, timeoutMs: GATEWAY_HEALTH_TIMEOUT_MS, fetchImpl: fetch, newRequestId: randomUUID });
      if (!response.ok) throw new Error(`Customer PostgreSQL erasure source read refused: ${response.status}`);
      const source = await response.json() as SharedAgentErasureSource;
      if (source.podUid !== diagnostics.pods[0]!.uid) throw new Error("Customer PostgreSQL erasure source pod changed");
      return source;
    },
    unmountSharedCustomer: (cleanup, agentStoreErasure, operation) => callUnmountRpc(store, { privateKey,
      gatewayId: cleanup.currentGatewayId!, slug: cleanup.slug, log: logFn, tag: "erase",
      migrationId: `erase-${operation.id}-claim-${operation.startedAt}`, agentStoreErasure }),
  });
  const postHogErasure = createPostHogErasureClient(
    postHogErasureConfigFromEnvironment(),
    {
      fetch,
      isOtherCustomerUid: async (distinctId) =>
        FIRESTORE_DOC_ID.test(distinctId) &&
        (await store.builders.records.get(distinctId)) !== null,
    },
  );
  const postHogErasureRequest = async (
    uid: string,
    deletionId: string,
  ): Promise<PostHogErasureRequest> => {
    const job = await store.jobs.deletions.get(deletionId);
    if (job === null) throw new Error(`deletion job missing: ${deletionId}`);
    if (job.uid !== uid) throw new Error(`deletion job uid mismatch: ${deletionId}`);
    return {
      uid,
      state: readPostHogErasureState(deletionId, job),
      persistState: (nextState) => persistPostHogErasureState(store, deletionId, nextState),
    };
  };
  return createEraseCustomerHandler({
    loadDeletionJob: async (deletionId) => {
      const job = await store.jobs.deletions.get(deletionId);
      if (job === null) return null;
      if (job.uid === undefined) throw new Error(`deletion job ${deletionId} is malformed`);
      return {
        uid: job.uid,
        status: job.status,
        eraseAfter: job.eraseAfter,
        stripeCustomerIds: productIds(job.productContext, "stripeCustomerIds"),
        archiveId: job.archiveId ?? null,
        cleanupContext: (job.cleanupContext as CustomerCleanupContext | undefined) ?? null,
      };
    },
    ensureAnonymousArchive: (deletionId) => ensureAnonymousDeletionArchive(db, store, deletionId),
    requestPostHogDeletion: async (uid, deletionId) =>
      postHogErasure.requestDeletion(await postHogErasureRequest(uid, deletionId)),
    confirmPostHogDeletion: async (uid, deletionId) =>
      postHogErasure.confirmDeletion(await postHogErasureRequest(uid, deletionId)),
    retainPostHogMappingOnly: (deletionId, archiveId) => retainPostHogMappingOnly(store, deletionId, archiveId),
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
    persistStripeCustomerIds: (deletionId, customerIds) =>
      persistDeletionProductContext(store, deletionId, { stripeCustomerIds: customerIds }),
    ensureOwnedGatewayRetired: (cleanup, deletionId) =>
      ensureOwnedGatewaysRetired({
        store,
        uid: cleanup.uid,
        deletionId,
        now: Date.now(),
        preserveRetirementProof: proof => preserveCustomerGatewayRetirement(store, cleanup.uid, deletionId, proof),
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
    eraseAgentStores,
    cloudErase: async (cleanup, currentOperationId) => {
      await assertNoBuilderAgentStores(requireEnv("OPENCLAW_AGENT_STORE_ADMIN_DSN", "account-deletion verification requires the PostgreSQL agent-store administration URL"), cleanup);
      return nukeUserCloudSide({ ...cleanup, currentOperationId }, cloudCleanup);
    },
    verifyErasure: async (cleanup, currentOperationId) => {
      const remaining = await verifyCustomerFirestoreErasure(
        { store, db },
        cleanup.uid,
        cleanup.slug,
        cleanup.email,
        currentOperationId,
      );
      remaining.push(...await cloudCleanup.verifyStorageErasure(
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
        if (userId && await cloudCleanup.channels.userExists(userId)) {
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
      await store.transaction({ label: "erase-customer.finalize-verified" }, async (tx) => {
        await tx.jobs.archives.merge(archiveId, { cleanupOutcomeCodes: ["verified_erasure"] });
        await tx.jobs.deletions.patch(deletionId, { status: "verified_pending_completion", archiveId, verifiedAt: Date.now() });
      });
    },
    now: () => Date.now(),
  });
}

function buildSuspendCustomerHandler(
  db: Firestore,
  store: PlatformStateStore,
  privateKey: string,
  logFn: (msg: string) => void,
  kubeOps: Pick<KubeOps, "readAvailableReplicas" | "readGatewayPodDiagnostics">,
) {
  const decryptConnectorSecret = createConnectorSecretDecryptor();
  return createSuspendCustomerHandler({
    assertRestoreNotInProgress: (uid) => assertCustomerRestoreNotInProgress(store, uid),
    loadDeletionJob: async (deletionId) => {
      const job = await store.jobs.deletions.get(deletionId);
      if (job === null) return null;
      return {
        uid: job.uid ?? "",
        slug: job.slug ?? null,
        currentGatewayId: job.currentGatewayId ?? null,
        stripeCustomerIds: productIds(job.productContext, "stripeCustomerIds"),
        stripeSubscriptionIds: productIds(job.productContext, "stripeSubscriptionIds"),
        cleanupContext: (job.cleanupContext as CustomerCleanupContext | undefined) ?? null,
      };
    },
    loadCleanupContext: (uid) => loadCustomerCleanupContext({ store, accounts: firestoreBuilderAccountReader(db), db }, uid),
    persistCleanupContext: (deletionId, cleanupContext) =>
      store.jobs.deletions.patch(deletionId, { cleanupContext: cleanupContext as unknown as OpaqueMap, status: "suspending", updatedAt: Date.now() }),
    suspendAuthUser: (uid) => disableAuthUserAndRevokeSessions(uid, getAuth()),
    cancelCustomerMigrations: (uid, deletionId) =>
      cancelCustomerMigrationsForSuspension(store, uid, deletionId, Date.now()),
    deactivateCustomerVisibility: (uid) => deactivateCustomerVisibility(store, db, uid),
    invalidatePendingCredentialFlows: (uid) => invalidatePendingCredentialFlows(db, uid),
    unmountFromGateway: createCustomerDeletionUnmount(db, store, privateKey, logFn, kubeOps),
    releasePlacement: (uid, gatewayId) => releaseCustomerPlacement(store, uid, gatewayId),
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
    persistStripeBillingRefs: (deletionId, customerIds, subscriptionIds) =>
      persistDeletionProductContext(store, deletionId, { stripeCustomerIds: customerIds, stripeSubscriptionIds: subscriptionIds }),
    revokeConnectorGrants: (uid) =>
      revokeAllConnectorGrantsForUser(uid, CONNECTOR_OAUTH_REVOCATION_TARGETS, {
        secrets: store.secrets,
        decryptSecret: decryptConnectorSecret,
        logger: { warn: logFn },
      }),
    revokeModelBrokerAccess: (uid) =>
      revokeOwnerModelBrokerTokens(store, uid, Date.now()),
    disableAutoTopUp: (uid) => disableCreditAutoTopUp(db, uid, Date.now()),
    deleteCredentialSecrets: async (secretNames) => {
      for (const secretName of secretNames) await deleteSecret(secretName);
    },
    retireProjectAgentMattermostUsers: async (userIds) => {
      const channels = createMattermostChannelHost({
        baseUrl: requireEnv("MM_URL", "project-agent suspension requires Mattermost"),
        adminToken: requireEnv("MM_ADMIN_TOKEN", "project-agent suspension requires Mattermost"),
        log: logFn,
      });
      await channels.erase({ teamId: null, ownerUserId: null, channelIds: [], userIds });
    },
    deleteProjectAgentCredentialDocs: (docPaths) => deleteProjectAgentCredentialSecrets(store, docPaths),
    ensureOwnedGatewaysRetired: (uid, deletionId) =>
      ensureOwnedGatewaysRetired({
        store,
        uid,
        deletionId,
        now: Date.now(),
        preserveRetirementProof: proof => preserveCustomerGatewayRetirement(store, uid, deletionId, proof),
      }),
    markSuspended: (deletionId) => markSuspendedAndReleaseErasure(store, deletionId, Date.now()),
    now: () => Date.now(),
  });
}

function createCustomerDeletionUnmount(
  db: Firestore,
  store: PlatformStateStore,
  privateKey: string,
  logFn: (msg: string) => void,
  kubeOps: Pick<KubeOps, "readAvailableReplicas" | "readGatewayPodDiagnostics">,
) {
  return createUnmountFromGateway({
    isRetiredSharedGateway: (gatewayId) => isRetiredSharedGateway(store, gatewayId,
      (id) => retiredSharedGatewayRuntimeAbsent(kubeOps, NAMESPACE, id, deploymentNameForInstance(id))),
    isGatewayAbsent: async (gatewayId) => {
      const [root, runtime, unassigned, builders] = await Promise.all([
        store.gateways.roots.get(gatewayId),
        store.fleetRegistry.get(gatewayId),
        store.gateways.assignments.isEmpty(gatewayId),
        store.builders.records.listByGateway(gatewayId, { limit: 1 }),
      ]);
      return root === null && runtime === null && unassigned && builders.length === 0 &&
        await retiredSharedGatewayRuntimeAbsent(kubeOps, NAMESPACE, gatewayId, deploymentNameForInstance(gatewayId));
    },
    resolveGatewayUnmountTarget: async (gatewayId) => {
      const authorization = await readGatewayAuthorizationInStore(store, gatewayId);
      if (!authorization) return null;
      const runtime = await store.fleetRegistry.get(gatewayId);
      if (runtime?.lifecycle !== "serving") return null;
      return {
        gatewayId,
        revisionId: gatewayId,
        profile: authorization.config.profile ?? "standard",
        runtime: resolveGatewayRuntime(runtime.runtime),
      };
    },
    isRuntimeAbsent: (gatewayId, revisionId) =>
      retiredSharedGatewayRuntimeAbsent(kubeOps, NAMESPACE, gatewayId, deploymentNameForInstance(revisionId)),
    unmountRpc: ({ gatewayId, slug }) =>
      callUnmountRpc(store, { privateKey, gatewayId, slug, log: logFn, allowUnready: true }),
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

function buildDeprovisionCustomerHandler({ db, store, logFn, kubeOps, privateKey, deleteHostingSites }: CustomerRemovalOptions) {
  return createDeprovisionCustomerHandler({
    loadCleanupContext: (uid) => loadCustomerCleanupContext({ store, accounts: firestoreBuilderAccountReader(db), db }, uid),
    unmountFromGateway: createCustomerDeletionUnmount(db, store, privateKey, logFn, kubeOps),
    cloudCleanup: buildCustomerCloudCleanupDeps(db, store, logFn, deleteHostingSites),
    now: () => Date.now(),
    log: logFn,
  });
}

function createBuilderHomeServices(store: PlatformStateStore, log: (message: string) => void) {
  const homeCopyRequest: ComputeRequest = async ({ url, method, body }) => {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const client = await auth.getClient();
    const result = await client.request({ url, method, ...(body === undefined ? {} : { data: body }) });
    return { status: result.status, data: result.data };
  };
  const homeJournal = <T>(what: string, uid: string, action: () => Promise<T>) => runNormalFleetMutation(store, {
    actor: "cowboy", forced: false, what, why: "Migrate the Builder home without removing its verified source", target: { ownerUid: uid }, preActionStatus: {}, mutation: { action: what }, action,
  });
  const provider = createBuilderHomeProvider({ store, projectId: gatewayComputeProjectId(), environment: COMPUTER_ENVIRONMENT,
    request: homeCopyRequest, vm: createGatewayComputeClient(store, log), journal: homeJournal });
  return {
    provider,
    copy: createHomeCopyClient({ request: homeCopyRequest, projectId: gatewayComputeProjectId(), journal: (what, input, action) => homeJournal(what, input.ownerUid, action) }),
  };
}

function buildCustomerCloudCleanupDeps(
  db: Firestore,
  store: PlatformStateStore,
  logFn: (msg: string) => void,
  deleteHostingSites?: HostingCleanup,
) {
  const cleanupEnv = (name: string) =>
    requireEnv(name, "customer erasure cloud cleanup requires it");
  const gitApiUrl = cleanupEnv("GIT_API_URL");
  const gitApiToken = cleanupEnv("GIT_API_TOKEN");
  const git = createGiteaGitHost({
    apiBaseUrl: gitApiUrl,
    token: () => gitApiToken,
    log: logFn,
  });
  const channels = createMattermostChannelHost({
    baseUrl: cleanupEnv("MM_URL"),
    adminToken: cleanupEnv("MM_ADMIN_TOKEN"),
    log: logFn,
  });
  const s3 = createS3UserBlobErasure();
  return {
    git,
    channels,
    nukeUserFirestore: (
      uid: string,
      slug: string,
      email: string | null,
      currentOperationId: string,
    ) => eraseCustomerFirestore({ store, db }, uid, slug, email, currentOperationId),
    deleteCustomerStorage: async (uid: string, slug: string, chatArtifactIds: string[], agentImportIds: string[]) => {
      await deleteCustomerStorageObjects(getStorage().bucket(), uid, slug, chatArtifactIds, agentImportIds);
      await s3?.erase(uid, slug);
    },
    verifyStorageErasure: async (uid: string, slug: string, chatArtifactIds: string[], agentImportIds: string[]) => {
      const remaining = await verifyCustomerStorageErasure(getStorage().bucket(), uid, slug, chatArtifactIds, agentImportIds);
      if (s3) remaining.push(...await s3.remaining(uid, slug));
      return remaining;
    },
    deleteCredentialSecrets: async (secretNames: string[]) => {
      for (const secretName of secretNames) await deleteSecret(secretName);
    },
    deleteAuthUser: (uid: string) => deleteAuthUserTolerantOfMissing(uid, getAuth()),
    deleteComputerHome: (_uid: string, slug: string) => deleteComputerHomeObjects(getStorage().bucket(), slug),
    ...(BUILDER_VM_SPEC
      ? {
          deleteComputer: async (uid: string) => {
            const runtime = vmGatewayRuntimeRef.current;
            if (!runtime) throw new Error("the VM gateway runtime is not initialised; cannot delete the Builder's computer");
            const deleted = await runtime.deleteComputer(uid);
            const homes = createBuilderHomeServices(store, logFn);
            if (!await eraseBuilderHomeMigrationStorage({ store, removeStoppedHome: homes.provider.removeStoppedHome, copy: homes.copy, remainingOwnerHomes: homes.provider.remainingOwnerHomes, log: logFn }, uid)) {
              throw new Error("Builder home cleanup is still converging; erasure tracking retained for retry");
            }
            return deleted;
          },
        }
      : {}),
    deleteHostingSites,
    log: logFn,
  };
}

export async function callUnmountRpc(
  state: GatewayRuntimeReader,
  opts: {
    privateKey: string;
    gatewayId: string;
    slug: string;
    log: (msg: string) => void;
    tag?: string;
    timeoutMs?: number;
    allowUnready?: boolean;
    migrationId?: string;
    agentStoreErasure?: import("@octogee/shared/types/fleet-controller").AgentStoreUnmountCoverage;
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

  const url = await resolveGatewayFleetUrl(state, gatewayId, { allowUnready: opts.allowUnready === true });
  const migrationId = opts.migrationId ?? `${tag}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const body = JSON.stringify({ migrationId, slug, ...(opts.agentStoreErasure ? { agentStoreErasure: opts.agentStoreErasure } : {}) });
  const signature = signFleetRequest(
    privateKey,
    gatewayScopedJobId(migrationId, gatewayId),
    body,
  );
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
  if (opts.agentStoreErasure) assertExactCustomerUnmountResponse(await resp.json(), migrationId, slug, opts.agentStoreErasure);
  log(`[${tag}] unmount RPC ok gatewayId=${gatewayId} slug=${slug}`);
}

function assertExactCustomerUnmountResponse(value: unknown, migrationId: string, slug: string, coverage: import("@octogee/shared/types/fleet-controller").AgentStoreUnmountCoverage): void {
  const response = value as import("@octogee/shared/types/fleet-controller").UnmountResponse | null;
  const confirmed = response?.agentStoreErasure;
  const expectedIds = [...coverage.agentIds].sort();
  if (response?.migrationId !== migrationId || response.slug !== slug || confirmed?.podUid !== coverage.podUid ||
      !Array.isArray(confirmed.agentIds) || confirmed.agentIds.length !== expectedIds.length ||
      [...confirmed.agentIds].sort().some((id, index) => id !== expectedIds[index])) {
    throw new Error("unmount did not confirm exact customer Native cleanup and source pod");
  }
}

async function resolveGatewayFleetUrl(
  state: GatewayRuntimeReader,
  gatewayId: string,
  options?: { allowUnready: boolean },
): Promise<string> {
  const runtime = await state.fleetRegistry.get(gatewayId);
  if (runtime === null) {
    throw new Error(`gateway not registered in glmGateways: ${gatewayId}`);
  }
  if (options?.allowUnready) return resolveMigrationRecoveryUrl({
    namespace: NAMESPACE, gatewayId, port: FLEET_CONTROLLER_PORT,
    runCommand: createSubprocessCommandRunner(),
    resolveGatewayVm: async () => gatewayVmAddress(runtime),
  });
  return gatewayFleetBaseUrl({ runtimeDoc: runtime, gatewayId, namespace: NAMESPACE, port: FLEET_CONTROLLER_PORT });
}

// A pending Helm release is auto-recoverable only for a RUNNING durable root
// whose runtime is not marked failed — a paused root's pending state may be an
// intentional scale-to-zero mid-flight, and a failed runtime needs an operator.
export async function isRecoverableGatewayRelease(
  state: GatewayStateReader,
  gatewayId: string,
): Promise<boolean> {
  const authorization = await readGatewayAuthorizationInStore(state, gatewayId);
  if (!authorization || authorization.gateway.desiredStatus !== "running") return false;
  return (await state.fleetRegistry.get(gatewayId))?.lifecycle !== "failed";
}

export async function resolveGatewayPlacement(
  state: GatewayStateReader,
  toGatewayId: string,
): Promise<
  | { ok: true; revisionId: string; release: number | null; gatewayClass: GatewayClass }
  | { ok: false; reason: "no-live-revision" | "revision-not-ready" }
  | null
> {
  const authorization = await readGatewayAuthorizationInStore(state, toGatewayId);
  if (!authorization) return null;
  const gateway = authorization.gateway as DurableGateway;
  if (gateway.desiredStatus !== "running") {
    return { ok: false, reason: "revision-not-ready" };
  }
  if (gateway.liveRelease == null) return { ok: false, reason: "no-live-revision" };
  const ready = await isServingRuntime(state, toGatewayId);
  if (!ready) return { ok: false, reason: "revision-not-ready" };
  return {
    ok: true,
    revisionId: toGatewayId,
    release: gateway.liveRelease,
    gatewayClass: resolveGatewayClass({
      gatewayClass: gateway.gatewayClass ?? undefined,
      profile: gateway.profile ?? undefined,
      imageProfile: gateway.imageProfile ?? undefined,
    }),
  };
}

export async function resolveLiveRevisionAsSource(
  state: GatewayStateReader,
  gatewayId: string,
): Promise<{
  revisionId: string;
  release: number;
  epoch?: number;
  assignmentMode: "unassigned-live";
  rootUpdatedAt: number;
  gatewayClass?: GatewayClass;
} | null> {
  const authorization = await readGatewayAuthorizationInStore(state, gatewayId);
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
  const ready = await isServingRuntime(state, gatewayId);
  return ready
    ? {
        revisionId: gatewayId,
        release: gateway.liveRelease,
        assignmentMode: "unassigned-live",
        rootUpdatedAt: gateway.updatedAt,
        ...(gateway.gatewayClass ? { gatewayClass: gateway.gatewayClass } : {}),
      }
    : null;
}

export async function resolveSourceRevision(
  state: GatewayStateReader,
  uid: string,
  gatewayId: string,
): Promise<{
  revisionId: string;
  release: number;
  epoch?: number;
  assignmentMode: "assigned" | "unassigned-live";
  rootUpdatedAt?: number;
  gatewayClass?: GatewayClass;
} | null> {
  const assignment = await state.gateways.assignments.get(gatewayId, uid);
  if (!assignment) return resolveLiveRevisionAsSource(state, gatewayId);
  const authorization = await readGatewayAuthorizationInStore(state, gatewayId);
  if (!authorization) return null;
  const gateway = authorization.gateway as DurableGateway;
  if (
    (gateway.desiredStatus !== "running" && gateway.desiredStatus !== "draining") ||
    assignment.gatewayId !== gatewayId
  ) {
    return null;
  }
  if (typeof gateway.liveRelease !== "number") return null;
  const ready = await isServingRuntime(state, gatewayId);
  if (!ready) return null;
  return {
    revisionId: gatewayId,
    release: gateway.liveRelease,
    epoch: assignment.epoch,
    assignmentMode: "assigned",
    ...(gateway.gatewayClass ? { gatewayClass: gateway.gatewayClass } : {}),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
