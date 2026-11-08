import { migrationCancellationDeferred } from "./fleet-state.js";
import { readSharedSourceRecoveryAuthority, readSharedSourceRecoverySupersession, SharedSourceRecoveryConflict } from "./shared-source-recovery.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";


import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { DocumentData, Firestore } from "firebase-admin/firestore";
import {
  isOperationAuditRecord,
  isOperationAuditRow,
  GATEWAY_CLASSES,
  GATEWAY_IMAGE_PROFILES,
  GATEWAY_PROFILES,
  NEW_GATEWAY_ID_REQUIREMENT,
  resolveUserGatewayControlState,
  isValidNewGatewayId,
  isGatewayClass,
  isGatewayProfile,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  resolveGatewayRuntime,
  deriveGatewayIdentity,
  type GatewayClass,
  type GatewayImageProfile,
  type GatewayProfile,
  type GatewayRuntime,
  type GatewayVmState,
  type OperationAuditAliasPlan,
  type OperationAuditDocument,
} from "@octogee/shared/types/glm";
import { deploymentTargetsForEnvironment } from "./deployment-environment.js";
import {
  DEFAULT_DISPOSABLE_GATEWAY_IDLE_MS,
  type PlatformRuntimeConfig,
} from "@octogee/shared/types/platform-config";
import {
  accountAllowsInteractiveAccess,
  type AccountLifecycle,
} from "@octogee/shared/types/account-lifecycle";
import {
  isReleasePayload,
  isGatewayRuntimeDoc,
  type AssignmentDoc,
  type AssignmentState,
  type CommitPlacementResult,
  type GatewayRuntimeDoc,
  type ReleaseDoc,
} from "@octogee/shared/types/gateway-releases";
import {
  isGatewayPodReplacements,
  summarizeGatewayPodReplacements,
  type GatewayPodReplacementSummary,
} from "@octogee/shared/types/gateway-pod-replacements";
import type { MigrationProgressRecord } from "@octogee/shared/types/glm";
import {
  GATEWAY_CONFIG_SCHEMA_VERSION,
  InitialGatewayReleaseConflictError,
  gatewayArtifactFromReleasePayload,
  isGatewayMutableConfigForGateway,
  writeInitialGatewayReleaseInStore,
  type GatewayArtifact,
  type GatewayMutableConfig,
} from "./gateway-live-release.js";
import { projectReleaseHistory } from "./gateway-release-history.js";
import {
  resolveContinuousBuilderPlacement,
  resolveLiveActivationTargetGatewayId,
} from "@octogee/shared/types/orchestrator-placement";
import {
  parseSharedGatewayAutoscalingConfig,
  type SharedGatewayAutoscalingConfig,
  type SharedGatewayPoolConfig,
} from "@octogee/shared/types/shared-gateway-pool";
import {
  InvalidSharedGatewayAutoscalingConfigError,
  ORCHESTRATOR_CONFIG_DOC_PATH,
  readSharedGatewayPoolConfigInStore,
} from "./shared-gateway-pool-read.js";
import {
  SIZING_TIERS,
  resolveSizingTier,
  type SizingTier,
} from "@octogee/shared/types/sizing";
import {
  SPOT_PRICE_MULTIPLIER,
  estimateGatewayMonthlyCost,
  type GatewayPricingMode,
} from "@octogee/shared/types/cost-estimator";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";
import {
  builderReturnOperationId,
  firestoreBuilderTierReader,
  placementRetireOperationId,
  requestBuilderActivationLease,
} from "./builder-activation-lease.js";
import { addAdminComputerRoutes } from "./admin-computer-router.js";
import {
  GatewayRetirementConflictError,
  assertGatewayRuntimeMutationUnfencedInStore,
  builderRuntimeMutationFenced,
  claimGatewayRetirementInStore,
} from "./gateway-retirement-claim.js";
import {
  appendGatewayRelease,
  asDurableGatewayRoot,
  InvalidGatewayRootError,
  StaleGatewayReleaseError,
  type DurableGatewayRoot,
} from "./gateway-release-append.js";
import {
  findActiveGatewayMigration,
  GatewayMigrationInFlightError,
} from "./fleet-operation-lock.js";
import { buildCustomerDeletionSchedule } from "@octogee/shared/types/account-lifecycle";
import { buildCustomerDeletionPlan } from "./customer-deletion-plan.js";
import {
  FleetMutationIdempotencyError,
  runNormalFleetMutation,
  type NormalFleetMutationResult,
} from "./normal-fleet-mutation.js";
import { OperationAuditIdempotencyConflictError } from "./operation-audit.js";
import {
  firestoreBuilderAccountReader,
  type BuilderAccount,
  type BuilderAccountReader,
} from "./builder-account.js";
import type {
  BuilderActivationLease,
  BuilderGatewayMirrorInput,
  BuilderRecord,
} from "./platform-state/builders.js";
import type { OrchestratorConfig } from "./platform-state/config.js";
import type { FleetRegistryRecord } from "./platform-state/fleet-registry.js";
import type { GatewayAssignment, GatewayRoot } from "./platform-state/gateways.js";
import type { NewOperation, OperationRecord } from "./platform-state/operations.js";
import type { PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";
import {
  type CentralReleaseAuthority,
  type ReleaseDigestManifest,
  centralGatewayReleasePayload,
} from "./artifact-registry.js";

export interface FleetLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export type GatewayPodDiagnosticsStatus = "ready" | "not-ready" | "missing" | "unknown";
export type GatewayPodCapacityType = "spot" | "on-demand";

function rejectPersistenceInBody(body: Record<string, unknown>): {
  status: number;
  body: Record<string, string>;
} | null {
  if (body.persistence === undefined) return null;
  return {
    status: 400,
    body: {
      error:
        "persistence specs are rejected — gateways use emptyDir; scheduling is managed independently",
    },
  };
}

export interface GatewayPodDiagnostic {
  name: string;
  uid: string | null;
  replicaSetUid: string | null;
  phase: string;
  readyContainers: number;
  totalContainers: number;
  restarts: number;
  reason: string | null;
  nodeName: string | null;
  instanceId: string | null;
  nodePool: string | null;
  capacityType: GatewayPodCapacityType | null;
  ageMs: number | null;
}

export interface GatewayPodDiagnostics {
  status: GatewayPodDiagnosticsStatus;
  totalPods: number;
  readyPods: number;
  totalRestarts: number;
  spotPods: number;
  onDemandPods: number;
  unknownCapacityPods: number;
  pods: GatewayPodDiagnostic[];
  error?: string;
}

export interface FleetRouterDeps {
  computerReplacementEnabled?: boolean;
  db: Firestore;
  store: PlatformStateStore;
  logger: FleetLogger;
  provisionGatewayAuthSecret: (opts: {
    gatewayId: string;
    gatewayServiceAccount: string;
  }) => Promise<unknown>;
  listGatewayBuilds: (opts: {
    service: string;
    limit: number;
  }) => Promise<unknown[]>;
  releaseEnvironment?: "test" | "prod" | null;
  releaseAuthority?: CentralReleaseAuthority;
  readGatewayPodDiagnostics?: (gatewayId: string) => Promise<GatewayPodDiagnostics>;
  readGatewayPodDiagnosticsBatch?: (
    gatewayIds: readonly string[],
  ) => Promise<Record<string, GatewayPodDiagnostics>>;

  requestNativeReturnSourceRecovery?: (input: { uid: string; operationId: string; requestedAt: number; requestedBy: string }) => Promise<boolean>;
  suspendAuthUser: (uid: string) => Promise<void>;
  revokeConnectorGrantsForUser: (uid: string) => Promise<void>;
}

type ActorRequest = Request & {
  uid?: string;
  user?: { email?: string | null };
};

class GatewayAuthSecretProvisionError extends Error {}

function resolveSizingForResponse(
  glmDoc: Record<string, unknown> | undefined,
  reservation: ReturnType<typeof projectGatewayReservation>,
): {
  tier: SizingTier;
  resolvedFrom: "explicit" | "class-default" | "profile-default";
  resources: { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } };
  capacity: { targetActiveBuilders: number; typicalBuilders: number };
  monthlyCostUsd: {
    compute: number;
    onDemandCompute: number;
    savings: number;
    pricingMode: GatewayPricingMode;
    perBuilderAtTarget: number;
    perBuilderAtTypical: number;
  };
} {
  const sizingTier =
    typeof glmDoc?.sizingTier === "string" && (SIZING_TIERS as readonly string[]).includes(glmDoc.sizingTier)
      ? (glmDoc.sizingTier as SizingTier)
      : undefined;
  const profile = isGatewayProfile(glmDoc?.profile) ? glmDoc.profile : undefined;
  const gatewayClass = resolveGatewayClass({
    gatewayClass: isGatewayClass(glmDoc?.gatewayClass) ? glmDoc.gatewayClass : undefined,
    profile,
    imageProfile: isGatewayProfile(glmDoc?.imageProfile) ? glmDoc.imageProfile : undefined,
  });
  const resolved = resolveSizingTier({ sizingTier, gatewayClass, profile });
  // Paused pods are scaled to 0 replicas → no node consumption → no compute
  // bill. Reflect that in both the per-gateway surface and the fleet roll-up
  // so the operator sees real cost, not nameplate.
  const isPaused = glmDoc?.desiredStatus === "paused";
  const cost = isPaused
    ? {
        computeUsd: 0,
        onDemandComputeUsd: 0,
        savingsUsd: 0,
        pricingMode: reservation.type,
        perBuilderAtTarget: 0,
        perBuilderAtTypical: 0,
      }
    : estimateGatewayMonthlyCost(resolved.tier, { pricingMode: reservation.type });
  return {
    tier: resolved.tier,
    resolvedFrom: resolved.resolvedFrom,
    resources: {
      requests: {
        cpu: resolved.preset.resources.requests.cpu,
        memory: resolved.preset.resources.requests.memory,
      },
      limits: {
        cpu: resolved.preset.resources.limits.cpu,
        memory: resolved.preset.resources.limits.memory,
      },
    },
    capacity: resolved.preset.capacity,
    monthlyCostUsd: {
      compute: cost.computeUsd,
      onDemandCompute: cost.onDemandComputeUsd,
      savings: cost.savingsUsd,
      pricingMode: cost.pricingMode,
      perBuilderAtTarget: cost.perBuilderAtTarget,
      perBuilderAtTypical: cost.perBuilderAtTypical,
    },
  };
}

function normalizeGatewayProfile(profile: unknown): GatewayProfile {
  return profile === "builder" ? "builder" : "standard";
}

function normalizeGatewayClass(doc: GlmDoc | undefined): GatewayClass {
  return resolveGatewayClass({
    gatewayClass: isGatewayClass(doc?.gatewayClass) ? doc.gatewayClass : undefined,
    profile: isGatewayProfile(doc?.profile) ? doc.profile : undefined,
    imageProfile: isGatewayProfile(doc?.imageProfile) ? doc.imageProfile : undefined,
  });
}

function normalizeGatewayImageProfile(doc: GlmDoc | undefined): GatewayImageProfile {
  return resolveGatewayImageProfile({
    gatewayClass: isGatewayClass(doc?.gatewayClass) ? doc.gatewayClass : undefined,
    profile: isGatewayProfile(doc?.profile) ? doc.profile : undefined,
    imageProfile: isGatewayProfile(doc?.imageProfile) ? doc.imageProfile : undefined,
  });
}

function isTruthyQueryFlag(value: unknown): boolean {
  return value === "true" || value === "1";
}

// The K8s namespace this fleet runs in — scopes the Grafana deep-link to the env.
export function resolveFleetNamespace(env: NodeJS.ProcessEnv = process.env): string {
  const ns = env.K8S_NAMESPACE;
  return typeof ns === "string" && ns.length > 0 ? ns : "octogee";
}

type GlmDoc = Record<string, unknown>;
interface FirestoreDocLike { id: string; data(): GlmDoc }
export const ERR_SHARED_POOL_RIDES_PLATFORM_RELEASE =
  "shared pool rides the platform release; deploy the platform instead";

interface DurableGatewayRuntime {
  root: DurableGatewayRoot;
  runtime: GatewayRuntimeDoc | null;
  heartbeat: GlmDoc | null;
}

type AdminOnboardingDriftState =
  | "healthy"
  | "pointer-drift"
  | "assigned-not-mounted"
  | "mounted-orphan"
  | "missing-gateway"
  | "in-flight";

type AdminOnboardingPlacementWarningCode =
  | "default-gateway-missing"
  | "default-gateway-retired"
  | "default-gateway-not-shared"
  | "pointer-drift"
  | "assigned-not-mounted"
  | "mounted-orphan"
  | "migration-in-flight"
  | "account-deletion-pending";

interface AdminOnboardingPlacementWarning {
  code: AdminOnboardingPlacementWarningCode;
  message: string;
  severity: "info" | "warning" | "error";
  gatewayId?: string;
  uid?: string;
  slug?: string;
  operationId?: string;
  expiresAt?: number;
}

interface AdminOnboardingLatestOperation {
  id: string;
  kind: string;
  status: string;
  gatewayId: string | null;
  inputUid: string | null;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  error?: string;
  input: Record<string, unknown>;
}

type AdminGatewayDesiredStatus = "running" | "paused" | "draining" | "retired";

interface AdminOnboardingGatewaySummary {
  gatewayId: string;
  gatewayClass: GatewayClass;
  desiredStatus: AdminGatewayDesiredStatus | null;
  status: string | null;
  imageTag: string | null;
  openclawVersion: string | null;
  assignableAsDefault: boolean;
  defaultTarget: boolean;
  assignedCount: number;
  mountedCount: number;
  driftCount: number;
  warnings: AdminOnboardingPlacementWarning[];
  lastOperation: AdminOnboardingLatestOperation | null;
}

interface AdminOnboardingCustomerProjection {
  uid: string;
  username: string;
  email: string;
  slug: string | null;
  policyTargetGatewayId: string | null;
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  provisioningStatus: string | null;
  driftState: AdminOnboardingDriftState;
  // Durable roster truth from gateways/{gw}/assignments/{uid}. null when
  // the customer has no assignment doc (legacy/un-backfilled gateway) — the
  // client falls back to derivation only in that case.
  rosterState: AssignmentState | null;
  rosterRevisionId: string | null;
  rosterEpoch: number | null;
  warnings: AdminOnboardingPlacementWarning[];
  latestOperation: AdminOnboardingLatestOperation | null;
}

interface AdminOnboardingPlacementResponse {
  config: {
    defaultGatewayId: string | null;
    sharedGatewayIds: string[];
    sharedGatewayAutoscaling: SharedGatewayAutoscalingConfig;
  };
  gateways: AdminOnboardingGatewaySummary[];
  customers: AdminOnboardingCustomerProjection[];
  driftSummary: Record<AdminOnboardingDriftState, number>;
  warnings: AdminOnboardingPlacementWarning[];
  generatedAt: string;
}

type OnboardingRuntimeConfig = SharedGatewayPoolConfig & {
  sharedGatewayAutoscaling: SharedGatewayAutoscalingConfig;
};

function sharedGatewayAutoscalingOf(config: OrchestratorConfig | null): SharedGatewayAutoscalingConfig {
  const autoscaling = config === null
    ? parseSharedGatewayAutoscalingConfig(undefined)
    : config.sharedGatewayAutoscaling;
  if (autoscaling === null) throw new InvalidSharedGatewayAutoscalingConfigError();
  return autoscaling;
}

async function readOnboardingRuntimeConfigInStore(
  transaction: PlatformStateTransaction,
): Promise<OnboardingRuntimeConfig> {
  const [pool, orchestrator] = await Promise.all([
    readSharedGatewayPoolConfigInStore(transaction),
    transaction.config.orchestrator.get(),
  ]);
  return {
    defaultGatewayId: pool?.defaultGatewayId ?? "",
    sharedGatewayIds: pool?.sharedGatewayIds ?? [],
    sharedGatewayAutoscaling: sharedGatewayAutoscalingOf(orchestrator),
  };
}

function presentFields(fields: GlmDoc): GlmDoc {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
}

function builderUserData(builder: BuilderRecord, account: BuilderAccount | null | undefined): GlmDoc {
  return presentFields({
    ...account?.planInputs,
    username: account?.username,
    email: account?.email,
    lastActive: account?.lastActive,
    accountLifecycle: builder.accountLifecycle,
    provisioning: presentFields({
      ...builder.provisioning,
      ...builder.home,
      computerRecovery: builder.fences.computerRecovery,
      pendingNativeSchedulerRetirement: builder.fences.pendingNativeSchedulerRetirement,
      openclaw: presentFields({
        ...builder.openclaw,
        ...builder.gateway,
        slug: builder.slug,
        activationLease: builder.activationLease,
        restoreFence: builder.fences.restoreFence,
        sourceTransferFence: builder.fences.sourceTransferFence,
        migration: builder.fences.migration,
        runtimeReset: builder.fences.runtimeReset,
      }),
    }),
  });
}

function builderUserDoc(builder: BuilderRecord, account: BuilderAccount | null | undefined): FirestoreDocLike {
  const data = builderUserData(builder, account);
  return { id: builder.uid, data: () => data };
}

function recordDoc(id: string, record: object): FirestoreDocLike {
  const { revision: _revision, id: _id, ...data } = record as GlmDoc;
  return { id, data: () => data };
}

function operationDocs(operations: readonly { readonly id: string }[]): FirestoreDocLike[] {
  return operations.map((operation) => recordDoc(operation.id, operation));
}

function runtimeRecordDoc(record: FleetRegistryRecord): FirestoreDocLike {
  return recordDoc(record.gatewayId, { docKind: "runtime", ...record });
}

interface FleetSnapshot {
  roots: readonly Stored<GatewayRoot>[];
  runtimes: readonly Stored<FleetRegistryRecord>[];
  builders: readonly Stored<BuilderRecord>[];
  assignments: readonly Stored<GatewayAssignment>[];
}

async function readFleetSnapshot(store: PlatformStateStore): Promise<FleetSnapshot> {
  const [roots, runtimes, builders, assignments] = await Promise.all([
    store.gateways.roots.list(),
    store.fleetRegistry.list(),
    store.builders.records.listAll(),
    store.gateways.assignments.listAll(),
  ]);
  return { roots, runtimes, builders, assignments };
}

function builderUserDocs(
  builders: readonly BuilderRecord[],
  accounts: ReadonlyMap<string, BuilderAccount>,
): FirestoreDocLike[] {
  return builders.map((builder) => builderUserDoc(builder, accounts.get(builder.uid)));
}

function fleetGatewayDocs(snapshot: Pick<FleetSnapshot, "roots" | "runtimes">): {
  gatewayDocs: FirestoreDocLike[];
  glmDocs: FirestoreDocLike[];
} {
  return {
    gatewayDocs: snapshot.roots.map((root) => recordDoc(root.gatewayId, root)),
    glmDocs: snapshot.runtimes.map(runtimeRecordDoc),
  };
}

function readUserOpenclaw(data: Record<string, unknown>): Record<string, unknown> {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  return (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
}

function readProvisioningStatus(data: Record<string, unknown>): string | null {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  return asStringOrNull(provisioning.status) ?? asStringOrNull(readUserOpenclaw(data).status);
}

function shapeOnboardingOperation(
  id: string,
  data: Record<string, unknown>,
): AdminOnboardingLatestOperation {
  return {
    id,
    kind: asStringOrNull(data.kind) ?? "unknown",
    status: asStringOrNull(data.status) ?? "unknown",
    gatewayId: asStringOrNull(data.gatewayId),
    inputUid: asStringOrNull(data.inputUid),
    createdAt: coerceNumberOrNull(data.createdAt),
    startedAt: coerceNumberOrNull(data.startedAt),
    completedAt: coerceNumberOrNull(data.completedAt),
    ...(typeof data.error === "string" ? { error: data.error } : {}),
    input: isPlainRecord(data.input) ? data.input : {},
  };
}

function latestOperation(
  operations: ReadonlyArray<AdminOnboardingLatestOperation>,
  predicate: (operation: AdminOnboardingLatestOperation) => boolean,
): AdminOnboardingLatestOperation | null {
  return operations
    .filter(predicate)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
}

function operationUid(operation: AdminOnboardingLatestOperation): string | null {
  return asStringOrNull(operation.input.uid) ?? asStringOrNull(operation.inputUid);
}

function operationTouchesGateway(
  operation: AdminOnboardingLatestOperation,
  gatewayId: string,
): boolean {
  return (
    operation.gatewayId === gatewayId ||
    operation.input.gatewayId === gatewayId ||
    operation.input.fromGatewayId === gatewayId ||
    operation.input.toGatewayId === gatewayId
  );
}

function isInFlightOperation(operation: AdminOnboardingLatestOperation | null): boolean {
  return operation?.status === "pending" || operation?.status === "running";
}

function mountedGatewayBySlug(
  gatewayById: ReadonlyMap<string, GlmDoc>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [gatewayId, runtime] of gatewayById) {
    const hb = effectiveHeartbeatDoc(gatewayId, runtime)?.data();
    if (!hb) continue;
    for (const slug of readMountedSlugs(hb)) {
      out.set(slug, gatewayId);
    }
  }
  return out;
}

function shouldIncludeOnboardingCustomer(input: {
  data: Record<string, unknown>;
}): boolean {
  return (
    accountAllowsInteractiveAccess(input.data) &&
    (
      asStringOrNull(input.data.username) !== null ||
      readUserGatewayId(input.data) !== null
    )
  );
}

// eslint-disable-next-line complexity -- Warning projection intentionally enumerates each drift state with its distinct operator message.
function userPlacementWarnings(input: {
  uid: string;
  slug: string | null;
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  policyTargetGatewayId: string | null;
  driftState: AdminOnboardingDriftState;
  latestOperation: AdminOnboardingLatestOperation | null;
}): AdminOnboardingPlacementWarning[] {
  const warnings: AdminOnboardingPlacementWarning[] = [];
  if (input.driftState === "pointer-drift") {
    warnings.push({
      code: "pointer-drift",
      severity: "warning",
      uid: input.uid,
      slug: input.slug ?? undefined,
      gatewayId: input.assignedGatewayId ?? undefined,
      message: `${input.slug ?? input.uid} is assigned to ${input.assignedGatewayId ?? "none"} but policy targets ${input.policyTargetGatewayId ?? "none"}`,
    });
  }
  if (input.driftState === "assigned-not-mounted") {
    warnings.push({
      code: "assigned-not-mounted",
      severity: "warning",
      uid: input.uid,
      slug: input.slug ?? undefined,
      gatewayId: input.assignedGatewayId ?? undefined,
      message: `${input.slug ?? input.uid} is assigned to ${input.assignedGatewayId ?? "none"} but is not mounted there`,
    });
  }
  if (input.driftState === "mounted-orphan") {
    warnings.push({
      code: "mounted-orphan",
      severity: "warning",
      uid: input.uid,
      slug: input.slug ?? undefined,
      gatewayId: input.mountedGatewayId ?? undefined,
      message: `${input.slug ?? input.uid} is mounted on ${input.mountedGatewayId ?? "none"} but assigned to ${input.assignedGatewayId ?? "none"}`,
    });
  }
  if (input.driftState === "in-flight" && input.latestOperation) {
    warnings.push({
      code: "migration-in-flight",
      severity: "info",
      uid: input.uid,
      slug: input.slug ?? undefined,
      operationId: input.latestOperation.id,
      message: `${input.latestOperation.kind} ${input.slug ?? "unresolved-builder"} (${input.uid}) is ${input.latestOperation.status}`,
    });
  }
  return warnings;
}

function accountLifecycleWarning(input: {
  uid: string;
  data: Record<string, unknown>;
  operations: ReadonlyArray<AdminOnboardingLatestOperation>;
}): AdminOnboardingPlacementWarning | null {
  const lifecycle = isPlainRecord(input.data.accountLifecycle)
    ? input.data.accountLifecycle
    : null;
  if (lifecycle?.status !== "deletion_scheduled" && lifecycle?.status !== "erasing") {
    return null;
  }
  const operation = latestOperation(
    input.operations,
    (candidate) =>
      candidate.kind === "erase-customer" && operationUid(candidate) === input.uid,
  );
  const slug = resolveCustomerSlug(input.data) ?? asStringOrNull(operation?.input.builderSlug);
  const expiresAt = toMillis(lifecycle.eraseAfter);
  return {
    code: "account-deletion-pending",
    severity: "info",
    uid: input.uid,
    slug: slug ?? undefined,
    ...(operation ? { operationId: operation.id } : {}),
    ...(expiresAt !== null ? { expiresAt } : {}),
    message: `${slug ?? "unresolved-builder"} (${input.uid}) is ${lifecycle.status === "erasing" ? "being deleted" : "scheduled for deletion"}`,
  };
}

function accountLifecycleWarnings(
  userDocs: ReadonlyArray<FirestoreDocLike>,
  operations: ReadonlyArray<AdminOnboardingLatestOperation>,
): AdminOnboardingPlacementWarning[] {
  return userDocs
    .map((userDoc) => accountLifecycleWarning({
      uid: userDoc.id,
      data: userDoc.data(),
      operations,
    }))
    .filter((warning): warning is AdminOnboardingPlacementWarning => warning !== null);
}

function driftStateForCustomer(input: {
  assignedGatewayId: string | null;
  mountedGatewayId: string | null;
  policyTargetGatewayId: string | null;
  latestOperation: AdminOnboardingLatestOperation | null;
  glmByGatewayId: Map<string, GlmDoc>;
}): AdminOnboardingDriftState {
  if (isInFlightOperation(input.latestOperation)) return "in-flight";
  const missing = (gatewayId: string | null): boolean =>
    Boolean(gatewayId) &&
    (!input.glmByGatewayId.has(gatewayId!) ||
      projectDesiredStatus(input.glmByGatewayId.get(gatewayId!)) === "retired");
  if (missing(input.policyTargetGatewayId) || missing(input.assignedGatewayId)) {
    return "missing-gateway";
  }
  if (
    input.assignedGatewayId &&
    input.policyTargetGatewayId &&
    input.assignedGatewayId !== input.policyTargetGatewayId
  ) {
    return "pointer-drift";
  }
  if (
    input.mountedGatewayId &&
    input.assignedGatewayId &&
    input.mountedGatewayId !== input.assignedGatewayId
  ) {
    return "mounted-orphan";
  }
  if (input.mountedGatewayId && !input.assignedGatewayId) return "mounted-orphan";
  if (
    input.assignedGatewayId &&
    input.mountedGatewayId !== input.assignedGatewayId
  ) {
    return "assigned-not-mounted";
  }
  return "healthy";
}

function activationPolicyGatewayId(input: {
  uid: string;
  data: Record<string, unknown>;
  assignedGatewayId: string | null;
  glmByGatewayId: ReadonlyMap<string, GlmDoc>;
}): string | null {
  const candidate = resolveLiveActivationTargetGatewayId({
    userData: input.data,
  });
  const gateway = candidate ? input.glmByGatewayId.get(candidate) : undefined;
  const placement = resolveContinuousBuilderPlacement({
    uid: input.uid,
    userData: input.data,
    currentGatewayId: input.assignedGatewayId,
    defaultGatewayId: "",
    ownedGateway: candidate && gateway
      ? {
          gatewayId: candidate,
          gatewayClass: normalizeGatewayClass(gateway),
          ownerUid: asStringOrNull(gateway.ownerUid),
          desiredStatus: projectDesiredStatus(gateway) ?? "invalid",
          ready: asStringOrNull(effectiveHeartbeatDoc(candidate, gateway)?.data()?.status) === "ready",
          disposable: isPlainRecord(gateway.allocation) &&
            gateway.allocation.kind === "disposable-builder",
        }
      : null,
  });
  return placement.targetGatewayId || null;
}

function projectionAssignment(
  assignmentsByUid: ReadonlyMap<string, AssignmentDoc[]>,
  uid: string,
  mirroredGatewayId: string | null,
): AssignmentDoc | null {
  const assignments = assignmentsByUid.get(uid) ?? [];
  return assignments.find((candidate) => candidate.gatewayId === mirroredGatewayId) ??
    (assignments.length === 1 ? assignments[0]! : null);
}

function buildCustomerPlacementProjection(input: {
  uid: string;
  data: Record<string, unknown>;
  config: SharedGatewayPoolConfig;
  mountedBySlug: Map<string, string>;
  operations: ReadonlyArray<AdminOnboardingLatestOperation>;
  glmByGatewayId: Map<string, GlmDoc>;
  assignmentsByUid: Map<string, AssignmentDoc[]>;
}): AdminOnboardingCustomerProjection {
  const slug = resolveCustomerSlug(input.data);
  const mirroredGatewayId = readUserGatewayId(input.data);
  const assignment = projectionAssignment(
    input.assignmentsByUid,
    input.uid,
    mirroredGatewayId,
  );
  const assignedGatewayId = assignment?.gatewayId ?? mirroredGatewayId;
  const policyTargetGatewayId = activationPolicyGatewayId({
    uid: input.uid,
    data: input.data,
    assignedGatewayId,
    glmByGatewayId: input.glmByGatewayId,
  }) ?? (
    assignedGatewayId !== null && input.config.sharedGatewayIds.includes(assignedGatewayId)
      ? assignedGatewayId
      : input.config.defaultGatewayId
  );
  const mountedGatewayId = slug ? input.mountedBySlug.get(slug) ?? null : null;
  const latestOp = latestOperation(
    input.operations,
    (operation: AdminOnboardingLatestOperation) => operationUid(operation) === input.uid,
  );
  const driftState = driftStateForCustomer({
    assignedGatewayId,
    mountedGatewayId,
    policyTargetGatewayId,
    latestOperation: latestOp,
    glmByGatewayId: input.glmByGatewayId,
  });
  const warnings = userPlacementWarnings({
    uid: input.uid,
    slug,
    assignedGatewayId,
    mountedGatewayId,
    policyTargetGatewayId,
    driftState,
    latestOperation: latestOp,
  });
  return {
    uid: input.uid,
    username: asStringOrNull(input.data.username) ?? "",
    email: asStringOrNull(input.data.email) ?? "",
    slug,
    policyTargetGatewayId,
    assignedGatewayId,
    mountedGatewayId,
    provisioningStatus: readProvisioningStatus(input.data),
    driftState,
    rosterState: assignment ? assignment.state : null,
    rosterRevisionId: assignment ? assignment.gatewayId : null,
    rosterEpoch: assignment ? assignment.epoch : null,
    warnings,
    latestOperation: latestOp,
  };
}

function countBy<T extends string | null>(
  items: ReadonlyArray<AdminOnboardingCustomerProjection>,
  key: (item: AdminOnboardingCustomerProjection) => T,
): Record<Exclude<T, null>, number> {
  const out = {} as Record<Exclude<T, null>, number>;
  for (const item of items) {
    const value = key(item);
    if (value === null) continue;
    out[value as Exclude<T, null>] = (out[value as Exclude<T, null>] ?? 0) + 1;
  }
  return out;
}

function indexAssignmentsByUid(
  assignments: readonly AssignmentDoc[],
): Map<string, AssignmentDoc[]> {
  const byUid = new Map<string, AssignmentDoc[]>();
  for (const assignment of assignments) {
    const forUid = byUid.get(assignment.uid) ?? [];
    forUid.push(assignment);
    byUid.set(assignment.uid, forUid);
  }
  return byUid;
}

function buildOnboardingPlacementResponse(opts: {
  config: OnboardingRuntimeConfig;
  glmDocs: ReadonlyArray<FirestoreDocLike>;
  gatewayDocs: ReadonlyArray<FirestoreDocLike>;
  userDocs: ReadonlyArray<FirestoreDocLike>;
  operationDocs: ReadonlyArray<FirestoreDocLike>;
  assignments: readonly AssignmentDoc[];
}): AdminOnboardingPlacementResponse {
  const glmByGatewayId = indexAdminGatewayRuntimeDocs({
    gatewayDocs: opts.gatewayDocs,
    glmDocs: opts.glmDocs,
  });
  const heartbeatByGatewayId = indexFirestoreDocs(opts.gatewayDocs);
  const assignmentsByUid = indexAssignmentsByUid(opts.assignments);
  const operations = opts.operationDocs.map((doc) =>
    shapeOnboardingOperation(doc.id, doc.data()),
  );
  const mountedBySlug = mountedGatewayBySlug(glmByGatewayId);
  const customers = opts.userDocs
    .filter((doc) =>
      shouldIncludeOnboardingCustomer({
        data: doc.data(),
      }),
    )
    .map((doc) =>
      buildCustomerPlacementProjection({
        uid: doc.id,
        data: doc.data(),
        config: opts.config,
        mountedBySlug,
        operations,
        glmByGatewayId,
        assignmentsByUid,
      }),
    )
    .sort((a, b) =>
      (a.slug ?? a.username ?? a.email ?? a.uid).localeCompare(
        b.slug ?? b.username ?? b.email ?? b.uid,
        undefined,
        { sensitivity: "base" },
      ),
    );

  const mountedCountsByGateway = countBy(customers, (customer) => customer.mountedGatewayId);
  const assignedCountsByGateway = countBy(customers, (customer) => customer.assignedGatewayId);
  const driftCountsByGateway: Record<string, number> = {};
  for (const customer of customers) {
    if (customer.driftState === "healthy") continue;
    const touchedGatewayIds = new Set(
      [
        customer.policyTargetGatewayId,
        customer.assignedGatewayId,
        customer.mountedGatewayId,
      ].filter((gatewayId): gatewayId is string => typeof gatewayId === "string"),
    );
    for (const gatewayId of touchedGatewayIds) {
      driftCountsByGateway[gatewayId] = (driftCountsByGateway[gatewayId] ?? 0) + 1;
    }
  }
  const driftSummary: Record<AdminOnboardingDriftState, number> = {
    healthy: 0,
    "pointer-drift": 0,
    "assigned-not-mounted": 0,
    "mounted-orphan": 0,
    "missing-gateway": 0,
    "in-flight": 0,
  };
  for (const customer of customers) driftSummary[customer.driftState] += 1;

  const gatewayIds = new Set([
    ...glmByGatewayId.keys(),
    ...heartbeatByGatewayId.keys(),
    ...customers.flatMap((customer) =>
      [
        customer.policyTargetGatewayId,
        customer.assignedGatewayId,
        customer.mountedGatewayId,
      ].filter((gatewayId): gatewayId is string => typeof gatewayId === "string"),
    ),
  ]);
  const gateways = [...gatewayIds].sort().map((gatewayId) => {
    const glmDoc = glmByGatewayId.get(gatewayId);
    const heartbeat = effectiveHeartbeatDoc(gatewayId, glmDoc)?.data();
    const desiredStatus = projectDesiredStatus(glmDoc);
    const gatewayClass = normalizeGatewayClass(glmDoc);
    const status = asStringOrNull(heartbeat?.status);
    const warnings = customers
      .filter((customer) =>
        [
          customer.policyTargetGatewayId,
          customer.assignedGatewayId,
          customer.mountedGatewayId,
        ].includes(gatewayId),
      )
      .flatMap((customer) => customer.warnings);
    return {
      gatewayId,
      gatewayClass,
      desiredStatus,
      status,
      imageTag: projectImageTag(heartbeat ?? {}, glmDoc),
      openclawVersion: projectOpenclawVersion(heartbeat ?? {}, glmDoc),
      assignableAsDefault:
        Boolean(glmDoc) &&
        gatewayClass === "shared" &&
        desiredStatus === "running" &&
        status === "ready",
      defaultTarget: opts.config.defaultGatewayId === gatewayId,
      assignedCount: assignedCountsByGateway[gatewayId] ?? 0,
      mountedCount: mountedCountsByGateway[gatewayId] ?? 0,
      driftCount: driftCountsByGateway[gatewayId] ?? 0,
      warnings,
      lastOperation: latestOperation(operations, (operation) =>
        operationTouchesGateway(operation, gatewayId),
      ),
    };
  });

  const warnings: AdminOnboardingPlacementWarning[] = [];
  const defaultGatewayId = opts.config.defaultGatewayId || null;
  if (defaultGatewayId) {
    const glmDoc = glmByGatewayId.get(defaultGatewayId);
    if (!glmDoc) {
      warnings.push({
        code: "default-gateway-missing",
        severity: "error",
        gatewayId: defaultGatewayId,
        message: `Shared Barn anchor ${defaultGatewayId} has no desired state`,
      });
    } else if (projectDesiredStatus(glmDoc) === "retired") {
      warnings.push({
        code: "default-gateway-retired",
        severity: "error",
        gatewayId: defaultGatewayId,
        message: `Shared Barn anchor ${defaultGatewayId} is retired`,
      });
    } else if (normalizeGatewayClass(glmDoc) !== "shared") {
      warnings.push({
        code: "default-gateway-not-shared",
        severity: "warning",
        gatewayId: defaultGatewayId,
        message: `Shared Barn anchor ${defaultGatewayId} is not a shared gateway`,
      });
    }
  } else {
    warnings.push({
      code: "default-gateway-missing",
      severity: "error",
      message: "No default onboarding gateway is configured",
    });
  }
  warnings.push(...accountLifecycleWarnings(opts.userDocs, operations));
  for (const customer of customers) warnings.push(...customer.warnings);

  return {
    config: {
      defaultGatewayId,
      sharedGatewayIds: [...opts.config.sharedGatewayIds],
      sharedGatewayAutoscaling: opts.config.sharedGatewayAutoscaling,
    },
    gateways,
    customers,
    driftSummary,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

async function readAdminOnboardingPlacementResponse(
  store: PlatformStateStore,
  accounts: BuilderAccountReader,
): Promise<AdminOnboardingPlacementResponse> {
  const [config, snapshot, recent, accountsByUid] = await Promise.all([
    store.transaction(
      { label: "admin.fleet.onboardingPlacementConfig", readOnly: true },
      readOnboardingRuntimeConfigInStore,
    ),
    readFleetSnapshot(store),
    store.journal.listRecent({ limit: 200 }),
    accounts.list(),
  ]);
  return buildOnboardingPlacementResponse({
    config,
    ...fleetGatewayDocs(snapshot),
    userDocs: builderUserDocs(snapshot.builders, accountsByUid),
    operationDocs: operationDocs(recent.items),
    assignments: snapshot.assignments,
  });
}

function indexGlmDocs(docs: ReadonlyArray<FirestoreDocLike>): Map<string, GlmDoc> {
  const out = new Map<string, GlmDoc>();
  for (const doc of docs) out.set(doc.id, doc.data());
  return out;
}

function addOperationId(ids: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.length > 0) ids.add(value);
}

function leasePlacementRetireOperationId(
  uid: string,
  targetGatewayId: string,
  generation: unknown,
): string | null {
  return Number.isSafeInteger(generation) && (generation as number) > 0
    ? placementRetireOperationId(uid, targetGatewayId, generation as number)
    : null;
}

function disposableRuntimeRetireOperationId(
  gateway: GlmDoc,
  gatewayId: string,
): string | null {
  const runtime = projectDisposableRuntime(gateway);
  return runtime && runtime.generation > 0
    ? placementRetireOperationId(runtime.ownerUid, gatewayId, runtime.generation)
    : null;
}

function fleetProjectionOperationIds(
  userDocs: ReadonlyArray<FirestoreDocLike>,
  gatewaysById: ReadonlyMap<string, GlmDoc>,
): string[] {
  const ids = new Set<string>();
  for (const userDoc of userDocs) {
    const resolved = activationLeaseFromUser(userDoc.data());
    if (!resolved) continue;
    addOperationId(ids, resolved.lease.activationOperationId);
    addOperationId(ids, resolved.lease.returnOperationId);
    const targetGatewayId = asStringOrNull(resolved.lease.targetGatewayId);
    if (!targetGatewayId) continue;
    const target = gatewaysById.get(targetGatewayId);
    const retirementClaim = isPlainRecord(target?.retirementClaim)
      ? target.retirementClaim
      : null;
    addOperationId(
      ids,
      asStringOrNull(retirementClaim?.operationId) ??
      leasePlacementRetireOperationId(userDoc.id, targetGatewayId, resolved.lease.generation),
    );
  }
  for (const [gatewayId, gateway] of gatewaysById) {
    if (
      projectDesiredStatus(gateway) !== "retired" ||
      projectDisposableRuntime(gateway) === null
    ) {
      continue;
    }
    const retirementClaim = isPlainRecord(gateway.retirementClaim)
      ? gateway.retirementClaim
      : null;
    addOperationId(
      ids,
      asStringOrNull(retirementClaim?.operationId) ??
      disposableRuntimeRetireOperationId(gateway, gatewayId),
    );
  }
  return [...ids].sort();
}

async function readFleetProjectionOperations(
  store: PlatformStateStore,
  operationIds: readonly string[],
): Promise<FirestoreDocLike[]> {
  const found = await store.journal.operations.getMany(operationIds);
  return operationDocs([...found.values()]);
}

function indexFirestoreDocs(docs: ReadonlyArray<FirestoreDocLike>): Map<string, FirestoreDocLike> {
  const out = new Map<string, FirestoreDocLike>();
  for (const doc of docs) out.set(doc.id, doc);
  return out;
}

function indexDurableGatewayRoots(
  docs: ReadonlyArray<FirestoreDocLike>,
): Map<string, DurableGatewayRoot> {
  const out = new Map<string, DurableGatewayRoot>();
  for (const doc of docs) {
    const root = asDurableGatewayRoot(doc.data(), doc.id);
    if (root) out.set(doc.id, root);
  }
  return out;
}

function projectDurableGatewayRuntime(
  root: DurableGatewayRoot,
  runtime: GatewayRuntimeDoc | null,
): GlmDoc {
  if (!runtime) return { ...root, gateway: root.gatewayId };
  return {
    ...root,
    gateway: root.gatewayId,
    imageRepository: runtime.helm.imageRepository,
    imageTag: runtime.helm.imageTag,
    heartbeat: runtime.heartbeat,
    lastError: runtime.lastError,
    podReplacements: runtime.podReplacements,
  };
}

function indexAdminGatewayRuntimeDocs(input: {
  gatewayDocs: ReadonlyArray<FirestoreDocLike>;
  glmDocs: ReadonlyArray<FirestoreDocLike>;
}): Map<string, GlmDoc> {
  const rawGlmById = indexGlmDocs(input.glmDocs);
  const rootsById = indexDurableGatewayRoots(input.gatewayDocs);
  const out = new Map<string, GlmDoc>();
  for (const [gatewayId, root] of rootsById) {
    out.set(
      gatewayId,
      projectDurableGatewayRuntime(root, exactRuntimeDoc(root, rawGlmById.get(gatewayId))),
    );
  }
  return out;
}

function projectLastError(raw: unknown):
  | { slug?: string; message?: string; at: string | null }
  | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { slug?: string; message?: string; at?: unknown };
  return { slug: e.slug, message: e.message, at: toIso(e.at) };
}

function projectDesiredStatus(glmDoc: GlmDoc | undefined):
  | "running" | "paused" | "draining" | "retired" | null {
  const v = glmDoc?.desiredStatus;
  if (typeof v !== "string") return null;
  if (v === "running" || v === "paused" || v === "draining" || v === "retired") return v;
  return null;
}

function requestedGatewayStatus(
  desiredStatus: ReturnType<typeof projectDesiredStatus>,
): string {
  if (desiredStatus === "running") return "booting";
  if (desiredStatus === "paused") return "paused";
  if (desiredStatus === "draining") return "draining";
  return "unknown";
}

function openclawVersionFromImageTag(imageTag: unknown): string | null {
  if (typeof imageTag !== "string") return null;
  const match = imageTag.match(/^[0-9a-f]{7,40}-oc(.+)$/u);
  return match?.[1] ?? null;
}

const OPENCLAW_VERSION_PRODUCT_PREFIX = /^openclaw\s+/iu;

function withoutBuildSuffix(value: string): string {
  if (!value.endsWith(")")) return value;
  const opensAt = value.lastIndexOf("(");
  return opensAt === -1 ? value : value.slice(0, opensAt);
}

function reportedOpenclawVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = withoutBuildSuffix(
    value.trim().replace(OPENCLAW_VERSION_PRODUCT_PREFIX, ""),
  ).trim();
  return version.length === 0 || version === "unknown" ? null : version;
}

function projectOpenclawVersion(data: GlmDoc, glmDoc: GlmDoc | undefined): string | null {
  return reportedOpenclawVersion(data.openclawVersion) ??
    openclawVersionFromImageTag(glmDoc?.imageTag);
}

function projectImageTag(data: GlmDoc, glmDoc: GlmDoc | undefined): string | null {
  if (typeof data.version === "string") return data.version;
  return typeof glmDoc?.imageTag === "string" ? glmDoc.imageTag : null;
}

function syntheticGatewayDoc(id: string): FirestoreDocLike {
  return { id, data: () => ({ gatewayId: id }) };
}

function effectiveHeartbeatDoc(
  gatewayId: string,
  glmDoc: GlmDoc | undefined,
): FirestoreDocLike | undefined {
  const hb = glmDoc?.heartbeat;
  if (isPlainRecord(hb) && Object.keys(hb).length > 0) {
    const lastError = isPlainRecord(glmDoc?.lastError) ? glmDoc.lastError : undefined;
    return {
      id: gatewayId,
      data: () => ({ gatewayId, ...hb, ...(lastError ? { lastError } : {}) }),
    };
  }
  return undefined;
}

function shouldProjectDesiredOnlyGateway(glmDoc: GlmDoc | undefined): boolean {
  const desiredStatus = projectDesiredStatus(glmDoc);
  return desiredStatus !== null && desiredStatus !== "retired";
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function exactRuntimeDoc(
  root: DurableGatewayRoot,
  data: unknown,
): GatewayRuntimeDoc | null {
  if (!isGatewayRuntimeDoc(data) || data.gatewayId !== root.gatewayId) {
    return null;
  }
  return data;
}

function runtimeHeartbeat(runtime: GatewayRuntimeDoc | null): GlmDoc | null {
  return runtime && isPlainRecord(runtime.heartbeat) ? runtime.heartbeat : null;
}

function durableRootOf(stored: GatewayRoot | null, gatewayId: string): DurableGatewayRoot | null {
  return stored === null ? null : asDurableGatewayRoot(recordDoc(gatewayId, stored).data(), gatewayId);
}

async function readDurableGatewayRuntime(
  store: PlatformStateStore,
  gatewayId: string,
): Promise<DurableGatewayRuntime | null> {
  const [stored, registry] = await Promise.all([
    store.gateways.roots.get(gatewayId),
    store.fleetRegistry.get(gatewayId),
  ]);
  const root = durableRootOf(stored, gatewayId);
  if (!root) return null;
  const runtime = registry === null ? null : exactRuntimeDoc(root, runtimeRecordDoc(registry).data());
  return { root, runtime, heartbeat: runtimeHeartbeat(runtime) };
}

function gatewayRetirementBlocker(
  gatewayId: string,
  runtime: DurableGatewayRuntime,
): Record<string, unknown> | null {
  if (
    runtime.root.desiredStatus === "running" &&
    runtime.root.liveRelease != null &&
    !runtime.runtime
  ) {
    return {
      error: "gateway runtime telemetry is unavailable",
      gatewayId,
    };
  }
  return null;
}

async function readGatewayRegistrationReadiness(
  store: PlatformStateStore,
  gatewayId: string,
): Promise<{
  registered: boolean;
  status: string | null;
  gatewayClass: DurableGatewayRoot["gatewayClass"] | null;
}> {
  const runtime = await readDurableGatewayRuntime(store, gatewayId);
  return {
    registered: runtime !== null,
    gatewayClass: runtime?.root.gatewayClass ?? null,
    status:
      runtime?.root.desiredStatus === "running"
        ? asStringOrNull(runtime.heartbeat?.status)
        : null,
  };
}

type ProjectedGatewayStorage = {
  mode: "emptyDir" | "pvc";
  pvcName: string | null;
  size: string | null;
  storageClassName: string | null;
  accessModes: string[];
};

function emptyDirGatewayStorage(): ProjectedGatewayStorage {
  return {
    mode: "emptyDir",
    pvcName: null,
    size: null,
    storageClassName: null,
    accessModes: [],
  };
}

function projectGatewayStorage(
  _gatewayId: string,
  _glmDoc: GlmDoc | undefined,
): ProjectedGatewayStorage {
  return emptyDirGatewayStorage();
}

export function projectGatewayReservation(
  glmDoc: GlmDoc | undefined,
  observedCapacityType?: GatewayPodCapacityType,
): {
  type: GatewayPricingMode;
  priceMultiplier: number;
  source: "kubernetes" | "class-default";
} {
  const type = observedCapacityType ??
    (normalizeGatewayClass(glmDoc) === "shared" ? "on-demand" : "spot");
  return {
    type,
    priceMultiplier: type === "spot" ? SPOT_PRICE_MULTIPLIER : 1,
    source: observedCapacityType ? "kubernetes" : "class-default",
  };
}

function projectDisposableRuntime(
  glmDoc: GlmDoc | undefined,
): {
  ownerUid: string;
  leaseId: string;
  generation: number;
} | null {
  const allocation = isPlainRecord(glmDoc?.allocation)
    ? glmDoc.allocation
    : null;
  if (
    allocation?.kind !== "disposable-builder" ||
    typeof allocation.leaseId !== "string" ||
    !Number.isSafeInteger(allocation.generation) ||
    typeof allocation.claimedByUid !== "string" ||
    glmDoc?.ownerUid !== allocation.claimedByUid
  ) {
    return null;
  }
  return {
    ownerUid: allocation.claimedByUid,
    leaseId: allocation.leaseId,
    generation: allocation.generation as number,
  };
}

// The stored window is a list of replacement timestamps, so the rolling counts
// are derived against the request clock rather than read back from a number that
// was accurate only when Cowboy last wrote the document.
function projectGatewayPodReplacements(
  glmDoc: GlmDoc | undefined,
  now: number,
): GatewayPodReplacementSummary | null {
  const stored = glmDoc?.podReplacements;
  if (!isGatewayPodReplacements(stored)) return null;
  return summarizeGatewayPodReplacements(stored, now);
}

export function projectGatewaySummary(
  doc: FirestoreDocLike,
  glmDoc: GlmDoc | undefined,
  now: number,
): {
  gatewayId: string; gateway: string; status: string;
  desiredStatus: AdminGatewayDesiredStatus | null;
  imageTag: string | null; openclawVersion: string | null;
  mountedCustomers: unknown[];
  handoffProgress?: Record<string, MigrationProgressRecord[]>;
  lastHeartbeatAt: string | null; heartbeatAgeMs: number | null;
  startedAt: string | null; uptimeMs: number | null;
  lastError: ReturnType<typeof projectLastError>;
  sizing: ReturnType<typeof resolveSizingForResponse>;
  storage: ReturnType<typeof projectGatewayStorage>;
  reservation: ReturnType<typeof projectGatewayReservation>;
  profile: GatewayProfile;
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
  disposableRuntime: ReturnType<typeof projectDisposableRuntime>;
  podReplacements: GatewayPodReplacementSummary | null;
} {
  const data = doc.data();
  const gatewayId = typeof data.gatewayId === "string" ? data.gatewayId : doc.id;
  const desiredStatus = projectDesiredStatus(glmDoc);
  const reservation = projectGatewayReservation(glmDoc);
  return {
    gatewayId,
    gateway: deriveGatewayIdentity(gatewayId, glmDoc?.gateway),
    status: typeof data.status === "string" ? data.status : requestedGatewayStatus(desiredStatus),
    desiredStatus,
    imageTag: projectImageTag(data, glmDoc),
    openclawVersion: projectOpenclawVersion(data, glmDoc),
    mountedCustomers: Array.isArray(data.mountedCustomers) ? data.mountedCustomers : [],
    lastHeartbeatAt: toIso(data.lastHeartbeatAt),
    heartbeatAgeMs: ageMsOrNull(toMillis(data.lastHeartbeatAt), now),
    startedAt: toIso(data.startedAt),
    uptimeMs: ageMsOrNull(toMillis(data.startedAt), now),
    lastError: projectLastError(data.lastError),
    sizing: resolveSizingForResponse(glmDoc, reservation),
    storage: projectGatewayStorage(gatewayId, glmDoc),
    reservation,
    profile: normalizeGatewayProfile(glmDoc?.profile),
    gatewayClass: normalizeGatewayClass(glmDoc),
    imageProfile: normalizeGatewayImageProfile(glmDoc),
    disposableRuntime: projectDisposableRuntime(glmDoc),
    podReplacements: projectGatewayPodReplacements(glmDoc, now),
  };
}

export type AdminBuilderRuntimeLifecycle =
  | "requested"
  | "provisioning"
  | "activating"
  | "active"
  | "returning"
  | "retiring"
  | "failed";

const LIVE_BUILDER_RUNTIME_STATUSES = new Set([
  "requested",
  "provisioning",
  "activating",
  "active",
  "returning",
]);
const BUILDER_RUNTIME_STALE_AFTER_MS = 10 * 60_000;
const BUILDER_RUNTIME_STATUS_FIELDS: Record<AdminBuilderRuntimeLifecycle, string> = {
  requested: "requestedAt",
  provisioning: "provisionedAt",
  activating: "activatingAt",
  active: "activeAt",
  returning: "returningAt",
  retiring: "returningAt",
  failed: "failedAt",
};

function activationLeaseFromUser(
  data: GlmDoc,
): {
  openclaw: GlmDoc;
  lease: GlmDoc;
} | null {
  const provisioning = isPlainRecord(data.provisioning)
    ? data.provisioning
    : null;
  const openclaw = isPlainRecord(provisioning?.openclaw)
    ? provisioning.openclaw
    : null;
  const lease = isPlainRecord(openclaw?.activationLease)
    ? openclaw.activationLease
    : null;
  return openclaw && lease ? { openclaw, lease } : null;
}

function runtimeStatusAt(lease: GlmDoc, lifecycle: AdminBuilderRuntimeLifecycle): number | null {
  const field = BUILDER_RUNTIME_STATUS_FIELDS[lifecycle];
  return toMillis(lease[field]) ?? toMillis(lease.requestedAt);
}

function runtimeWakeDurationMs(
  lease: GlmDoc,
  leaseStatus: string,
  requestedAt: number | null,
  now: number,
): number | null {
  if (requestedAt === null) return null;
  let completedAt: number | null = null;
  if (
    leaseStatus === "active" ||
    leaseStatus === "returning" ||
    leaseStatus === "parked"
  ) {
    completedAt = toMillis(lease.activeAt);
  } else if (leaseStatus === "failed") {
    completedAt = toMillis(lease.failedAt);
  }
  return Math.max(0, (completedAt ?? now) - requestedAt);
}

function projectOperationSteps(
  operation: GlmDoc | undefined,
): Array<{ name: string; status: string }> {
  return Array.isArray(operation?.steps)
    ? operation.steps.flatMap((step) => {
        if (
          !isPlainRecord(step) ||
          typeof step.name !== "string" ||
          typeof step.status !== "string"
        ) {
          return [];
        }
        return [{ name: step.name, status: step.status }];
      })
    : [];
}

interface BuilderRuntimeLeaseContext {
  data: GlmDoc;
  openclaw: GlmDoc;
  lease: GlmDoc;
  leaseId: string;
  generation: number;
  leaseStatus: string;
}

interface BuilderRuntimeRetirementContext {
  targetGatewayId: string | null;
  target: GlmDoc | undefined;
  operationId: string | null;
  operation: GlmDoc | undefined;
  started: boolean;
  complete: boolean;
  failed: boolean;
}

type AdminBuilderRuntimePhase = "activation" | "runtime" | "return" | "retirement";

function builderRuntimeLeaseContext(
  userDoc: FirestoreDocLike,
): BuilderRuntimeLeaseContext | null {
  const data = userDoc.data();
  const resolved = activationLeaseFromUser(data);
  if (!resolved) return null;
  const { openclaw, lease } = resolved;
  if (
    typeof lease.leaseId !== "string" ||
    !Number.isSafeInteger(lease.generation)
  ) {
    return null;
  }
  return {
    data,
    openclaw,
    lease,
    leaseId: lease.leaseId,
    generation: lease.generation as number,
    leaseStatus: typeof lease.status === "string" ? lease.status : "",
  };
}

function builderRuntimeRetirementContext(
  uid: string,
  lease: GlmDoc,
  gatewaysById: ReadonlyMap<string, GlmDoc>,
  operationsById: ReadonlyMap<string, GlmDoc>,
): BuilderRuntimeRetirementContext {
  const targetGatewayId = asStringOrNull(lease.targetGatewayId);
  const target = targetGatewayId ? gatewaysById.get(targetGatewayId) : undefined;
  const retirementClaim = isPlainRecord(target?.retirementClaim)
    ? target.retirementClaim
    : null;
  let operationId: string | null = null;
  if (targetGatewayId) {
    operationId =
      asStringOrNull(retirementClaim?.operationId) ??
      leasePlacementRetireOperationId(uid, targetGatewayId, lease.generation);
  }
  const operation = operationId ? operationsById.get(operationId) : undefined;
  return {
    targetGatewayId,
    target,
    operationId,
    operation,
    started: target?.desiredStatus === "retired",
    complete: operation?.status === "succeeded",
    failed: operation?.status === "failed",
  };
}

function builderRuntimeLifecycle(
  leaseStatus: string,
  retirement: BuilderRuntimeRetirementContext,
): AdminBuilderRuntimeLifecycle | null {
  const targetRetained = leaseStatus === "parked" && !retirement.started && !retirement.failed &&
    projectDesiredStatus(retirement.target) === "paused";
  const teardownLingers = retirement.target !== undefined && !retirement.complete && !targetRetained;
  const visible =
    LIVE_BUILDER_RUNTIME_STATUSES.has(leaseStatus) ||
    ((leaseStatus === "parked" || leaseStatus === "failed") && teardownLingers);
  if (!visible) return null;
  if (retirement.failed || leaseStatus === "failed") return "failed";
  if (retirement.started || leaseStatus === "parked") return "retiring";
  return leaseStatus as AdminBuilderRuntimeLifecycle;
}

function builderRuntimePhase(
  leaseStatus: string,
  lifecycle: AdminBuilderRuntimeLifecycle,
  retirementStarted: boolean,
): AdminBuilderRuntimePhase {
  if (leaseStatus === "failed") return "activation";
  if (retirementStarted) return "retirement";
  if (lifecycle === "returning") return "return";
  if (lifecycle === "active") return "runtime";
  return "activation";
}

function builderRuntimeOperationId(
  phase: AdminBuilderRuntimePhase,
  lease: GlmDoc,
  retirementOperationId: string | null,
): string | null {
  if (phase === "retirement") return retirementOperationId;
  if (phase === "return") return asStringOrNull(lease.returnOperationId);
  return asStringOrNull(lease.activationOperationId);
}

function builderRuntimeSlug(
  uid: string,
  data: GlmDoc,
  openclaw: GlmDoc,
  lease: GlmDoc,
): string {
  const leaseSlug = asStringOrNull(lease.builderSlug);
  if (leaseSlug) return leaseSlug;
  const openclawSlug = asStringOrNull(openclaw.slug);
  if (openclawSlug) return openclawSlug;
  return asStringOrNull(data.username) ?? uid;
}

function builderRuntimeIsStale(
  leaseStatus: string,
  wakeDurationMs: number | null,
): boolean {
  const preCutover =
    leaseStatus === "requested" ||
    leaseStatus === "provisioning" ||
    leaseStatus === "activating";
  return preCutover &&
    wakeDurationMs !== null &&
    wakeDurationMs > BUILDER_RUNTIME_STALE_AFTER_MS;
}

function builderRuntimeTerminationAvailable(input: {
  targetGatewayId: string | null;
  currentGatewayId: string | null;
  target: GlmDoc | undefined;
  leaseFailed: boolean;
  stale: boolean;
}): boolean {
  return input.targetGatewayId !== null &&
    input.currentGatewayId !== input.targetGatewayId &&
    input.target?.desiredStatus !== "retired" &&
    (input.leaseFailed || input.stale);
}

function isoFromMillis(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function projectBuilderRuntime(
  userDoc: FirestoreDocLike,
  gatewaysById: ReadonlyMap<string, GlmDoc>,
  operationsById: ReadonlyMap<string, GlmDoc>,
  now: number,
): {
  uid: string;
  builderSlug: string;
  lifecycle: AdminBuilderRuntimeLifecycle;
  phase: "activation" | "runtime" | "return" | "retirement";
  leaseId: string;
  generation: number;
  cause: string | null;
  currentGatewayId: string | null;
  sourceGatewayId: string | null;
  targetGatewayId: string | null;
  sizingTier: string | null;
  requestedAt: string | null;
  wakeDurationMs: number | null;
  statusAt: string | null;
  statusAgeMs: number | null;
  stale: boolean;
  operationId: string | null;
  operationStatus: string | null;
  operationSteps: Array<{ name: string; status: string }>;
  cleanupOperationId: string | null;
  cleanupOperationStatus: string | null;
  cleanupOperationSteps: Array<{ name: string; status: string }>;
  cleanupError: string | null;
  error: string | null;
  terminationAvailable: boolean;
  targetPodStatus: GatewayPodDiagnosticsStatus | null;
  targetPodCount: number | null;
} | null {
  const leaseContext = builderRuntimeLeaseContext(userDoc);
  if (!leaseContext) return null;
  const { data, openclaw, lease, leaseId, generation, leaseStatus } = leaseContext;
  if (openclaw.managedBy === "operator") return null;
  const retirement = builderRuntimeRetirementContext(
    userDoc.id,
    lease,
    gatewaysById,
    operationsById,
  );
  const { targetGatewayId } = retirement;
  const lifecycle = builderRuntimeLifecycle(leaseStatus, retirement);
  if (!lifecycle) return null;
  const leaseFailed = leaseStatus === "failed";
  const phase = builderRuntimePhase(
    leaseStatus,
    lifecycle,
    retirement.started,
  );
  const operationId = builderRuntimeOperationId(
    phase,
    lease,
    retirement.operationId,
  );
  const operation = operationId ? operationsById.get(operationId) : undefined;
  const operationSteps = projectOperationSteps(operation);
  const cleanupOperationId = retirement.started
    ? retirement.operationId
    : null;
  const cleanupOperation = cleanupOperationId
    ? retirement.operation
    : undefined;
  const lastError = isPlainRecord(lease.lastError) ? lease.lastError : null;
  const requestedAt = toMillis(lease.requestedAt);
  const statusAt = runtimeStatusAt(lease, lifecycle);
  const statusAgeMs = ageMsOrNull(statusAt, now);
  const wakeDurationMs = runtimeWakeDurationMs(
    lease,
    leaseStatus,
    requestedAt,
    now,
  );
  const currentGatewayId = asStringOrNull(openclaw.gatewayId);
  const stale = builderRuntimeIsStale(leaseStatus, wakeDurationMs);
  return {
    uid: userDoc.id,
    builderSlug: builderRuntimeSlug(userDoc.id, data, openclaw, lease),
    lifecycle,
    phase,
    leaseId,
    generation,
    cause: asStringOrNull(lease.cause),
    currentGatewayId,
    sourceGatewayId: asStringOrNull(lease.sourceGatewayId),
    targetGatewayId,
    sizingTier: asStringOrNull(lease.sizingTier),
    requestedAt: isoFromMillis(requestedAt),
    wakeDurationMs,
    statusAt: isoFromMillis(statusAt),
    statusAgeMs,
    stale,
    operationId,
    operationStatus: asStringOrNull(operation?.status),
    operationSteps,
    cleanupOperationId,
    cleanupOperationStatus: asStringOrNull(cleanupOperation?.status),
    cleanupOperationSteps: projectOperationSteps(cleanupOperation),
    cleanupError: asStringOrNull(cleanupOperation?.error),
    error:
      asStringOrNull(operation?.error) ??
      asStringOrNull(lastError?.message),
    terminationAvailable: builderRuntimeTerminationAvailable({
      targetGatewayId,
      currentGatewayId,
      target: retirement.target,
      leaseFailed,
      stale,
    }),
    targetPodStatus: null,
    targetPodCount: null,
  };
}

export function projectDisposableFleetCapacity(
  gateways: ReadonlyArray<ReturnType<typeof projectGatewaySummary>>,
  builderRuntimes: ReadonlyArray<NonNullable<ReturnType<typeof projectBuilderRuntime>>> = [],
  parkedBuilders = 0,
): {
  disposableInstances: number;
  stagedInstances: 0;
  byTier: Record<string, number>;
  parkedBuilders: number;
  byLifecycle: Record<AdminBuilderRuntimeLifecycle | "parked", number>;
  failedBuilders: number;
  staleActivations: number;
  oldestActivationAgeMs: number | null;
} {
  const disposables = gateways.filter((gateway) => gateway.disposableRuntime !== null);
  const byTier: Record<string, number> = {};
  const byLifecycle: Record<AdminBuilderRuntimeLifecycle | "parked", number> = {
    requested: 0,
    provisioning: 0,
    activating: 0,
    active: 0,
    returning: 0,
    retiring: 0,
    failed: 0,
    parked: parkedBuilders,
  };
  for (const gateway of disposables) {
    byTier[gateway.sizing.tier] = (byTier[gateway.sizing.tier] ?? 0) + 1;
  }
  for (const runtime of builderRuntimes) {
    byLifecycle[runtime.lifecycle] += 1;
  }
  const activationAges = builderRuntimes.flatMap((runtime) =>
    (
      runtime.lifecycle === "requested" ||
      runtime.lifecycle === "provisioning" ||
      runtime.lifecycle === "activating"
    ) && runtime.wakeDurationMs !== null
      ? [runtime.wakeDurationMs]
      : []
  );
  return {
    disposableInstances: disposables.length,
    stagedInstances: 0,
    byTier,
    parkedBuilders,
    byLifecycle,
    failedBuilders: byLifecycle.failed,
    staleActivations: builderRuntimes.filter((runtime) => runtime.stale).length,
    oldestActivationAgeMs:
      activationAges.length === 0 ? null : Math.max(...activationAges),
  };
}

function rollupFleetStats(
  gateways: ReadonlyArray<ReturnType<typeof projectGatewaySummary>>,
): {
  gateways: { total: number; ready: number; paused: number; unreachable: number };
  customersMounted: number;
  fleetCost: {
    monthlyUsd: number;
    onDemandMonthlyUsd: number;
    savingsUsd: number;
    byTier: Record<string, {
      count: number;
      subtotalUsd: number;
      onDemandSubtotalUsd: number;
      spotCount: number;
      onDemandCount: number;
    }>;
  };
} {
  let ready = 0, paused = 0, unreachable = 0, customersMounted = 0, fleetMonthlyUsd = 0, fleetOnDemandUsd = 0;
  const byTier: Record<string, {
    count: number;
    subtotalUsd: number;
    onDemandSubtotalUsd: number;
    spotCount: number;
    onDemandCount: number;
  }> = {};
  for (const g of gateways) {
    // Derived reachability (replaces the deleted Cloud-Function "unreachable" writer):
    // a gateway whose heartbeat has aged out is unreachable, whatever its last
    // self-reported status said. See FLEET-RECONCILE-SPEC.
    const stale = g.heartbeatAgeMs != null && g.heartbeatAgeMs > GATEWAY_UNREACHABLE_AFTER_MS;
    if (g.desiredStatus === "paused") paused++;
    else if (stale) unreachable++;
    else if (g.status === "ready") ready++;
    customersMounted += g.mountedCustomers.length;
    fleetMonthlyUsd += g.sizing.monthlyCostUsd.compute;
    fleetOnDemandUsd += g.sizing.monthlyCostUsd.onDemandCompute;
    const entry = byTier[g.sizing.tier] ?? {
      count: 0,
      subtotalUsd: 0,
      onDemandSubtotalUsd: 0,
      spotCount: 0,
      onDemandCount: 0,
    };
    entry.count += 1;
    entry.subtotalUsd += g.sizing.monthlyCostUsd.compute;
    entry.onDemandSubtotalUsd += g.sizing.monthlyCostUsd.onDemandCompute;
    if (g.reservation.type === "spot") entry.spotCount += 1;
    else entry.onDemandCount += 1;
    byTier[g.sizing.tier] = entry;
  }
  return {
    gateways: { total: gateways.length, ready, paused, unreachable },
    customersMounted,
    fleetCost: {
      monthlyUsd: fleetMonthlyUsd,
      onDemandMonthlyUsd: fleetOnDemandUsd,
      savingsUsd: Math.max(0, fleetOnDemandUsd - fleetMonthlyUsd),
      byTier,
    },
  };
}

const ERR_GATEWAY_NOT_FOUND = "gateway not found";
const ERR_GATEWAY_OPERATION_IN_FLIGHT =
  "another operation is already pending or running for this gateway";
const ERR_USER_NOT_FOUND = "user not found";
const ERR_TARGET_GATEWAY_NOT_READY = "target gateway not ready";
const ADMIN_FLEET_REQUEST_REASON = "Admin fleet request";
const OP_KIND_RESTART_GATEWAY = "restart-gateway";

interface RestoreRecoveryBody {
  sourceSha?: unknown;
  operationId?: unknown;
  reauthorizeAttemptId?: unknown;
  supersedeRecoveryId?: unknown;
}
function validRecoveryOperationId(value: unknown): value is string {
  return typeof value === "string" && Boolean(value) && value.length <= 256 && !value.includes("/");
}
function validRecoveryAttemptId(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 256;
}
function validRecoverySupersession(body: RestoreRecoveryBody): boolean {
  return body.supersedeRecoveryId === undefined || (validRecoveryAttemptId(body.supersedeRecoveryId) &&
    !body.supersedeRecoveryId.includes("/"));
}
function validSourceRecoveryBody(body: Record<string, unknown>): boolean {
  const predecessorId = body.supersedeRecoveryId;
  return typeof body.sourceSha === "string" && /^[a-f0-9]{40}$/.test(body.sourceSha) &&
    Object.keys(body).every(key => ["sourceSha", "supersedeRecoveryId"].includes(key)) &&
    (predecessorId === undefined || (typeof predecessorId === "string" && Boolean(predecessorId) && !predecessorId.includes("/")));
}
function validRestoreRecoveryBody(body: RestoreRecoveryBody): boolean {
  return typeof body.sourceSha === "string" && /^[a-f0-9]{40}$/.test(body.sourceSha) &&
    validRecoveryOperationId(body.operationId) &&
    (body.reauthorizeAttemptId === undefined || validRecoveryAttemptId(body.reauthorizeAttemptId)) &&
    validRecoverySupersession(body) &&
    Object.keys(body).every(key => ["sourceSha", "operationId", "reauthorizeAttemptId", "supersedeRecoveryId"].includes(key));
}
async function capturedRestoreAttempt(store: PlatformStateStore, operationId: string, attemptId: unknown): Promise<DocumentData | undefined> {
  if (attemptId === undefined) return undefined;
  return (await store.journal.operations.get(operationId))?.restoreAttempt;
}
function failedRecoveryOperationMatches(previous: DocumentData | undefined, gatewayId: string): previous is DocumentData {
  return previous?.kind === OP_KIND_RESTART_GATEWAY && previous.status === "failed" &&
    previous.cancellationRequestedAt === undefined && previous.completedAt > 0 &&
    previous.restoreRuntimeRecovery === undefined && previous.input?.gatewayId === gatewayId;
}
function recoveryPredecessorFenceMatches(input: {
  fence: DocumentData | undefined;
  predecessorId: string;
  gatewayId: string;
  operationId: string;
  images: unknown;
}): boolean {
  const { fence, predecessorId, gatewayId, operationId, images } = input;
  return fence?.kind === "restore-recovery" && fence.attemptId === predecessorId &&
    fence.gatewayId === gatewayId && fence.phase === "dispatched" &&
    fence.target?.restoreOperationId === operationId && isDeepStrictEqual(fence.target?.images, images);
}
async function capturedRecoveryPredecessor(store: PlatformStateStore, gatewayId: string, operationId: string, predecessorId: string, reauthorize: unknown) {
  const [root, predecessor] = await Promise.all([
    store.gateways.roots.get(gatewayId), store.journal.operations.get(predecessorId),
  ]);
  const previous: DocumentData | undefined = predecessor === null ? undefined : recordDoc(predecessorId, predecessor).data();
  const fence: DocumentData | undefined = root?.runtimeRestartFence;
  const recovery = previous?.input?.restoreRecovery;
  if (recovery?.operationId !== operationId ||
      !recoveryPredecessorFenceMatches({ fence, predecessorId, gatewayId, operationId, images: recovery.images })) return null;
  if (!failedRecoveryOperationMatches(previous, gatewayId) || reauthorize === undefined || !isDeepStrictEqual(recovery.reauthorize, reauthorize)) return null;
  return { operationId: predecessorId, input: previous.input, completedAt: previous.completedAt, fence };
}
function restoreRecoveryOperationInput(input: {
  gatewayId: string;
  sourceSha: string;
  operationId: string;
  payload: ReturnType<typeof centralGatewayReleasePayload>;
  reauthorize: DocumentData | undefined;
  supersede: Awaited<ReturnType<typeof capturedRecoveryPredecessor>> | undefined;
}) {
  const { gatewayId, sourceSha, operationId, payload, reauthorize, supersede } = input;
  return { gatewayId, restoreRecovery: { operationId, sourceSha,
    ...(reauthorize ? { reauthorize } : {}), ...(supersede ? { supersede } : {}),
    images: { gateway: `${payload.imageRepository}:${payload.imageTag}`,
      "gateway-edge": `${payload.gatewayEdgeImage!.imageRepository}:${payload.gatewayEdgeImage!.imageTag}` } } };
}
const OP_KIND_MIGRATE_CUSTOMER = "migrate-customer";
const GATEWAY_IMAGE_REPO_PREFIXES = [...new Set(
  (["prod", "test"] as const).flatMap((environment) =>
    deploymentTargetsForEnvironment(environment).map(
      (target) => `${target.artifactRegistryRepository}/`,
    ),
  ),
)];
const BUILDS_SERVICE_ALLOWLIST = new Set([
  "octogee-gateway",
  "gateway-edge",
  "release-digest-manifest",
]);

const OP_KINDS = new Set([
  "add-gateway",
  OP_KIND_MIGRATE_CUSTOMER,
  "retire-gateway",
  OP_KIND_RESTART_GATEWAY,
  "rollout",
  "deprovision-customer",
  "suspend-customer",
  "erase-customer",
]);
const OP_STATUSES = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "rolled-back",
]);

export interface AdminGatewayControlProjection {
  desiredStatus: string;
  desiredRelease: number | null;
  liveRelease: number | null;
  runtime: GatewayRuntime;
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
  profile: GatewayProfile | null;
  sizingTier: string | null;
  ownerUid: string | null;
  builderSlug: string | null;
  gcpProject: string | null;
  serviceAccountName: string | null;
  builderAccess: Record<string, unknown> | null;
  modelBrokerLimits: Record<string, unknown> | null;
  vm: GatewayVmState | null;
}

export function projectGatewayControl(
  root: DurableGatewayRoot,
  glmData: Record<string, unknown> | undefined,
): AdminGatewayControlProjection {
  const profileInput = {
    gatewayClass: root.gatewayClass,
    imageProfile: root.imageProfile,
    profile: root.profile ?? undefined,
  };
  return {
    desiredStatus: root.desiredStatus,
    desiredRelease: releaseNumberOrNull(root.desiredRelease),
    liveRelease: releaseNumberOrNull(root.liveRelease),
    runtime: resolveGatewayRuntime(glmData?.runtime),
    gatewayClass: resolveGatewayClass(profileInput),
    imageProfile: resolveGatewayImageProfile(profileInput),
    profile: orNull(root.profile),
    sizingTier: orNull(root.sizingTier),
    ownerUid: orNull(root.ownerUid),
    builderSlug: orNull(root.builderSlug),
    gcpProject: orNull(root.gcpProject),
    serviceAccountName: orNull(root.serviceAccountName),
    builderAccess: orNull(root.builderAccess as Record<string, unknown> | null | undefined),
    modelBrokerLimits: orNull(root.modelBrokerLimits as Record<string, unknown> | null | undefined),
    vm: recordOrNull(glmData?.vm) as GatewayVmState | null,
  };
}

function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function releaseNumberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

interface DrawerMountedCustomer {
  uid: string;
  slug: string;
  username: string;
  email: string;
  lastActive: string | null;
}

interface DrawerOperation {
  id: string;
  kind: string;
  status: string;
  createdBy: string;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  input: Record<string, unknown>;
  steps: unknown[];
  error?: string;
  rolledBack?: boolean;
}

interface NewOperationInput {
  kind:
    | "add-gateway"
    | typeof OP_KIND_MIGRATE_CUSTOMER
    | "retire-gateway"
    | "restart-gateway"
    | "rollout"
    | "deprovision-customer"
    | "suspend-customer"
    | "erase-customer";
  createdBy: string;
  origin?: "automatic" | "operator";
  input: Record<string, unknown>;
}

interface AddGatewayBody {
  gatewayId: string;
  imageRepository: string;
  imageTag: string;
  profile: string;
  gatewayClass: string;
  imageProfile: string;
  sizingTier: string;
  ownerUid: string;
  builderSlug: string;
}

interface AddGatewayCreate {
  gatewayId: string;
  imageRepository: string;
  imageTag: string;
  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  sizingTier?: SizingTier;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function coerceNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toMillis(v: unknown): number | null {
  if (v == null) return null;
  const t = v as { toDate?: () => Date };
  if (typeof t?.toDate === "function") return t.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return null;
}

function toIso(v: unknown): string | null {
  const ms = toMillis(v);
  return ms == null ? null : new Date(ms).toISOString();
}

function ageMsOrNull(ms: number | null, now: number): number | null {
  return ms == null ? null : now - ms;
}

function isValidGatewayImageRepository(repo: string): boolean {
  return GATEWAY_IMAGE_REPO_PREFIXES.some((prefix) => repo.startsWith(prefix));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

interface RolloutBodyError {
  status: number;
  body: Record<string, unknown>;
}

// A PATCH may move a gateway between running/paused/draining, but NOT to
// "retired": that must run full teardown via DELETE (which creates the
// retire-gateway op). A bare PATCH to "retired" only flips desired state, and
// the reconciler would then remove the pod while stranding the PVC, both
// auth-token secrets, the GSA, and the Firestore records.
export function validateDesiredStatusPatch(
  desiredStatus: string,
):
  | { error: { status: number; body: { error: string; got?: string } } }
  | { ok: "running" | "paused" | "draining" } {
  if (desiredStatus === "retired") {
    return {
      error: {
        status: 400,
        body: {
          error:
            "retire a gateway via DELETE /gateways/:id (full teardown), not PATCH desiredStatus=retired",
        },
      },
    };
  }
  if (
    desiredStatus !== "running" &&
    desiredStatus !== "paused" &&
    desiredStatus !== "draining"
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: "desiredStatus must be one of: running, paused, draining",
          got: desiredStatus,
        },
      },
    };
  }
  return { ok: desiredStatus };
}

export function validateDeployBody(
  body: unknown,
): { error: RolloutBodyError } | { ok: { sourceSha: string } } {
  if (
    !isPlainRecord(body) ||
    Object.keys(body).length !== 1 ||
    !releaseSourceShaFromBody(body.sourceSha)
  ) {
    return {
      error: {
        status: 400,
        body: { error: "deploy requires one exact full lowercase sourceSha" },
      },
    };
  }
  return { ok: { sourceSha: body.sourceSha as string } };
}

function validateAddGatewayRequiredFields(
  body: Partial<AddGatewayBody>,
): { error: RolloutBodyError } | {
  ok: Pick<
    AddGatewayCreate,
    "gatewayId" | "imageRepository" | "imageTag"
  >;
} {
  if (
    !isNonEmptyString(body.gatewayId) ||
    !isNonEmptyString(body.imageRepository) ||
    !isNonEmptyString(body.imageTag)
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: "missing required fields",
          required: ["gatewayId", "imageRepository", "imageTag"],
        },
      },
    };
  }
  if (!isValidNewGatewayId(body.gatewayId)) {
    return {
      error: {
        status: 400,
        body: {
          error: NEW_GATEWAY_ID_REQUIREMENT,
          got: body.gatewayId,
        },
      },
    };
  }
  return {
    ok: {
      gatewayId: body.gatewayId,
      imageRepository: body.imageRepository,
      imageTag: body.imageTag,
    },
  };
}

function validateAddGatewayProfile(
  body: Partial<AddGatewayBody>,
): {
  error: RolloutBodyError;
} | {
  ok: {
    profile?: GatewayProfile;
    gatewayClass?: GatewayClass;
    imageProfile?: GatewayImageProfile;
  };
} {
  if (body.profile !== undefined && !isGatewayProfile(body.profile)) {
    return {
      error: {
        status: 400,
        body: {
          error: `profile must be one of: ${GATEWAY_PROFILES.join(", ")}`,
          got: body.profile,
        },
      },
    };
  }
  if (body.gatewayClass !== undefined && !isGatewayClass(body.gatewayClass)) {
    return {
      error: {
        status: 400,
        body: {
          error: `gatewayClass must be one of: ${GATEWAY_CLASSES.join(", ")}`,
          got: body.gatewayClass,
        },
      },
    };
  }
  if (body.imageProfile !== undefined && !isGatewayProfile(body.imageProfile)) {
    return {
      error: {
        status: 400,
        body: {
          error: `imageProfile must be one of: ${GATEWAY_IMAGE_PROFILES.join(", ")}`,
          got: body.imageProfile,
        },
      },
    };
  }
  return {
    ok: {
      ...(body.profile ? { profile: body.profile as GatewayProfile } : {}),
      ...(body.gatewayClass ? { gatewayClass: body.gatewayClass as GatewayClass } : {}),
      ...(body.imageProfile ? { imageProfile: body.imageProfile as GatewayImageProfile } : {}),
    },
  };
}

function validateAddGatewaySizing(
  body: Partial<AddGatewayBody>,
): { error: RolloutBodyError } | { ok: { sizingTier?: SizingTier } } {
  if (
    body.sizingTier !== undefined &&
    !(SIZING_TIERS as readonly string[]).includes(body.sizingTier)
  ) {
    return {
      error: {
        status: 400,
        body: {
          error: `sizingTier must be one of: ${SIZING_TIERS.join(", ")}`,
          got: body.sizingTier,
        },
      },
    };
  }
  return {
    ok: body.sizingTier ? { sizingTier: body.sizingTier as SizingTier } : {},
  };
}

function validateSharedGatewayCreate(
  body: Partial<AddGatewayBody>,
  gatewayClass: GatewayClass,
): RolloutBodyError | null {
  if (gatewayClass !== "shared") {
    return {
      status: 400,
      body: {
        error: "Builder gateways are created by the disposable lifecycle",
      },
    };
  }
  if (body.ownerUid !== undefined || body.builderSlug !== undefined) {
    return {
      status: 400,
      body: { error: "shared gateway creation does not accept owner fields" },
    };
  }
  return null;
}

function validateAddGatewayBody(
  body: Partial<AddGatewayBody>,
): { error: RolloutBodyError } | { ok: AddGatewayCreate } {
  const required = validateAddGatewayRequiredFields(body);
  if ("error" in required) return required;
  const profile = validateAddGatewayProfile(body);
  if ("error" in profile) return profile;
  const gatewayClass = resolveGatewayClass(profile.ok);
  const sizing = validateAddGatewaySizing(body);
  if ("error" in sizing) return sizing;
  const ownershipError = validateSharedGatewayCreate(
    body,
    gatewayClass,
  );
  if (ownershipError) return { error: ownershipError };
  const artifactError = validateArtifact(required.ok);
  if (artifactError) return { error: artifactError };
  return {
    ok: {
      ...required.ok,
      ...profile.ok,
      gatewayClass,
      imageProfile: resolveGatewayImageProfile(profile.ok),
      ...sizing.ok,
    },
  };
}

function readUserGatewayId(
  data: Record<string, unknown> | undefined,
): string | null {
  const provisioning =
    (data?.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  return asStringOrNull(openclaw.gatewayId);
}

function resolveCustomerSlug(userData: Record<string, unknown>): string | null {
  return asStringOrNull(readUserOpenclaw(userData).slug) ?? asStringOrNull(userData.username);
}

interface PendingPlacement {
  uid: string;
  username: string;
  email: string;
  currentGatewayId: string | null;
  reason: "never-assigned" | "gateway-gone";
}

interface UserPlacement {
  kind: "unassigned" | "orphan" | "assigned-not-mounted" | "mounted";
  gid: string | null;
  pending: PendingPlacement | null;
}

function classifyUserPlacement(
  uid: string,
  data: Record<string, unknown>,
  gateways: Map<string, { mountedCustomers: Set<string> }>,
): UserPlacement {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  const slug = userSlug(data) || null;
  const gid =
    typeof openclaw.gatewayId === "string" ? openclaw.gatewayId : null;
  const username = typeof data.username === "string" ? data.username : "";
  const email = typeof data.email === "string" ? data.email : "";

  if (!gid) {
    return {
      kind: "unassigned",
      gid: null,
      pending: {
        uid,
        username,
        email,
        currentGatewayId: null,
        reason: "never-assigned",
      },
    };
  }
  const gw = gateways.get(gid);
  if (!gw) {
    return {
      kind: "orphan",
      gid,
      pending: {
        uid,
        username,
        email,
        currentGatewayId: gid,
        reason: "gateway-gone",
      },
    };
  }
  return {
    kind: slug && gw.mountedCustomers.has(slug) ? "mounted" : "assigned-not-mounted",
    gid,
    pending: null,
  };
}

function readMountedSlugs(
  hbData: Record<string, unknown> | undefined,
): Set<string> {
  if (!Array.isArray(hbData?.mountedCustomers)) return new Set();
  return new Set(
    (hbData.mountedCustomers as unknown[]).filter(
      (s): s is string => typeof s === "string",
    ),
  );
}

function buildMountedCustomer(
  uid: string,
  data: Record<string, unknown>,
  slug: string,
): DrawerMountedCustomer {
  return {
    uid,
    slug,
    username: typeof data.username === "string" ? data.username : "",
    email: typeof data.email === "string" ? data.email : "",
    lastActive: toIso(data.lastActive),
  };
}

function userSlug(data: Record<string, unknown>): string {
  const provisioning =
    (data.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  if (typeof openclaw.slug === "string") return openclaw.slug;
  return typeof data.username === "string" ? data.username : "";
}

function shapeDrawerOperation(
  id: string,
  data: Record<string, unknown>,
): DrawerOperation {
  const kind =
    typeof data.kind === "string" && OP_KINDS.has(data.kind)
      ? data.kind
      : "unknown";
  const status =
    typeof data.status === "string" && OP_STATUSES.has(data.status)
      ? data.status
      : "unknown";
  const out: DrawerOperation = {
    id,
    kind,
    status,
    createdBy:
      typeof data.createdBy === "string" ? data.createdBy : "unknown",
    createdAt: coerceNumberOrNull(data.createdAt),
    startedAt: coerceNumberOrNull(data.startedAt),
    completedAt: coerceNumberOrNull(data.completedAt),
    input:
      typeof data.input === "object" && data.input !== null
        ? (data.input as Record<string, unknown>)
        : {},
    steps: Array.isArray(data.steps) ? data.steps : [],
  };
  if (typeof data.error === "string") out.error = data.error;
  if (typeof data.rolledBack === "boolean") out.rolledBack = data.rolledBack;
  return out;
}

function shapeInvalidOperationAuditHistoryRecord(
  id: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    recordType: "audit",
    invalid: true,
    schemaVersion: typeof data.schemaVersion === "number" ? data.schemaVersion : null,
    status: "invalid",
    lifecycleStage: "invalid",
    createdAt: typeof data.createdAt === "number" && Number.isFinite(data.createdAt)
      ? data.createdAt
      : 0,
    completedAt: null,
    error: "Unsupported or malformed operation audit record",
  };
}

function shapeAuditHistoryPreCreatedAtFields(
  data: OperationAuditDocument,
): Record<string, unknown> {
  return {
    ...(data.aliasOutcomes ? { aliasOutcomes: data.aliasOutcomes } : {}),
    ...(data.releaseRollout ? { releaseRollout: data.releaseRollout } : {}),
    ...(data.testProvenance ? { testProvenance: data.testProvenance } : {}),
    ...(data.outcome ? { outcome: data.outcome } : {}),
    ...(data.partialOutcome ? { partialOutcome: data.partialOutcome } : {}),
  };
}

function shapeAuditHistoryActionFields(
  data: OperationAuditDocument,
): Record<string, unknown> {
  return {
    ...(data.actionClaimId ? { actionClaimId: data.actionClaimId } : {}),
    ...(data.actionStartedAt !== undefined ? { actionStartedAt: data.actionStartedAt } : {}),
    ...(data.actionRecoveryCount !== undefined
      ? { actionRecoveryCount: data.actionRecoveryCount }
      : {}),
  };
}

function shapeAuditHistoryErrorField(
  data: OperationAuditDocument,
): Record<string, unknown> {
  return {
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
}

function shapeValidOperationAuditHistoryRecord(
  id: string,
  data: OperationAuditDocument,
): Record<string, unknown> {
  return {
    id,
    recordType: data.recordType,
    schemaVersion: data.schemaVersion,
    status: data.status,
    lifecycleStage: data.lifecycleStage,
    idempotencyKey: data.idempotencyKey,
    mutationFingerprint: data.mutationFingerprint,
    mutation: data.mutation,
    actor: data.actor,
    forced: data.forced,
    what: data.what,
    why: data.why,
    target: data.target,
    preActionStatus: data.preActionStatus,
    aliasPlan: data.aliasPlan,
    ...shapeAuditHistoryPreCreatedAtFields(data),
    createdAt: data.createdAt,
    ...shapeAuditHistoryActionFields(data),
    completedAt: data.completedAt,
    ...shapeAuditHistoryErrorField(data),
  };
}

function attachHandoffProgress(
  gateways: Array<{ gateway: string; handoffProgress?: Record<string, MigrationProgressRecord[]> }>,
  byGateway: ReadonlyMap<string, Record<string, MigrationProgressRecord[]>>,
): void {
  for (const gateway of gateways) {
    gateway.handoffProgress = byGateway.get(gateway.gateway) ?? {};
  }
}

export function projectHandoffProgress(
  assignments: readonly AssignmentDoc[],
): Map<string, Record<string, MigrationProgressRecord[]>> {
  const byGateway = new Map<string, Record<string, MigrationProgressRecord[]>>();
  for (const assignment of assignments) {
    const progress = assignment.handoffProgress;
    if (!progress || progress.length === 0) continue;
    const newest = [...progress].sort((a, b) => b.at - a.at)[0];
    if (assignment.state === "serving" && newest.status !== "failed") continue;
    const slugs = byGateway.get(assignment.gatewayId) ?? {};
    slugs[assignment.slug] = progress;
    byGateway.set(assignment.gatewayId, slugs);
  }
  return byGateway;
}

function isUnresolvedMigrationFailure(data: Record<string, unknown>): boolean {
  return data.kind === OP_KIND_MIGRATE_CUSTOMER && (data.status === "failed" || data.status === "rolled-back");
}

async function listUnresolvedOperationDocs(
  store: PlatformStateStore,
  limit: number,
): Promise<FirestoreDocLike[]> {
  const [inFlight, assignments] = await Promise.all([
    store.journal.operations.listByStatus(["pending", "running"]),
    store.gateways.assignments.listAll(),
  ]);
  const inFlightIds = new Set(inFlight.map((operation) => operation.id));
  const pointed = new Set<string>();
  for (const assignment of assignments) {
    const operationId = asStringOrNull(assignment.updatedByOperationId);
    if (operationId && !inFlightIds.has(operationId)) pointed.add(operationId);
  }
  const pointedOperations = await store.journal.operations.getMany([...pointed]);
  const pointedFailures = [...pointedOperations.values()].filter((operation) =>
    isUnresolvedMigrationFailure({ ...operation }));
  const createdAt = (operation: OperationRecord): number => coerceNumberOrNull(operation.createdAt) ?? 0;
  const newestFirst = (operations: OperationRecord[]): OperationRecord[] =>
    operations.sort((a, b) => createdAt(b) - createdAt(a));
  const inFlightCapped = newestFirst([...inFlight]).slice(0, limit);
  return operationDocs(newestFirst([...pointedFailures, ...inFlightCapped]));
}

export function shapeOperationsHistoryRecord(
  id: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (isOperationAuditRow(data) && !isOperationAuditRecord(data)) {
    return shapeInvalidOperationAuditHistoryRecord(id, data);
  }
  if (isOperationAuditRecord(data)) {
    return shapeValidOperationAuditHistoryRecord(id, data);
  }
  return { id, ...data };
}

async function projectGatewaySummaryWithDiagnostics(
  deps: FleetRouterDeps,
  doc: FirestoreDocLike,
  glmDoc: GlmDoc | undefined,
  now: number,
): Promise<ReturnType<typeof projectGatewaySummary> & {
  podDiagnostics: GatewayPodDiagnostics | null;
}> {
  const summary = projectGatewaySummary(doc, glmDoc, now);
  if (!deps.readGatewayPodDiagnostics) {
    return { ...summary, podDiagnostics: null };
  }
  try {
    const podDiagnostics = await deps.readGatewayPodDiagnostics(summary.gatewayId);
    return {
      ...repriceGatewaySummaryFromKubernetes(summary, podDiagnostics),
      podDiagnostics,
    };
  } catch (e) {
    deps.logger.warn("gateway pod diagnostics failed", {
      gatewayId: summary.gatewayId,
      error: (e as Error)?.message ?? String(e),
    });
    return {
      ...summary,
      podDiagnostics: {
        status: "unknown",
        totalPods: 0,
        readyPods: 0,
        totalRestarts: 0,
        spotPods: 0,
        onDemandPods: 0,
        unknownCapacityPods: 0,
        pods: [],
        error: (e as Error)?.message ?? "pod diagnostics failed",
      },
    };
  }
}

function unknownGatewayPodDiagnostics(error: string): GatewayPodDiagnostics {
  return {
    status: "unknown",
    totalPods: 0,
    readyPods: 0,
    totalRestarts: 0,
    spotPods: 0,
    onDemandPods: 0,
    unknownCapacityPods: 0,
    pods: [],
    error,
  };
}

function observedGatewayCapacityType(
  diagnostics: GatewayPodDiagnostics,
): GatewayPodCapacityType | undefined {
  if (diagnostics.onDemandPods > 0) return "on-demand";
  if (diagnostics.spotPods > 0) return "spot";
  return undefined;
}

function repriceGatewaySummaryFromKubernetes<T extends ReturnType<typeof projectGatewaySummary>>(
  summary: T,
  diagnostics: GatewayPodDiagnostics,
): T {
  const reservation = projectGatewayReservation(
    { gatewayClass: summary.gatewayClass },
    observedGatewayCapacityType(diagnostics),
  );
  const cost = summary.desiredStatus === "paused"
    ? {
        computeUsd: 0,
        onDemandComputeUsd: 0,
        savingsUsd: 0,
        pricingMode: reservation.type,
        perBuilderAtTarget: 0,
        perBuilderAtTypical: 0,
      }
    : estimateGatewayMonthlyCost(summary.sizing.tier, {
        pricingMode: reservation.type,
      });
  return {
    ...summary,
    reservation,
    sizing: {
      ...summary.sizing,
      monthlyCostUsd: {
        compute: cost.computeUsd,
        onDemandCompute: cost.onDemandComputeUsd,
        savings: cost.savingsUsd,
        pricingMode: cost.pricingMode,
        perBuilderAtTarget: cost.perBuilderAtTarget,
        perBuilderAtTypical: cost.perBuilderAtTypical,
      },
    },
  };
}

async function projectGatewaySummariesWithDiagnostics(
  deps: FleetRouterDeps,
  summaries: Array<ReturnType<typeof projectGatewaySummary>>,
  readBatch: NonNullable<FleetRouterDeps["readGatewayPodDiagnosticsBatch"]>,
): Promise<Array<ReturnType<typeof projectGatewaySummary> & {
  podDiagnostics: GatewayPodDiagnostics | null;
}>> {
  try {
    const diagnostics = await readBatch(
      summaries.map((summary) => summary.gatewayId),
    );
    return summaries.map((summary) => {
      const podDiagnostics = diagnostics[summary.gatewayId] ??
        unknownGatewayPodDiagnostics("gateway missing from batched pod diagnostics");
      return {
        ...repriceGatewaySummaryFromKubernetes(summary, podDiagnostics),
        podDiagnostics,
      };
    });
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    deps.logger.warn("gateway pod diagnostics batch failed", { error: message });
    return summaries.map((summary) => ({
      ...summary,
      podDiagnostics: unknownGatewayPodDiagnostics(message),
    }));
  }
}

function operationGatewayId(input: Record<string, unknown>): string | null {
  for (const field of ["gatewayId", "toGatewayId", "fromGatewayId"]) {
    const value = input[field];
    if (typeof value === "string") return value;
  }
  return null;
}

async function createOperation(
  store: PlatformStateStore,
  opts: NewOperationInput,
): Promise<string> {
  return store.transaction({ label: "admin.fleet.createOperation" }, (transaction) =>
    transaction.journal.operations.enqueue(operationDoc(opts, Date.now())));
}

function operationDoc(
  opts: NewOperationInput,
  createdAt: number,
): NewOperation {
  const gatewayId = operationGatewayId(opts.input);
  const inputUid =
    typeof opts.input.uid === "string" ? opts.input.uid : null;
  return {
    kind: opts.kind,
    status: "pending",
    createdBy: opts.createdBy,
    ...(opts.origin ? { origin: opts.origin } : {}),
    createdAt,
    startedAt: null,
    completedAt: null,
    input: opts.input,
    steps: [],
    ...(gatewayId !== null ? { gatewayId } : {}),
    ...(inputUid !== null ? { inputUid } : {}),
  };
}

async function readGatewayDoc(
  store: PlatformStateStore,
  gatewayId: string,
): Promise<DurableGatewayRoot | null> {
  return durableRootOf(await store.gateways.roots.get(gatewayId), gatewayId);
}

function releaseSourceShaFromBody(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : null;
}

function artifactFromRelease(release: ReleaseDoc): GatewayArtifact | null {
  if (!isReleasePayload(release.payload)) return null;
  return gatewayArtifactFromReleasePayload(release.payload);
}

function sameArtifact(left: GatewayArtifact, right: GatewayArtifact): boolean {
  return (
    left.imageRepository === right.imageRepository &&
    left.imageTag === right.imageTag
  );
}

function respondReleaseWriteConflict(res: Response, error: unknown): boolean {
  if (error instanceof GatewayRetirementConflictError) {
    res.status(409).json({ error: error.message });
    return true;
  }
  if (error instanceof GatewayMigrationInFlightError) {
    res.status(409).json({
      error: error.message,
      gatewayId: error.gatewayId,
      operationId: error.operationId,
      kind: OP_KIND_MIGRATE_CUSTOMER,
    });
    return true;
  }
  if (error instanceof InvalidGatewayRootError) {
    res.status(409).json({ error: error.message, gatewayId: error.gatewayId });
    return true;
  }
  if (error instanceof StaleGatewayReleaseError) {
    res.status(409).json({
      error: error.message,
      gatewayId: error.gatewayId,
      expectedRelease: error.expectedRelease,
      actualRelease: error.actualRelease,
    });
    return true;
  }
  return false;
}

class CentralReleaseRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : "CENTRAL release request failed");
  }
}

function rejectCentralReleaseRequest(status: number, body: Record<string, unknown>): never {
  throw new CentralReleaseRequestError(status, body);
}

async function centralManifestForSourceSha(
  authority: CentralReleaseAuthority,
  sourceSha: string,
): Promise<ReleaseDigestManifest> {
  const manifest = await authority.resolveManifest(sourceSha);
  if (manifest.sourceSha !== sourceSha) {
    rejectCentralReleaseRequest(409, {
      error: "release manifest sourceSha does not match the requested SHA",
    });
  }
  return manifest;
}

function respondCentralReleaseError(res: Response, error: unknown): boolean {
  if (error instanceof CentralReleaseRequestError) {
    res.status(error.status).json(error.body);
    return true;
  }
  return respondReleaseWriteConflict(res, error);
}

const GATEWAY_MUTABLE_CONFIG_FIELDS = [
  "profile",
  "gatewayClass",
  "imageProfile",
  "sizingTier",
  "gcpProject",
  "gatewayContainerSecurityContext",
  "serviceAccountName",
  "serviceAccount",
  "builderAccess",
  "ownerUid",
  "builderSlug",
  "modelBrokerLimits",
] as const satisfies ReadonlyArray<keyof Omit<GatewayMutableConfig, "configSchemaVersion">>;

function mutableConfigPatchFromBody(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of GATEWAY_MUTABLE_CONFIG_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) patch[field] = body[field];
  }
  return patch;
}

function validateArtifact(artifact: GatewayArtifact): RolloutBodyError | null {
  if (!isValidGatewayImageRepository(artifact.imageRepository)) {
    return {
      status: 400,
      body: {
        error: "imageRepository must be the canonical Octogee Artifact Registry repo",
        expectedPrefixes: GATEWAY_IMAGE_REPO_PREFIXES,
        got: artifact.imageRepository,
      },
    };
  }
  if (!IMAGE_TAG_PATTERN.test(artifact.imageTag)) {
    return {
      status: 400,
      body: {
        error:
          "imageTag must be a lowercase hex SHA (7–40 chars) or pinned bundle (e.g. abc1234-oc2026.5.2)",
        got: artifact.imageTag,
      },
    };
  }
  return null;
}

function buildCreateGatewayConfig(args: {
  body: AddGatewayCreate;
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
}): GatewayMutableConfig {
  return {
    configSchemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
    profile: args.body.profile ?? null,
    gatewayClass: args.gatewayClass,
    imageProfile: args.imageProfile,
    sizingTier: args.body.sizingTier ?? null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
  };
}

function buildCreateArtifact(body: AddGatewayCreate): GatewayArtifact {
  return {
    imageRepository: body.imageRepository,
    imageTag: body.imageTag,
  };
}

function buildDurableGatewayPatch(args: {
  gatewayId: string;
  current: GatewayMutableConfig;
  body: Record<string, unknown>;
}):
  | { error: RolloutBodyError }
  | { ok: { patch: Record<string, unknown>; config: GatewayMutableConfig } } {
  const artifactFields = ["imageRepository", "imageTag"].filter((field) =>
    Object.prototype.hasOwnProperty.call(args.body, field),
  );
  if (artifactFields.length > 0) {
    return {
      error: {
        status: 409,
        body: {
          error: "image artifacts deploy from immutable releases; use POST /api/admin/gateways/:id/deploy",
          fields: artifactFields,
        },
      },
    };
  }
  if (Object.prototype.hasOwnProperty.call(args.body, "byosub")) {
    return {
      error: {
        status: 400,
        body: { error: "gateway credential references are user-scoped and cannot be patched here" },
      },
    };
  }
  const lifecycleOwnedFields = ["gatewayClass", "ownerUid", "builderSlug"].filter((field) =>
    Object.prototype.hasOwnProperty.call(args.body, field),
  );
  if (lifecycleOwnedFields.length > 0) {
    return {
      error: {
        status: 400,
        body: {
          error: "gateway ownership is managed by the disposable lifecycle",
          fields: lifecycleOwnedFields,
        },
      },
    };
  }
  if (args.current.gatewayClass === "builder" && args.body.sizingTier === "xs") {
    return { error: { status: 400, body: { error: "Builder sizingTier must be s, m, or l" } } };
  }
  const configPatch = mutableConfigPatchFromBody(args.body);
  const patch: Record<string, unknown> = { ...configPatch };
  if (args.body.desiredStatus !== undefined) {
    if (typeof args.body.desiredStatus !== "string") {
      return { error: { status: 400, body: { error: "desiredStatus must be a string" } } };
    }
    const desired = validateDesiredStatusPatch(args.body.desiredStatus);
    if ("error" in desired) return { error: desired.error };
    if (desired.ok === "draining") {
      return {
        error: {
          status: 400,
          body: { error: "durable gateway desiredStatus must be running or paused" },
        },
      };
    }
    patch.desiredStatus = desired.ok;
  }
  if (Object.keys(patch).length === 0) {
    return { error: { status: 400, body: { error: "no updatable fields provided" } } };
  }
  const config = { ...args.current, ...configPatch } as GatewayMutableConfig;
  if (!isGatewayMutableConfigForGateway(config, args.gatewayId)) {
    return {
      error: {
        status: 400,
        body: { error: "invalid durable gateway configuration", gatewayId: args.gatewayId },
      },
    };
  }
  return { ok: { patch, config } };
}

async function findConflictingGatewayOp(
  store: PlatformStateStore,
  gatewayId: string,
): Promise<{ id: string; kind: string | null } | null> {
  const pendingOps = await store.journal.operations.listByStatus(["pending", "running"]);
  const conflicting = pendingOps.find((operation) => operation.input.gatewayId === gatewayId);
  return conflicting ? { id: conflicting.id, kind: conflicting.kind } : null;
}

type RollbackReleaseResolution =
  | { error: RolloutBodyError }
  | {
      ok: {
        gateway: DurableGatewayRoot;
        target: ReleaseDoc;
        artifact: GatewayArtifact;
        release: number;
        note: string;
      };
    };

async function resolveRollbackRelease(args: {
  store: PlatformStateStore;
  gatewayId: string;
  requestedRelease: string | string[] | undefined;
  body: Record<string, unknown>;
}): Promise<RollbackReleaseResolution> {
  const release = Number(args.requestedRelease);
  if (
    typeof args.requestedRelease !== "string" ||
    !Number.isInteger(release) ||
    release < 1
  ) {
    return {
      error: {
        status: 400,
        body: { error: "release must be a positive integer", got: args.requestedRelease },
      },
    };
  }
  const gateway = await readGatewayDoc(args.store, args.gatewayId);
  if (!gateway) {
    return {
      error: {
        status: 404,
        body: { error: ERR_GATEWAY_NOT_FOUND, gatewayId: args.gatewayId },
      },
    };
  }
  if (gateway.desiredStatus === "retired") {
    return {
      error: {
        status: 409,
        body: {
          error: "cannot cut a release for a retired gateway",
          gatewayId: args.gatewayId,
        },
      },
    };
  }
  if (gateway.gatewayClass === "shared") {
    return {
      error: {
        status: 409,
        body: { error: ERR_SHARED_POOL_RIDES_PLATFORM_RELEASE, gatewayId: args.gatewayId },
      },
    };
  }
  const target = await args.store.gateways.releases.get(args.gatewayId, release);
  if (!target) {
    return {
      error: {
        status: 404,
        body: { error: "release not found", gatewayId: args.gatewayId, release },
      },
    };
  }
  const previous = await args.store.gateways.releases.get(args.gatewayId, gateway.latestRelease);
  if (!previous) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway has no current release artifact",
          gatewayId: args.gatewayId,
          latestRelease: gateway.latestRelease,
        },
      },
    };
  }
  const artifact = artifactFromRelease(target);
  const previousArtifact = artifactFromRelease(previous);
  if (!artifact || !previousArtifact) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway release artifact is malformed",
          gatewayId: args.gatewayId,
        },
      },
    };
  }
  if (sameArtifact(artifact, previousArtifact)) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway is already on release artifact — no-op rollback",
          gatewayId: args.gatewayId,
          release: gateway.latestRelease,
        },
      },
    };
  }
  const conflicting = await findConflictingGatewayOp(args.store, args.gatewayId);
  if (conflicting) {
    return {
      error: {
        status: 409,
        body: {
          error: ERR_GATEWAY_OPERATION_IN_FLIGHT,
          gatewayId: args.gatewayId,
          operationId: conflicting.id,
          kind: conflicting.kind,
        },
      },
    };
  }
  return {
    ok: {
      gateway,
      target,
      artifact,
      release,
      note:
        typeof args.body.note === "string"
          ? args.body.note
          : `rollback to release ${release}`,
    },
  };
}

async function ensureGatewayCreateIsUnique(
  store: PlatformStateStore,
  body: Pick<AddGatewayCreate, "gatewayId">,
): Promise<{ error: RolloutBodyError } | { ok: true }> {
  const [runtime, durable] = await Promise.all([
    store.fleetRegistry.get(body.gatewayId),
    store.gateways.roots.get(body.gatewayId),
  ]);
  if (runtime !== null || durable !== null) {
    return {
      error: {
        status: 409,
        body: {
          error: "gateway already exists",
          gatewayId: body.gatewayId,
        },
      },
    };
  }

  return { ok: true };
}

async function accelerateScheduledCustomerErasure(opts: {
  store: PlatformStateStore;
  uid: string;
}): Promise<
  | { status: 202; body: Record<string, unknown> }
  | { status: 409; body: Record<string, unknown> }
> {
  return opts.store.transaction({ label: "admin.fleet.accelerateCustomerErasure" }, async (transaction) => {
    const lifecycle = (await transaction.builders.records.get(opts.uid))?.accountLifecycle ?? null;
    const deletionId = asStringOrNull(lifecycle?.deletionId);
    if (!lifecycle || !deletionId) {
      return {
        status: 409 as const,
        body: { error: "Scheduled deletion is missing its deletion id" },
      };
    }
    const deletion = await transaction.jobs.deletions.get(deletionId);
    const erasureOperationId = asStringOrNull(deletion?.erasureOperationId);
    if (!erasureOperationId) {
      return {
        status: 409 as const,
        body: {
          error: "Scheduled deletion is missing its durable erasure operation",
          deletionId,
        },
      };
    }
    const erasure = await transaction.journal.operations.get(erasureOperationId);
    const runnable = erasure?.kind === "erase-customer" &&
      (erasure.status === "pending" || erasure.status === "running");
    if (!runnable) {
      return {
        status: 409 as const,
        body: {
          error: "Scheduled erasure operation is not runnable",
          deletionId,
          erasureOperationId,
        },
      };
    }
    const now = Date.now();
    await transaction.builders.records.patch(opts.uid, { accountLifecycle: { ...lifecycle, eraseAfter: now } });
    await transaction.jobs.deletions.patch(deletionId, { eraseAfter: now, updatedAt: now });
    await transaction.journal.operations.patch(erasureOperationId, { nextAttemptAt: now });
    return {
      status: 202 as const,
      body: {
        status: "erasure_requested",
        deletionId,
        erasureOperationId,
        eraseAfter: now,
      },
    };
  });
}

type CustomerDeletionAdmission =
  | { kind: "not-found" }
  | { kind: "conflict"; runtimeFenced: boolean; deletionId: string | null; operationId: string | null }
  | {
      kind: "created";
      deletionId: string;
      suspensionOperationId: string;
      erasureOperationId: string;
      eraseAfter: number;
      slug: string | null;
    };

type CustomerDeletionActionOutcome =
  | CustomerDeletionAdmission
  | {
      kind: "partial";
      failedStep: "suspend-auth" | "revoke-connector-grants";
      claimed: Extract<CustomerDeletionAdmission, { kind: "created" }>;
      error: Error;
    };

function isCustomerDeletionConflict(operation: OperationRecord): boolean {
  return (operation.kind === "suspend-customer" || operation.kind === "erase-customer") &&
    (operation.status === "pending" || operation.status === "running");
}

async function customerDeletionConflict(
  transaction: PlatformStateTransaction,
  builder: Stored<BuilderRecord>,
): Promise<CustomerDeletionAdmission | null> {
  if (builderRuntimeMutationFenced(builder)) {
    return { kind: "conflict", runtimeFenced: true, deletionId: null, operationId: null };
  }
  const lifecycle = builder.accountLifecycle;
  if (lifecycle?.status === "deletion_scheduled" || lifecycle?.status === "erasing") {
    return {
      kind: "conflict",
      runtimeFenced: false,
      deletionId: asStringOrNull(lifecycle.deletionId),
      operationId: null,
    };
  }
  const inFlight = await inFlightOperationsForUid(transaction, builder.uid);
  const forwardMigration = inFlight.find((operation) =>
    operation.kind === OP_KIND_MIGRATE_CUSTOMER && migrationCancellationDeferred({ ...operation }, operation.id));
  if (forwardMigration) {
    return { kind: "conflict", runtimeFenced: true, deletionId: null, operationId: forwardMigration.id };
  }
  const conflict = inFlight.find(isCustomerDeletionConflict);
  return conflict
    ? { kind: "conflict", runtimeFenced: false, deletionId: null, operationId: conflict.id }
    : null;
}

async function claimCustomerDeletion(opts: {
  store: PlatformStateStore;
  accounts: BuilderAccountReader;
  uid: string;
  requestedBy: string;
  eraseNow: boolean;
}): Promise<CustomerDeletionAdmission> {
  const account = await opts.accounts.get(opts.uid);
  const deletionId = randomUUID();
  const suspensionOperationId = randomUUID();
  const erasureOperationId = randomUUID();
  return opts.store.transaction({ label: "admin.fleet.claimCustomerDeletion" }, async (transaction): Promise<CustomerDeletionAdmission> => {
    const builder = await transaction.builders.records.get(opts.uid);
    if (!builder) return { kind: "not-found" };
    const conflict = await customerDeletionConflict(transaction, builder);
    if (conflict) return conflict;
    const now = Date.now();
    const schedule = buildCustomerDeletionSchedule({ now, eraseNow: opts.eraseNow });
    const currentGatewayId = builder.gateway?.gatewayId ?? null;
    const plan = buildCustomerDeletionPlan({
      uid: opts.uid,
      slug: builder.slug,
      currentGatewayId,
      requestedBy: opts.requestedBy,
      requestedAt: schedule.requestedAt,
      eraseAfter: schedule.eraseAfter,
      deletionId,
      suspensionOperationId,
      erasureOperationId,
      stripeCustomerIds: [...(account?.stripeCustomerIds ?? [])],
      stripeSubscriptionIds: [...(account?.stripeSubscriptionIds ?? [])],
    });
    if (currentGatewayId) {
      await transaction.gateways.assignments.delete(currentGatewayId, opts.uid);
      await transaction.builders.records.setGatewayMirror(opts.uid, { clear: true });
    }
    await transaction.builders.records.patch(opts.uid, { accountLifecycle: plan.lifecycle });
    await transaction.jobs.deletions.create(plan.job);
    await transaction.journal.operations.create(plan.suspensionOperation);
    await transaction.journal.operations.create(plan.erasureOperation);
    return {
      kind: "created",
      deletionId,
      suspensionOperationId,
      erasureOperationId,
      eraseAfter: schedule.eraseAfter,
      slug: builder.slug,
    };
  });
}

function classifyErasureAcceleration(
  result: Awaited<ReturnType<typeof accelerateScheduledCustomerErasure>>,
): NormalFleetMutationResult {
  if (result.status < 400) return { outcome: "completed" };
  return {
    outcome: "failed",
    error: typeof result.body.error === "string"
      ? result.body.error
      : `customer erasure acceleration returned ${result.status}`,
  };
}

function eraseNowValueIsInvalid(value: unknown): boolean {
  return value !== undefined && typeof value !== "boolean";
}

function customerDeletionIsActive(
  lifecycle: AccountLifecycle | undefined,
): lifecycle is AccountLifecycle {
  return lifecycle?.status === "deletion_scheduled" ||
    lifecycle?.status === "erasing";
}

function customerDeletionCanAccelerate(
  lifecycleStatus: unknown,
  eraseNow: unknown,
): boolean {
  return lifecycleStatus === "deletion_scheduled" && eraseNow === true;
}

function classifyCustomerDeletion(
  result: CustomerDeletionActionOutcome,
  uid: string,
): NormalFleetMutationResult {
  if (result.kind === "not-found") {
    return { outcome: "failed", error: "User not found" };
  }
  if (result.kind === "conflict") {
    return { outcome: "failed", error: "Cleanup already in progress" };
  }
  if (result.kind !== "partial") return { outcome: "completed" };
  const summary = result.failedStep === "suspend-auth"
    ? "customer deletion was scheduled but identity suspension failed"
    : "customer deletion was scheduled but connector grant revocation failed";
  return {
    outcome: "partial",
    partialOutcome: {
      summary,
      details: {
        uid,
        failedStep: result.failedStep,
        deletionId: result.claimed.deletionId,
        suspensionOperationId: result.claimed.suspensionOperationId,
        erasureOperationId: result.claimed.erasureOperationId,
      },
    },
  };
}

function respondToCustomerDeletionAdmission(
  admission: CustomerDeletionActionOutcome,
  res: Response,
  logger: FleetLogger,
  uid: string,
): void {
  if (admission.kind === "partial") throw admission.error;
  if (admission.kind === "not-found") {
    res.status(404).json({ error: "User not found", uid });
    return;
  }
  if (admission.kind === "conflict") {
    res.status(409).json({
      error: "Cleanup already in progress",
      ...(admission.deletionId ? { deletionId: admission.deletionId } : {}),
      ...(admission.operationId ? { operationId: admission.operationId } : {}),
    });
    return;
  }
  logger.info(
    `[admin-delete] scheduled deletion=${admission.deletionId} uid=${uid} eraseAfter=${admission.eraseAfter}`,
  );
  res.status(202).json({
    status: "deletion_scheduled",
    deletionId: admission.deletionId,
    suspensionOperationId: admission.suspensionOperationId,
    erasureOperationId: admission.erasureOperationId,
    eraseAfter: admission.eraseAfter,
    slug: admission.slug,
  });
}

async function claimAndCleanupCustomerDeletion(opts: {
  store: PlatformStateStore;
  accounts: BuilderAccountReader;
  deps: Pick<FleetRouterDeps, "suspendAuthUser" | "revokeConnectorGrantsForUser">;
  uid: string;
  requestedBy: string;
  eraseNow: boolean;
}): Promise<CustomerDeletionActionOutcome> {
  const claimed = await claimCustomerDeletion({
    store: opts.store,
    accounts: opts.accounts,
    uid: opts.uid,
    requestedBy: opts.requestedBy,
    eraseNow: opts.eraseNow,
  });
  if (claimed.kind !== "created") return claimed;
  try {
    await opts.deps.suspendAuthUser(opts.uid);
  } catch (error) {
    return {
      kind: "partial",
      failedStep: "suspend-auth",
      claimed,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  try {
    await opts.deps.revokeConnectorGrantsForUser(opts.uid);
  } catch (error) {
    return {
      kind: "partial",
      failedStep: "revoke-connector-grants",
      claimed,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  return claimed;
}

const CUSTOMER_SELF_DELETION_REASON = "Customer account deletion request";

export type CustomerSelfDeletionOutcome =
  | { kind: "not-found" }
  | { kind: "conflict" }
  | { kind: "workspace-busy" }
  | {
      kind: "scheduled";
      deletionId: string;
      eraseAfter: number;
      incompleteStep: { name: "suspend-auth" | "revoke-connector-grants"; error: Error } | null;
    };

export async function scheduleCustomerSelfDeletion(opts: {
  store: PlatformStateStore;
  accounts: BuilderAccountReader;
  deps: Pick<FleetRouterDeps, "suspendAuthUser" | "revokeConnectorGrantsForUser">;
  uid: string;
}): Promise<CustomerSelfDeletionOutcome> {
  const builder = await opts.store.builders.records.get(opts.uid);
  if (!builder) return { kind: "not-found" };
  const lifecycle = builder.accountLifecycle ?? undefined;
  const lifecycleStatus = lifecycle?.status ?? null;
  if (customerDeletionIsActive(lifecycle)) return { kind: "conflict" };
  const outcome = await runNormalFleetMutation(opts.store, {
    actor: opts.uid,
    forced: false,
    what: "schedule customer deletion",
    why: CUSTOMER_SELF_DELETION_REASON,
    target: { uid: opts.uid },
    preActionStatus: { lifecycleStatus },
    mutation: { kind: "schedule-customer-deletion", uid: opts.uid, eraseNow: false },
    classifyResult: (result) => classifyCustomerDeletion(result, opts.uid),
    action: async () => claimAndCleanupCustomerDeletion({
      store: opts.store,
      accounts: opts.accounts,
      deps: opts.deps,
      uid: opts.uid,
      requestedBy: opts.uid,
      eraseNow: false,
    }),
  });
  if (outcome.kind === "not-found") return { kind: "not-found" };
  if (outcome.kind === "conflict") {
    return outcome.runtimeFenced ? { kind: "workspace-busy" } : { kind: "conflict" };
  }
  const claimed = outcome.kind === "partial" ? outcome.claimed : outcome;
  return {
    kind: "scheduled",
    deletionId: claimed.deletionId,
    eraseAfter: claimed.eraseAfter,
    incompleteStep: outcome.kind === "partial"
      ? { name: outcome.failedStep, error: outcome.error }
      : null,
  };
}

type ActivationLeaseTerminationOutcome =
  | { kind: "not-found" }
  | { kind: "conflict"; reason: string }
  | { kind: "adopted" }
  | { kind: "requested" };

type ActivationLeaseReturnOutcome =
  | { kind: "not-found" }
  | { kind: "conflict"; status: string | null }
  | { kind: "adopted" }
  | { kind: "requested" };

type ReasonedActivationLeaseMutationOutcome =
  | { kind: "not-found" }
  | { kind: "conflict"; reason: string }
  | { kind: "retried" | "cancelled" };

function classifyActivationLeaseTermination(
  result: ActivationLeaseTerminationOutcome,
): NormalFleetMutationResult {
  if (result.kind === "not-found") {
    return { outcome: "failed", error: ERR_USER_NOT_FOUND };
  }
  if (result.kind === "conflict") {
    return { outcome: "failed", error: result.reason };
  }
  if (result.kind === "adopted") {
    return {
      outcome: "failed",
      error: "activation lease termination was already requested",
    };
  }
  return { outcome: "completed" };
}

function classifyActivationLeaseReturn(
  result: ActivationLeaseReturnOutcome,
): NormalFleetMutationResult {
  if (result.kind === "not-found") {
    return { outcome: "failed", error: ERR_USER_NOT_FOUND };
  }
  if (result.kind === "conflict") {
    return {
      outcome: "failed",
      error: "activation lease is not the requested active generation",
    };
  }
  if (result.kind === "adopted") {
    return {
      outcome: "failed",
      error: "activation lease return was already requested",
    };
  }
  return { outcome: "completed" };
}

function classifyReasonedActivationLeaseMutation(
  result: ReasonedActivationLeaseMutationOutcome,
): NormalFleetMutationResult {
  if (result.kind === "not-found") {
    return { outcome: "failed", error: ERR_USER_NOT_FOUND };
  }
  if (result.kind === "conflict") {
    return { outcome: "failed", error: result.reason };
  }
  return { outcome: "completed" };
}

function migrationLockRef(operation: OperationRecord): {
  id: string;
  kind: string;
  status: string;
  input: unknown;
  customerMigrationV2: unknown;
} {
  return {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    input: operation.input,
    customerMigrationV2: operation.customerMigrationV2,
  };
}

const IN_FLIGHT_OPERATION_STATUSES = ["pending", "running"] as const;

function inFlightOperationsForUid(
  transaction: Pick<PlatformStateTransaction, "journal">,
  uid: string,
): Promise<readonly Stored<OperationRecord>[]> {
  return transaction.journal.operations.listForUid(uid, { statuses: [...IN_FLIGHT_OPERATION_STATUSES] });
}

function isInFlightCustomerMigration(operation: OperationRecord): boolean {
  return operation.kind === OP_KIND_MIGRATE_CUSTOMER &&
    (operation.status === "pending" || operation.status === "running");
}

type AddGatewayMutationOutcome =
  | { kind: "completed"; operationId: string }
  | {
      kind: "partial";
      failedStep: "initial-release" | "rollout-operation";
      error: Error;
    };

function gatewayCreationBodyError(
  body: Record<string, unknown>,
): RolloutBodyError | null {
  const persistenceError = rejectPersistenceInBody(body);
  if (persistenceError) return persistenceError;
  if (!Object.prototype.hasOwnProperty.call(body, "byosub")) return null;
  return {
    status: 400,
    body: {
      error: "gateway credential references are user-scoped and cannot be created here",
    },
  };
}

function respondToAddGatewayMutationError(
  error: unknown,
  res: Response,
  gatewayId: string,
): boolean {
  if (error instanceof GatewayAuthSecretProvisionError) {
    res.status(502).json({
      error: "failed to provision gateway auth-token secret",
      gatewayId,
      detail: error.message,
    });
    return true;
  }
  if (error instanceof InitialGatewayReleaseConflictError) {
    res.status(409).json({
      error: "gateway already exists",
      gatewayId: error.gatewayId,
    });
    return true;
  }
  return false;
}

function classifyAddGatewayMutation(
  outcome: AddGatewayMutationOutcome,
  gatewayId: string,
  artifact: GatewayArtifact,
): NormalFleetMutationResult {
  if (outcome.kind === "completed") {
    return {
      outcome: "completed",
      releaseRollout: {
        releaseId: `${gatewayId}/1`,
        releaseTag: artifact.imageTag,
        rolloutOperationId: outcome.operationId,
      },
    };
  }
  if (outcome.failedStep === "initial-release") {
    return {
      outcome: "partial",
      partialOutcome: {
        summary: "gateway auth secret was provisioned but its initial release was not created",
        details: { gatewayId, failedStep: outcome.failedStep },
      },
    };
  }
  return {
    outcome: "partial",
    partialOutcome: {
      summary: "gateway release was created but its rollout operation could not be enqueued",
      details: { gatewayId, release: 1, failedStep: outcome.failedStep },
    },
    releaseRollout: {
      releaseId: `${gatewayId}/1`,
      releaseTag: artifact.imageTag,
    },
  };
}

async function performAddGatewayMutation(opts: {
  store: PlatformStateStore;
  provisionGatewayAuthSecret: FleetRouterDeps["provisionGatewayAuthSecret"];
  gatewayServiceAccount: string;
  body: AddGatewayCreate;
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
  config: GatewayMutableConfig;
  artifact: GatewayArtifact;
  createdBy: string;
  now: number;
}): Promise<AddGatewayMutationOutcome> {
  try {
    await opts.provisionGatewayAuthSecret({
      gatewayId: opts.body.gatewayId,
      gatewayServiceAccount: opts.gatewayServiceAccount,
    });
  } catch (error) {
    throw new GatewayAuthSecretProvisionError(
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    await writeInitialGatewayReleaseInStore(opts.store, {
      gatewayId: opts.body.gatewayId,
      createdBy: opts.createdBy,
      now: opts.now,
      desiredStatus: "running",
      config: opts.config,
      artifact: opts.artifact,
    });
  } catch (error) {
    return {
      kind: "partial",
      failedStep: "initial-release",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  try {
    const operationId = await createOperation(opts.store, {
      kind: "add-gateway",
      createdBy: opts.createdBy,
      input: {
        gatewayId: opts.body.gatewayId,
        imageTag: opts.body.imageTag,
        ...(opts.body.profile ? { profile: opts.body.profile } : {}),
        gatewayClass: opts.gatewayClass,
        ...(opts.imageProfile !== "standard" ? { imageProfile: opts.imageProfile } : {}),
        ...(opts.body.sizingTier ? { sizingTier: opts.body.sizingTier } : {}),
      },
    });
    return { kind: "completed", operationId };
  } catch (error) {
    return {
      kind: "partial",
      failedStep: "rollout-operation",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function activationLeaseForTermination(
  data: GlmDoc,
  leaseId: string,
  generation: number,
): NonNullable<ReturnType<typeof activationLeaseFromUser>> | null {
  const resolved = activationLeaseFromUser(data);
  if (
    !resolved ||
    resolved.lease.leaseId !== leaseId ||
    resolved.lease.generation !== generation
  ) {
    return null;
  }
  return resolved;
}

function sharedAssignmentServesBuilder(input: {
  assignment: GatewayAssignment | null;
  uid: string;
  gatewayId: string;
}): boolean {
  return input.assignment?.uid === input.uid &&
    input.assignment.gatewayId === input.gatewayId &&
    input.assignment.state === "serving" &&
    Number.isSafeInteger(input.assignment.epoch);
}

function disposableRuntimeMatchesTermination(input: {
  target: GatewayRoot | null;
  uid: string;
  leaseId: string;
  generation: number;
}): boolean {
  const allocation = isPlainRecord(input.target?.allocation)
    ? input.target.allocation
    : null;
  return input.target?.ownerUid === input.uid &&
    allocation?.kind === "disposable-builder" &&
    allocation.claimedByUid === input.uid &&
    allocation.leaseId === input.leaseId &&
    allocation.generation === input.generation;
}

function terminationStatusAt(lease: GlmDoc): number | null {
  if (lease.status === "activating") return toMillis(lease.activatingAt);
  return toMillis(lease.provisionedAt ?? lease.requestedAt);
}

function runtimeTerminationCanStart(lease: GlmDoc, now: number): boolean {
  const statusAt = terminationStatusAt(lease);
  const stale = statusAt !== null &&
    now - statusAt > BUILDER_RUNTIME_STALE_AFTER_MS;
  return lease.status === "failed" || stale;
}

async function requestActivationLeaseTermination(
  transaction: PlatformStateTransaction,
  input: {
    uid: string;
    leaseId: string;
    generation: number;
    sharedGatewayIds: readonly string[];
    requestedAt: number;
    requestedBy: string;
  },
): Promise<ActivationLeaseTerminationOutcome> {
  const builder = await transaction.builders.records.get(input.uid);
  if (!builder) return { kind: "not-found" };
  const resolved = activationLeaseForTermination(
    builderUserData(builder, null),
    input.leaseId,
    input.generation,
  );
  if (!resolved) {
    return { kind: "conflict", reason: "lease generation changed" };
  }
  const { lease, openclaw } = resolved;
  const targetGatewayId = asStringOrNull(lease.targetGatewayId);
  const sharedGatewayId = asStringOrNull(openclaw.gatewayId);
  if (
    !targetGatewayId ||
    !sharedGatewayId ||
    !input.sharedGatewayIds.includes(sharedGatewayId)
  ) {
    return {
      kind: "conflict",
      reason: "Builder is not authoritative on the shared gateway",
    };
  }
  const assignment = await transaction.gateways.assignments.get(sharedGatewayId, input.uid);
  if (!sharedAssignmentServesBuilder({
    assignment,
    uid: input.uid,
    gatewayId: sharedGatewayId,
  })) {
    return {
      kind: "conflict",
      reason: "canonical shared assignment is not serving",
    };
  }
  if (
    lease.status === "returning" &&
    toMillis(lease.operatorTerminateRequestedAt) !== null
  ) {
    return { kind: "adopted" };
  }
  const target = await transaction.gateways.roots.get(targetGatewayId);
  if (!disposableRuntimeMatchesTermination({
    target,
    uid: input.uid,
    leaseId: input.leaseId,
    generation: input.generation,
  })) {
    return {
      kind: "conflict",
      reason: "disposable runtime ownership changed",
    };
  }
  if (!runtimeTerminationCanStart(lease, input.requestedAt)) {
    return {
      kind: "conflict",
      reason: "runtime is neither failed nor stale",
    };
  }
  await transaction.builders.records.patchActivationLease(input.uid, {
    status: "returning",
    returnRequestedAt: input.requestedAt,
    returnRequestedBy: input.requestedBy,
    operatorTerminateRequestedAt: input.requestedAt,
    operatorTerminateRequestedBy: input.requestedBy,
  }, { leaseId: input.leaseId, generation: input.generation });
  return { kind: "requested" };
}

const WORKSPACE_IDENTITIES_NOT_INITIALIZED =
  "OpenClaw workspace identities are not initialized for this boot";

function isEndpointPreflightError(error: string, operationInput: GlmDoc): boolean {
  const { fromGatewayId, toGatewayId } = operationInput;
  const preflightPrefix = [
    `source gateway ${fromGatewayId} is not migration-ready (`,
    `source gateway ${fromGatewayId} has no durable placement`,
    `target gateway ${toGatewayId} is not migration-ready (`,
    `target gateway ${toGatewayId} has no durable placement`,
    `placement rejected for ${toGatewayId}: `,
  ].some((prefix) => error.startsWith(prefix));
  const schedulerIdentityNotReady = [fromGatewayId, toGatewayId].some(
    (gatewayId) => error.startsWith(`/scheduler/${gatewayId}: 500 `),
  ) && error.includes(WORKSPACE_IDENTITIES_NOT_INITIALIZED);
  const postgresRuntimeMismatch = error ===
    "PostgreSQL agent handoff requires the same fully identified OpenClaw build on both Gateways; align their runtime pins before moving state";
  return preflightPrefix || schedulerIdentityNotReady || postgresRuntimeMismatch;
}

function rearmableBuilderReturnOperation(input: {
  operation: GlmDoc | undefined;
  uid: string;
  targetGatewayId: string;
}): boolean {
  const operation = input.operation;
  if (!operation || !isPlainRecord(operation.input)) return false;
  const operationInput = operation.input;
  const terminalStatus = operation.status === "failed" || operation.status === "rolled-back";
  const steps = operation.steps;
  const error = operation.error;
  const endpointPreflightFailure = Array.isArray(steps) && steps.length === 0 &&
    typeof error === "string" && isEndpointPreflightError(error, operationInput);
  const failedBeforeSourceQuiesce = operation.rolledBack === false &&
    (endpointPreflightFailure || (Array.isArray(steps) && steps.length === 1 &&
      isPlainRecord(steps[0]) && steps[0].name === "keys-sync-state" &&
      steps[0].status === "failed"));
  return [
    operation.kind === OP_KIND_MIGRATE_CUSTOMER,
    terminalStatus,
    operation.rolledBack === true || failedBeforeSourceQuiesce,
    operation.origin === "automatic",
    operation.createdBy === "glm-controller-placement-policy",
    operation.inputUid === input.uid,
    operation.gatewayId === operationInput.toGatewayId,
    operationInput.uid === input.uid,
    operationInput.fromGatewayId === input.targetGatewayId,
    operationInput.source === "builder-activation-lease",
    typeof operationInput.toGatewayId === "string" && operationInput.toGatewayId.length > 0,
    operation.customerMigrationV2 === undefined,
  ].every(Boolean);
}

type BuilderReturnRetryLease = {
  lease: GlmDoc;
  targetGatewayId: string;
  returnOperationId: string;
};

function retryableBuilderReturnLease(
  data: GlmDoc,
  operationId: string,
): BuilderReturnRetryLease | null {
  const resolved = activationLeaseFromUser(data);
  const lease = resolved?.lease;
  const targetGatewayId = asStringOrNull(lease?.targetGatewayId);
  const returnOperationId = asStringOrNull(lease?.returnOperationId);
  if (
    !lease ||
    lease.status !== "returning" ||
    !targetGatewayId ||
    asStringOrNull(resolved?.openclaw.gatewayId) !== targetGatewayId ||
    !Number.isSafeInteger(lease.generation) ||
    (lease.generation as number) < 1 ||
    returnOperationId !== builderReturnOperationId(targetGatewayId, lease.generation as number) ||
    operationId !== returnOperationId
  ) {
    return null;
  }
  return { lease, targetGatewayId, returnOperationId };
}

type BuilderReturnRetryState = {
  assignment: GatewayAssignment | null;
  target: GatewayRoot | null;
  operation: GlmDoc | undefined;
};

async function readBuilderReturnRetryState(
  transaction: PlatformStateTransaction,
  input: { uid: string; targetGatewayId: string; returnOperationId: string },
): Promise<BuilderReturnRetryState> {
  const [assignment, target, operation] = await Promise.all([
    transaction.gateways.assignments.get(input.targetGatewayId, input.uid),
    transaction.gateways.roots.get(input.targetGatewayId),
    transaction.journal.operations.get(input.returnOperationId),
  ]);
  return {
    assignment,
    target,
    operation: operation === null ? undefined : recordDoc(operation.id, operation).data(),
  };
}

function matchesBuilderReturnRetryState(input: {
  state: BuilderReturnRetryState;
  uid: string;
  targetGatewayId: string;
  lease: GlmDoc;
}): boolean {
  return [
    sharedAssignmentServesBuilder({
      assignment: input.state.assignment,
      uid: input.uid,
      gatewayId: input.targetGatewayId,
    }),
    input.state.target?.gatewayClass === "builder",
    disposableRuntimeMatchesTermination({
      target: input.state.target,
      uid: input.uid,
      leaseId: asStringOrNull(input.lease.leaseId) ?? "",
      generation: typeof input.lease.generation === "number" ? input.lease.generation : 0,
    }),
    rearmableBuilderReturnOperation({
      operation: input.state.operation,
      uid: input.uid,
      targetGatewayId: input.targetGatewayId,
    }),
  ].every(Boolean);
}

async function retryActivationLeaseReturn(
  transaction: PlatformStateTransaction,
  input: {
    uid: string;
    operationId: string;
    requestedAt: number;
    requestedBy: string;
  },
): Promise<ReasonedActivationLeaseMutationOutcome> {
  const builder = await transaction.builders.records.get(input.uid);
  if (!builder) return { kind: "not-found" };
  const retryLease = retryableBuilderReturnLease(builderUserData(builder, null), input.operationId);
  if (!retryLease) {
    return { kind: "conflict", reason: "Builder return is no longer retryable" };
  }
  const state = await readBuilderReturnRetryState(transaction, {
    uid: input.uid,
    targetGatewayId: retryLease.targetGatewayId,
    returnOperationId: retryLease.returnOperationId,
  });
  if (!matchesBuilderReturnRetryState({
    state,
    uid: input.uid,
    targetGatewayId: retryLease.targetGatewayId,
    lease: retryLease.lease,
  })) {
    return { kind: "conflict", reason: "Builder return no longer matches its original lease" };
  }
  await transaction.journal.operations.patch(retryLease.returnOperationId, {
    retryRequestedAt: input.requestedAt,
    retryRequestedBy: input.requestedBy,
  });
  return { kind: "retried" };
}

async function placementBuilderRejection(
  transaction: PlatformStateTransaction,
  builder: Stored<BuilderRecord> | null,
  uid: string,
  gatewayId: string,
): Promise<CommitPlacementResult | null> {
  if (builder !== null && builderRuntimeMutationFenced(builder)) {
    return {
      kind: "rejected",
      reason: builder.fences.restoreFence !== undefined ? "restore-in-progress" : "source-transfer-in-progress",
    };
  }
  if (!accountAllowsInteractiveAccess({ accountLifecycle: builder?.accountLifecycle })) {
    return { kind: "rejected", reason: "account-not-interactive" };
  }
  const currentGatewayId = builder?.gateway?.gatewayId;
  if (
    currentGatewayId !== undefined && currentGatewayId !== gatewayId &&
    await transaction.gateways.assignments.get(currentGatewayId, uid) !== null
  ) {
    return { kind: "rejected", reason: "assigned-elsewhere" };
  }
  return null;
}

async function commitAdminPlacementInStore(
  store: PlatformStateStore,
  input: {
    uid: string;
    slug: string;
    now: number;
    assignmentWrite: "upsert" | "create-if-missing";
    mirror: BuilderGatewayMirrorInput;
  },
): Promise<CommitPlacementResult> {
  const gatewayId = input.mirror.gatewayId;
  return store.transaction({ label: "admin.fleet.assignCustomer" }, async (transaction): Promise<CommitPlacementResult> => {
    const builder = await transaction.builders.records.get(input.uid);
    const rejection = await placementBuilderRejection(transaction, builder, input.uid, gatewayId);
    if (rejection) return rejection;
    const stored = await transaction.gateways.roots.get(gatewayId);
    if (stored === null) {
      await transaction.builders.records.setGatewayMirror(input.uid, input.mirror);
      return { kind: "mirror-only" };
    }
    const root = durableRootOf(stored, gatewayId);
    if (root === null) return { kind: "rejected", reason: "gateway-root-invalid" };
    if (root.desiredStatus !== "running") return { kind: "rejected", reason: "gateway-not-running" };
    const runtime = await transaction.fleetRegistry.get(gatewayId);
    if (runtime?.lifecycle !== "serving") return { kind: "rejected", reason: "gateway-not-serving" };
    const existing = input.assignmentWrite === "create-if-missing"
      ? await transaction.gateways.assignments.get(gatewayId, input.uid)
      : null;
    await transaction.builders.records.setGatewayMirror(input.uid, input.mirror);
    if (existing !== null) return { kind: "assignment-preserved" };
    await transaction.gateways.assignments.put({
      uid: input.uid,
      slug: input.slug,
      gatewayId,
      source: "repair",
      state: "serving",
      epoch: 0,
      createdAt: input.now,
      updatedAt: input.now,
      updatedByOperationId: null,
    });
    return { kind: "assigned", release: root.liveRelease };
  });
}

function builderMountOf(builder: BuilderRecord | null): { currentGatewayId: string | null; builderSlug: string | null } {
  return { currentGatewayId: builder?.gateway?.gatewayId ?? null, builderSlug: builder?.slug ?? null };
}

async function readPlatformRuntimeConfig(store: PlatformStateStore): Promise<PlatformRuntimeConfig> {
  const config = await store.config.orchestrator.get();
  return { disposableGatewayIdleMs: config?.disposableGatewayIdleMs ?? DEFAULT_DISPOSABLE_GATEWAY_IDLE_MS };
}

async function setOperatorParkedBuilderGatewayStatus(transaction: PlatformStateTransaction, gatewayId: string, input: { actor: string | undefined; uid: string; desiredStatus: "paused" | "running" }): Promise<{ dedicated: boolean; error?: string }> {
  const gateway = await transaction.gateways.roots.get(gatewayId);
  if (gateway?.gatewayClass !== "builder") return { dedicated: false };
  if (gateway.ownerUid !== input.uid || gateway.desiredStatus === "retired" || gateway.runtimeRestartFence !== undefined || gateway.retirementClaim != null) {
    return { dedicated: true, error: "dedicated gateway ownership or runtime outcome must settle before changing parking" };
  }
  await transaction.gateways.roots.patch(gatewayId, { desiredStatus: input.desiredStatus, updatedAt: Date.now(), updatedBy: input.actor ?? "unknown" });
  return { dedicated: true };
}

async function updateOperatorParkingGateway(transaction: PlatformStateTransaction, input: { gatewayId: string | null; uid: string; actor: string | undefined; park: boolean }): Promise<{ dedicated: boolean; error?: string }> {
  if (!input.gatewayId) return { dedicated: false };
  const assignment = await transaction.gateways.assignments.get(input.gatewayId, input.uid);
  if (assignment && assignment.state !== "serving") return { dedicated: false, error: `customer roster state ${assignment.state} must settle before changing parking` };
  const gateway = await setOperatorParkedBuilderGatewayStatus(transaction, input.gatewayId, { ...input, desiredStatus: input.park ? "paused" : "running" });
  if (gateway.error) return gateway;
  if (input.park && !gateway.dedicated) await transaction.gateways.assignments.delete(input.gatewayId, input.uid);
  return gateway;
}

function parkingHasUnsettledAllocation(lease: BuilderActivationLease | null, gatewayId: string | null): boolean {
  if (lease?.status === "requested") return true;
  return typeof lease?.targetGatewayId === "string" && lease.targetGatewayId !== gatewayId && lease.status !== "parked";
}

// eslint-disable-next-line max-lines-per-function -- factory mounts ~15 admin routes; splitting it would scatter the contract across files for no readability gain
export function addAdminFleetRoutes(
  router: Router,
  deps: FleetRouterDeps,
): Router {
  const { db, logger, store } = deps;
  const readBuilderTier = firestoreBuilderTierReader(db);
  const accounts = firestoreBuilderAccountReader(db);

  async function runAdminFleetMutation<T>(input: {
    req: Request;
    what: string;
    why: string;
    target: Record<string, unknown>;
    preActionStatus: Record<string, unknown>;
    mutation: Record<string, unknown>;
    forced?: boolean;
    action: () => Promise<T>;
    classifyResult?: (result: T) => NormalFleetMutationResult;
    idempotencyScope?: string;
    aliasPlan?: OperationAuditAliasPlan[];
  }): Promise<T> {
    const actor = input.req as ActorRequest;
    const headerKey = input.req.get("Idempotency-Key")?.trim();
    return runNormalFleetMutation(store, {
      actor: actor.uid ?? "unknown",
      forced: input.forced === true,
      what: input.what,
      why: input.why,
      target: input.target,
      preActionStatus: input.preActionStatus,
      mutation: input.mutation,
      action: async () => input.action(),
      classifyResult: input.classifyResult,
      ...(input.aliasPlan ? { aliasPlan: input.aliasPlan } : {}),
      ...(headerKey
        ? { idempotencyKey: `${headerKey}:${input.idempotencyScope ?? input.what}` }
      : {}),
    });
  }

  addAdminComputerRoutes(router, { store, replacementEnabled: deps.computerReplacementEnabled, journal: runAdminFleetMutation });

  router.get("/platform-runtime-config", async (_req, res, next) => {
    try {
      res.json(await readPlatformRuntimeConfig(store));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/platform-runtime-config", async (req, res, next) => {
    try {
      const body: unknown = req.body;
      if (!isPlainRecord(body) || Object.keys(body).length !== 1 ||
        typeof body.disposableGatewayIdleMs !== "number" ||
        !Number.isSafeInteger(body.disposableGatewayIdleMs) || body.disposableGatewayIdleMs < 0) {
        res.status(400).json({ error: "disposableGatewayIdleMs must be the only field and a nonnegative safe integer" });
        return;
      }
      const config: PlatformRuntimeConfig = { disposableGatewayIdleMs: body.disposableGatewayIdleMs };
      const previous = await readPlatformRuntimeConfig(store);
      await runAdminFleetMutation({
        req,
        what: "set platform gateway idle return duration",
        why: ADMIN_FLEET_REQUEST_REASON,
        target: { configPath: ORCHESTRATOR_CONFIG_DOC_PATH },
        preActionStatus: { ...previous },
        mutation: { ...config },
        action: async () => {
          await store.config.orchestrator.patch(config);
        },
      });
      res.json(config);
    } catch (error) {
      next(error);
    }
  });

  async function handleActiveCustomerDeletion(input: {
    req: Request;
    res: Response;
    uid: string;
    lifecycle: AccountLifecycle | undefined;
    eraseNow: unknown;
  }): Promise<boolean> {
    const lifecycle = input.lifecycle;
    if (!customerDeletionIsActive(lifecycle)) return false;
    const lifecycleStatus = lifecycle.status;
    if (!customerDeletionCanAccelerate(lifecycleStatus, input.eraseNow)) {
      input.res.status(409).json({
        error: "Cleanup already in progress",
        deletionId: lifecycle.deletionId ?? null,
      });
      return true;
    }
    const acceleration = await runAdminFleetMutation({
      req: input.req,
      what: "accelerate scheduled customer erasure",
      why: ADMIN_FLEET_REQUEST_REASON,
      target: { uid: input.uid, deletionId: lifecycle.deletionId ?? null },
      preActionStatus: { lifecycleStatus },
      mutation: { kind: "accelerate-customer-erasure", uid: input.uid },
      classifyResult: classifyErasureAcceleration,
      action: async () => accelerateScheduledCustomerErasure({ store, uid: input.uid }),
    });
    input.res.status(acceleration.status).json(acceleration.body);
    return true;
  }

router.post(
    "/customer/:uid/delete",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const body = (req.body ?? {}) as { eraseNow?: unknown };
        if (eraseNowValueIsInvalid(body.eraseNow)) {
          res.status(400).json({ error: "eraseNow must be a boolean" });
          return;
        }
        const builder = await store.builders.records.get(uid);
        if (!builder) {
          res.status(404).json({ error: "User not found", uid });
          return;
        }
        const existingLifecycle = builder.accountLifecycle ?? undefined;
        const existingStatus = existingLifecycle?.status;
        const activeDeletionHandled = await handleActiveCustomerDeletion({
          req,
          res,
          uid,
          lifecycle: existingLifecycle,
          eraseNow: body.eraseNow,
        });
        if (activeDeletionHandled) return;
        const actor = req as ActorRequest;
        const admission = await runAdminFleetMutation({
          req,
          what: "schedule customer deletion",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid },
          preActionStatus: { lifecycleStatus: existingStatus ?? null },
          mutation: { kind: "schedule-customer-deletion", uid, eraseNow: body.eraseNow === true },
          classifyResult: (result) => classifyCustomerDeletion(result, uid),
          action: async () => claimAndCleanupCustomerDeletion({
            store,
            accounts,
            deps,
            uid,
            requestedBy: actor.uid ?? "unknown",
            eraseNow: body.eraseNow === true,
          }),
        });
        respondToCustomerDeletionAdmission(admission, res, logger, uid);
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/gateways",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [snapshot, sharedPoolConfig] = await Promise.all([
          readFleetSnapshot(store),
          store.transaction(
            { label: "admin.fleet.gatewaysSharedPool", readOnly: true },
            readSharedGatewayPoolConfigInStore,
          ),
        ]);
        const userDocs = builderUserDocs(snapshot.builders, new Map());
        const handoffProgressByGateway = projectHandoffProgress(snapshot.assignments);
        const glmByGatewayId = indexAdminGatewayRuntimeDocs(fleetGatewayDocs(snapshot));
        const projectionOperations = await readFleetProjectionOperations(
          store,
          fleetProjectionOperationIds(userDocs, glmByGatewayId),
        );
        const operationsById = indexGlmDocs(projectionOperations);
        const now = Date.now();
        const builderRuntimes = userDocs.flatMap((doc) => {
          const runtime = projectBuilderRuntime(
            doc,
            glmByGatewayId,
            operationsById,
            now,
          );
          return runtime ? [runtime] : [];
        });
        const visibleRetiredGatewayIds = new Set(
          builderRuntimes.flatMap((runtime) =>
            runtime.targetGatewayId &&
            (runtime.lifecycle === "failed" ||
              (runtime.cleanupOperationId &&
                runtime.cleanupOperationStatus !== "succeeded"))
              ? [runtime.targetGatewayId]
              : [],
          ),
        );
        for (const [gatewayId, gateway] of glmByGatewayId) {
          const retirementClaim = isPlainRecord(gateway.retirementClaim)
            ? gateway.retirementClaim
            : null;
          const operationId =
            asStringOrNull(retirementClaim?.operationId) ??
            disposableRuntimeRetireOperationId(gateway, gatewayId);
          const cleanupStatus = operationId ? operationsById.get(operationId)?.status : undefined;
          if (
            projectDesiredStatus(gateway) === "retired" &&
            projectDisposableRuntime(gateway) !== null &&
            cleanupStatus !== "succeeded"
          ) {
            visibleRetiredGatewayIds.add(gatewayId);
          }
        }
        const gatewayIds = new Set(glmByGatewayId.keys());
        const gatewayInputs = [...gatewayIds].flatMap((gatewayId) => {
          const glmDoc = glmByGatewayId.get(gatewayId);
          if (
            projectDesiredStatus(glmDoc) === "retired" &&
            !visibleRetiredGatewayIds.has(gatewayId)
          ) {
            return [];
          }
          const doc = effectiveHeartbeatDoc(gatewayId, glmDoc);
          if (
            !doc &&
            !shouldProjectDesiredOnlyGateway(glmDoc) &&
            !visibleRetiredGatewayIds.has(gatewayId)
          ) {
            return [];
          }
          return [{ doc: doc ?? syntheticGatewayDoc(gatewayId), glmDoc }];
        });
        const summaries = gatewayInputs.map(({ doc, glmDoc }) =>
          projectGatewaySummary(doc, glmDoc, now),
        );
        const readBatch = deps.readGatewayPodDiagnosticsBatch;
        const gateways = readBatch
          ? await projectGatewaySummariesWithDiagnostics(deps, summaries, readBatch)
          : await Promise.all(
              gatewayInputs.map(({ doc, glmDoc }) =>
                projectGatewaySummaryWithDiagnostics(deps, doc, glmDoc, now),
              ),
            );
        attachHandoffProgress(gateways, handoffProgressByGateway);
        const gatewayById = new Map(
          gateways.map((gateway) => [gateway.gatewayId, gateway]),
        );
        const builderRuntimeViews = builderRuntimes.map((runtime) => {
          const target = runtime.targetGatewayId
            ? gatewayById.get(runtime.targetGatewayId)
            : undefined;
          return {
            ...runtime,
            targetPodStatus: target?.podDiagnostics?.status ?? null,
            targetPodCount: target?.podDiagnostics?.totalPods ?? null,
          };
        });
        const sharedGatewayIds = new Set(sharedPoolConfig?.sharedGatewayIds ?? []);
        const parkedBuilders = userDocs.filter((doc) => {
          const resolved = activationLeaseFromUser(doc.data());
          return (
            resolved?.lease.status === "parked" &&
            sharedGatewayIds.has(asStringOrNull(resolved.openclaw.gatewayId) ?? "")
          );
        }).length;
        res.json({
          gateways,
          builderRuntimes: builderRuntimeViews,
          disposableCapacity: {
            ...projectDisposableFleetCapacity(gateways, builderRuntimeViews, parkedBuilders),
            operatorParkedBuilders: snapshot.builders.filter((builder) => builder.openclaw.managedBy === "operator").length,
          },
          stats: rollupFleetStats(
            gateways.filter((gateway) => gateway.desiredStatus !== "retired"),
          ),
          namespace: resolveFleetNamespace(),
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/onboarding-placement",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await readAdminOnboardingPlacementResponse(store, accounts));
      } catch (e) {
        next(e);
      }
    },
  );

  router.patch(
    "/onboarding-placement/autoscaling",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const autoscaling = parseSharedGatewayAutoscalingConfig(req.body);
        if (autoscaling === null) {
          res.status(400).json({
            error: "enabled and buildersPerGateway must form a valid shared pool autoscaling config",
          });
          return;
        }
        const [pool, orchestrator] = await store.transaction(
          { label: "admin.fleet.sharedPoolAutoscaling", readOnly: true },
          (transaction) => Promise.all([
            readSharedGatewayPoolConfigInStore(transaction),
            transaction.config.orchestrator.get(),
          ]),
        );
        const current = orchestrator === null
          ? sharedGatewayAutoscalingOf(null)
          : orchestrator.sharedGatewayAutoscaling;
        const actor = req as ActorRequest;
        const updatedBy = actor.uid ?? "unknown";
        await runAdminFleetMutation({
          req,
          what: "set shared pool autoscaling",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { sharedGatewayIds: pool?.sharedGatewayIds ?? [] },
          preActionStatus: { sharedGatewayAutoscaling: current },
          mutation: { kind: "set-shared-gateway-autoscaling", autoscaling },
          action: async () => {
            await store.config.orchestrator.patch({
              sharedGatewayAutoscaling: autoscaling,
              placementUpdatedAt: Date.now(),
              placementUpdatedBy: updatedBy,
            });
          },
        });
        res.json(await readAdminOnboardingPlacementResponse(store, accounts));
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateway-migrations/bulk",
    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- Linear admin repair route validates input, adopts existing ops, or enqueues one result per uid.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Partial<{
          uids: unknown;
          toGatewayId: unknown;
          targetGatewayId: unknown;
          sourceGatewayId: unknown;
        }>;
        const uids = Array.isArray(body.uids)
          ? body.uids.filter((uid): uid is string => typeof uid === "string" && uid.length > 0)
          : [];
        const toGatewayId = asStringOrNull(body.toGatewayId) ?? asStringOrNull(body.targetGatewayId);
        const sourceGatewayId = asStringOrNull(body.sourceGatewayId);
        if (!toGatewayId) {
          res.status(400).json({ error: "toGatewayId is required" });
          return;
        }
        if (uids.length === 0) {
          res.status(400).json({ error: "uids must contain at least one uid" });
          return;
        }

        // Registration is either doc; readiness comes from the relocated
        // glmGateways/{id}.heartbeat (cutover step 2), not the flat status.
        const target = await readGatewayRegistrationReadiness(store, toGatewayId);
        if (!target.registered) {
          res.status(404).json({ error: "target gateway not registered", gatewayId: toGatewayId });
          return;
        }
        if (target.gatewayClass !== "shared") {
          res.status(400).json({
            error: "manual migration target must be a shared gateway",
            gatewayId: toGatewayId,
          });
          return;
        }
        if (target.status !== "ready") {
          res.status(409).json({
            error: ERR_TARGET_GATEWAY_NOT_READY,
            gatewayId: toGatewayId,
            status: target.status ?? "unknown",
          });
          return;
        }

        const pendingOps = await store.journal.operations.listByStatus(["pending", "running"]);
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const enqueued: Array<{ uid: string; operationId: string }> = [];
        const adopted: Array<{ uid: string; operationId: string }> = [];
        const rejected: Array<{ uid: string; reason: string; currentGatewayId?: string | null }> = [];
        for (const uid of [...new Set(uids)]) {
          const builder = await store.builders.records.get(uid);
          if (!builder) {
            rejected.push({ uid, reason: "user-not-found" });
            continue;
          }
          const currentGatewayId = builder.gateway?.gatewayId ?? null;
          const builderSlug = builder.slug;
          if (currentGatewayId === toGatewayId) {
            rejected.push({ uid, reason: "already-on-target", currentGatewayId });
            continue;
          }
          if (sourceGatewayId && currentGatewayId !== sourceGatewayId) {
            rejected.push({ uid, reason: "source-gateway-mismatch", currentGatewayId });
            continue;
          }
          const existing = pendingOps.find((operation) =>
            operation.kind === OP_KIND_MIGRATE_CUSTOMER &&
            (operation.inputUid === uid || operation.input.uid === uid) &&
            operation.input.toGatewayId === toGatewayId);
          if (existing) {
            adopted.push({ uid, operationId: existing.id });
            continue;
          }
          const operationInput = {
            uid,
            ...(builderSlug ? { builderSlug } : {}),
            ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
            toGatewayId,
            source: "admin-bulk-repair",
          };
          const operationId = await runAdminFleetMutation({
            req,
            what: "migrate builder",
            why: "Admin bulk migration request",
            target: { uid, gatewayId: toGatewayId },
            preActionStatus: { gatewayId: currentGatewayId ?? null },
            mutation: {
              kind: OP_KIND_MIGRATE_CUSTOMER,
              uid,
              ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
              toGatewayId,
              source: "admin-bulk-repair",
            },
            idempotencyScope: `bulk-migration:${uid}`,
            action: async () => createOperation(store, {
              kind: OP_KIND_MIGRATE_CUSTOMER,
              createdBy,
              input: operationInput,
            }),
          });
          enqueued.push({ uid, operationId });
        }

        res.status(202).json({
          targetGatewayId: toGatewayId,
          sourceGatewayId: sourceGatewayId ?? null,
          enqueued,
          adopted,
          rejected,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

function activeDistributionGateways(
  glmById: ReadonlyMap<string, GlmDoc>,
  rootsById: ReadonlyMap<string, unknown>,
): Map<string, { status: string; mountedCustomers: Set<string>; mountedCount: number }> {
  const gateways = new Map<
    string,
    { status: string; mountedCustomers: Set<string>; mountedCount: number }
  >();
  for (const gatewayId of new Set([...glmById.keys(), ...rootsById.keys()])) {
    if (projectDesiredStatus(glmById.get(gatewayId)) === "retired") continue;
    const hb = effectiveHeartbeatDoc(gatewayId, glmById.get(gatewayId))?.data();
    const mounted = [...readMountedSlugs(hb)];
    gateways.set(gatewayId, {
      status: typeof hb?.status === "string" ? hb.status : "unknown",
      mountedCustomers: new Set(mounted),
      mountedCount: mounted.length,
    });
  }
  return gateways;
}

router.get(
    "/customer-distribution",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [roots, runtimes, builders, accountsByUid] = await Promise.all([
          store.gateways.roots.list(),
          store.fleetRegistry.list(),
          store.builders.records.listAll(),
          accounts.list(),
        ]);

        const rootsById = new Map(roots.map((root) => [root.gatewayId, root]));
        const glmById = indexAdminGatewayRuntimeDocs(fleetGatewayDocs({ roots, runtimes }));
        const gateways = activeDistributionGateways(glmById, rootsById);

        const assignedByGateway = new Map<string, number>();
        const mountedByGateway = new Map<string, number>();
        const pendingPlacements: PendingPlacement[] = [];
        let totalBuilders = 0;
        let assigned = 0;
        let unassigned = 0;
        let mounted = 0;

        for (const doc of builderUserDocs(builders, accountsByUid)) {
          const data = doc.data();
          if (!userSlug(data)) continue;
          totalBuilders++;
          const placement = classifyUserPlacement(
            doc.id,
            data,
            gateways,
          );
          if (placement.pending) pendingPlacements.push(placement.pending);
          if (placement.kind === "unassigned") {
            unassigned++;
          } else if (placement.kind !== "orphan" && placement.gid) {
            assigned++;
            assignedByGateway.set(
              placement.gid,
              (assignedByGateway.get(placement.gid) ?? 0) + 1,
            );
            if (placement.kind === "mounted") {
              mounted++;
              mountedByGateway.set(
                placement.gid,
                (mountedByGateway.get(placement.gid) ?? 0) + 1,
              );
            }
          }
        }

        const perGateway = Array.from(gateways.entries()).map(
          ([gatewayId, gw]) => ({
            gatewayId,
            status: gw.status,
            assignedCount: assignedByGateway.get(gatewayId) ?? 0,
            mountedCount: mountedByGateway.get(gatewayId) ?? 0,
          }),
        );

        res.json({
          stats: {
            totalBuilders,
            assigned,
            unassigned,
            mounted,
            assignedNotMounted: assigned - mounted,
          },
          perGateway,
          pendingPlacements,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/gateways/:id/details",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const [runtime, builders, accountsByUid, gatewayOperations] = await Promise.all([
          readDurableGatewayRuntime(store, id),
          store.builders.records.listAll(),
          accounts.list(),
          store.journal.operations.listByGateway(id, 50),
        ]);
        if (!runtime) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const mountedSlugs = readMountedSlugs(runtime.heartbeat ?? {});

        const mountedCustomers: DrawerMountedCustomer[] = [];
        for (const doc of builderUserDocs(builders, accountsByUid)) {
          const data = doc.data();
          const slug = userSlug(data);
          if (!slug || !mountedSlugs.has(slug)) continue;
          mountedCustomers.push(buildMountedCustomer(doc.id, data, slug));
        }
        mountedCustomers.sort((a, b) => a.slug.localeCompare(b.slug));

        const recentOperations = operationDocs(gatewayOperations)
          .map((d) => shapeDrawerOperation(d.id, d.data()))
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          .slice(0, 20);

        res.json({
          mountedCustomers,
          recentOperations,
          control: projectGatewayControl(
            runtime.root,
            runtime.runtime ? { ...runtime.runtime } : undefined,
          ),
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/customers/:uid/assign",
    // eslint-disable-next-line complexity -- linear request validation and one repair fast-path; each branch returns its own operator-facing response.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const body = req.body as Partial<{ gatewayId: string }>;
        if (!body.gatewayId || typeof body.gatewayId !== "string") {
          res.status(400).json({ error: "missing gatewayId in body" });
          return;
        }
        const targetGatewayId = body.gatewayId;
        const builder = await store.builders.records.get(uid);
        if (!builder) {
          res.status(404).json({ error: ERR_USER_NOT_FOUND, uid });
          return;
        }
        const target = await readDurableGatewayRuntime(store, targetGatewayId);
        if (!target) {
          res.status(404).json({
            error: ERR_GATEWAY_NOT_FOUND,
            gatewayId: targetGatewayId,
          });
          return;
        }
        if (target.root.gatewayClass !== "shared") {
          res.status(400).json({
            error: "Builder gateway placement is managed by the disposable lifecycle",
            gatewayId: targetGatewayId,
          });
          return;
        }
        if (target.root.desiredStatus !== "running") {
          res.status(409).json({
            error: ERR_TARGET_GATEWAY_NOT_READY,
            gatewayId: targetGatewayId,
            status: target.root.desiredStatus,
          });
          return;
        }
        const targetStatus = asStringOrNull(target.heartbeat?.status);
        if (targetStatus !== "ready") {
          res.status(409).json({
            error: ERR_TARGET_GATEWAY_NOT_READY,
            gatewayId: body.gatewayId,
            status: targetStatus ?? "unknown",
          });
          return;
        }
        const currentGid = builder.gateway?.gatewayId;
        const controlState = resolveUserGatewayControlState(
          {
            gatewayClass: target.root.gatewayClass,
            profile: target.root.profile ?? undefined,
            imageProfile: target.root.imageProfile,
            ownerUid: target.root.ownerUid ?? undefined,
            builderAccess: target.root.builderAccess ?? undefined,
          },
          uid,
        );
        const gatewayProfile = controlState.gatewayProfile;
        const slug = builder.slug;
        if (!slug) {
          res.status(409).json({
            error: "customer has no canonical slug",
            uid,
          });
          return;
        }
        const placement = await runAdminFleetMutation({
          req,
          what: "assign builder to gateway",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid, gatewayId: targetGatewayId },
          preActionStatus: { gatewayId: currentGid ?? null },
          mutation: {
            kind: "assign-customer",
            uid,
            gatewayId: targetGatewayId,
            assignmentWrite: currentGid === targetGatewayId ? "create-if-missing" : "upsert",
          },
          classifyResult: (result) => result.kind === "rejected"
            ? { outcome: "failed", error: `target revision not placeable: ${result.reason}` }
            : { outcome: "completed" },
          action: async () => commitAdminPlacementInStore(store, {
            uid,
            slug,
            now: Date.now(),
            assignmentWrite: currentGid === targetGatewayId ? "create-if-missing" : "upsert",
            mirror: {
              gatewayId: targetGatewayId,
              gatewayProfile,
              controlUiEnabled: controlState.controlUiEnabled,
            },
          }),
        });
        if (placement.kind === "rejected") {
          res.status(409).json({
            error: `target revision not placeable: ${placement.reason}`,
            gatewayId: targetGatewayId,
            reason: placement.reason,
          });
          return;
        }
        res.status(currentGid === targetGatewayId ? 200 : 202).json({
          uid,
          gatewayId: targetGatewayId,
          gatewayProfile,
          ...(currentGid === targetGatewayId ? { repaired: true } : {}),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/customers/:uid/activation-lease/cancel",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = isPlainRecord(req.body) ? req.body : {};
        const allowed = new Set(["leaseId", "generation"]);
        if (
          Object.keys(body).some((key) => !allowed.has(key)) ||
          typeof body.leaseId !== "string" ||
          !Number.isSafeInteger(body.generation) ||
          (body.generation as number) <= 0
        ) {
          res.status(400).json({ error: "leaseId and generation are required" });
          return;
        }
        const uid = req.params.uid as string;
        const leaseId = body.leaseId;
        const generation = body.generation as number;
        const outcome = await runAdminFleetMutation({
          req,
          what: "cancel builder activation lease",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid, leaseId, generation },
          preActionStatus: {},
          mutation: { kind: "cancel-activation-lease", uid, leaseId, generation },
          classifyResult: classifyReasonedActivationLeaseMutation,
          action: async () => store.transaction({ label: "admin.fleet.cancelActivationLease" }, async (transaction) => {
            const builder = await transaction.builders.records.get(uid);
            if (!builder) return { kind: "not-found" as const };
            const lease = builder.activationLease;
            if (
              !lease ||
              lease.leaseId !== leaseId ||
              lease.generation !== generation
            ) {
              return {
                kind: "conflict" as const,
                reason: "lease generation changed",
              };
            }
            if (
              lease.status !== "requested" ||
              asStringOrNull(lease.targetGatewayId) !== null ||
              asStringOrNull(lease.activationOperationId) !== null
            ) {
              return {
                kind: "conflict" as const,
                reason: "activation request has already allocated a disposable runtime",
              };
            }
            await transaction.builders.records.setActivationLease(uid, { clear: true }, { leaseId, generation });
            return { kind: "cancelled" as const };
          }),
        });
        if (outcome.kind === "not-found") {
          res.status(404).json({ error: ERR_USER_NOT_FOUND, uid });
          return;
        }
        if (outcome.kind === "conflict") {
          res.status(409).json({ error: outcome.reason });
          return;
        }
        res.status(200).json({ status: "cancelled", leaseId, generation });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/customers/:uid/activation-lease/terminate",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = isPlainRecord(req.body) ? req.body : {};
        const allowed = new Set(["leaseId", "generation"]);
        if (
          Object.keys(body).some((key) => !allowed.has(key)) ||
          typeof body.leaseId !== "string" ||
          !Number.isSafeInteger(body.generation) ||
          (body.generation as number) <= 0
        ) {
          res.status(400).json({ error: "leaseId and generation are required" });
          return;
        }
        const uid = req.params.uid as string;
        const actor = req as ActorRequest;
        const leaseId = body.leaseId;
        const generation = body.generation as number;
        const now = Date.now();
        const sharedPoolConfig = await store.transaction(
          { label: "admin.fleet.terminateSharedPool", readOnly: true },
          readSharedGatewayPoolConfigInStore,
        );
        if (sharedPoolConfig === null) {
          res.status(409).json({ error: "shared pool has no members" });
          return;
        }
        const outcome = await runAdminFleetMutation({
          req,
          what: "terminate builder activation lease",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid, leaseId, generation },
          preActionStatus: { defaultGatewayId: sharedPoolConfig.defaultGatewayId },
          mutation: { kind: "terminate-activation-lease", uid, leaseId, generation },
          classifyResult: classifyActivationLeaseTermination,
          action: async () => store.transaction({ label: "admin.fleet.terminateActivationLease" }, (transaction) =>
            requestActivationLeaseTermination(transaction, {
              uid,
              leaseId,
              generation,
              sharedGatewayIds: sharedPoolConfig.sharedGatewayIds,
              requestedAt: now,
              requestedBy: actor.uid ?? "unknown",
            })
          ),
        });
        if (outcome.kind === "not-found") {
          res.status(404).json({ error: ERR_USER_NOT_FOUND, uid });
          return;
        }
        if (outcome.kind === "conflict") {
          res.status(409).json({ error: outcome.reason });
          return;
        }
        res.status(outcome.kind === "adopted" ? 200 : 202).json({
          status: "termination-requested",
          leaseId,
          generation,
          ...(outcome.kind === "adopted" ? { adopted: true } : {}),
        });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/customers/:uid/activation-lease/return",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = isPlainRecord(req.body) ? req.body : {};
        const allowed = new Set(["leaseId", "generation"]);
        if (
          Object.keys(body).some((key) => !allowed.has(key)) ||
          typeof body.leaseId !== "string" ||
          !Number.isSafeInteger(body.generation) ||
          (body.generation as number) <= 0
        ) {
          res.status(400).json({ error: "leaseId and generation are required" });
          return;
        }
        const uid = req.params.uid as string;
        const actor = req as ActorRequest;
        const requestedAt = Date.now();
        const outcome = await runAdminFleetMutation({
          req,
          what: "return builder activation lease",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid, leaseId: body.leaseId, generation: body.generation },
          preActionStatus: {},
          mutation: {
            kind: "return-activation-lease",
            uid,
            leaseId: body.leaseId,
            generation: body.generation,
          },
          classifyResult: classifyActivationLeaseReturn,
          action: async () => store.transaction({ label: "admin.fleet.returnActivationLease" }, async (transaction) => {
            const builder = await transaction.builders.records.get(uid);
            if (!builder) return { kind: "not-found" as const };
            const lease = builder.activationLease;
            if (
              !lease ||
              lease.leaseId !== body.leaseId ||
              lease.generation !== body.generation ||
              lease.status !== "active"
            ) {
              return {
                kind: "conflict" as const,
                status: asStringOrNull(lease?.status),
              };
            }
            if (toMillis(lease.returnRequestedAt) !== null) {
              return { kind: "adopted" as const };
            }
            await transaction.builders.records.patchActivationLease(uid, {
              returnRequestedAt: requestedAt,
              returnRequestedBy: actor.uid ?? "unknown",
            }, { leaseId: lease.leaseId, generation: lease.generation });
            return { kind: "requested" as const };
          }),
        });
        if (outcome.kind === "not-found") {
          res.status(404).json({ error: ERR_USER_NOT_FOUND, uid });
          return;
        }
        if (outcome.kind === "conflict") {
          res.status(409).json({
            error: "activation lease is not the requested active generation",
            status: outcome.status,
          });
          return;
        }
        res.status(outcome.kind === "adopted" ? 200 : 202).json({
          status: "return-requested",
          leaseId: body.leaseId,
          generation: body.generation,
          ...(outcome.kind === "adopted" ? { adopted: true } : {}),
        });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/customers/:uid/activation-lease/return/retry",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = isPlainRecord(req.body) ? req.body : {};
        if (
          Object.keys(body).length !== 1 ||
          typeof body.operationId !== "string" ||
          body.operationId.length === 0
        ) {
          res.status(400).json({ error: "operationId is required" });
          return;
        }
        const operationId = body.operationId;
        const uid = req.params.uid as string;
        const inFlight = await findInFlightMigrateOp(uid);
        if (inFlight) {
          res.status(409).json({
            error: "a migration for this customer is already pending or running",
            operationId: inFlight.id,
            uid,
          });
          return;
        }
        const outcome = await runAdminFleetMutation({
          req,
          what: "retry builder activation lease return",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid, operationId },
          preActionStatus: {},
          mutation: {
            kind: "retry-return-activation-lease",
            uid,
            operationId,
          },
          classifyResult: classifyReasonedActivationLeaseMutation,
          action: async () => {
            const input = { uid, operationId, requestedAt: Date.now(), requestedBy: (req as ActorRequest).uid ?? "unknown" };
            const ordinary = await store.transaction(
              { label: "admin.fleet.retryActivationLeaseReturn" },
              (transaction) => retryActivationLeaseReturn(transaction, input),
            );
            if (ordinary.kind === "conflict" && await deps.requestNativeReturnSourceRecovery?.(input)) return { kind: "retried" as const };
            return ordinary;
          },
        });
        if (outcome.kind === "not-found") {
          res.status(404).json({ error: ERR_USER_NOT_FOUND, uid });
          return;
        }
        if (outcome.kind === "conflict") {
          res.status(409).json({ error: outcome.reason });
          return;
        }
        res.status(202).json({ status: "return-retried", operationId });
      } catch (e) {
        next(e);
      }
    },
  );

router.post(
    "/customers/:uid/activation-lease",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();
        const builder = await store.builders.records.get(uid);
        if (!builder) {
          res.status(404).json({ error: ERR_USER_NOT_FOUND, uid });
          return;
        }
        const reportingGatewayId = builder.gateway?.gatewayId ?? null;
        const assignment = reportingGatewayId
          ? await store.gateways.assignments.get(reportingGatewayId, uid)
          : null;
        const assignmentEpoch = assignment?.epoch;
        const result = await runAdminFleetMutation({
          req,
          what: "request builder activation lease",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid },
          preActionStatus: {
            gatewayId: reportingGatewayId ?? null,
            assignmentEpoch: assignmentEpoch ?? null,
          },
          mutation: { kind: "request-activation-lease", uid },
          classifyResult: (result) => result.statusCode >= 400
            ? {
                outcome: "failed",
                error: typeof result.body.error === "string"
                  ? result.body.error
                  : `activation lease request returned ${result.statusCode}`,
              }
            : { outcome: "completed" },
          action: async () => requestBuilderActivationLease({
            store,
            readBuilderTier,
            uid,
            reportingGatewayId: reportingGatewayId ?? undefined,
            assignmentEpoch,
            eventKey: `manual:${createdBy}:${now}`,
            cause: "manual",
            observedAt: now,
            createdBy,
            now,
          }),
        });
        res.status(result.statusCode).json(result.body);
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();

        const bodyError = gatewayCreationBodyError(
          (req.body ?? {}) as Record<string, unknown>,
        );
        if (bodyError) {
          res.status(bodyError.status).json(bodyError.body);
          return;
        }

        const parsed = validateAddGatewayBody(req.body as Partial<AddGatewayBody>);
        if ("error" in parsed) {
          res.status(parsed.error.status).json(parsed.error.body);
          return;
        }
        const body = parsed.ok;

        const uniqueness = await ensureGatewayCreateIsUnique(store, body);
        if ("error" in uniqueness) {
          res.status(uniqueness.error.status).json(uniqueness.error.body);
          return;
        }

        const gatewayServiceAccount = process.env.GATEWAY_SERVICE_ACCOUNT;
        if (!gatewayServiceAccount) {
          res.status(500).json({
            error:
              "GATEWAY_SERVICE_ACCOUNT not configured — admin cannot provision gateway auth-token secret",
          });
          return;
        }
        const gatewayClass = resolveGatewayClass(body);
        const imageProfile = resolveGatewayImageProfile(body);
        const config = buildCreateGatewayConfig({
          body,
          gatewayClass,
          imageProfile,
        });
        const artifact = buildCreateArtifact(body);
        let operationId: string;
        try {
          const result = await runAdminFleetMutation({
            req,
            what: "add gateway",
            why: ADMIN_FLEET_REQUEST_REASON,
            target: { gatewayId: body.gatewayId },
            preActionStatus: { exists: false },
            mutation: {
              kind: "add-gateway",
              gatewayId: body.gatewayId,
              imageTag: body.imageTag,
              gatewayClass,
              imageProfile,
              desiredStatus: "running",
            },
            classifyResult: (outcome) =>
              classifyAddGatewayMutation(outcome, body.gatewayId, artifact),
            action: async () => performAddGatewayMutation({
              store,
              provisionGatewayAuthSecret: deps.provisionGatewayAuthSecret,
              gatewayServiceAccount,
              body,
              gatewayClass,
              imageProfile,
              config,
              artifact,
              createdBy,
              now,
            }),
          });
          if (result.kind === "partial") throw result.error;
          operationId = result.operationId;
        } catch (e) {
          if (respondToAddGatewayMutationError(e, res, body.gatewayId)) return;
          throw e;
        }
        res
          .status(202)
          .json({ gatewayId: body.gatewayId, operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  router.patch(
    "/gateways/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const stored = await store.gateways.roots.get(id);
        if (!stored) {
          res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const root = durableRootOf(stored, id);
        if (!root) {
          res.status(409).json({ error: "gateway durable root is invalid", gatewayId: id });
          return;
        }
        const built = buildDurableGatewayPatch({
          gatewayId: id,
          current: root,
          body,
        });
        if ("error" in built) {
          res.status(built.error.status).json(built.error.body);
          return;
        }
        const updatedBy = (req as ActorRequest).uid ?? "unknown";
        const patchResult = await runAdminFleetMutation({
          req,
          what: "update gateway desired configuration",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { gatewayId: id },
          preActionStatus: {
            desiredStatus: root.desiredStatus,
            desiredRelease: root.desiredRelease,
          },
          mutation: { kind: "patch-gateway", gatewayId: id, patch: built.ok.patch },
          classifyResult: (result) => result.ok
            ? { outcome: "completed" }
            : { outcome: "failed", error: result.error },
          action: async () => store.transaction({ label: "admin.fleet.patchGateway" }, async (transaction) => {
            const [currentStored, activeOperations] = await Promise.all([
              transaction.gateways.roots.get(id),
              transaction.journal.operations.listByStatus(["pending", "running"]),
            ]);
            const current = durableRootOf(currentStored, id);
            if (!current) return { ok: false as const, error: ERR_GATEWAY_NOT_FOUND };
            if (current.desiredStatus === "retired" || current.retirementClaim != null) {
              return {
                ok: false as const,
                error: "gateway has a current retirement claim",
              };
            }
            const migrationConflict = findActiveGatewayMigration(id, activeOperations.map(migrationLockRef));
            if (migrationConflict) {
              return {
                ok: false as const,
                error: `customer migration is in flight for gateway ${id}`,
              };
            }
            try {
              await assertGatewayRuntimeMutationUnfencedInStore(transaction, id);
            } catch (error) {
              if (!(error instanceof GatewayRetirementConflictError)) throw error;
              return { ok: false as const, error: error.message };
            }
            await transaction.gateways.roots.patch(id, {
              ...built.ok.patch,
              updatedAt: Date.now(),
              updatedBy,
            });
            return { ok: true as const };
          }),
        });
        if (!patchResult.ok) {
          res.status(409).json({ error: patchResult.error, gatewayId: id });
          return;
        }
        res.status(202).json({ gatewayId: id, updated: Object.keys(built.ok.patch) });
      } catch (e) {
        next(e);
      }
    },
  );

  router.delete(
    "/gateways/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const retainData = isTruthyQueryFlag(req.query.retainData);
        const retainServiceAccount = isTruthyQueryFlag(req.query.retainServiceAccount);
        const runtime = await readDurableGatewayRuntime(store, id);
        if (!runtime) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const disposable = projectDisposableRuntime(
          runtime.root as unknown as GlmDoc,
        );
        if (disposable) {
          res.status(409).json({
            error:
              "disposable gateway termination is owned by the Builder runtime lifecycle",
            gatewayId: id,
          });
          return;
        }
        const retirementBlocker = gatewayRetirementBlocker(id, runtime);
        if (retirementBlocker) {
          res.status(409).json(retirementBlocker);
          return;
        }
        // Refuse synchronously while any customer is still assigned — the
        // controller's retire arm enforces the same gate, but a 409 here spares
        // the operator a marked-retired-then-blocked gateway.
        const assignments = await store.gateways.assignments.list(id);
        if (assignments.length > 0) {
          res.status(409).json({
            error:
              "gateway still has assigned customers; migrate them off before retiring",
            gatewayId: id,
            assignedCustomers: assignments.map((a) => a.slug),
          });
          return;
        }
        const mounted = [...readMountedSlugs(runtime.heartbeat ?? undefined)];
        if (mounted.length > 0) {
          res.status(409).json({
            error:
              "gateway still has mounted customers; migrate them off before retiring",
            gatewayId: id,
            mountedCustomers: mounted,
          });
          return;
        }

        const operationId = randomUUID();
        const createdAt = Date.now();
        try {
          await runAdminFleetMutation({
            req,
            what: "retire gateway",
            why: ADMIN_FLEET_REQUEST_REASON,
            target: { gatewayId: id },
            preActionStatus: {
              desiredStatus: runtime.root.desiredStatus,
              desiredRelease: runtime.root.desiredRelease,
            },
            mutation: {
              kind: "retire-gateway",
              gatewayId: id,
              ...(retainData ? { retainData: true } : {}),
              ...(retainServiceAccount ? { retainServiceAccount: true } : {}),
            },
            action: async () => claimGatewayRetirementInStore({
              store,
              gatewayId: id,
              operationId,
              operation: {
                kind: "retire-gateway",
                status: "pending",
                createdBy,
                createdAt,
                startedAt: null,
                completedAt: null,
                input: {
                  gatewayId: id,
                  ...(retainData ? { retainData: true } : {}),
                  ...(retainServiceAccount ? { retainServiceAccount: true } : {}),
                },
                steps: [],
                gatewayId: id,
              },
              now: createdAt,
              updatedBy: createdBy,
            }),
          });
        } catch (error) {
          if (error instanceof GatewayRetirementConflictError) {
            res.status(409).json({ error: error.message, gatewayId: id });
            return;
          }
          throw error;
        }
        res.status(202).json({ gatewayId: id, operationId, retainData, retainServiceAccount });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post("/gateways/:id/recover-source", async (req, res, next) => {
    try {
      const gatewayId = req.params.id as string, body = req.body ?? {}, sourceSha = body.sourceSha, predecessorId = body.supersedeRecoveryId;
      if (!validSourceRecoveryBody(body)) {
        res.status(400).json({ error: "sourceSha is required" }); return;
      }
      if (!deps.releaseAuthority) { res.status(503).json({ error: "immutable build manifests are unavailable" }); return; }
      const captured = await store.transaction({ label: "admin.fleet.recoverSource", readOnly: true }, async transaction => predecessorId === undefined
        ? { source: await readSharedSourceRecoveryAuthority(transaction, gatewayId), supersede: undefined }
        : readSharedSourceRecoverySupersession(transaction, gatewayId, predecessorId));
      const { source, supersede } = captured;
      const manifest = await centralManifestForSourceSha(deps.releaseAuthority, sourceSha);
      const payload = centralGatewayReleasePayload(manifest);
      if (supersede) {
        const priorPayload = centralGatewayReleasePayload(await centralManifestForSourceSha(deps.releaseAuthority, supersede.input.sourceRecovery.sourceSha));
        const priorImages = { gateway: `${priorPayload.imageRepository}:${priorPayload.imageTag}`,
          "gateway-edge": `${priorPayload.gatewayEdgeImage!.imageRepository}:${priorPayload.gatewayEdgeImage!.imageTag}` };
        if (priorPayload.openclawSourceSha !== payload.openclawSourceSha || !isDeepStrictEqual(priorImages, supersede.input.sourceRecovery.images)) {
          throw new SharedSourceRecoveryConflict("source recovery predecessor immutable build changed");
        }
      }
      const input = { gatewayId, sourceRecovery: { sourceSha, ...source, ...(source.postgresAgentStores ? { payload } : {}), ...(supersede ? { supersede } : {}), images: {
        gateway: `${payload.imageRepository}:${payload.imageTag}`,
        "gateway-edge": `${payload.gatewayEdgeImage!.imageRepository}:${payload.gatewayEdgeImage!.imageTag}`,
      } } };
      const operationId = await runAdminFleetMutation({ req, what: "repair Shared source before export", why: ADMIN_FLEET_REQUEST_REASON,
        target: { gatewayId }, preActionStatus: source.root, mutation: input,
        action: async () => createOperation(store, { kind: OP_KIND_RESTART_GATEWAY, createdBy: (req as ActorRequest).uid ?? "unknown", input }) });
      res.status(202).json({ gatewayId, sourceSha, operationId });
    } catch (error) {
      if (error instanceof SharedSourceRecoveryConflict) { res.status(409).json({ error: error.message }); return; }
      if (respondCentralReleaseError(res, error)) return;
      next(error);
    }
  });

  router.post("/gateways/:id/recover-restore", async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const body = req.body ?? {};
      const { sourceSha, operationId, reauthorizeAttemptId, supersedeRecoveryId } = body;
      if (!validRestoreRecoveryBody(body)) {
        res.status(400).json({ error: "sourceSha and restore operationId are required" }); return;
      }
      const gateway = await readGatewayDoc(store, id);
      if (!gateway || gateway.gatewayClass !== "shared" || gateway.desiredStatus === "retired") {
        res.status(409).json({ error: "restore recovery requires a live Shared gateway" }); return;
      }
      if (!deps.releaseAuthority) { res.status(503).json({ error: "immutable build manifests are unavailable" }); return; }
      const reauthorize = await capturedRestoreAttempt(store, operationId, reauthorizeAttemptId);
      if (reauthorizeAttemptId !== undefined && reauthorize?.attemptId !== reauthorizeAttemptId) {
        res.status(409).json({ error: "retained restore attempt changed" }); return;
      }
      const supersede = supersedeRecoveryId === undefined ? undefined :
        await capturedRecoveryPredecessor(store, id, operationId, supersedeRecoveryId, reauthorize);
      if (supersedeRecoveryId !== undefined && !supersede) {
        res.status(409).json({ error: "failed restore recovery predecessor changed" }); return;
      }
      const manifest = await centralManifestForSourceSha(deps.releaseAuthority, sourceSha);
      const payload = centralGatewayReleasePayload(manifest);
      const input = restoreRecoveryOperationInput({ gatewayId: id, operationId, sourceSha, payload, reauthorize, supersede });
      const queued = await runAdminFleetMutation({ req, what: "recover fenced Shared restore runtime", why: ADMIN_FLEET_REQUEST_REASON,
        target: { gatewayId: id, operationId }, preActionStatus: { desiredRelease: gateway.desiredRelease },
        mutation: input, action: async () => createOperation(store, {
          kind: OP_KIND_RESTART_GATEWAY, createdBy: (req as ActorRequest).uid ?? "unknown", input,
        }) });
      res.status(202).json({ gatewayId: id, sourceSha, operationId: queued });
    } catch (error) {
      if (respondCentralReleaseError(res, error)) return;
      next(error);
    }
  });

  router.post(
    "/gateways/:id/restart",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const gateway = await readGatewayDoc(store, id);
        if (!gateway) {
          res
            .status(404)
            .json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        if (gateway.desiredStatus === "retired") {
          res.status(409).json({ error: "cannot restart a retired gateway", gatewayId: id });
          return;
        }

        const conflicting = await findConflictingGatewayOp(store, id);
        if (conflicting) {
          res.status(409).json({
            error: ERR_GATEWAY_OPERATION_IN_FLIGHT,
            gatewayId: id,
            operationId: conflicting.id,
            kind: conflicting.kind,
          });
          return;
        }

        const operationId = await runAdminFleetMutation({
          req,
          what: "restart gateway",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { gatewayId: id },
          preActionStatus: {
            desiredStatus: gateway.desiredStatus,
            desiredRelease: gateway.desiredRelease,
          },
          mutation: { kind: "restart-gateway", gatewayId: id },
          action: async () => createOperation(store, {
            kind: "restart-gateway",
            createdBy: (req as ActorRequest).uid ?? "unknown",
            input: { gatewayId: id },
          }),
        });
        res.status(202).json({ gatewayId: id, operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways/:id/deploy",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const validation = validateDeployBody(req.body);
        if ("error" in validation) {
          res.status(validation.error.status).json(validation.error.body);
          return;
        }
        const gateway = await readGatewayDoc(store, id);
        if (!gateway) {
          res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        if (gateway.desiredStatus === "retired") {
          res.status(409).json({ error: "cannot deploy to a retired gateway", gatewayId: id });
          return;
        }
        if (gateway.gatewayClass === "shared") {
          res.status(409).json({ error: ERR_SHARED_POOL_RIDES_PLATFORM_RELEASE, gatewayId: id });
          return;
        }
        if (!deps.releaseEnvironment || !deps.releaseAuthority) {
          res.status(503).json({ error: "immutable build manifests are unavailable" });
          return;
        }
        const { sourceSha } = validation.ok;
        const manifest = await centralManifestForSourceSha(deps.releaseAuthority, sourceSha);
        const payload = centralGatewayReleasePayload(manifest);
        const artifact = gatewayArtifactFromReleasePayload(payload);
        const actor = req as ActorRequest;
        let deployed: { release: number; operationId: string | null };
        try {
          deployed = await runAdminFleetMutation({
            req,
            what: "deploy build to gateway",
            why: ADMIN_FLEET_REQUEST_REASON,
            target: { gatewayId: id },
            preActionStatus: {
              desiredStatus: gateway.desiredStatus,
              desiredRelease: gateway.desiredRelease,
              latestRelease: gateway.latestRelease,
            },
            mutation: {
              kind: "deploy-gateway-build",
              gatewayId: id,
              sourceSha,
              manifestDigest: manifest.manifestDigest,
            },
            action: async () => appendGatewayRelease(store, {
              gateway,
              artifact,
              payload,
              createdBy: actor.uid ?? "unknown",
              origin: "operator",
              now: Date.now(),
              sourceRelease: gateway.latestRelease,
              note: `operator deployment of ${sourceSha}`,
            }),
          });
        } catch (error) {
          if (respondCentralReleaseError(res, error)) return;
          throw error;
        }
        res.status(202).json({
          gatewayId: id,
          sourceSha,
          release: deployed.release,
          operationId: deployed.operationId,
        });
      } catch (error) {
        if (respondCentralReleaseError(res, error)) return;
        next(error);
      }
    },
  );

  router.get(
    "/gateways/:id/releases",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const gateway = await readGatewayDoc(store, id);
        if (!gateway) {
          res.status(404).json({ error: ERR_GATEWAY_NOT_FOUND, gatewayId: id });
          return;
        }
        const docs = await store.gateways.releases.list(id, "desc");
        const history = projectReleaseHistory({ gateway, releases: [...docs] });
        const payloadByRelease = new Map(docs.map((r) => [r.release, r.payload]));
        const releases = history.map((entry) => ({
          ...entry,
          payload: payloadByRelease.get(entry.release) ?? null,
        }));
        res.json({
          gatewayId: id,
          latestRelease: gateway.latestRelease,
          desiredRelease: gateway.desiredRelease,
          liveRelease: gateway.liveRelease,
          releases,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/gateways/:id/releases/:n/rollback",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const now = Date.now();
        const body = (req.body ?? {}) as Record<string, unknown>;
        const resolved = await resolveRollbackRelease({
          store,
          gatewayId: id,
          requestedRelease: req.params.n,
          body,
        });
        if ("error" in resolved) {
          res.status(resolved.error.status).json(resolved.error.body);
          return;
        }
        const { gateway, artifact, release, note } = resolved.ok;
        let appended: { release: number; operationId: string | null };
        try {
          appended = await runAdminFleetMutation({
            req,
            what: "roll back gateway release",
            why: ADMIN_FLEET_REQUEST_REASON,
            target: { gatewayId: id, release },
            preActionStatus: {
              latestRelease: gateway.latestRelease,
              desiredRelease: gateway.desiredRelease,
            },
            mutation: {
              kind: "rollback-gateway-release",
              gatewayId: id,
              sourceRelease: release,
              artifact,
              note,
            },
            action: async () => appendGatewayRelease(store, {
              gateway,
              artifact,
              createdBy,
              origin: "operator",
              now,
              sourceRelease: release,
              note,
            }),
          });
        } catch (e) {
          if (respondReleaseWriteConflict(res, e)) return;
          throw e;
        }
        res
          .status(202)
          .json({ gatewayId: id, ...appended, rolledBackFrom: release });
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/customers/by-slug/:slug",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const slug = req.params.slug as string;
        const builder = await store.builders.records.findBySlug(slug);
        if (builder) {
          res.json({ uid: builder.uid, currentGatewayId: builder.gateway?.gatewayId ?? null });
          return;
        }
        res.status(404).json({ error: "customer not found", slug });
      } catch (e) {
        next(e);
      }
    },
  );

  async function findInFlightMigrateOp(
    uid: string,
  ): Promise<{ id: string } | null> {
    const operation = (await inFlightOperationsForUid(store, uid)).find(isInFlightCustomerMigration);
    return operation ? { id: operation.id } : null;
  }

  router.patch("/customers/:uid/placement", async (req, res, next) => {
    try {
      const command = (req.body ?? {}) as { managedBy?: unknown; gatewayId?: unknown };
      const park = command.managedBy === "operator" && command.gatewayId === null;
      const release = command.managedBy === "cowboy" && command.gatewayId === undefined;
      if (!park && !release) {
        res.status(400).json({ error: "choose operator with gatewayId=null to park, or cowboy to release" });
        return;
      }
      const uid = req.params.uid as string;
      const before = await store.builders.records.get(uid);
      const outcome = await runAdminFleetMutation({
        req,
        what: park ? "park builder" : "release builder to Cowboy",
        why: ADMIN_FLEET_REQUEST_REASON,
        target: { uid },
        preActionStatus: { gatewayId: before?.gateway?.gatewayId ?? null },
        mutation: { kind: park ? "park-builder" : "place-builder", uid },
        classifyResult: result => result.status >= 400
          ? { outcome: "failed", error: String(result.body.error) }
          : { outcome: "completed" },
        action: () => store.transaction({ label: "admin.fleet.customerPlacement" }, async (transaction): Promise<{ status: number; body: Record<string, unknown> }> => {
          const [builder, operations] = await Promise.all([
            transaction.builders.records.get(uid),
            inFlightOperationsForUid(transaction, uid),
          ]);
          if (!builder) return { status: 404, body: { error: ERR_USER_NOT_FOUND, uid } };
          if (builderRuntimeMutationFenced(builder)) return { status: 409, body: { error: "customer restore or source transfer is unresolved — cannot change placement", uid } };
          const inFlight = operations.find(isInFlightCustomerMigration);
          if (inFlight) return { status: 409, body: { error: "customer migration is pending or running — cannot change placement", operationId: inFlight.id, uid } };
          const gatewayId = builder.gateway?.gatewayId ?? null;
          if (park && parkingHasUnsettledAllocation(builder.activationLease, gatewayId)) {
            return { status: 409, body: { error: "allocated activation target must settle before parking", uid } };
          }
          const gateway = await updateOperatorParkingGateway(transaction, { gatewayId, uid, actor: (req as ActorRequest).uid, park });
          if (gateway.error) return { status: 409, body: { error: gateway.error, uid } };
          if (release) {
            const provisioningComplete = (builder.provisioning.status ?? builder.openclaw.status) === "complete";
            await transaction.builders.records.patch(uid, {
              openclaw: { managedBy: "cowboy" },
              ...(provisioningComplete ? { provisioning: { status: "complete" } } : {}),
            });
            return { status: 200, body: { uid, managedBy: "cowboy" } };
          }
          await transaction.builders.records.patch(uid, { openclaw: { managedBy: "operator" } });
          if (gateway.dedicated) {
            return { status: 200, body: { uid, parked: true, gatewayId, managedBy: "operator" } };
          }
          await transaction.builders.records.setGatewayMirror(uid, { clear: true });
          return { status: 200, body: { uid, parked: true, managedBy: "operator" } };
        }),
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error) { next(error); }
  });

  router.post(
    "/customers/:uid/migrate",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const body = req.body as Partial<{ to: string }>;
        if (typeof body.to !== "string" || body.to.length === 0) {
          res
            .status(400)
            .json({ error: "missing target gateway", required: ["to"] });
          return;
        }
        const inFlight = await findInFlightMigrateOp(uid);
        if (inFlight) {
          res.status(409).json({
            error:
              "a migration for this customer is already pending or running",
            operationId: inFlight.id,
            uid,
          });
          return;
        }
        // Registration is either doc; readiness comes from the relocated
        // glmGateways/{id}.heartbeat (cutover step 2).
        const target = await readGatewayRegistrationReadiness(store, body.to);
        if (!target.registered) {
          res.status(404).json({
            error: "target gateway not registered",
            gatewayId: body.to,
          });
          return;
        }
        if (target.gatewayClass !== "shared") {
          res.status(400).json({
            error: "manual migration target must be a shared gateway",
            gatewayId: body.to,
          });
          return;
        }
        if (target.status !== "ready") {
          res.status(409).json({
            error: ERR_TARGET_GATEWAY_NOT_READY,
            gatewayId: body.to,
            status: target.status ?? "unknown",
          });
          return;
        }
        const { currentGatewayId, builderSlug } = builderMountOf(await store.builders.records.get(uid));
        if (currentGatewayId === body.to) {
          res.status(409).json({
            error: "customer is already mounted on the target gateway",
            uid,
            gatewayId: body.to,
          });
          return;
        }
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const operationId = await runAdminFleetMutation({
          req,
          what: "migrate builder",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid, gatewayId: body.to },
          preActionStatus: { gatewayId: currentGatewayId ?? null },
          mutation: {
            kind: OP_KIND_MIGRATE_CUSTOMER,
            uid,
            ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
            toGatewayId: body.to,
          },
          action: async () => createOperation(store, {
            kind: OP_KIND_MIGRATE_CUSTOMER,
            createdBy,
            input: {
              uid,
              ...(builderSlug ? { builderSlug } : {}),
              ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
              toGatewayId: body.to,
            },
          }),
        });
        res.status(202).json({ operationId });
      } catch (e) {
        next(e);
      }
    },
  );

  // Clears the customer's gateway placement so they land in pending-placement:
  // deletes gateways/{gw}/assignments/{uid} AND clears the user mirror fields in
  // ONE transaction (same all-or-nothing discipline as commitCutoverAtomic). The
  // guard runs INSIDE that transaction — it re-reads the in-flight migrate ops
  // (a migrate enqueued between check and commit conflicts the txn's query read
  // and retries) and the assignment doc's durable `state`, refusing (409) if a
  // migrate op is pending/running OR the durable roster state is not "serving"
  // (a terminal failed roll can leave the customer quiescing with no live op).
  // Never destructive beyond the placement: the user + workspace stay put.
  router.post(
    "/customers/:uid/unassign",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const userBefore = await store.builders.records.get(uid);
        const preActionGatewayId = userBefore?.gateway?.gatewayId ?? null;
        const outcome = await runAdminFleetMutation({
          req,
          what: "unassign builder from gateway",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { uid },
          preActionStatus: { gatewayId: preActionGatewayId },
          mutation: {
            kind: "unassign-customer",
            uid,
            ...(preActionGatewayId ? { gatewayId: preActionGatewayId } : {}),
          },
          classifyResult: (result) => result.status >= 400
            ? {
                outcome: "failed",
                error: typeof result.body.error === "string"
                  ? result.body.error
                  : `unassign returned ${result.status}`,
              }
            : { outcome: "completed" },
          action: async () => store.transaction({ label: "admin.fleet.unassignCustomer" }, async (transaction): Promise<{
            status: number;
            body: Record<string, unknown>;
            from?: string;
          }> => {
            const builder = await transaction.builders.records.get(uid);
            if (!builder) {
              return { status: 404, body: { error: ERR_USER_NOT_FOUND, uid } };
            }
            if (builderRuntimeMutationFenced(builder)) {
              const action = builder.fences.restoreFence !== undefined ? "restore" : "source transfer";
              return { status: 409, body: { error: `customer ${action} outcome is unresolved — cannot unassign`, uid } };
            }
            const currentGatewayId = builder.gateway?.gatewayId ?? null;
            if (!currentGatewayId) {
              return { status: 409, body: { error: "customer is already unassigned", uid } };
            }
            const [assignment, operations] = await Promise.all([
              transaction.gateways.assignments.get(currentGatewayId, uid),
              inFlightOperationsForUid(transaction, uid),
            ]);
            const inFlight = operations.find(isInFlightCustomerMigration);
            if (inFlight) {
              return {
                status: 409,
                body: {
                  error:
                    "a migration for this customer is pending or running — let it finish or fail before unassigning",
                  operationId: inFlight.id,
                  uid,
                },
              };
            }
            if (assignment && assignment.state !== "serving") {
              return {
                status: 409,
                body: {
                  error: `customer is mid-migration (roster state ${assignment.state}) — cannot unassign until the migration settles`,
                  uid,
                  state: assignment.state,
                },
              };
            }
            await transaction.gateways.assignments.delete(currentGatewayId, uid);
            await transaction.builders.records.setGatewayMirror(uid, { clear: true });
            return {
              status: 200,
              body: {
                unassigned: true,
                uid,
                from: currentGatewayId,
              },
              from: currentGatewayId,
            };
          }),
        });
        if (outcome.status === 200) {
          const actor = (req as ActorRequest).uid ?? "unknown";
          deps.logger.info("admin unassigned customer from gateway", {
            actor,
            uid,
            from: outcome.from,
          });
        }
        res.status(outcome.status).json(outcome.body);
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/rollouts",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Partial<{
          gatewayId: string;
          targetRelease: number;
          imageTag: string;
        }>;
        if (
          typeof body.gatewayId !== "string" ||
          body.gatewayId.length === 0 ||
          typeof body.targetRelease !== "number" ||
          !Number.isSafeInteger(body.targetRelease) ||
          body.targetRelease < 1 ||
          typeof body.imageTag !== "string" ||
          body.imageTag.length === 0
        ) {
          res.status(400).json({
            error: "missing required fields",
            required: ["gatewayId", "targetRelease", "imageTag"],
          });
          return;
        }
        const actor = req as ActorRequest;
        const createdBy = actor.uid ?? "unknown";
        const operationId = await runAdminFleetMutation({
          req,
          what: "roll out gateway image",
          why: ADMIN_FLEET_REQUEST_REASON,
          target: { gatewayId: body.gatewayId },
          preActionStatus: {},
          mutation: {
            kind: "rollout",
            gatewayId: body.gatewayId,
            targetRelease: body.targetRelease,
            imageTag: body.imageTag,
          },
          action: async () => createOperation(store, {
            kind: "rollout",
            createdBy,
            input: {
              gatewayId: body.gatewayId,
              targetRelease: body.targetRelease,
              imageTag: body.imageTag,
            },
          }),
        });
        res.status(202).json({ operationId });
      } catch (e) {
        next(e);
      }
    },
  );


router.get(
    "/builds",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const service = (req.query.service as string) || "octogee-gateway";
        if (!BUILDS_SERVICE_ALLOWLIST.has(service)) {
          res.status(400).json({
            error:
              "service must be one of the canonical Octogee gateway-pod images",
            allowed: [...BUILDS_SERVICE_ALLOWLIST],
            got: service,
          });
          return;
        }
        const parsedLimit = parseInt(
          (req.query.limit as string) ?? "30",
          10,
        );
        const limit = Math.min(
          100,
          Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 30),
        );
        try {
          const builds = await deps.listGatewayBuilds({ service, limit });
          res.json({
            service,
            builds,
            generatedAt: new Date().toISOString(),
          });
        } catch (e) {
          logger.warn("artifact-registry list failed", {
            service,
            error: (e as Error)?.message,
          });
          res.status(502).json({
            error: (e as Error)?.message ?? "artifact-registry list failed",
            service,
          });
        }
      } catch (e) {
        next(e);
      }
    },
  );

router.get(
    "/operations",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const limit = Math.min(
          100,
          Math.max(1, parseInt((req.query.limit as string) ?? "25", 10)),
        );
        const status = req.query.status;
        if (status !== undefined && status !== "unresolved") {
          res.status(400).json({ error: "status must be omitted or \"unresolved\"", got: status });
          return;
        }
        const docs = status === "unresolved"
          ? await listUnresolvedOperationDocs(store, limit)
          : operationDocs((await store.journal.listRecent({ limit })).items);
        const operations = docs.map((doc) =>
          shapeOperationsHistoryRecord(doc.id, doc.data()),
        );
        res.json({ operations, generatedAt: new Date().toISOString() });
      } catch (e) {
        next(e);
      }
    },
  );

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof FleetMutationIdempotencyError) {
      res.status(409).json({
        error: error.message,
        auditId: error.auditId,
        status: error.status,
      });
      return;
    }
    if (error instanceof OperationAuditIdempotencyConflictError) {
      res.status(409).json({
        error: error.message,
        auditId: error.auditId,
      });
      return;
    }
    next(error);
  });

  return router;
}
