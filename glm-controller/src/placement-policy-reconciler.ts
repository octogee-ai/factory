import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import { isDeepStrictEqual } from 'node:util';
import { createServiceLogger } from "@octogee/shared/server/service-logger";
const eventLogger = createServiceLogger("cowboy");
import type {
  Firestore,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { isReapedOperationError, REARMED_RETIRE_OPERATION } from "./stuck-op-reaper.js";
import { sourceRecoveryForwardRetryable } from "./legacy-migration-recovery.js";
import { schedulerHandoffAwaitingRelease } from "./scheduler-handoff-release.js";
import { createHash } from "node:crypto";

import {
  GatewayRetirementConflictError,
  builderRuntimeMutationFenced,
  claimGatewayRetirementInStore,
} from "@octogee/core/gateway-retirement-claim";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { resolveBuilderTier } from "@octogee/shared/types/billing";
import {
  GATEWAY_UNREACHABLE_AFTER_MS,
  parseConfiguredBuilderReport,
  type ConfiguredBuilderReport,
} from "@octogee/shared/types/fleet-controller";
import {
  isGatewayRuntime,
  resolveGatewayRuntime,
    type GatewayRuntime,
} from "@octogee/shared/types/glm";
import {
  type GatewayKubernetesObservation,
  isReleasePayload,
  projectGatewayDesiredRootForGateway,
  releasePayloadHash,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import {
  GATEWAY_POD_REPLACEMENT_SCHEMA,
  isGatewayPodPlacement,
  isGatewayPodReplacements,
  type GatewayPodPlacement,
  type GatewayPodReplacements,
} from "@octogee/shared/types/gateway-pod-replacements";
import {
  nextPodReplacementTransition,
  observedPodPlacements,
  observedReplicaSets,
  type PodReplacementTransition,
} from "./pod-replacement-tracking.js";
import {
  authoritativeSharedGatewayLoad,
  compareSharedGatewayIds,
  deriveSharedGatewayPoolConfig,
  isAcceptingSharedGateway,
  isSettledSharedGateway,
  parseSharedGatewayAutoscalingConfig,
  parseSharedGatewayPoolConfig,
  platformPreferredSharedGatewayCandidates,
  selectSharedGateway,
  type SharedGatewayPlacementPurpose,
  type SharedGatewayPoolCandidate,
  type SharedGatewayRebalance,
  type SharedGatewaySelection,
  type SharedPoolReplacement,
} from "@octogee/shared/types/shared-gateway-pool";
import {
  InvalidSharedGatewayAutoscalingConfigError,
  readSharedGatewayPoolConfigInStore,
} from "@octogee/core/shared-gateway-pool-read";
import {
  builderActivateOperationId,
  builderRecoverOperationId,
  builderReturnOperationId,
  isBuilderReturnOperationIdFor,
  placementRetireOperationId,
  type BuilderTierReader,
} from "@octogee/core/builder-activation-lease";
import {
  clearRetiredBuilderActivationPreparation,
  commitRecoveredDisposableRuntimeResetAtomic,
  commitUnavailableGatewayRecoveryAtomic,
  type RecoveredDisposableRuntimeResetParams,
  type UnavailableGatewayRecoveryParams,
  type UnavailableGatewayRecoveryTargetValidationContext,
} from "@octogee/core/fleet-state";
import { supersedeRollingSharedGatewayRoll } from "@octogee/core/shared-gateway-roll-recovery";
import {
  FenceMismatchError,
  type BuilderRecord,
  type FleetRegistryRecord,
  type GatewayAssignment,
  type GatewayRecoveryReceipt,
  type GatewayRoot,
  type OperationPatch,
  type OperationRecord,
  type OrchestratorConfig,
  type PlacementAdmissionDecision,
  type PlacementAdmissionPolicy,
  type PlatformStateStore,
  type PlatformStateTransaction,
  type Stored,
} from "@octogee/core/platform-state";
import {
  resolveContinuousBuilderPlacement,
  resolveLiveActivationTargetGatewayId,
  resolveOnboardingPlacementEligibility,
  type ContinuousPlacementOwnedGateway,
} from "@octogee/shared/types/orchestrator-placement";
import type { SizingTier } from "@octogee/shared/types/sizing";
import { BUILDER_TIERS, type BuilderTierName } from "@octogee/shared/types/billing-tiers";
import {
  advanceActivationLeaseFirestore,
  requestTierTransitionFirestore,
  refreshRequestedAllocationFirestore,
  allocateDisposableGatewayFirestore,
  completeActivationLeaseFirestore,
  failActivationLeaseFirestore,
  readBuilderActivityFirestore,
} from "./disposable-gateway-lifecycle.js";
import { MIGRATE_CUSTOMER_KIND } from "./operation-kinds.js";
import { commitInitialPlacement, type AssignInitialPlacementInput } from "./initial-placement.js";
import { pairedReplacementTarget, readSharedPoolReplacements } from "./shared-pool-replacements.js";
import type { FleetInformer } from "./fleet-informer.js";
import {
  classifyOperationFailure,
  isAgentStoreRetirementSessionDrain,
  isGatewayStartupUnavailable,
  OPERATION_JOURNAL_RETENTION_MS,
} from "./operation-retry.js";

export const PLACEMENT_POLICY_RECONCILE_MS_DEFAULT = 15_000;
export const DISPOSABLE_GATEWAY_COMPUTER_START_TIMEOUT_MS = 20 * 60_000;
export const DISPOSABLE_GATEWAY_PROVISION_TIMEOUT_MS = 10 * 60_000;
export const DISPOSABLE_GATEWAY_RUNTIME_STARTUP_TIMEOUT_MS = 10 * 60_000;
export const DISPOSABLE_GATEWAY_TOTAL_PROVISION_TIMEOUT_MS =
  DISPOSABLE_GATEWAY_PROVISION_TIMEOUT_MS + DISPOSABLE_GATEWAY_RUNTIME_STARTUP_TIMEOUT_MS;
export const SHARED_GATEWAY_REBALANCE_STABILITY_MS = 10 * 60_000;
const PLACEMENT_POLICY_ACTOR = "glm-controller-placement-policy";
const BUILDER_ACTIVATION_LEASE_SOURCE = "builder-activation-lease";
const DISPOSABLE_BUILDER_ALLOCATION_KIND = "disposable-builder";
const ROLLED_BACK_STATUS = "rolled-back";
const NO_ACCEPTING_SHARED_GATEWAY = "no-accepting-shared-gateway";
const CONTINUOUS_PLACEMENT_POLICY_SOURCE = "continuous-placement-policy";
const LIVE_LEASE_STATUSES = new Set([
  "requested",
  "provisioning",
  "activating",
  "active",
  "returning",
]);

export class TerminalPlacementMigrationConflictError extends Error {
  constructor(
    readonly operationId: string,
    readonly status: string,
  ) {
    super(`migration operation ${operationId} ended with status ${status}`);
    this.name = "TerminalPlacementMigrationConflictError";
  }
}

export class HeldBuilderPlacementError extends GatewayRetirementConflictError {
  constructor(readonly uid: string) {
    super(`builder ${uid} is operator-managed`);
    this.name = "HeldBuilderPlacementError";
  }
}

function isSkippablePlacementConflict(
  error: unknown,
): error is TerminalPlacementMigrationConflictError | HeldBuilderPlacementError {
  return error instanceof TerminalPlacementMigrationConflictError || error instanceof HeldBuilderPlacementError;
}

export interface PlacementPolicyUser {
  uid: string;
  data: Record<string, unknown>;
}

export interface PlacementPolicyMigration {
  id: string;
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  source: "continuous-placement-policy" | "builder-activation-lease";
  status: "pending" | "running" | "succeeded" | "failed" | "rolled-back";
  error?: string;
  retryRequested?: boolean;
  sourceRecoveryPending?: boolean;
  sharedRevisionRetryable?: boolean;
}

export type PlacementPolicyKubernetesStatus = "ready" | "not-ready" | "missing" | "unknown";

export interface PlacementPolicyPodDiagnostics {
  status: string;
  totalPods: number;
  readyPods: number;
  pods?: ReadonlyArray<{
    gatewayId?: string | null;
    phase?: string;
    deleting?: boolean;
    gatewayContainerStartedAt?: number | null;
    uid?: string | null;
    name?: string | null;
    replicaSetUid?: string | null;
    nodeName?: string | null;
    instanceId?: string | null;
    nodePool?: string | null;
  }>;
  replicaSets?: ReadonlyArray<{
    uid: string;
    name: string;
    desiredReplicas: number;
    observedReplicas: number;
  }>;
  error?: string;
}

export function placementKubernetesStatus(
  diagnostics: PlacementPolicyPodDiagnostics | undefined,
): PlacementPolicyKubernetesStatus {
  if (!diagnostics || diagnostics.error) return "unknown";
  if (diagnostics.status === "unknown") return "unknown";
  if (diagnostics.totalPods === 0) return "missing";
  if (diagnostics.totalPods > 0 && diagnostics.readyPods > 0) return "ready";
  if (diagnostics.totalPods > 0) return "not-ready";
  return "unknown";
}

export interface PlacementPolicyGateway extends ContinuousPlacementOwnedGateway {
  runtime?: GatewayRuntime;
  builderSlug?: string | null;
  sizingTier?: SizingTier | null;
  kubernetesStatus?: PlacementPolicyKubernetesStatus;
  serving?: boolean;
  runtimeStatus?: string;
  heartbeatFresh?: boolean;
  computerStartedAt?: number | null;
  runtimeStartedAt?: number | null;
  liveReleaseReady?: boolean;
  rosterComplete?: boolean;
  assignmentCount?: number;
  latestRelease?: number;
  desiredRelease?: number;
  liveRelease?: number | null;
  rollActive?: boolean;
  recoveryGraceUntil?: number;
  mountedCustomers?: readonly string[];
  configuredBuilder?: ConfiguredBuilderReport | null;
}

export const SHARED_GATEWAY_RECOVERY_GRACE_MS = GATEWAY_UNREACHABLE_AFTER_MS;

export interface PlacementPolicyAssignment {
  uid: string;
  slug: string;
  gatewayId: string;
  state: string;
  epoch: number | null;
  createdAt?: number | null;
  source?: string;
  updatedByOperationId?: string;
}

export interface PlacementPolicySnapshot {
  defaultGatewayId: string;
  sharedGatewayIds: readonly string[];
  idleMs: number;
  buildersPerGateway: number;
  platformCurrentGatewayIds: readonly string[];
  sharedPoolReplacements: readonly SharedPoolReplacement[];
  users: PlacementPolicyUser[];
  gateways: PlacementPolicyGateway[];
  assignments: PlacementPolicyAssignment[];
  activeMigrations: PlacementPolicyMigration[];
}

export interface EnqueuePlacementMigrationInput {
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  source: "continuous-placement-policy" | "builder-activation-lease";
  operationId: string;
  sharedDrain?: { pairedTargetGatewayId: string | null };
}

export interface SupersedePendingSharedDrainMoveInput {
  operationId: string;
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  leaseId: string;
  generation: number;
  targetGatewayId: string;
  activationOperationId: string;
}

export class SharedDrainSupersededError extends Error {
  constructor(readonly fromGatewayId: string, reason: string) {
    super(`shared drain of ${fromGatewayId} no longer authorizes this migration: ${reason}`);
    this.name = "SharedDrainSupersededError";
  }
}

export interface AllocateDisposableGatewayInput {
  uid: string;
  builderSlug: string;
  leaseId: string;
  generation: number;
  sourceGatewayId: string;
  sourceAssignmentEpoch: number;
  entitlementTier: BuilderTierName;
  sizingTier: SizingTier;
  parkedGateway?: { gatewayId: string; generation: number };
}

export interface TierTransitionInput {
  uid: string;
  leaseId: string;
  generation: number;
  targetGatewayId: string;
  tier: BuilderTierName;
}

export interface AdvanceActivationLeaseInput {
  uid: string;
  leaseId: string;
  generation: number;
  fromStatus: "provisioning" | "activating" | "active";
  toStatus: "activating" | "active" | "returning";
  operationId?: string;
}

export interface CompleteActivationLeaseInput {
  uid: string;
  leaseId: string;
  generation: number;
  targetGatewayId: string;
  parked?: true;
}

export interface FailActivationLeaseInput {
  uid: string;
  leaseId: string;
  generation: number;
  targetGatewayId: string;
  operationId: string;
  message: string;
}

export interface RecoverUnreachableDisposableGatewayInput {
  uid: string;
  builderSlug: string;
  gatewayId: string;
  leaseId: string;
  generation: number;
  authoritativeGatewayId: string;
  sourceUnavailable?: boolean;
}

export interface RecoverUnavailableGatewayInput extends UnavailableGatewayRecoveryParams {}

export interface SupersedeRollingSharedGatewayInput {
  sourceGatewayId: string;
  targetGatewayId: string;
  expectedLiveRelease: number;
  expectedDesiredRelease: number;
  targetHeartbeatMaxAgeMs: number;
}

export interface BuilderRuntimeActivity {
  lastActiveAt: number | null;
}

type AuthoritativeLeaseStatus = "provisioning" | "activating" | "returning";

export type PlacementRetirementReason =
  | "provisioning-timeout"
  | "provisioning-target-paused"
  | "builder-authorization-ended"
  | "activation-failed"
  | "builder-returned"
  | "operator-terminated"
  | "parked-computer-replaced"
  | "owned-gateway-not-kept";

export interface RetireOwnedGatewayInput {
  uid: string;
  builderSlug: string;
  gatewayId: string;
  reason: PlacementRetirementReason;
  leaseId?: string;
  generation: number;
  telemetryFenceOperationId?: string;
  telemetryFenceStatus?: "succeeded" | "terminal-failure";
  authoritativeGatewayId?: string;
  authoritativeLeaseStatus?: AuthoritativeLeaseStatus;
  zeroWorkloadRecoveryOperationId?: string;
}

export interface PlacementPolicyReconcilerDeps {
  now(): number;
  log(message: string): void;
  debug?(message: string): void;
  readSnapshot(): Promise<PlacementPolicySnapshot>;
  decidePlacementAdmission(uid: string): Promise<PlacementAdmissionDecision>;
  assignInitialPlacement(input: AssignInitialPlacementInput): Promise<void>;
  allocateDisposableGateway(input: AllocateDisposableGatewayInput): Promise<string | null>;
  advanceActivationLease(input: AdvanceActivationLeaseInput): Promise<void>;
  requestTierTransition(input: TierTransitionInput): Promise<void>;
  completeActivationLease(input: CompleteActivationLeaseInput): Promise<void>;
  failActivationLease(input: FailActivationLeaseInput): Promise<void>;
  recoverUnavailableGateway(input: RecoverUnavailableGatewayInput): Promise<{ operationId: string }>;
  recoverDisposableRuntimeReset(
    input: RecoveredDisposableRuntimeResetParams,
  ): Promise<{ operationId: string }>;
  supersedeRollingSharedGateway(input: SupersedeRollingSharedGatewayInput): Promise<{
    kind: "scheduled" | "already-scheduled" | "not-eligible";
    release?: number;
    operationId?: string;
  }>;
  recoverUnreachableDisposableGateway(
    input: RecoverUnreachableDisposableGatewayInput,
  ): Promise<{ recovered: boolean; operationId: string }>;
  readBuilderActivity(input: {
    uid: string;
    builderSlug: string;
    gatewayId: string;
    userData: Record<string, unknown>;
  }): Promise<BuilderRuntimeActivity>;
  enqueueMigration(input: EnqueuePlacementMigrationInput): Promise<string>;
  supersedePendingSharedDrainMove(input: SupersedePendingSharedDrainMoveInput): Promise<boolean>;
  retireOwnedGateway(input: RetireOwnedGatewayInput): Promise<boolean>;
  deleteRetiredDisposableGateway(
    input: DeleteRetiredDisposableGatewayInput,
  ): Promise<boolean>;
}

export interface DeleteRetiredDisposableGatewayInput {
  gatewayId: string;
  ownerUid: string;
  generation: number;
}

export interface PlacementPolicyReconcileResult {
  assigned: number;
  enqueued: number;
  adopted: number;
  retired: number;
  swept: number;
  blocked: number;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function currentGatewayId(data: Record<string, unknown>): string | null {
  const provisioning = data.provisioning;
  if (!provisioning || typeof provisioning !== "object" || Array.isArray(provisioning)) return null;
  const openclaw = (provisioning as Record<string, unknown>).openclaw;
  return openclaw && typeof openclaw === "object" && !Array.isArray(openclaw)
    ? nonEmptyString((openclaw as Record<string, unknown>).gatewayId)
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function millis(value: unknown): number | null {
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

interface BuilderActivationLease {
  raw: Record<string, unknown>;
  leaseId: string;
  generation: number;
  status: string;
  targetGatewayId: string | null;
}

interface ActivationTargetContext {
  context: PlacementPolicyReconcileContext;
  user: PlacementPolicyUser;
  builderSlug: string;
  current: string | null;
  lease: BuilderActivationLease;
  target: PlacementPolicyGateway;
}

// The 15s tick must not re-read the terminal journal. Only unfinished operations
// need a scan; the terminal rows any consumer looks up are addressed by
// deterministic id derived from a live activation lease, so they are fetched by
// document read instead.
export const PLACEMENT_ACTIVE_OPERATION_STATUSES = ["pending", "running"] as const;

const TERMINAL_LEASE_OPERATION_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  ROLLED_BACK_STATUS,
]);

export function leaseJournalOperationIds(userData: Record<string, unknown>): string[] {
  const lease = builderActivationLease(userData);
  if (!lease?.targetGatewayId) return [];
  return [
    builderActivateOperationId(lease.targetGatewayId, lease.generation),
    builderReturnOperationId(lease.targetGatewayId, lease.generation),
  ];
}

function builderActivationLease(data: Record<string, unknown>): BuilderActivationLease | null {
  return activationLeaseOf(record(record(data.provisioning)?.openclaw)?.activationLease);
}

function activationLeaseOf(value: unknown): BuilderActivationLease | null {
  const raw = record(value);
  const leaseId = nonEmptyString(raw?.leaseId);
  const generation = positiveInteger(raw?.generation);
  const status = nonEmptyString(raw?.status);
  if (!raw || !leaseId || !generation || !status) return null;
  return {
    raw,
    leaseId,
    generation,
    status,
    targetGatewayId: nonEmptyString(raw.targetGatewayId),
  };
}

interface PlacementPolicyReconcileContext {
  deps: PlacementPolicyReconcilerDeps;
  state: PlacementPolicySnapshot;
  gateways: Map<string, PlacementPolicyGateway>;
  migrations: Map<string, PlacementPolicyMigration>;
  operations: Map<string, PlacementPolicyMigration>;
  assignments: Map<string, PlacementPolicyAssignment>;
  projectedSharedGatewayPlacements: Map<string, number>;
  supersededSharedGatewayIds: Set<string>;
  result: PlacementPolicyReconcileResult;
}

function blockPlacement(
  context: PlacementPolicyReconcileContext,
  input: {
    uid: string;
    code: string;
    reason: string;
    lease?: BuilderActivationLease;
  },
): void {
  context.result.blocked += 1;
  const leaseIdentity = input.lease
    ? ` lease=${input.lease.leaseId} generation=${input.lease.generation}`
    : "";
  context.deps.log(
    `[placement-policy] blocked code=${input.code} uid=${input.uid}${leaseIdentity}: ${input.reason}`,
  );
}

function placementAssignmentKey(gatewayId: string, uid: string): string {
  return `${gatewayId}\u0000${uid}`;
}

export function continuousPlacementMigrationOperationId(input: {
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  sourceAssignmentEpoch: number;
}): string {
  if (nonNegativeInteger(input.sourceAssignmentEpoch) === null) {
    throw new Error("continuous placement requires a non-negative source assignment epoch");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([
      input.uid,
      input.builderSlug,
      input.fromGatewayId,
      input.toGatewayId,
      input.sourceAssignmentEpoch,
    ]))
    .digest("hex")
    .slice(0, 32);
  return `placement-${digest}`;
}

function sourceAssignmentEpoch(
  context: PlacementPolicyReconcileContext,
  gatewayId: string,
  uid: string,
): number {
  const epoch = context.assignments.get(placementAssignmentKey(gatewayId, uid))?.epoch;
  const parsed = nonNegativeInteger(epoch);
  if (parsed === null) {
    throw new Error(`Builder ${uid} has no authoritative assignment epoch on ${gatewayId}`);
  }
  return parsed;
}

function kubernetesReady(gateway: PlacementPolicyGateway): boolean {
  return gateway.kubernetesStatus === undefined
    ? gateway.ready
    : gateway.kubernetesStatus === "ready";
}

function knownKubernetesUnavailable(gateway: PlacementPolicyGateway | undefined): boolean {
  return gateway?.kubernetesStatus === "missing" || gateway?.kubernetesStatus === "not-ready";
}

function transientSharedRecoveryFence(
  context: PlacementPolicyReconcileContext,
  gateway: PlacementPolicyGateway,
): string | null {
  const sharedGateway = isSharedPoolGateway(context, gateway.gatewayId) && gateway.gatewayClass === "shared";
  if (
    sharedGateway &&
    gatewayHeartbeatFresh(gateway) &&
    (gateway.kubernetesStatus === "not-ready" || gateway.kubernetesStatus === "missing")
  ) {
    return `source ${gateway.gatewayId} still has a fresh runtime heartbeat while Kubernetes reports ${gateway.kubernetesStatus}`;
  }
  if (!sharedGateway) return null;
  if (gateway.kubernetesStatus === "not-ready") {
    return `shared source ${gateway.gatewayId} still has Kubernetes pods; retaining assignments until it is missing`;
  }
  if (gateway.rollActive) {
    return `shared source ${gateway.gatewayId} is in an active roll`;
  }
  if (
    typeof gateway.recoveryGraceUntil === "number"
    && context.deps.now() < gateway.recoveryGraceUntil
  ) {
    return `shared source ${gateway.gatewayId} is inside its post-change recovery grace`;
  }
  return null;
}

function gatewayRuntimeServing(gateway: PlacementPolicyGateway): boolean {
  return gateway.serving ?? gateway.ready;
}

function gatewayHeartbeatFresh(gateway: PlacementPolicyGateway): boolean {
  return gateway.heartbeatFresh ?? gateway.ready;
}

function gatewayLiveReleaseReady(gateway: PlacementPolicyGateway): boolean {
  return gateway.liveReleaseReady ?? gateway.ready;
}

function isPositiveRelease(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isSharedPoolGateway(
  context: PlacementPolicyReconcileContext,
  gatewayId: string | null,
): boolean {
  return gatewayId !== null && context.state.sharedGatewayIds.includes(gatewayId);
}

function sharedGatewayCandidates(
  context: PlacementPolicyReconcileContext,
): SharedGatewayPoolCandidate[] {
  return context.state.gateways.map((gateway) => {
    const incomingMigrationCount = context.state.activeMigrations.filter(
      (operation) =>
        (operation.status === "pending" || operation.status === "running") &&
        operation.toGatewayId === gateway.gatewayId &&
        !context.assignments.has(placementAssignmentKey(gateway.gatewayId, operation.uid)),
    ).length;
    const outgoingMigrationCount = context.state.activeMigrations.filter(
      (operation) =>
        (operation.status === "pending" || operation.status === "running") &&
        operation.fromGatewayId === gateway.gatewayId &&
        context.assignments.has(placementAssignmentKey(gateway.gatewayId, operation.uid)),
    ).length;
    const assignmentCount = (
      gateway.assignmentCount ?? context.state.assignments.filter(
        (assignment) => assignment.gatewayId === gateway.gatewayId,
      ).length
    ) - outgoingMigrationCount +
      (context.projectedSharedGatewayPlacements.get(gateway.gatewayId) ?? 0);
    return {
      gatewayId: gateway.gatewayId,
      gatewayClass: gateway.gatewayClass,
      desiredStatus: gateway.desiredStatus,
      ready: kubernetesReady(gateway),
      serving: gatewayRuntimeServing(gateway),
      heartbeatFresh: gatewayHeartbeatFresh(gateway),
      liveReleaseReady: gatewayLiveReleaseReady(gateway),
      rosterComplete: gateway.rosterComplete ?? true,
      incomingMigrationCount,
      assignmentCount,
    };
  });
}

function sharedGatewayPoolStableForRebalance(
  context: PlacementPolicyReconcileContext,
): boolean {
  const now = context.deps.now();
  return context.state.sharedGatewayIds.every((gatewayId) => {
    const gateway = context.gateways.get(gatewayId);
    if (!gateway) return false;
    if (gateway.desiredStatus !== "running") return true;
    if (gateway.rollActive === true || gateway.liveReleaseReady === false) return false;
    const startedAt = gateway.runtimeStartedAt;
    return typeof startedAt === "number" &&
      Number.isFinite(startedAt) &&
      now - startedAt >= SHARED_GATEWAY_REBALANCE_STABILITY_MS;
  });
}

function rollingSharedGatewayForUnavailableRecovery(
  context: PlacementPolicyReconcileContext,
  sourceGatewayId: string,
): SupersedeRollingSharedGatewayInput | null {
  const candidates = sharedGatewayCandidates(context);
  const peers: SupersedeRollingSharedGatewayInput[] = [];
  for (const gateway of context.state.gateways) {
    const peer = rollingSharedGatewayPeer(
      context,
      sourceGatewayId,
      candidates.find((candidate) => candidate.gatewayId === gateway.gatewayId),
      gateway,
    );
    if (peer) peers.push(peer);
  }
  return peers.length === 1 ? peers[0]! : null;
}

function rollingSharedGatewayPeer(
  context: PlacementPolicyReconcileContext,
  sourceGatewayId: string,
  candidate: SharedGatewayPoolCandidate | undefined,
  gateway: PlacementPolicyGateway,
): SupersedeRollingSharedGatewayInput | null {
  if (gateway.gatewayId === sourceGatewayId || !candidate) return null;
  const { liveRelease, desiredRelease } = gateway;
  const candidateIsRollingPeer = [
    context.state.sharedGatewayIds.includes(gateway.gatewayId),
    candidate.gatewayClass === "shared",
    candidate.desiredStatus === "running",
    kubernetesReady(gateway),
    candidate.serving,
    candidate.heartbeatFresh,
    candidate.rosterComplete,
    candidate.incomingMigrationCount === 0,
    gateway.latestRelease === desiredRelease,
  ].every(Boolean);
  if (
    !candidateIsRollingPeer ||
    !isPositiveRelease(liveRelease) ||
    !isPositiveRelease(desiredRelease) ||
    desiredRelease <= liveRelease
  ) return null;
  return {
    sourceGatewayId,
    targetGatewayId: gateway.gatewayId,
    expectedLiveRelease: liveRelease,
    expectedDesiredRelease: desiredRelease,
    targetHeartbeatMaxAgeMs: GATEWAY_UNREACHABLE_AFTER_MS,
  };
}

function sharedGatewayPlacementConfig(context: PlacementPolicyReconcileContext) {
  return {
    defaultGatewayId: context.state.defaultGatewayId,
    sharedGatewayIds: context.state.sharedGatewayIds,
  };
}

function selectPlatformPreferredSharedGateway(
  context: PlacementPolicyReconcileContext,
  input: {
    uid: string;
    purpose: SharedGatewayPlacementPurpose;
    candidates: readonly SharedGatewayPoolCandidate[];
    currentGatewayId?: string | null;
  },
): SharedGatewaySelection {
  const config = sharedGatewayPlacementConfig(context);
  return selectSharedGateway({
    uid: input.uid,
    purpose: input.purpose,
    buildersPerGateway: context.state.buildersPerGateway,
    config,
    candidates: platformPreferredSharedGatewayCandidates({
      config,
      candidates: input.candidates,
      purpose: input.purpose,
      preference: {
        platformCurrentGatewayIds: context.state.platformCurrentGatewayIds,
        buildersPerGateway: context.state.buildersPerGateway,
      },
      currentGatewayId: input.currentGatewayId,
    }),
    ...(input.currentGatewayId === undefined ? {} : { currentGatewayId: input.currentGatewayId }),
  });
}

function initialPlacementSiblingGatewayIds(
  context: PlacementPolicyReconcileContext,
  uid: string,
  placement: ReturnType<typeof resolveContinuousBuilderPlacement>,
): string[] {
  if (placement.ownedGatewayId !== null) return [];
  const config = sharedGatewayPlacementConfig(context);
  return platformPreferredSharedGatewayCandidates({
    config,
    candidates: sharedGatewayCandidates(context),
    purpose: "initial-placement",
    preference: {
      platformCurrentGatewayIds: context.state.platformCurrentGatewayIds,
      buildersPerGateway: context.state.buildersPerGateway,
    },
    currentGatewayId: null,
  })
    .filter((candidate) => candidate.gatewayId !== placement.targetGatewayId && isAcceptingSharedGateway(config, candidate))
    .map((candidate) => candidate.gatewayId);
}

function selectAcceptingSharedGateway(
  context: PlacementPolicyReconcileContext,
  uid: string,
  purpose: SharedGatewayPlacementPurpose,
  currentGatewayId?: string | null,
): string | null {
  const selection = selectPlatformPreferredSharedGateway(context, {
    uid,
    purpose,
    candidates: sharedGatewayCandidates(context),
    ...(currentGatewayId === undefined ? {} : { currentGatewayId }),
  });
  return selection.kind === "selected" ? selection.gatewayId : null;
}

function selectReturnSharedGateway(
  context: PlacementPolicyReconcileContext,
  uid: string,
): { gatewayId: string } | { blockedReason: string } {
  const replacedSlots = new Set(
    context.state.sharedPoolReplacements.map((replacement) => replacement.sourceGatewayId),
  );
  const selection = selectPlatformPreferredSharedGateway(context, {
    uid,
    purpose: "migration",
    candidates: sharedGatewayCandidates(context).filter((candidate) => !replacedSlots.has(candidate.gatewayId)),
  });
  if (selection.kind === "selected") return { gatewayId: selection.gatewayId };
  const pendingReplacements = context.state.sharedPoolReplacements
    .filter((replacement) => context.state.sharedGatewayIds.includes(replacement.sourceGatewayId))
    .map((replacement) => `${replacement.sourceGatewayId} is being replaced by ${replacement.targetGatewayId}`);
  return {
    blockedReason: pendingReplacements.length === 0
      ? "no configured shared gateway can receive the returning Builder"
      : `no configured shared gateway can receive the returning Builder while ${pendingReplacements.join(", ")}`,
  };
}

function sharedAuthorityGatewayId(
  context: PlacementPolicyReconcileContext,
  currentGatewayId: string | null,
): string | null {
  if (isSharedPoolGateway(context, currentGatewayId)) return currentGatewayId;
  return selectAcceptingSharedGateway(context, "placement-policy-authority", "migration");
}

function projectSharedGatewayPlacement(
  context: PlacementPolicyReconcileContext,
  gatewayId: string,
): void {
  if (isSharedPoolGateway(context, gatewayId)) {
    context.projectedSharedGatewayPlacements.set(
      gatewayId,
      (context.projectedSharedGatewayPlacements.get(gatewayId) ?? 0) + 1,
    );
  }
}

function entitledComputerSizing(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
): SizingTier | null {
  if (!accountAllowsInteractiveAccess(user.data)) return null;
  const tier = resolveBuilderTier(user.data, new Date(context.deps.now()));
  const config = tier ? BUILDER_TIERS[tier] : null;
  return config?.computer?.runtime === "gce-vm" ? config.instance : null;
}

function ownedPausedDisposableGateway(gateway: PlacementPolicyGateway, uid: string): boolean {
  return gateway.desiredStatus === "paused" &&
    gateway.gatewayClass === "builder" &&
    gateway.disposable === true &&
    gateway.ownerUid === uid &&
    gateway.allocation?.claimedByUid === uid;
}

function ownedParkedComputer(gateway: PlacementPolicyGateway, uid: string): boolean {
  return ownedPausedDisposableGateway(gateway, uid) && gateway.runtime === "gce-vm";
}

function parkedComputerGateway(
  gateway: PlacementPolicyGateway,
  uid: string,
  builderSlug: string,
  sizingTier: SizingTier | null,
): boolean {
  return sizingTier !== null &&
    ownedParkedComputer(gateway, uid) &&
    gateway.builderSlug === builderSlug &&
    gateway.sizingTier === sizingTier;
}

async function retireObsoleteParkedComputers(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  lease: BuilderActivationLease,
  keptSizing: SizingTier | null,
): Promise<boolean> {
  const obsolete = context.state.gateways.filter((gateway) =>
    ownedPausedDisposableGateway(gateway, user.uid) &&
    !parkedComputerGateway(gateway, user.uid, builderSlug, keptSizing));
  for (const gateway of obsolete) {
    const retired = await context.deps.retireOwnedGateway({
      uid: user.uid,
      builderSlug,
      gatewayId: gateway.gatewayId,
      reason: "parked-computer-replaced",
      generation: gateway.allocation!.generation,
    });
    if (!retired) {
      blockPlacement(context, {
        uid: user.uid,
        lease,
        code: "parked-gateway-retirement-fence",
        reason: `parked gateway ${gateway.gatewayId} did not satisfy retirement fences`,
      });
      return false;
    }
    context.result.retired += 1;
  }
  return true;
}

async function retireUnentitledOwnedGateways(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
): Promise<void> {
  const keptSizing = entitledComputerSizing(context, user);
  const ownedGateways = context.state.gateways.filter(
    (gateway) => gateway.ownerUid === user.uid &&
      gateway.disposable === true &&
      gateway.gatewayClass !== "shared" &&
      gateway.desiredStatus !== "retired" &&
      !parkedComputerGateway(gateway, user.uid, builderSlug, keptSizing),
  );
  for (const gateway of ownedGateways) {
    const generation = gateway.allocation?.generation;
    if (generation === undefined) {
      blockPlacement(context, {
        uid: user.uid,
        code: "disposable-retirement-fence",
        reason: `gateway ${gateway.gatewayId} has no disposable allocation generation`,
      });
      continue;
    }
    const retired = await context.deps.retireOwnedGateway({
      uid: user.uid,
      builderSlug,
      gatewayId: gateway.gatewayId,
      reason: "owned-gateway-not-kept",
      generation,
    });
    if (retired) context.result.retired += 1;
    else {
      blockPlacement(context, {
        uid: user.uid,
        code: "disposable-retirement-fence",
        reason: `gateway ${gateway.gatewayId} did not satisfy retirement fences`,
      });
    }
  }
}

async function assignMissingPlacement(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  placement: ReturnType<typeof resolveContinuousBuilderPlacement>,
): Promise<void> {
  const targetGateway = context.gateways.get(placement.targetGatewayId);
  if (!targetGateway) throw new Error(`placement target ${placement.targetGatewayId} is missing`);
  const admission = await context.deps.decidePlacementAdmission(user.uid);
  if (admission.kind !== "admitted") {
    blockPlacement(context, {
      uid: user.uid,
      code: admission.kind === "refused" ? admission.code : "placement-admission-pending",
      reason: admission.reason,
    });
    return;
  }
  await context.deps.assignInitialPlacement({
    uid: user.uid,
    builderSlug,
    gatewayId: placement.targetGatewayId,
    gateway: targetGateway,
    siblingGatewayIds: initialPlacementSiblingGatewayIds(context, user.uid, placement),
  });
  projectSharedGatewayPlacement(context, placement.targetGatewayId);
  context.result.assigned += 1;
}

function adoptActiveMigration(
  context: PlacementPolicyReconcileContext,
  uid: string,
  targetGatewayId: string,
): boolean {
  const active = context.migrations.get(uid);
  if (!active) return false;
  if (active.toGatewayId === targetGatewayId) context.result.adopted += 1;
  else {
    blockPlacement(context, {
      uid,
      code: "migration-target-conflict",
      reason: `active migration ${active.id} targets ${active.toGatewayId}, expected ${targetGatewayId}`,
    });
  }
  return true;
}

function activationMigrationMatches(
  operation: PlacementPolicyMigration,
  input: {
    id: string;
    uid: string;
    builderSlug: string;
    fromGatewayId: string;
    toGatewayId: string;
  },
): boolean {
  return operation.id === input.id &&
    operation.uid === input.uid &&
    operation.builderSlug === input.builderSlug &&
    operation.fromGatewayId === input.fromGatewayId &&
    operation.toGatewayId === input.toGatewayId &&
    operation.source === BUILDER_ACTIVATION_LEASE_SOURCE;
}

function disposableTargetIdentityMatchesLease(
  gateway: ContinuousPlacementOwnedGateway,
  user: PlacementPolicyUser,
  lease: BuilderActivationLease,
): boolean {
  const allocation = gateway.allocation;
  return gateway.gatewayClass === "builder" &&
    gateway.ownerUid === user.uid &&
    gateway.disposable === true &&
    allocation?.kind === DISPOSABLE_BUILDER_ALLOCATION_KIND &&
    allocation.claimedByUid === user.uid &&
    allocation.leaseId === lease.leaseId &&
    allocation.generation === lease.generation;
}

function disposableTargetMatchesLease(
  gateway: ContinuousPlacementOwnedGateway,
  user: PlacementPolicyUser,
  lease: BuilderActivationLease,
): boolean {
  return gateway.desiredStatus === "running" &&
    disposableTargetIdentityMatchesLease(gateway, user, lease);
}

function disposableTargetActivationReady(gateway: PlacementPolicyGateway): boolean {
  if (gateway.assignmentCount !== 0) return false;
  if (!Array.isArray(gateway.mountedCustomers) || gateway.mountedCustomers.length !== 0) {
    return false;
  }
  if (gateway.ready) return true;
  return (gateway.runtime === "gce-vm" || gateway.kubernetesStatus === "not-ready") &&
    gateway.serving === true &&
    gateway.runtimeStatus === "booting" &&
    gateway.heartbeatFresh === true &&
    gateway.liveReleaseReady === true;
}

function recoveredRuntimeResetState(user: PlacementPolicyUser): Record<string, unknown> | null {
  return record(record(record(user.data.provisioning)?.openclaw)?.runtimeReset);
}

function recoveredRuntimeResetTarget(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  currentGatewayId: string | null,
): {
  target: PlacementPolicyGateway;
  assignment: PlacementPolicyAssignment;
  epoch: number;
} | null {
  if (!currentGatewayId || !isSharedPoolGateway(context, currentGatewayId)) return null;
  const target = context.gateways.get(currentGatewayId);
  const assignment = context.assignments.get(
    placementAssignmentKey(currentGatewayId, user.uid),
  );
  if (
    !target ||
    target.gatewayClass !== "shared" ||
    !assignment ||
    assignment.state !== "serving" ||
    assignment.epoch === null
  ) return null;
  return { target, assignment, epoch: assignment.epoch };
}

function reconcileRecoveredRuntimeResetMarker(input: {
  context: PlacementPolicyReconcileContext;
  user: PlacementPolicyUser;
  builderSlug: string;
  gatewayId: string;
  assignment: PlacementPolicyAssignment;
}): boolean | null {
  const marker = recoveredRuntimeResetState(input.user);
  if (!marker) return null;
  if (marker.status === "acknowledged") return false;
  const exact = [
    marker.uid === input.user.uid,
    marker.slug === input.builderSlug,
    marker.targetGatewayId === input.gatewayId,
    marker.generation === input.assignment.epoch,
    marker.operationId === input.assignment.updatedByOperationId,
    input.assignment.source === "repair",
  ].every(Boolean);
  if (!exact || marker.status !== "pending") {
    blockPlacement(input.context, {
      uid: input.user.uid,
      code: "recovered-runtime-reset-fence",
      reason: `runtime reset marker does not match ${input.gatewayId}/${input.assignment.epoch}`,
    });
    return true;
  }
  return marker.status === "pending";
}

function recoveredRuntimeResetPreviousOperationId(
  assignment: PlacementPolicyAssignment,
  target: PlacementPolicyGateway,
  builderSlug: string,
): string | null {
  const operationId = assignment.updatedByOperationId;
  if (
    assignment.source !== "repair" ||
    typeof operationId !== "string" ||
    !operationId.startsWith("recover-disposable-") ||
    operationId.startsWith("recover-disposable-reset-") ||
    target.mountedCustomers?.includes(builderSlug)
  ) return null;
  return operationId;
}

function recoveredRuntimeResetTargetIsReady(target: PlacementPolicyGateway): boolean {
  return [
    gatewayRuntimeServing(target),
    gatewayHeartbeatFresh(target),
    gatewayLiveReleaseReady(target),
  ].every(Boolean);
}

async function reconcileRecoveredDisposableRuntimeReset(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  currentGatewayId: string | null,
): Promise<boolean> {
  const recovery = recoveredRuntimeResetTarget(context, user, currentGatewayId);
  if (!recovery || !currentGatewayId) return false;
  const markerResult = reconcileRecoveredRuntimeResetMarker({
    context,
    user,
    builderSlug,
    gatewayId: currentGatewayId,
    assignment: recovery.assignment,
  });
  if (markerResult !== null) return markerResult;
  const previousRecoveryOperationId = recoveredRuntimeResetPreviousOperationId(
    recovery.assignment,
    recovery.target,
    builderSlug,
  );
  if (!previousRecoveryOperationId) return false;
  if (!recoveredRuntimeResetTargetIsReady(recovery.target)) {
    blockPlacement(context, {
      uid: user.uid,
      code: "recovered-runtime-reset-target-unavailable",
      reason: `shared repair target ${currentGatewayId} is not a fresh serving runtime`,
    });
    return true;
  }
  const operationId = `recover-disposable-reset-${user.uid}-${currentGatewayId}-${recovery.epoch}`;
  await context.deps.recoverDisposableRuntimeReset({
    operationId,
    previousRecoveryOperationId,
    uid: user.uid,
    slug: builderSlug,
    targetGatewayId: currentGatewayId,
    expectedAssignmentEpoch: recovery.epoch,
    sharedGatewayIds: context.state.sharedGatewayIds,
    targetHeartbeatMaxAgeMs: GATEWAY_UNREACHABLE_AFTER_MS,
  });
  return true;
}

async function reconcileUnavailableServingGateway(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  currentGatewayId: string | null,
): Promise<boolean> {
  const source = currentGatewayId ? context.gateways.get(currentGatewayId) : null;
  if (!source || source.gatewayClass !== "shared" ||
    !isSharedPoolGateway(context, source.gatewayId) || !knownKubernetesUnavailable(source)) return false;

  const transientFence = transientSharedRecoveryFence(context, source);
  if (transientFence) {
    blockPlacement(context, {
      uid: user.uid,
      code: "transient-kubernetes-unavailability",
      reason: transientFence,
    });
    return true;
  }

  const assignment = context.assignments.get(
    placementAssignmentKey(source.gatewayId, user.uid),
  );
  if (!assignment || assignment.state !== "serving" || assignment.epoch === null) {
    blockPlacement(context, {
      uid: user.uid,
      code: "unavailable-source-assignment-fence",
      reason: `source ${source.gatewayId} has no exact serving assignment epoch`,
    });
    return true;
  }

  const targetGatewayId = selectAcceptingSharedGateway(context, user.uid, "migration", source.gatewayId);
  if (!targetGatewayId) {
    await scheduleRollingSharedPeerRecovery(context, source);
    blockPlacement(context, {
      uid: user.uid,
      code: NO_ACCEPTING_SHARED_GATEWAY,
      reason: `source ${source.gatewayId} has known Kubernetes status ${source.kubernetesStatus}`,
    });
    return true;
  }
  const operationId = `recover-shared-${user.uid}-${source.gatewayId}-${assignment.epoch}`;
  await context.deps.recoverUnavailableGateway({
    operationId,
    kind: "recover-shared-customer",
    uid: user.uid,
    slug: builderSlug,
    fromGatewayId: source.gatewayId,
    toGatewayId: targetGatewayId,
    expectedSourceEpoch: assignment.epoch,
    sharedGatewayIds: context.state.sharedGatewayIds,
    targetHeartbeatMaxAgeMs: GATEWAY_UNREACHABLE_AFTER_MS,
  });
  projectSharedGatewayPlacement(context, targetGatewayId);
  return true;
}

async function scheduleRollingSharedPeerRecovery(
  context: PlacementPolicyReconcileContext,
  source: PlacementPolicyGateway,
): Promise<void> {
  if (source.kubernetesStatus !== "missing") return;
  const peerRoll = rollingSharedGatewayForUnavailableRecovery(context, source.gatewayId);
  if (!peerRoll || context.supersededSharedGatewayIds.has(peerRoll.targetGatewayId)) return;
  try {
    const outcome = await context.deps.supersedeRollingSharedGateway(peerRoll);
    if (outcome.kind === "not-eligible") return;
    context.deps.log(
      `[placement-policy] shared-peer-roll-recovery outcome=${outcome.kind} ` +
        `source=${peerRoll.sourceGatewayId} target=${peerRoll.targetGatewayId} ` +
        `supersededRelease=${peerRoll.expectedDesiredRelease} ` +
        `rollbackRelease=${outcome.release ?? "unknown"} ` +
        `operationId=${outcome.operationId ?? "unknown"}`,
    );
  } finally {
    context.supersededSharedGatewayIds.add(peerRoll.targetGatewayId);
  }
}

function authoritativeLeaseStatus(
  lease: BuilderActivationLease,
): AuthoritativeLeaseStatus {
  if (lease.status === "activating") return "activating";
  if (lease.status === "returning") return "returning";
  return "provisioning";
}

async function recoverAndRetireUnreachableTarget(
  input: ActivationTargetContext,
  reason: PlacementRetirementReason,
): Promise<string | null> {
  const { context, user, builderSlug, lease, target } = input;
  const authoritativeGatewayId = sharedAuthorityGatewayId(
    context,
    currentGatewayId(user.data),
  );
  if (!authoritativeGatewayId) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: NO_ACCEPTING_SHARED_GATEWAY,
      reason: "no configured shared gateway is authoritative for disposable cleanup",
    });
    return null;
  }
  const recovery = await context.deps.recoverUnreachableDisposableGateway({
    uid: user.uid,
    builderSlug,
    gatewayId: target.gatewayId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    authoritativeGatewayId,
    ...(lease.raw.returnReason === "source-unavailable" ? { sourceUnavailable: true } : {}),
  });
  if (!recovery.recovered) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "unreachable-target-recovery-pending",
      reason: `target ${target.gatewayId} is quarantined until its pods are absent`,
    });
    return null;
  }
  const retired = await context.deps.retireOwnedGateway({
    uid: user.uid,
    builderSlug,
    gatewayId: target.gatewayId,
    reason,
    leaseId: lease.leaseId,
    generation: lease.generation,
    authoritativeGatewayId,
    authoritativeLeaseStatus: authoritativeLeaseStatus(lease),
    zeroWorkloadRecoveryOperationId: recovery.operationId,
  });
  if (!retired) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "unreachable-target-retirement-fence",
      reason: `target ${target.gatewayId} did not satisfy recovery retirement fences`,
    });
    return null;
  }
  context.result.retired += 1;
  return recovery.operationId;
}

function disposableGatewayProvisioningClockStartedAt(input: {
  now: number;
  provisionedAt: number;
  target: PlacementPolicyGateway;
}): number | null {
  if (input.target.runtime === "cluster") return input.provisionedAt;
  const computerStartedAt = millis(input.target.computerStartedAt);
  return computerStartedAt !== null &&
    computerStartedAt >= input.provisionedAt &&
    computerStartedAt <= input.now
    ? computerStartedAt
    : null;
}

function disposableGatewayProvisioningBudgetOpen(input: {
  now: number;
  provisionedAt: number;
  target: PlacementPolicyGateway;
}): boolean {
  const clockStartedAt = disposableGatewayProvisioningClockStartedAt(input);
  if (clockStartedAt === null) {
    return input.now - input.provisionedAt < DISPOSABLE_GATEWAY_COMPUTER_START_TIMEOUT_MS;
  }
  const provisionElapsedMs = input.now - clockStartedAt;
  if (provisionElapsedMs < DISPOSABLE_GATEWAY_PROVISION_TIMEOUT_MS) return true;
  const runtimeStartedAt = millis(input.target.runtimeStartedAt);
  if (
    runtimeStartedAt === null ||
    runtimeStartedAt < clockStartedAt ||
    runtimeStartedAt > input.now
  ) {
    return false;
  }
  return input.now - runtimeStartedAt < DISPOSABLE_GATEWAY_RUNTIME_STARTUP_TIMEOUT_MS &&
    provisionElapsedMs < DISPOSABLE_GATEWAY_TOTAL_PROVISION_TIMEOUT_MS;
}

async function cleanupUnreachableProvisioningTarget(
  input: ActivationTargetContext,
): Promise<boolean> {
  const { context, user, current, lease, target } = input;
  if (target.desiredStatus === "running" && provisioningTargetActivationReady(target, lease)) return false;
  if (target.desiredStatus !== "running" && target.desiredStatus !== "paused") return false;
  if (!isSharedPoolGateway(context, current)) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "unreachable-target-authority-fence",
      reason: `Builder is assigned to ${current ?? "missing"}, not a configured shared gateway`,
    });
    return true;
  }
  if (target.desiredStatus === "running") {
    const provisionedAt = millis(lease.raw.provisionedAt);
    if (provisionedAt === null) {
      blockPlacement(context, {
        uid: user.uid,
        lease,
        code: "unreachable-target-timestamp-missing",
        reason: `target ${target.gatewayId} is not ready and the provisioning timestamp is missing`,
      });
      return true;
    }
    if (disposableGatewayProvisioningBudgetOpen({
      now: context.deps.now(),
      provisionedAt,
      target,
    })) {
      return true;
    }
  }
  const recoveryOperationId = await recoverAndRetireUnreachableTarget(
    input,
    target.desiredStatus === "running" ? "provisioning-timeout" : "provisioning-target-paused",
  );
  if (!recoveryOperationId) return true;
  await context.deps.failActivationLease({
    uid: user.uid,
    leaseId: lease.leaseId,
    generation: lease.generation,
    targetGatewayId: target.gatewayId,
    operationId: recoveryOperationId,
    message: "disposable gateway did not become reachable before timeout",
  });
  return true;
}

async function reconcileRequestedActivation(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  lease: BuilderActivationLease,
): Promise<void> {
  const sourceGatewayId = nonEmptyString(lease.raw.sourceGatewayId);
  const sourceAssignmentEpoch = Number.isSafeInteger(lease.raw.sourceAssignmentEpoch)
    ? lease.raw.sourceAssignmentEpoch as number
    : null;
  const entitlementTier = nonEmptyString(lease.raw.entitlementTier) as BuilderTierName | null;
  const sizingTier = nonEmptyString(lease.raw.sizingTier) as SizingTier | null;
  if (
    !sourceGatewayId ||
    sourceAssignmentEpoch === null ||
    !entitlementTier ||
    !sizingTier
  ) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "requested-lease-invalid",
      reason: "requested activation lease is missing its source or entitlement snapshot",
    });
    return;
  }
  const keptSizing = entitledComputerSizing(context, user) === sizingTier ? sizingTier : null;
  if (!await retireObsoleteParkedComputers(context, user, builderSlug, lease, keptSizing)) return;
  const parked = context.state.gateways.filter(
    (gateway) => parkedComputerGateway(gateway, user.uid, builderSlug, keptSizing),
  );
  if (parked.length > 1) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "parked-gateway-ambiguous",
      reason: `${parked.length} parked gateways match ${sizingTier}: ${parked.map((gateway) => gateway.gatewayId).join(", ")}`,
    });
    return;
  }
  const parkedGateway = parked[0];
  await context.deps.allocateDisposableGateway({
    uid: user.uid,
    builderSlug,
    leaseId: lease.leaseId,
    generation: lease.generation,
    sourceGatewayId,
    sourceAssignmentEpoch,
    entitlementTier,
    sizingTier,
    ...(parkedGateway
      ? { parkedGateway: { gatewayId: parkedGateway.gatewayId, generation: parkedGateway.allocation!.generation } }
      : {}),
  });
}

async function retireProvisioningTarget(
  input: ActivationTargetContext,
  reason: PlacementRetirementReason,
  blocked: { code: string; reason: string },
): Promise<boolean> {
  const { context, user, builderSlug, lease, target } = input;
  const retired = target.ready
    ? await context.deps.retireOwnedGateway({
        uid: user.uid,
        builderSlug,
        gatewayId: target.gatewayId,
        reason,
        leaseId: lease.leaseId,
        generation: lease.generation,
        authoritativeGatewayId: sharedAuthorityGatewayId(
          context,
          currentGatewayId(user.data),
        ) ?? context.state.defaultGatewayId,
        authoritativeLeaseStatus: "provisioning",
      })
    : Boolean(await recoverAndRetireUnreachableTarget(input, reason));
  if (!retired) {
    blockPlacement(context, { uid: user.uid, lease, ...blocked });
    return false;
  }
  if (target.ready) context.result.retired += 1;
  return true;
}

async function cleanupUnauthorizedProvisioningTarget(
  input: ActivationTargetContext,
): Promise<boolean> {
  const { context, user, lease, target } = input;
  const authorized = accountAllowsInteractiveAccess(user.data) &&
    resolveBuilderTier(user.data, new Date(context.deps.now())) !== null;
  if (authorized) return false;
  if (!await retireProvisioningTarget(input, "builder-authorization-ended", {
    code: "provisioning-authorization-cleanup-pending",
    reason: `target ${target.gatewayId} is awaiting safe cleanup after authorization ended`,
  })) return true;
  await context.deps.failActivationLease({
    uid: user.uid,
    leaseId: lease.leaseId,
    generation: lease.generation,
    targetGatewayId: target.gatewayId,
    operationId: `builder-authorization-ended-${target.gatewayId}`,
    message: "Builder authorization ended before activation cutover",
  });
  return true;
}

function pendingMoveOffDrainingSharedSlot(
  context: PlacementPolicyReconcileContext,
  operation: PlacementPolicyMigration,
  current: string | null,
  builderSlug: string,
): boolean {
  return operation.status === "pending" &&
    operation.source === CONTINUOUS_PLACEMENT_POLICY_SOURCE &&
    operation.builderSlug === builderSlug &&
    current !== null &&
    operation.fromGatewayId === current &&
    isSharedPoolGateway(context, current) &&
    context.gateways.get(current)?.desiredStatus === "draining";
}

async function supersedeDrainMoveForActivation(
  input: ActivationTargetContext,
  operation: PlacementPolicyMigration,
  activationOperationId: string,
): Promise<boolean> {
  const { context, user, builderSlug, current, lease, target } = input;
  if (!pendingMoveOffDrainingSharedSlot(context, operation, current, builderSlug)) return false;
  const superseded = await context.deps.supersedePendingSharedDrainMove({
    operationId: operation.id,
    uid: user.uid,
    builderSlug,
    fromGatewayId: operation.fromGatewayId,
    toGatewayId: operation.toGatewayId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    targetGatewayId: target.gatewayId,
    activationOperationId,
  });
  if (!superseded) return false;
  context.migrations.delete(user.uid);
  context.deps.log(
    `[placement-policy] superseded pending drain move ${operation.id} uid=${user.uid} ` +
    `lease=${lease.leaseId} generation=${lease.generation} for activation ${activationOperationId}`,
  );
  return true;
}

function targetClaimedForLease(target: PlacementPolicyGateway, lease: BuilderActivationLease): boolean {
  const report = target.configuredBuilder;
  if (report?.state !== "claimed") return false;
  return report.generation === lease.generation || (target.runtime === "gce-vm" && report.generation === null);
}

function provisioningTargetActivationReady(target: PlacementPolicyGateway, lease: BuilderActivationLease): boolean {
  return disposableTargetActivationReady(target) && targetClaimedForLease(target, lease);
}

async function advanceReadyProvisioningTarget(
  input: ActivationTargetContext,
): Promise<void> {
  const { context, user, builderSlug, current, lease, target } = input;
  const operationId = builderActivateOperationId(lease.targetGatewayId!, lease.generation);
  const active = context.migrations.get(user.uid);
  if (active && !await supersedeDrainMoveForActivation(input, active, operationId)) {
    if (!activationMigrationMatches(active, {
      id: operationId,
      uid: user.uid,
      builderSlug,
      fromGatewayId: current ?? sharedAuthorityGatewayId(context, null) ?? context.state.defaultGatewayId,
      toGatewayId: target.gatewayId,
    })) {
      blockPlacement(context, {
        uid: user.uid,
        lease,
        code: "activation-migration-conflict",
        reason: `active migration ${active.id} does not match move-in demand`,
      });
      return;
    }
    context.result.adopted += 1;
    await context.deps.advanceActivationLease({
      uid: user.uid,
      leaseId: lease.leaseId,
      generation: lease.generation,
      fromStatus: "provisioning",
      toStatus: "activating",
      operationId: active.id,
    });
    return;
  }
  const enqueuedOperationId = await context.deps.enqueueMigration({
    uid: user.uid,
    builderSlug,
    fromGatewayId: current ?? sharedAuthorityGatewayId(context, null) ?? context.state.defaultGatewayId,
    toGatewayId: target.gatewayId,
    source: BUILDER_ACTIVATION_LEASE_SOURCE,
    operationId,
  });
  context.result.enqueued += 1;
  await context.deps.advanceActivationLease({
    uid: user.uid,
    leaseId: lease.leaseId,
    generation: lease.generation,
    fromStatus: "provisioning",
    toStatus: "activating",
    operationId: enqueuedOperationId,
  });
}

async function reconcileProvisioningActivation(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
  lease: BuilderActivationLease,
): Promise<void> {
  const targetGatewayId = lease.targetGatewayId;
  const target = targetGatewayId ? context.gateways.get(targetGatewayId) : null;
  if (!target || !disposableTargetIdentityMatchesLease(target, user, lease)) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "provisioning-target-fence",
      reason: `target ${targetGatewayId ?? "missing"} does not match the activation lease`,
    });
    return;
  }
  if (await cleanupFailedActivation({
    context,
    user,
    builderSlug,
    current,
    lease,
    target,
  })) return;
  if (current === targetGatewayId) {
    await context.deps.advanceActivationLease({
      uid: user.uid,
      leaseId: lease.leaseId,
      generation: lease.generation,
      fromStatus: "provisioning",
      toStatus: "active",
    });
    return;
  }
  if (target.desiredStatus === "retired") {
    await context.deps.failActivationLease({
      uid: user.uid,
      leaseId: lease.leaseId,
      generation: lease.generation,
      targetGatewayId: target.gatewayId,
      operationId: placementRetireOperationId(user.uid, target.gatewayId, lease.generation),
      message: "disposable gateway retired before activation cutover completed",
    });
    return;
  }
  const targetInput = { context, user, builderSlug, current, lease, target };
  if (await cleanupUnauthorizedProvisioningTarget(targetInput)) return;
  if (
    await cleanupUnreachableProvisioningTarget({
      context,
      user,
      builderSlug,
      current,
      lease,
      target,
    })
  ) {
    return;
  }
  if (target.desiredStatus !== "running") {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "provisioning-target-status",
      reason: `target ${target.gatewayId} has desired status ${target.desiredStatus}`,
    });
    return;
  }
  if (!provisioningTargetActivationReady(target, lease)) return;
  await advanceReadyProvisioningTarget(targetInput);
}

async function reconcileActivatingLease(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
  lease: BuilderActivationLease,
): Promise<void> {
  const targetGatewayId = lease.targetGatewayId;
  const target = targetGatewayId ? context.gateways.get(targetGatewayId) : null;
  if (!target || !disposableTargetIdentityMatchesLease(target, user, lease)) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "activating-target-fence",
      reason: `target ${targetGatewayId ?? "missing"} does not match the activation lease`,
    });
    return;
  }
  if (await cleanupFailedActivation({
    context,
    user,
    builderSlug,
    current,
    lease,
    target,
  })) return;
  const authorized = accountAllowsInteractiveAccess(user.data) &&
    resolveBuilderTier(user.data, new Date(context.deps.now())) !== null;
  if (!authorized && current !== lease.targetGatewayId) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "activating-authorization-ended",
      reason: "activation migration must roll back because Builder authorization ended",
    });
    return;
  }
  if (current !== lease.targetGatewayId) return;
  await context.deps.advanceActivationLease({
    uid: user.uid,
    leaseId: lease.leaseId,
    generation: lease.generation,
    fromStatus: "activating",
    toStatus: "active",
  });
}

async function cleanupFailedActivation(
  input: ActivationTargetContext,
): Promise<boolean> {
  const { context, user, builderSlug, current, lease, target } = input;
  const operationId = builderActivateOperationId(target.gatewayId, lease.generation);
  const operation = context.operations.get(operationId);
  if (!operation || (operation.status !== "failed" && operation.status !== ROLLED_BACK_STATUS)) {
    return false;
  }
  if (operation.sourceRecoveryPending) return true;
  if (target.desiredStatus !== "retired") {
    const recoveredRetirement = isSharedPoolGateway(context, current) && !target.ready;
    const retired = recoveredRetirement
      ? Boolean(await recoverAndRetireUnreachableTarget(input, "activation-failed"))
      : await context.deps.retireOwnedGateway({
          uid: user.uid,
          builderSlug,
          gatewayId: target.gatewayId,
          reason: "activation-failed",
          leaseId: lease.leaseId,
          generation: lease.generation,
          telemetryFenceOperationId: operationId,
          telemetryFenceStatus: "terminal-failure",
        });
    if (!retired) {
      blockPlacement(context, {
        uid: user.uid,
        lease,
        code: "failed-activation-cleanup-fence",
        reason: `target ${target.gatewayId} did not satisfy failure cleanup fences`,
      });
      return true;
    }
    if (!recoveredRetirement) context.result.retired += 1;
  }
  await context.deps.failActivationLease({
    uid: user.uid,
    leaseId: lease.leaseId,
    generation: lease.generation,
    targetGatewayId: target.gatewayId,
    operationId,
    message: operation.error ?? `activation migration ${operation.status}`,
  });
  return true;
}

async function queueLeaseReturn(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  lease: BuilderActivationLease,
): Promise<void> {
  const targetGatewayId = lease.targetGatewayId!;
  const active = context.migrations.get(user.uid);
  if (active) {
    if (!activationMigrationMatches(active, {
      id: builderReturnOperationId(targetGatewayId, lease.generation),
      uid: user.uid,
      builderSlug,
      fromGatewayId: targetGatewayId,
      toGatewayId: active.toGatewayId,
    }) || !isSharedPoolGateway(context, active.toGatewayId)) {
      blockPlacement(context, {
        uid: user.uid,
        lease,
        code: "return-migration-conflict",
        reason: `active migration ${active.id} does not match return demand`,
      });
      return;
    }
    context.result.adopted += 1;
    await context.deps.advanceActivationLease({
      uid: user.uid,
      leaseId: lease.leaseId,
      generation: lease.generation,
      fromStatus: "active",
      toStatus: "returning",
      operationId: active.id,
    });
    return;
  }
  const returnTarget = selectReturnSharedGateway(context, user.uid);
  if ("blockedReason" in returnTarget) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: NO_ACCEPTING_SHARED_GATEWAY,
      reason: returnTarget.blockedReason,
    });
    return;
  }
  const sharedGatewayId = returnTarget.gatewayId;
  const operationId = await context.deps.enqueueMigration({
    uid: user.uid,
    builderSlug,
    fromGatewayId: targetGatewayId,
    toGatewayId: sharedGatewayId,
    source: BUILDER_ACTIVATION_LEASE_SOURCE,
    operationId: builderReturnOperationId(targetGatewayId, lease.generation),
  });
  projectSharedGatewayPlacement(context, sharedGatewayId);
  context.result.enqueued += 1;
  await context.deps.advanceActivationLease({
    uid: user.uid,
    leaseId: lease.leaseId,
    generation: lease.generation,
    fromStatus: "active",
    toStatus: "returning",
    operationId,
  });
}

function completedReturnMigration(input: ActivationTargetContext): PlacementPolicyMigration | null {
  const { context, user, builderSlug, current, lease, target } = input;
  const operationId = builderReturnOperationId(lease.targetGatewayId!, lease.generation);
  const operation = context.operations.get(operationId);
  if (
    !isSharedPoolGateway(context, current) ||
    current !== operation?.toGatewayId ||
    operation?.status !== "succeeded" ||
    !disposableTargetIdentityMatchesLease(target, user, lease) ||
    !activationMigrationMatches(operation, {
      id: operationId,
      uid: user.uid,
      builderSlug,
      fromGatewayId: target.gatewayId,
      toGatewayId: operation?.toGatewayId ?? "",
    })
  ) {
    return null;
  }
  return operation;
}

function builderActivityRequiresRuntime(
  activity: BuilderRuntimeActivity,
  returnRequested: boolean,
  now: () => number,
  idleMs: number,
): boolean {
  return !returnRequested && (
    activity.lastActiveAt === null ||
    now() - activity.lastActiveAt < idleMs
  );
}

function leaseTierChanged(lease: BuilderActivationLease, tier: string): boolean {
  return typeof lease.raw.entitlementTier === "string" && lease.raw.entitlementTier !== tier;
}

async function reconcileActiveLease(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
  lease: BuilderActivationLease,
): Promise<void> {
  const targetGatewayId = lease.targetGatewayId;
  const target = targetGatewayId ? context.gateways.get(targetGatewayId) : null;
  const targetInput = target
    ? { context, user, builderSlug, current, lease, target }
    : null;
  const completedReturn = targetInput ? completedReturnMigration(targetInput) : null;
  if (completedReturn) {
    await context.deps.advanceActivationLease({
      uid: user.uid,
      leaseId: lease.leaseId,
      generation: lease.generation,
      fromStatus: "active",
      toStatus: "returning",
      operationId: completedReturn.id,
    });
    return;
  }
  if (
    current !== targetGatewayId ||
    !target ||
    !disposableTargetMatchesLease(target, user, lease)
  ) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "active-lease-fence",
      reason: `current gateway ${current ?? "missing"} does not match an active disposable target`,
    });
    return;
  }
  const tier = resolveBuilderTier(user.data, new Date(context.deps.now()));
  const authorized = accountAllowsInteractiveAccess(user.data) && tier !== null;
  if (!authorized) {
    await queueLeaseReturn(context, user, builderSlug, lease);
    return;
  }
  if (leaseTierChanged(lease, tier!)) {
    await context.deps.requestTierTransition({ uid: user.uid, leaseId: lease.leaseId, generation: lease.generation, targetGatewayId: targetGatewayId!, tier: tier! });
    await queueLeaseReturn(context, user, builderSlug, lease);
    return;
  }
  const returnRequested = millis(lease.raw.returnRequestedAt) !== null;
  if (!returnRequested && context.state.idleMs <= 0) {
    return;
  }
  const activity = await context.deps.readBuilderActivity({
    uid: user.uid,
    builderSlug,
    gatewayId: targetGatewayId!,
    userData: user.data,
  });
  if (builderActivityRequiresRuntime(
    activity,
    returnRequested,
    context.deps.now,
    context.state.idleMs,
  )) return;
  await queueLeaseReturn(context, user, builderSlug, lease);
}

async function reconcileReturnMigrationOnTarget(
  input: ActivationTargetContext,
): Promise<boolean> {
  const { context, user, builderSlug, current, lease } = input;
  const targetGatewayId = lease.targetGatewayId!;
  if (current !== targetGatewayId) return false;
  const operationId = builderReturnOperationId(targetGatewayId, lease.generation);
  const returnOperation = context.operations.get(operationId);
  if (
    (returnOperation?.status === "failed" ||
      returnOperation?.status === ROLLED_BACK_STATUS) &&
    returnOperation.retryRequested !== true && returnOperation.sharedRevisionRetryable !== true &&
    !isGatewayStartupUnavailable(returnOperation.error)
  ) {
    blockTerminalReturnOperation(context, user.uid, lease, returnOperation);
    return true;
  }
  const active = context.migrations.get(user.uid);
  if (active) {
    if (activationMigrationMatches(active, {
      id: operationId,
      uid: user.uid,
      builderSlug,
      fromGatewayId: targetGatewayId,
      toGatewayId: active.toGatewayId,
    }) && isSharedPoolGateway(context, active.toGatewayId)) {
      context.result.adopted += 1;
    } else {
      blockPlacement(context, {
        uid: user.uid,
        lease,
        code: "return-migration-conflict",
        reason: `active migration ${active.id} does not match return demand`,
      });
    }
    return true;
  }
  const returnTarget = selectReturnSharedGateway(context, user.uid);
  if ("blockedReason" in returnTarget) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: NO_ACCEPTING_SHARED_GATEWAY,
      reason: returnTarget.blockedReason,
    });
    return true;
  }
  const sharedGatewayId = returnTarget.gatewayId;
  await context.deps.enqueueMigration({
    uid: user.uid,
    builderSlug,
    fromGatewayId: targetGatewayId,
    toGatewayId: sharedGatewayId,
    source: BUILDER_ACTIVATION_LEASE_SOURCE,
    operationId,
  });
  projectSharedGatewayPlacement(context, sharedGatewayId);
  context.result.enqueued += 1;
  return true;
}

function blockTerminalReturnOperation(
  context: PlacementPolicyReconcileContext,
  uid: string,
  lease: BuilderActivationLease,
  operation: PlacementPolicyMigration,
): void {
  blockPlacement(context, {
    uid,
    lease,
    code: "return-operation-failed",
    reason: `return operation ended with ${operation.status}: ${operation.error ?? "unknown error"}`,
  });
}

function returnedComputerStaysParked(
  input: ActivationTargetContext,
  operation: PlacementPolicyMigration | undefined,
): boolean {
  const { context, user, builderSlug, lease, target } = input;
  return operation?.status === "succeeded" &&
    lease.raw.returnReason !== "source-unavailable" &&
    millis(lease.raw.operatorTerminateRequestedAt) === null &&
    parkedComputerGateway(target, user.uid, builderSlug, entitledComputerSizing(context, user));
}

function returnRetirementReason(lease: BuilderActivationLease): PlacementRetirementReason {
  return millis(lease.raw.operatorTerminateRequestedAt) === null ? "builder-returned" : "operator-terminated";
}

async function completeReturnedLease(
  input: ActivationTargetContext,
): Promise<void> {
  const { context, user, builderSlug, lease, target } = input;
  const targetGatewayId = lease.targetGatewayId!;
  const returnOperationId = builderReturnOperationId(targetGatewayId, lease.generation);
  const reason = returnRetirementReason(lease);
  const operation = context.operations.get(returnOperationId);
  if (operation?.status === "pending" || operation?.status === "running") {
    context.result.adopted += 1;
    return;
  }
  if (target.desiredStatus === "retired") {
    await context.deps.completeActivationLease({
      uid: user.uid,
      leaseId: lease.leaseId,
      generation: lease.generation,
      targetGatewayId,
    });
    return;
  }
  if (returnedComputerStaysParked(input, operation)) {
    await context.deps.completeActivationLease({
      uid: user.uid,
      leaseId: lease.leaseId,
      generation: lease.generation,
      targetGatewayId,
      parked: true,
    });
    return;
  }
  if (
    lease.raw.returnReason === "source-unavailable" ||
    !target.ready ||
    target.desiredStatus === "paused"
  ) {
    const recoveryOperationId = await recoverAndRetireUnreachableTarget(input, reason);
    if (!recoveryOperationId) return;
    await context.deps.completeActivationLease({
      uid: user.uid,
      leaseId: lease.leaseId,
      generation: lease.generation,
      targetGatewayId,
    });
    return;
  }
  if (target.desiredStatus !== "running") {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "return-target-status",
      reason: `target ${target.gatewayId} has desired status ${target.desiredStatus}`,
    });
    return;
  }
  const operatorTermination = millis(lease.raw.operatorTerminateRequestedAt) !== null;
  const retired = await context.deps.retireOwnedGateway({
    uid: user.uid,
    builderSlug,
    gatewayId: targetGatewayId,
    reason,
    leaseId: lease.leaseId,
    generation: lease.generation,
    ...(operatorTermination
      ? {}
      : {
          telemetryFenceOperationId: returnOperationId,
          telemetryFenceStatus: "succeeded" as const,
        }),
    authoritativeGatewayId: sharedAuthorityGatewayId(
      context,
      currentGatewayId(user.data),
    ) ?? context.state.defaultGatewayId,
  });
  if (!retired) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "return-retirement-fence",
      reason: `target ${targetGatewayId} did not satisfy retirement fences`,
    });
    return;
  }
  context.result.retired += 1;
  await context.deps.completeActivationLease({
    uid: user.uid,
    leaseId: lease.leaseId,
    generation: lease.generation,
    targetGatewayId,
  });
}

async function reconcileReturningLease(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
  lease: BuilderActivationLease,
): Promise<void> {
  const targetGatewayId = lease.targetGatewayId;
  const target = targetGatewayId ? context.gateways.get(targetGatewayId) : null;
  if (
    !targetGatewayId ||
    !target ||
    !disposableTargetIdentityMatchesLease(target, user, lease)
  ) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "returning-target-fence",
      reason: `target ${targetGatewayId ?? "missing"} does not match the returning lease`,
    });
    return;
  }
  const targetInput = { context, user, builderSlug, current, lease, target };
  if (await reconcileReturnMigrationOnTarget(targetInput)) return;
  if (!isSharedPoolGateway(context, current)) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "return-authority-fence",
      reason: `Builder is assigned to ${current ?? "missing"}, not a configured shared gateway`,
    });
    return;
  }
  await completeReturnedLease(targetInput);
}

async function reconcileActivationLease(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
): Promise<boolean> {
  const lease = builderActivationLease(user.data);
  if (!lease) return false;
  if (lease.status === "requested") {
    await reconcileRequestedActivation(context, user, builderSlug, lease);
    return true;
  }
  if (lease.status === "provisioning") {
    await reconcileProvisioningActivation(context, user, builderSlug, current, lease);
    return true;
  }
  if (lease.status === "activating") {
    await reconcileActivatingLease(context, user, builderSlug, current, lease);
    return true;
  }
  if (lease.status === "active") {
    await reconcileActiveLease(context, user, builderSlug, current, lease);
    return true;
  }
  if (lease.status === "returning") {
    await reconcileReturningLease(context, user, builderSlug, current, lease);
    return true;
  }
  return false;
}

function retainUnavailableActiveBuilder(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  current: string | null,
): boolean {
  const lease = builderActivationLease(user.data);
  const source = current ? context.gateways.get(current) : null;
  if (lease?.status === "active" && current === lease.targetGatewayId && source &&
    disposableTargetIdentityMatchesLease(source, user, lease) &&
    (source.desiredStatus !== "running" || !source.ready || knownKubernetesUnavailable(source))) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: source.desiredStatus === "paused" ? "builder-paused" : "builder-runtime-unavailable",
      reason: `retaining Builder authority and home on ${source.gatewayId}; ` +
        (source.desiredStatus === "paused" ? "waiting for resume" : "waiting for runtime recovery"),
    });
    return true;
  }
  return false;
}

async function reconcileEligibleBuilder(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
): Promise<void> {
  const current = currentGatewayId(user.data);
  if (retainUnavailableActiveBuilder(context, user, current)) return;
  if (
    await reconcileRecoveredDisposableRuntimeReset(
      context,
      user,
      builderSlug,
      current,
    )
  ) return;
  if (await reconcileUnavailableServingGateway(context, user, builderSlug, current)) return;
  if (await reconcileActivationLease(context, user, builderSlug, current)) return;
  const entitledOwned = resolveLiveActivationTargetGatewayId({
    userData: user.data,
    now: new Date(context.deps.now()),
  });
  const resolvedPlacement = resolveContinuousBuilderPlacement({
    uid: user.uid,
    userData: user.data,
    currentGatewayId: current,
    defaultGatewayId: context.state.defaultGatewayId,
    ownedGateway: entitledOwned ? context.gateways.get(entitledOwned) ?? null : null,
    now: new Date(context.deps.now()),
  });
  const activeMigration = context.migrations.get(user.uid);
  const targetGatewayId = eligiblePlacementTargetGatewayId(
    context,
    user.uid,
    current,
    resolvedPlacement,
    activeMigration,
  );
  if (!targetGatewayId) {
    blockPlacement(context, {
      uid: user.uid,
      code: NO_ACCEPTING_SHARED_GATEWAY,
      reason: "no configured shared gateway is accepting placement",
    });
    return;
  }
  const placement = { ...resolvedPlacement, targetGatewayId };
  await reconcileResolvedPlacement(context, user, builderSlug, current, placement);
}

function eligiblePlacementTargetGatewayId(
  context: PlacementPolicyReconcileContext,
  uid: string,
  currentGatewayId: string | null,
  placement: ReturnType<typeof resolveContinuousBuilderPlacement>,
  activeMigration: PlacementPolicyMigration | undefined,
): string | null {
  if (placement.ownedGatewayId !== null) return placement.targetGatewayId;
  if (activeMigration && isSharedPoolGateway(context, activeMigration.toGatewayId)) {
    return activeMigration.toGatewayId;
  }
  return selectAcceptingSharedGateway(
    context,
    uid,
    currentGatewayId === null ? "initial-placement" : "migration",
    currentGatewayId,
  );
}

async function reconcileResolvedPlacement(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
  placement: ReturnType<typeof resolveContinuousBuilderPlacement>,
): Promise<void> {
  if (!current) {
    await assignMissingPlacement(context, user, builderSlug, placement);
    return;
  }
  if (placement.targetGatewayId === current) {
    if (placement.ownedGatewayId === null && isSharedPoolGateway(context, current)) {
      await retireUnentitledOwnedGateways(context, user, builderSlug);
    }
    return;
  }
  if (placement.ownedGatewayId === null && isSharedPoolGateway(context, current)) {
    const source = context.gateways.get(current);
    if (!source || !kubernetesReady(source)) {
      blockPlacement(context, {
        uid: user.uid,
        code: "shared-source-not-ready",
        reason: `source ${current} is not known Kubernetes Ready`,
      });
      return;
    }
    return;
  }
  if (adoptActiveMigration(context, user.uid, placement.targetGatewayId)) return;
  const sourceEpoch = sourceAssignmentEpoch(context, current, user.uid);
  await context.deps.enqueueMigration({
    uid: user.uid,
    builderSlug,
    fromGatewayId: current,
    toGatewayId: placement.targetGatewayId,
    source: CONTINUOUS_PLACEMENT_POLICY_SOURCE,
    operationId: continuousPlacementMigrationOperationId({
      uid: user.uid,
      builderSlug,
      fromGatewayId: current,
      toGatewayId: placement.targetGatewayId,
      sourceAssignmentEpoch: sourceEpoch,
    }),
  });
  projectSharedGatewayPlacement(context, placement.targetGatewayId);
  context.result.enqueued += 1;
}

async function reconcilePlacementUser(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
): Promise<void> {
  const eligibility = resolveOnboardingPlacementEligibility(user.data);
  if (!eligibility.eligible) return;
  await reconcileEligibleBuilder(context, user, eligibility.slug);
}

function settledSharedAssignment(
  assignment: PlacementPolicyAssignment,
  now: number,
): boolean {
  return typeof assignment.createdAt === "number" &&
    now - assignment.createdAt >= SHARED_GATEWAY_REBALANCE_STABILITY_MS;
}

function sharedRebalanceBuilder(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  fromGatewayId: string,
  scheduled: ReadonlySet<string>,
): { uid: string; builderSlug: string; sourceAssignmentEpoch: number; settledAt: number } | null {
  if (scheduled.has(user.uid) || currentGatewayId(user.data) !== fromGatewayId) return null;
  if (record(record(user.data.provisioning)?.openclaw)?.status !== "complete") return null;
  const lease = builderActivationLease(user.data);
  if (lease && LIVE_LEASE_STATUSES.has(lease.status)) return null;
  const eligibility = resolveOnboardingPlacementEligibility(user.data);
  if (!eligibility.eligible || context.migrations.has(user.uid)) return null;
  const assignment = context.assignments.get(
    placementAssignmentKey(fromGatewayId, user.uid),
  );
  if (assignment?.state !== "serving") return null;
  if (!settledSharedAssignment(assignment, context.deps.now())) return null;
  const sourceAssignmentEpoch = nonNegativeInteger(assignment.epoch);
  if (sourceAssignmentEpoch === null) return null;
  return {
    uid: user.uid,
    builderSlug: eligibility.slug,
    sourceAssignmentEpoch,
    settledAt: assignment.createdAt!,
  };
}

function longestSettledSharedRebalanceBuilder(
  context: PlacementPolicyReconcileContext,
  users: readonly PlacementPolicyUser[],
  fromGatewayId: string,
  scheduled: ReadonlySet<string>,
): { uid: string; builderSlug: string; sourceAssignmentEpoch: number } | null {
  let chosen: ReturnType<typeof sharedRebalanceBuilder> = null;
  for (const user of users) {
    const candidate = sharedRebalanceBuilder(context, user, fromGatewayId, scheduled);
    if (!candidate) continue;
    if (!chosen || candidate.settledAt < chosen.settledAt) chosen = candidate;
  }
  return chosen
    ? { uid: chosen.uid, builderSlug: chosen.builderSlug, sourceAssignmentEpoch: chosen.sourceAssignmentEpoch }
    : null;
}

function applyProjectedRebalance(
  candidates: SharedGatewayPoolCandidate[],
  fromGatewayId: string,
  toGatewayId: string,
): void {
  const source = candidates.find((candidate) => candidate.gatewayId === fromGatewayId);
  const target = candidates.find((candidate) => candidate.gatewayId === toGatewayId);
  if (!source || !target) throw new Error("shared rebalance candidates changed during planning");
  source.assignmentCount -= 1;
  target.assignmentCount += 1;
}

function compareSharedGatewayLoad(
  left: SharedGatewayPoolCandidate,
  right: SharedGatewayPoolCandidate,
): number {
  const loadDifference = authoritativeSharedGatewayLoad(left) - authoritativeSharedGatewayLoad(right);
  return loadDifference !== 0 ? loadDifference : compareSharedGatewayIds(left.gatewayId, right.gatewayId);
}

function planPlatformPreferredSharedGatewayRebalance(
  context: PlacementPolicyReconcileContext,
  candidates: readonly SharedGatewayPoolCandidate[],
): SharedGatewayRebalance | null {
  const config = sharedGatewayPlacementConfig(context);
  const platformCurrent = new Set(context.state.platformCurrentGatewayIds);
  const settled = candidates
    .filter((candidate) => isSettledSharedGateway(config, candidate))
    .sort(compareSharedGatewayLoad);
  const currentWithHeadroom = settled.filter((candidate) =>
    platformCurrent.has(candidate.gatewayId) &&
    authoritativeSharedGatewayLoad(candidate) < context.state.buildersPerGateway);
  const to = (currentWithHeadroom.length > 0 ? currentWithHeadroom : settled)[0];
  if (!to) return null;
  const toIsCurrent = platformCurrent.has(to.gatewayId);
  const from = settled
    .filter((candidate) =>
      candidate.gatewayId !== to.gatewayId &&
      (toIsCurrent || !platformCurrent.has(candidate.gatewayId)))
    .at(-1);
  if (!from) return null;
  return authoritativeSharedGatewayLoad(from) - authoritativeSharedGatewayLoad(to) >= 2
    ? { fromGatewayId: from.gatewayId, toGatewayId: to.gatewayId }
    : null;
}

async function reconcileSharedGatewayRebalance(
  context: PlacementPolicyReconcileContext,
): Promise<void> {
  const candidates = sharedGatewayCandidates(context).map((candidate) => ({ ...candidate }));
  if (!planPlatformPreferredSharedGatewayRebalance(context, candidates)) return;
  if (!sharedGatewayPoolStableForRebalance(context)) return;
  const users = [...context.state.users].sort((left, right) => left.uid.localeCompare(right.uid));
  const scheduled = new Set<string>();
  while (true) {
    const plan = planPlatformPreferredSharedGatewayRebalance(context, candidates);
    if (!plan) return;
    const builder = longestSettledSharedRebalanceBuilder(context, users, plan.fromGatewayId, scheduled);
    if (!builder) return;
    const operationId = continuousPlacementMigrationOperationId({
      ...builder,
      fromGatewayId: plan.fromGatewayId,
      toGatewayId: plan.toGatewayId,
    });
    try {
      await context.deps.enqueueMigration({
        uid: builder.uid,
        builderSlug: builder.builderSlug,
        fromGatewayId: plan.fromGatewayId,
        toGatewayId: plan.toGatewayId,
        source: CONTINUOUS_PLACEMENT_POLICY_SOURCE,
        operationId,
      });
    } catch (error) {
      if (!isSkippablePlacementConflict(error)) throw error;
      scheduled.add(builder.uid);
      context.deps.log(
        `[placement-policy] rebalance skipped uid=${builder.uid} operationId=${operationId}: ${error.message}`,
      );
      continue;
    }
    scheduled.add(builder.uid);
    applyProjectedRebalance(candidates, plan.fromGatewayId, plan.toGatewayId);
    context.result.enqueued += 1;
  }
}

function drainingSharedGatewayBuilder(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  fromGatewayId: string,
): { uid: string; builderSlug: string; sourceAssignmentEpoch: number } | null {
  if (context.migrations.has(user.uid)) return null;
  const lease = builderActivationLease(user.data);
  if (lease && LIVE_LEASE_STATUSES.has(lease.status)) return null;
  const assignment = context.assignments.get(
    placementAssignmentKey(fromGatewayId, user.uid),
  );
  const builderSlug = assignment ? nonEmptyString(assignment.slug) : null;
  if (assignment?.state !== "serving" || builderSlug === null) return null;
  const sourceAssignmentEpoch = nonNegativeInteger(assignment.epoch);
  if (sourceAssignmentEpoch === null) return null;
  return { uid: user.uid, builderSlug, sourceAssignmentEpoch };
}

async function reconcileDrainingSharedGateway(
  context: PlacementPolicyReconcileContext,
): Promise<boolean> {
  const drainingGatewayIds = context.state.sharedGatewayIds.filter(
    (gatewayId) => context.gateways.get(gatewayId)?.desiredStatus === "draining",
  );
  if (drainingGatewayIds.length === 0) return false;
  const projectedCandidates = sharedGatewayCandidates(context).map((candidate) => ({
    ...candidate,
  }));

  for (const fromGatewayId of drainingGatewayIds) {
    const pairedTargetGatewayId = pairedReplacementTarget(context.state.sharedPoolReplacements, fromGatewayId);
    const candidates = pairedTargetGatewayId === null
      ? projectedCandidates
      : projectedCandidates.filter((candidate) => candidate.gatewayId === pairedTargetGatewayId);
    for (const user of [...context.state.users].sort((left, right) =>
      left.uid.localeCompare(right.uid))) {
      const builder = drainingSharedGatewayBuilder(context, user, fromGatewayId);
      if (!builder) continue;
      const selection = selectPlatformPreferredSharedGateway(context, {
        uid: user.uid,
        purpose: "migration",
        candidates,
      });
      if (selection.kind !== "selected") continue;
      const outcome = await enqueueDrainMove(context, {
        builder, fromGatewayId, toGatewayId: selection.gatewayId, pairedTargetGatewayId,
      });
      if (outcome === "stopped") break;
      if (outcome === "skipped") continue;
      const target = projectedCandidates.find(
        (candidate) => candidate.gatewayId === selection.gatewayId,
      )!;
      target.assignmentCount += 1;
      context.result.enqueued += 1;
    }
  }
  return true;
}

async function enqueueDrainMove(
  context: PlacementPolicyReconcileContext,
  move: {
    builder: { uid: string; builderSlug: string; sourceAssignmentEpoch: number };
    fromGatewayId: string;
    toGatewayId: string;
    pairedTargetGatewayId: string | null;
  },
): Promise<"enqueued" | "skipped" | "stopped"> {
  const { builder, fromGatewayId, toGatewayId } = move;
  try {
    await context.deps.enqueueMigration({
      uid: builder.uid,
      builderSlug: builder.builderSlug,
      fromGatewayId,
      toGatewayId,
      source: CONTINUOUS_PLACEMENT_POLICY_SOURCE,
      operationId: continuousPlacementMigrationOperationId({ ...builder, fromGatewayId, toGatewayId }),
      sharedDrain: { pairedTargetGatewayId: move.pairedTargetGatewayId },
    });
    return "enqueued";
  } catch (error) {
    if (isSkippablePlacementConflict(error)) {
      context.deps.log(
        `[placement-policy] drain of ${fromGatewayId} skipped uid=${builder.uid}: ${error.message}; an operator move is needed`,
      );
      return "skipped";
    }
    if (!(error instanceof SharedDrainSupersededError)) throw error;
    context.deps.log(`[placement-policy] drain of ${fromGatewayId} stopped: ${error.message}`);
    return "stopped";
  }
}

export async function reconcilePlacementPolicyOnce(
  deps: PlacementPolicyReconcilerDeps,
): Promise<PlacementPolicyReconcileResult> {
  const result: PlacementPolicyReconcileResult = {
    assigned: 0,
    enqueued: 0,
    adopted: 0,
    retired: 0,
    swept: 0,
    blocked: 0,
  };
  const state = await deps.readSnapshot();
  const pool = parseSharedGatewayPoolConfig({
    defaultGatewayId: state.defaultGatewayId,
    sharedGatewayIds: state.sharedGatewayIds,
  });
  if (!pool) {
    deps.log("[placement-policy] idle: the shared pool has no Cowboy-managed members yet");
    return result;
  }
  const gateways = new Map(state.gateways.map((item) => [item.gatewayId, item]));
  const unknownMirrorGatewayIds = state.users
    .flatMap((user) => {
      const gatewayId = currentGatewayId(user.data);
      return gatewayId && !gateways.has(gatewayId) ? [gatewayId] : [];
    })
    .sort();
  if (unknownMirrorGatewayIds.length > 0) {
    deps.log(
      `[placement-policy] disabled: user mirrors reference missing gateways ${[...new Set(unknownMirrorGatewayIds)].join(",")}`,
    );
    return result;
  }
  const migrations = new Map(
    state.activeMigrations
      .filter((item) => item.status === "pending" || item.status === "running")
      .map((item) => [item.uid, item]),
  );
  const operations = new Map(state.activeMigrations.map((item) => [item.id, item]));
  const assignments = new Map(
    state.assignments.map((assignment) => [
      placementAssignmentKey(assignment.gatewayId, assignment.uid),
      assignment,
    ]),
  );

  const context = {
    deps,
    state,
    gateways,
    migrations,
    operations,
    assignments,
    projectedSharedGatewayPlacements: new Map<string, number>(),
    supersededSharedGatewayIds: new Set<string>(),
    result,
  };
  for (const user of [...state.users].sort((a, b) => a.uid.localeCompare(b.uid))) {
    try {
      await reconcilePlacementUser(context, user);
    } catch (error) {
      result.blocked += 1;
      deps.log(
        `[placement-policy] ${user.uid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    const draining = await reconcileDrainingSharedGateway(context);
    if (!draining) await reconcileSharedGatewayRebalance(context);
  } catch (error) {
    result.blocked += 1;
    deps.log(
      `[placement-policy] shared placement: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await reconcileDisposableTombstones(context);
  } catch (error) {
    result.blocked += 1;
    deps.log(
      `[placement-policy] tombstone sweep: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result;
}

function liveLeaseTargetGatewayIds(
  users: ReadonlyArray<PlacementPolicyUser>,
): Set<string> {
  const targets = new Set<string>();
  for (const user of users) {
    const lease = record(record(record(user.data.provisioning)?.openclaw)?.activationLease);
    const target = lease ? nonEmptyString(lease.targetGatewayId) : null;
    if (lease && target && LIVE_LEASE_STATUSES.has(String(lease.status))) {
      targets.add(target);
    }
  }
  return targets;
}

// Disposable runtimes leave no fleet tombstone: once retirement cleanup has
// succeeded, the durable record is deleted and the Builder's placement
// receipts become the audit trail.
async function reconcileDisposableTombstones(
  context: PlacementPolicyReconcileContext,
): Promise<void> {
  const liveTargets = liveLeaseTargetGatewayIds(context.state.users);
  const candidates = context.state.gateways
    .filter((gateway) =>
      gateway.disposable &&
      gateway.desiredStatus === "retired" &&
      gateway.ownerUid !== null &&
      gateway.allocation?.generation !== undefined &&
      !liveTargets.has(gateway.gatewayId))
    .sort((a, b) => a.gatewayId.localeCompare(b.gatewayId));
  for (const gateway of candidates) {
    const deleted = await context.deps.deleteRetiredDisposableGateway({
      gatewayId: gateway.gatewayId,
      ownerUid: gateway.ownerUid!,
      generation: gateway.allocation!.generation,
    });
    if (deleted) {
      context.result.swept += 1;
    }
  }
}

function placementMigrationStatus(
  value: unknown,
): PlacementPolicyMigration["status"] | null {
  if (
    value === "pending" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === ROLLED_BACK_STATUS
  ) {
    return value;
  }
  return null;
}

function placementMigrationSource(
  value: unknown,
): PlacementPolicyMigration["source"] | null {
  if (value === CONTINUOUS_PLACEMENT_POLICY_SOURCE) return value;
  if (value === BUILDER_ACTIVATION_LEASE_SOURCE) return value;
  return null;
}

function activeMigration(operation: Stored<OperationRecord>): PlacementPolicyMigration | null {
  const data = operation as unknown as Record<string, unknown>;
  if (data.kind !== MIGRATE_CUSTOMER_KIND) return null;
  const input = record(data.input);
  if (!input) return null;
  const uid = nonEmptyString(input.uid) ?? nonEmptyString(data.inputUid);
  const builderSlug = nonEmptyString(input.builderSlug);
  const fromGatewayId = nonEmptyString(input.fromGatewayId);
  const toGatewayId = nonEmptyString(input.toGatewayId);
  const source = placementMigrationSource(input.source);
  const status = placementMigrationStatus(data.status);
  if (!uid || !builderSlug || !fromGatewayId || !toGatewayId || !source || !status) return null;
  return {
    id: operation.id,
    uid,
    builderSlug,
    fromGatewayId,
    toGatewayId,
    source,
    status,
    ...(typeof data.error === "string" ? { error: data.error } : {}),
    ...(schedulerHandoffAwaitingRelease(data) ? { sourceRecoveryPending: true } : {}),
    ...(millis(data.retryRequestedAt) !== null ? { retryRequested: true } : {}),
    ...(sharedRevisionPreflightReturnRetryable(data, operation.id) ? { sharedRevisionRetryable: true } : {}),
  };
}

interface FirestorePlacementPolicyInput {
  db: Firestore;
  store: PlatformStateStore;
  readBuilderTier: BuilderTierReader;
  placementAdmission: PlacementAdmissionPolicy;
  prepareBuilderHome?: (request: AllocateDisposableGatewayInput) => Promise<boolean>;
  informer: FleetInformer;
  namespace: string;
  idleMs: number;
  platformArtifact: ReleasePayload;
  now(): number;
  log(message: string): void;
  debug?(message: string): void;
  ensureAuthSecret(input: { namespace: string; gatewayId: string }): Promise<unknown>;
  readGatewayPodDiagnostics(input: {
    namespace: string;
    gatewayId: string;
  }): Promise<{
    status: string;
    totalPods: number;
    error?: string;
  }>;
  readGatewayPodDiagnosticsBatch(input: {
    namespace: string;
    gatewayIds: readonly string[];
    includeReplicaSets?: boolean;
  }): Promise<Record<string, PlacementPolicyPodDiagnostics>>;
}

function completedReturnOperationIds(
  userDocuments: ReadonlyArray<QueryDocumentSnapshot>,
  sharedGatewayIds: readonly string[],
): string[] {
  return userDocuments.flatMap((doc) => {
    const userData = doc.data() as Record<string, unknown>;
    const lease = builderActivationLease(userData);
    const onShared = sharedGatewayIds.includes(currentGatewayId(userData) ?? "");
    const returnMayHaveSucceeded = lease?.status === "returning" ||
      (lease?.status === "active" && onShared);
    if (!returnMayHaveSucceeded || !lease?.targetGatewayId) return [];
    return [builderReturnOperationId(lease.targetGatewayId, lease.generation)];
  });
}

async function readCompletedReturnOperations(
  store: PlatformStateStore,
  userDocuments: ReadonlyArray<QueryDocumentSnapshot>,
  sharedGatewayIds: readonly string[],
): Promise<Stored<OperationRecord>[]> {
  const operations = await store.journal.operations.getMany(completedReturnOperationIds(userDocuments, sharedGatewayIds));
  return [...operations.values()].filter((operation) => operation.status === "succeeded");
}

// A failed or rolled-back activation/return operation stays reconcile-relevant
// until its lease is cleaned up, so it is read by deterministic id rather than
// left in the tick's collection scan.
async function readTerminalLeaseOperations(
  store: PlatformStateStore,
  userDocuments: ReadonlyArray<QueryDocumentSnapshot>,
): Promise<Stored<OperationRecord>[]> {
  const operationIds = [...new Set(
    userDocuments.flatMap((doc) => leaseJournalOperationIds(doc.data() as Record<string, unknown>)),
  )];
  const operations = await store.journal.operations.getMany(operationIds);
  return [...operations.values()].filter((operation) => TERMINAL_LEASE_OPERATION_STATUSES.has(operation.status));
}

export function placementPodDiagnosticsScope(
  gatewayIds: readonly string[],
  runtimes: ReadonlyMap<string, Pick<FleetRegistryRecord, "runtime">>,
): {
  clusterGatewayIds: string[];
  vmDiagnostics: Record<string, PlacementPolicyPodDiagnostics>;
} {
  const clusterGatewayIds: string[] = [];
  const vmDiagnostics: Record<string, PlacementPolicyPodDiagnostics> = {};
  for (const gatewayId of gatewayIds) {
    if (resolveGatewayRuntime(runtimes.get(gatewayId)?.runtime) === "gce-vm") {
      vmDiagnostics[gatewayId] = { status: "unknown", totalPods: 0, readyPods: 0 };
    } else {
      clusterGatewayIds.push(gatewayId);
    }
  }
  return { clusterGatewayIds, vmDiagnostics };
}

// Must stay a reconcile tick inside GATEWAY_UNREACHABLE_AFTER_MS.
export const KUBERNETES_OBSERVATION_REFRESH_MS = 120_000;

interface KubernetesObservation {
  status: string;
  totalPods: number;
  readyPods: number;
}

// Structured record mirroring octogee.disruption.v1: emitted to stdout so Cloud
// Logging can extract gateway_id / instance_id / node_pool as log-metric labels.
// instance_id is the join key against octogee_spot_preemptions, which knows the
// preempted instance but not which gateway was running on it. Node identity is
// "unknown" rather than null when the pod was never observed on a node, so the
// metric carries an explicit unattributed series instead of a blank label.
export interface GatewayPodReplacementRecord {
  schema: typeof GATEWAY_POD_REPLACEMENT_SCHEMA;
  recordType: "gateway_pod_replacement";
  observedAt: string;
  namespace: string;
  gatewayId: string;
  podName: string;
  vacatedPodUid: string;
  replicaSetUid: string;
  nodeName: string;
  instanceId: string;
  nodePool: string;
  total: number;
}

export const UNATTRIBUTED_NODE_IDENTITY = "unknown";

function emitGatewayPodReplacementRecord(value: GatewayPodReplacementRecord): void {
  eventLogger.info("Gateway pod replaced", { ...value });
}

function storedPodPlacements(
  stored: Record<string, unknown> | null,
): GatewayPodPlacement[] | null {
  const pods = stored?.pods;
  if (!Array.isArray(pods)) return null;
  const placements: GatewayPodPlacement[] = [];
  for (const pod of pods) {
    if (!isGatewayPodPlacement(pod)) return null;
    placements.push({
      uid: pod.uid,
      name: pod.name,
      replicaSetUid: pod.replicaSetUid,
      nodeName: pod.nodeName,
      instanceId: pod.instanceId,
      nodePool: pod.nodePool,
    });
  }
  return placements;
}

function samePodPlacement(left: GatewayPodPlacement, right: GatewayPodPlacement): boolean {
  return left.uid === right.uid &&
    left.name === right.name &&
    left.replicaSetUid === right.replicaSetUid &&
    left.nodeName === right.nodeName &&
    left.instanceId === right.instanceId &&
    left.nodePool === right.nodePool;
}

// A Spot preemption replaces the pod without changing readyPods or the restart
// count, so pod identity has to be part of the freshness comparison — otherwise
// a loss inside the refresh interval is skipped and never recorded. Node facts
// are compared too: a pod first seen Pending binds to its node later, and the
// instance id it lands on must be persisted before that node can be preempted.
function samePodPlacements(
  stored: Record<string, unknown> | null,
  observed: readonly GatewayPodPlacement[] | null,
): boolean {
  if (observed === null) return true;
  const previous = storedPodPlacements(stored);
  if (previous === null) return false;
  return previous.length === observed.length &&
    previous.every((pod, index) => samePodPlacement(pod, observed[index]!));
}

function kubernetesObservationIsCurrent(input: {
  stored: unknown;
  observed: KubernetesObservation;
  observedPlacements: readonly GatewayPodPlacement[] | null;
  now: number;
}): boolean {
  const { observed, observedPlacements, now } = input;
  const current = record(input.stored);
  if (!current) return false;
  const observedAt = current.observedAt;
  if (typeof observedAt !== "number") return false;
  if (observedAt > now || now - observedAt >= KUBERNETES_OBSERVATION_REFRESH_MS) return false;
  return current.status === observed.status &&
    current.totalPods === observed.totalPods &&
    current.readyPods === observed.readyPods &&
    samePodPlacements(current, observedPlacements);
}

interface KubernetesObservationOutcome {
  transition: PodReplacementTransition | null;
  malformedReplacements: boolean;
}

function persistedKubernetesObservation(input: {
  observed: KubernetesObservation;
  now: number;
  transition: PodReplacementTransition | null;
}): { kubernetes: Record<string, unknown>; podReplacements?: GatewayPodReplacements } {
  const { observed, now, transition } = input;
  if (transition === null) return { kubernetes: { ...observed, observedAt: now } };
  return {
    kubernetes: { ...observed, observedAt: now, pods: transition.placements },
    ...(transition.replacements ? { podReplacements: transition.replacements } : {}),
  };
}

function gatewayPodReplacementRecord(input: {
  gatewayId: string;
  namespace: string;
  vacated: GatewayPodPlacement;
  total: number;
  now: number;
}): GatewayPodReplacementRecord {
  const { vacated } = input;
  return {
    schema: GATEWAY_POD_REPLACEMENT_SCHEMA,
    recordType: "gateway_pod_replacement",
    observedAt: new Date(input.now).toISOString(),
    namespace: input.namespace,
    gatewayId: input.gatewayId,
    podName: vacated.name,
    vacatedPodUid: vacated.uid,
    replicaSetUid: vacated.replicaSetUid ?? UNATTRIBUTED_NODE_IDENTITY,
    nodeName: vacated.nodeName ?? UNATTRIBUTED_NODE_IDENTITY,
    instanceId: vacated.instanceId ?? UNATTRIBUTED_NODE_IDENTITY,
    nodePool: vacated.nodePool ?? UNATTRIBUTED_NODE_IDENTITY,
    total: input.total,
  };
}

function describePlacement(pod: GatewayPodPlacement): string {
  return `${pod.name} (uid=${pod.uid} rs=${pod.replicaSetUid ?? "none"} node=${pod.nodeName ?? "unscheduled"} ` +
    `instance=${pod.instanceId ?? "unknown"} nodePool=${pod.nodePool ?? "unknown"})`;
}

// Log lines and the structured record are emitted only after the transaction
// has committed: firebase-admin re-runs the transaction callback on contention,
// and a DELTA log metric would count every retry as another loss.
function reportKubernetesObservationOutcome(input: {
  gatewayId: string;
  outcome: KubernetesObservationOutcome;
  now: number;
  options: PersistKubernetesObservationsOptions;
}): void {
  const { gatewayId, outcome, now, options } = input;
  const log = options.log ?? (() => undefined);
  if (outcome.malformedReplacements) {
    log(`[placement-policy] ${gatewayId} stored podReplacements were malformed; restarting the loss history`);
  }
  const transition = outcome.transition;
  if (!transition) return;
  for (const pod of transition.deferred) {
    log(
      `[placement-policy] ${gatewayId} pod ${describePlacement(pod)} is missing from the pod list but ` +
        `its ReplicaSet still counts it; deferring the verdict to the next observation`,
    );
  }
  for (const pod of transition.unowned) {
    log(`[placement-policy] ${gatewayId} pod ${describePlacement(pod)} vanished with no ReplicaSet owner; not counted`);
  }
  for (const pod of transition.vacated) {
    log(
      `[placement-policy] ${gatewayId} lost pod ${describePlacement(pod)} while its ReplicaSet ` +
        `still wanted it running; total=${transition.replacements?.total ?? 0}`,
    );
    (options.emitReplacement ?? emitGatewayPodReplacementRecord)(gatewayPodReplacementRecord({
      gatewayId,
      namespace: options.namespace ?? UNATTRIBUTED_NODE_IDENTITY,
      vacated: pod,
      total: transition.replacements?.total ?? 0,
      now,
    }));
  }
}

export interface PersistKubernetesObservationsOptions {
  log?: (message: string) => void;
  emitReplacement?: (record: GatewayPodReplacementRecord) => void;
  namespace?: string;
}

export interface ScannedGatewayRuntime {
  gatewayId: string;
  kubernetes: unknown;
}

export async function persistKubernetesObservations(
  store: PlatformStateStore,
  runtimes: ReadonlyArray<ScannedGatewayRuntime>,
  kubernetesByGatewayId: Readonly<Record<string, PlacementPolicyPodDiagnostics>>,
  now: number,
  options: PersistKubernetesObservationsOptions = {},
): Promise<void> {
  if (runtimes.length === 0) return;
  await Promise.all(runtimes.map(async (scanned) => {
    const diagnostics = kubernetesByGatewayId[scanned.gatewayId];
    const observed: KubernetesObservation = {
      status: placementKubernetesStatus(diagnostics),
      totalPods: diagnostics?.totalPods ?? 0,
      readyPods: diagnostics?.readyPods ?? 0,
    };
    const observedPlacements = observedPodPlacements(diagnostics);
    const replicaSets = observedReplicaSets(diagnostics);
    if (kubernetesObservationIsCurrent({
      stored: scanned.kubernetes,
      observed,
      observedPlacements,
      now,
    })) return;
    const outcome = await store.transaction(
      { label: "placement-policy.kubernetes-observation" },
      async (transaction): Promise<KubernetesObservationOutcome | null> => {
        const current = await transaction.fleetRegistry.get(scanned.gatewayId);
        if (current === null) return null;
        const storedKubernetes = record(current.kubernetes);
        const storedObservedAt = storedKubernetes?.observedAt;
        if (typeof storedObservedAt === "number" && storedObservedAt > now) return null;
        const malformedReplacements = current.podReplacements !== undefined &&
          !isGatewayPodReplacements(current.podReplacements);
        const transition = nextPodReplacementTransition({
          previousPlacements: storedPodPlacements(storedKubernetes),
          previous: isGatewayPodReplacements(current.podReplacements) ? current.podReplacements : null,
          observedPlacements,
          replicaSets,
          now,
        });
        const persisted = persistedKubernetesObservation({ observed, now, transition });
        await transaction.fleetRegistry.patch(scanned.gatewayId, {
          ...persisted,
          kubernetes: { ...storedKubernetes, ...persisted.kubernetes } as unknown as GatewayKubernetesObservation,
        }, { revision: current.revision });
        return { transition, malformedReplacements };
      },
    );
    if (outcome) {
      reportKubernetesObservationOutcome({ gatewayId: scanned.gatewayId, outcome, now, options });
    }
  }));
}


function placementAssignmentFromRecord(assignment: GatewayAssignment): PlacementPolicyAssignment {
  return {
    uid: assignment.uid,
    slug: assignment.slug,
    gatewayId: assignment.gatewayId,
    state: assignment.state,
    epoch: assignment.epoch,
    createdAt: assignment.createdAt,
    source: assignment.source,
    ...(assignment.updatedByOperationId ? { updatedByOperationId: assignment.updatedByOperationId } : {}),
  };
}

function gatewayRuntimeStartedAt(input: {
  gatewayId: string;
  gatewayClass: string;
  runtime: FleetRegistryRecord | null;
  diagnostics: PlacementPolicyPodDiagnostics | undefined;
}): number | null {
  const heartbeatStartedAt = input.runtime ? millis(input.runtime.heartbeat.startedAt) : null;
  if (input.gatewayClass !== "builder" || resolveGatewayRuntime(input.runtime?.runtime) !== "cluster") {
    return heartbeatStartedAt;
  }
  return heartbeatStartedAt ?? gatewayPodStartedAt(input.gatewayId, input.diagnostics);
}

function gatewayPodStartedAt(
  gatewayId: string,
  diagnostics: PlacementPolicyPodDiagnostics | undefined,
): number | null {
  if (!diagnostics || diagnostics.error || diagnostics.status === "unknown" ||
      !diagnostics.pods || diagnostics.totalPods !== diagnostics.pods.length) return null;
  const currentPods = diagnostics.pods.filter((pod) => Boolean(
    pod.uid && pod.gatewayId === gatewayId && pod.deleting === false &&
    pod.phase === "Running" && pod.name?.startsWith(`octogee-gateway-${gatewayId}-`) &&
    diagnostics.replicaSets?.some(owner => owner.uid === pod.replicaSetUid && owner.desiredReplicas > 0) &&
    millis(pod.gatewayContainerStartedAt) !== null,
  ));
  return currentPods.length === 1 ? millis(currentPods[0].gatewayContainerStartedAt) : null;
}

function gatewayComputerStartedAt(runtime: FleetRegistryRecord | null): number | null {
  if (runtime?.runtime !== "gce-vm") return null;
  return runtime.vm?.status === "RUNNING" ? millis(runtime.vm.startedAt) : null;
}

function gatewayRuntimeObservation(runtime: FleetRegistryRecord | null) {
  return {
    runtime: isGatewayRuntime(runtime?.runtime) ? runtime.runtime : undefined,
    computerStartedAt: gatewayComputerStartedAt(runtime),
    runtimeStatus: runtime?.heartbeat.status,
  };
}

function runtimeConfiguredBuilder(runtime: FleetRegistryRecord | null): ConfiguredBuilderReport | null {
  return runtime ? parseConfiguredBuilderReport(runtime.heartbeat.configuredBuilder) : null;
}

function placementGatewayFromRoot(input: {
  stored: Stored<GatewayRoot>;
  runtimes: ReadonlyMap<string, Stored<FleetRegistryRecord>>;
  assignments: readonly PlacementPolicyAssignment[];
  kubernetesByGatewayId: Readonly<Record<string, PlacementPolicyPodDiagnostics>>;
  now: number;
}): PlacementPolicyGateway | null {
  const { stored, runtimes, assignments, kubernetesByGatewayId, now } = input;
  const gatewayId = stored.gatewayId;
  const root = projectGatewayDesiredRootForGateway(stored, gatewayId);
  if (!root) return null;
  const runtime = runtimes.get(gatewayId) ?? null;
  const heartbeatAt = millis(runtime?.heartbeat.lastHeartbeatAt);
  const heartbeatFresh = heartbeatAt === null
    ? false
    : now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS;
  const runtimeReady = [
    runtime !== null,
    root.liveRelease !== null,
    root.desiredRelease === root.liveRelease,
    runtime?.release === root.liveRelease,
    runtime?.lifecycle === "serving",
    runtime?.heartbeat.status === "ready",
    heartbeatFresh,
  ].every(Boolean);
  const assigned = assignments.filter((assignment) => assignment.gatewayId === gatewayId);
  const mounted = new Set(runtime?.heartbeat.mountedCustomers ?? []);
  return {
    gatewayId,
    gatewayClass: root.gatewayClass,
    ownerUid: root.ownerUid,
    builderSlug: root.builderSlug,
    sizingTier: root.sizingTier,
    desiredStatus: root.desiredStatus,
    disposable: root.allocation?.kind === DISPOSABLE_BUILDER_ALLOCATION_KIND,
    configuredBuilder: runtimeConfiguredBuilder(runtime),
    allocation: root.allocation ?? null,
    ready: runtimeReady,
    ...gatewayRuntimeObservation(runtime),
    kubernetesStatus: placementKubernetesStatus(kubernetesByGatewayId[gatewayId]),
    serving: runtime?.lifecycle === "serving",
    heartbeatFresh,
    runtimeStartedAt: gatewayRuntimeStartedAt({
      gatewayId,
      gatewayClass: root.gatewayClass,
      runtime,
      diagnostics: kubernetesByGatewayId[gatewayId],
    }),
    liveReleaseReady: [
      runtime !== null,
      root.liveRelease !== null,
      root.desiredRelease === root.liveRelease,
      runtime?.release === root.liveRelease,
    ].every(Boolean),
    rosterComplete: assigned.every((assignment) => mounted.has(assignment.slug)),
    assignmentCount: assigned.length,
    latestRelease: root.latestRelease,
    desiredRelease: root.desiredRelease,
    liveRelease: root.liveRelease,
    rollActive: root.desiredRelease !== root.liveRelease,
    recoveryGraceUntil: root.updatedAt + SHARED_GATEWAY_RECOVERY_GRACE_MS,
    mountedCustomers: [...mounted],
  };
}

function placementBuildersPerGateway(orchestrator: OrchestratorConfig | null): number {
  const config = orchestrator === null
    ? parseSharedGatewayAutoscalingConfig(undefined)
    : orchestrator.sharedGatewayAutoscaling;
  if (config === null) throw new InvalidSharedGatewayAutoscalingConfigError();
  return config.buildersPerGateway;
}

async function readPlatformCurrentSharedGatewayIds(
  input: FirestorePlacementPolicyInput,
  sharedGateways: readonly PlacementPolicyGateway[],
): Promise<string[]> {
  const platformHash = releasePayloadHash(input.platformArtifact);
  const current = await Promise.all(sharedGateways.map(async (gateway) => {
    const release = gateway.latestRelease === undefined
      ? null
      : await input.store.gateways.releases.get(gateway.gatewayId, gateway.latestRelease);
    const payload = release?.payload;
    if (!isReleasePayload(payload)) {
      throw new Error(
        `shared pool member ${gateway.gatewayId} latest release ${gateway.latestRelease} has no readable payload`,
      );
    }
    return releasePayloadHash(payload) === platformHash;
  }));
  return sharedGateways
    .filter((_gateway, index) => current[index])
    .map((gateway) => gateway.gatewayId);
}

async function readPlacementPolicySnapshot(
  input: FirestorePlacementPolicyInput,
): Promise<PlacementPolicySnapshot> {
  const { db, store, idleMs: fallbackIdleMs, now: nowFn, informer } = input;
  const now = nowFn();
  const [orchestrator, userDocs, roots, runtimeRecords, activeOperations, assignmentRecords, sharedPoolReplacements] =
    await Promise.all([
      store.config.orchestrator.get(),
      informer.users() ?? db.collection("users").get().then((snapshot) => snapshot.docs),
      informer.gateways() ?? store.gateways.roots.list(),
      informer.fleetRegistry() ?? store.fleetRegistry.list(),
      store.journal.operations.listByStatus([...PLACEMENT_ACTIVE_OPERATION_STATUSES]),
      informer.assignments() ?? store.gateways.assignments.listAll(),
      readSharedPoolReplacements(store),
    ]);
  const pool = deriveSharedGatewayPoolConfig(roots.map((root) => ({
    gatewayId: root.gatewayId,
    gatewayClass: root.gatewayClass,
    desiredStatus: root.desiredStatus,
  })));
  const defaultGatewayId = pool?.defaultGatewayId ?? "";
  const sharedGatewayIds = pool?.sharedGatewayIds ?? [];
  const [completedReturnOperations, terminalLeaseOperations] = await Promise.all([
    readCompletedReturnOperations(store, userDocs, sharedGatewayIds),
    readTerminalLeaseOperations(store, userDocs),
  ]);
  const idleMs = orchestrator?.disposableGatewayIdleMs ?? fallbackIdleMs;
  const buildersPerGateway = placementBuildersPerGateway(orchestrator);
  const runtimes = new Map(runtimeRecords.map((runtime) => [runtime.gatewayId, runtime]));
  const diagnosticsScope = placementPodDiagnosticsScope(roots.map((root) => root.gatewayId), runtimes);
  const kubernetesByGatewayId = {
    ...diagnosticsScope.vmDiagnostics,
    ...await input.readGatewayPodDiagnosticsBatch({
      namespace: input.namespace,
      gatewayIds: diagnosticsScope.clusterGatewayIds,
      includeReplicaSets: true,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      input.log(`[placement-policy] Kubernetes diagnostics unreadable; treating fleet as unknown: ${message}`);
      return Object.fromEntries(diagnosticsScope.clusterGatewayIds.map((gatewayId) => [gatewayId, {
        status: "unknown",
        totalPods: 0,
        readyPods: 0,
      }]));
    }),
  };
  await persistKubernetesObservations(input.store, runtimeRecords.map((runtime) => ({
    gatewayId: runtime.gatewayId,
    kubernetes: runtime.kubernetes,
  })), kubernetesByGatewayId, now, {
    log: input.log,
    namespace: input.namespace,
  });
  const assignments = assignmentRecords.map(placementAssignmentFromRecord);
  const gateways = roots
    .map((stored) => placementGatewayFromRoot({
      stored,
      runtimes,
      assignments,
      kubernetesByGatewayId,
      now,
    }))
    .filter((gateway): gateway is PlacementPolicyGateway => gateway !== null);
  const platformCurrentGatewayIds = await readPlatformCurrentSharedGatewayIds(
    input,
    gateways.filter((gateway) => sharedGatewayIds.includes(gateway.gatewayId)),
  );
  return {
    defaultGatewayId,
    sharedGatewayIds,
    idleMs,
    buildersPerGateway,
    platformCurrentGatewayIds,
    sharedPoolReplacements,
    users: userDocs.map((doc) => ({ uid: doc.id, data: doc.data() as Record<string, unknown> })),
    gateways,
    assignments,
    activeMigrations: [
      ...activeOperations,
      ...completedReturnOperations,
      ...terminalLeaseOperations,
    ].flatMap((operation) => activeMigration(operation) ?? []),
  };
}

function unavailableRecoveryTargetFence(
  request: UnavailableGatewayRecoveryParams,
): (context: UnavailableGatewayRecoveryTargetValidationContext) => Promise<void> {
  return async (context) => {
    const pool = await readSharedGatewayPoolConfigInStore(context.transaction);
    if (
      pool === null ||
      pool.sharedGatewayIds.length !== request.sharedGatewayIds.length ||
      pool.sharedGatewayIds.some((gatewayId, index) => gatewayId !== request.sharedGatewayIds[index]) ||
      !pool.sharedGatewayIds.includes(context.targetGatewayId)
    ) {
      throw new Error("shared gateway pool changed before unavailable-source recovery");
    }
  };
}

async function assignInitialPlacementInStore(
  input: FirestorePlacementPolicyInput,
  request: AssignInitialPlacementInput,
): Promise<void> {
  const placement = await commitInitialPlacement(input.store, request, { nowMs: input.now(), log: input.log });
  if (placement.kind === "rejected") {
    throw new Error(`initial placement onto ${request.gatewayId} failed: ${placement.reason}`);
  }
}

function isAutomaticRolledBackPlacement(
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): boolean {
  return request.source === CONTINUOUS_PLACEMENT_POLICY_SOURCE
    && data.status === "failed"
    && data.origin === "automatic"
    && data.createdBy === PLACEMENT_POLICY_ACTOR
    && data.rolledBack === true
    && data.customerMigrationV2 === undefined
    && millis(data.completedAt) !== null;
}

function rolledBackTransientPlacementCanRearm(
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): boolean {
  if (!isAutomaticRolledBackPlacement(data, request)) return false;
  const error = typeof data.error === "string" ? data.error : null;
  const attempts = positiveInteger(data.attempts);
  const history = Array.isArray(data.attemptHistory) ? data.attemptHistory : null;
  const lastAttempt = record(history?.at(-1));
  return error !== null &&
    classifyOperationFailure(error) === "transient" &&
    attempts !== null &&
    positiveInteger(lastAttempt?.attempt) === attempts &&
    lastAttempt?.error === error;
}

function existingPlacementMigrationMatchesDemand(
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): boolean {
  const operationInput = record(data.input);
  return [
    data.kind === MIGRATE_CUSTOMER_KIND,
    operationInput?.uid === request.uid,
    operationInput?.builderSlug === request.builderSlug,
    operationInput?.fromGatewayId === request.fromGatewayId,
    operationInput?.toGatewayId === request.toGatewayId,
    operationInput?.source === request.source,
  ].every(Boolean);
}

function operatorRetriedBuilderReturnMatchesDemand(
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): boolean {
  const operationInput = record(data.input);
  return [
    request.source === BUILDER_ACTIVATION_LEASE_SOURCE,
    data.kind === MIGRATE_CUSTOMER_KIND,
    data.status === "failed" || data.status === ROLLED_BACK_STATUS,
    millis(data.retryRequestedAt) !== null,
    operationInput?.uid === request.uid,
    operationInput?.builderSlug === request.builderSlug,
    operationInput?.fromGatewayId === request.fromGatewayId,
    operationInput?.source === request.source,
  ].every(Boolean);
}

function placementMigrationIsNonTerminal(data: Record<string, unknown>): boolean {
  return ["pending", "running", "succeeded"].includes(data.status as string);
}

function startupFailedReturnMatchesDemand(data: Record<string, unknown>, request: EnqueuePlacementMigrationInput): boolean {
  const original = record(data.input);
  return request.source === BUILDER_ACTIVATION_LEASE_SOURCE && data.kind === MIGRATE_CUSTOMER_KIND &&
    data.status === "failed" && data.origin === "automatic" && data.createdBy === PLACEMENT_POLICY_ACTOR &&
    data.customerMigrationV2 === undefined && data.cutoverCommittedAt === undefined && data.cancellationRequestedAt === undefined &&
    original?.uid === request.uid && original.builderSlug === request.builderSlug &&
    original.fromGatewayId === request.fromGatewayId && original.source === request.source &&
    isGatewayStartupUnavailable(typeof data.error === "string" ? data.error : undefined);
}

function sharedRevisionPreflightReturnRetryable(data: Record<string, unknown>, operationId: string): boolean {
  const original = record(data.input);
  return [
    data.kind === MIGRATE_CUSTOMER_KIND,
    data.status === "failed",
    data.origin === "automatic",
    data.createdBy === PLACEMENT_POLICY_ACTOR,
    original?.source === BUILDER_ACTIVATION_LEASE_SOURCE,
    isBuilderReturnOperationIdFor(operationId, original?.fromGatewayId),
    nonEmptyString(original?.toGatewayId) !== null,
    data.gatewayId === original?.toGatewayId,
    data.inputUid === original?.uid,
    data.error === `placement rejected for ${original?.toGatewayId}: revision-not-ready`,
    Array.isArray(data.steps) && data.steps.length === 0,
    data.rolledBack === false,
    data.customerMigrationV2 === undefined,
    data.cutoverCommittedAt === undefined,
    data.cancellationRequestedAt === undefined,
    data.sourceTransferExecution === undefined,
    data.schedulerHandoffLost === undefined,
    data.schedulerHandoffReleased !== false,
    data.schedulerHandoff === undefined || data.schedulerHandoffReleased === true,
    original?.recoverSourceOnly === undefined,
  ].every(Boolean);
}

function sharedRevisionReturnMatchesDemand(data: Record<string, unknown>, request: EnqueuePlacementMigrationInput): boolean {
  const original = record(data.input);
  return sharedRevisionPreflightReturnRetryable(data, request.operationId) &&
    request.source === BUILDER_ACTIVATION_LEASE_SOURCE && original?.uid === request.uid &&
    original.builderSlug === request.builderSlug && original.fromGatewayId === request.fromGatewayId;
}

function preRpcAuthorityFailure(data: Record<string, unknown>, request: EnqueuePlacementMigrationInput): boolean {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const step = record(steps[0]);
  return request.source === CONTINUOUS_PLACEMENT_POLICY_SOURCE && data.status === "failed" &&
    data.origin === "automatic" && data.createdBy === PLACEMENT_POLICY_ACTOR &&
    data.customerMigrationV2 === undefined && data.cutoverCommittedAt === undefined && data.cancellationRequestedAt === undefined &&
    data.error === "workspace migration phase authority changed" && steps.length === 1 &&
    step?.name === "keys-sync-state" && step.status === "failed" && step.error === data.error;
}

function sourceOnlyRollbackCompleted(data: Record<string, unknown>, request: EnqueuePlacementMigrationInput): boolean {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const step = record(steps[0]);
  return isAutomaticRolledBackPlacement(data, request) && record(data.input)?.recoverSourceOnly === true &&
    sourceRecoveryForwardRetryable({ ...data, id: request.operationId } as unknown as Parameters<typeof sourceRecoveryForwardRetryable>[0]) &&
    data.cutoverCommittedAt === undefined && data.cancellationRequestedAt === undefined && steps.length === 1 &&
    step?.name === "recover-source" && step.status === "done";
}

function builderGatewayId(builder: Stored<BuilderRecord> | null): string | null {
  return nonEmptyString(builder?.gateway?.gatewayId);
}

function builderMutationFenced(builder: Stored<BuilderRecord> | null): boolean {
  return builder !== null && builderRuntimeMutationFenced(builder);
}

async function assertPreRpcRetryAuthority(
  transaction: PlatformStateTransaction,
  builder: Stored<BuilderRecord> | null,
  request: EnqueuePlacementMigrationInput,
): Promise<GatewayAssignment> {
  const [source, target] = await Promise.all([
    transaction.gateways.assignments.get(request.fromGatewayId, request.uid),
    transaction.gateways.assignments.get(request.toGatewayId, request.uid),
  ]);
  const exact = !builderMutationFenced(builder) &&
    builderGatewayId(builder) === request.fromGatewayId &&
    builder?.fences.migration === undefined && target === null &&
    retrySourceAssignmentMatches(source, request) &&
    continuousPlacementMigrationOperationId({ ...request, sourceAssignmentEpoch: source.epoch }) === request.operationId;
  if (!exact) throw new Error("workspace migration retry authority remains blocked");
  return source!;
}

function retrySourceAssignmentMatches(assignment: GatewayAssignment | null, request: EnqueuePlacementMigrationInput): assignment is GatewayAssignment {
  return assignment?.uid === request.uid && assignment.gatewayId === request.fromGatewayId &&
    assignment.state === "serving" && Number.isSafeInteger(assignment.epoch) && assignment.epoch >= 0;
}

function startupReturnLeaseMatches(builder: Stored<BuilderRecord> | null, lease: BuilderActivationLease | null, request: EnqueuePlacementMigrationInput): lease is BuilderActivationLease {
  return !builderMutationFenced(builder) && builderGatewayId(builder) === request.fromGatewayId &&
    lease?.status === "returning" && lease.targetGatewayId === request.fromGatewayId && lease.raw.returnOperationId === request.operationId;
}

function startupReturnSourceMatches(root: ReturnType<typeof projectGatewayDesiredRootForGateway>, lease: BuilderActivationLease, request: EnqueuePlacementMigrationInput): boolean {
  const allocation = root?.allocation;
  return root?.gatewayClass === "builder" && root.ownerUid === request.uid && root.desiredStatus !== "retired" &&
    allocation?.kind === DISPOSABLE_BUILDER_ALLOCATION_KIND && allocation.claimedByUid === request.uid &&
    allocation.leaseId === lease.leaseId && allocation.generation === lease.generation;
}

function sharedReturnTargetReady(root: ReturnType<typeof projectGatewayDesiredRootForGateway>, runtime: Stored<FleetRegistryRecord> | null, request: EnqueuePlacementMigrationInput, now: number): boolean {
  if (!root || runtime === null) return false;
  const heartbeatAt = millis(runtime.heartbeat.lastHeartbeatAt);
  return root.gatewayClass === "shared" && root.desiredStatus === "running" && root.liveRelease !== null &&
    root.liveRelease === root.desiredRelease && runtime.gatewayId === request.toGatewayId && runtime.release === root.liveRelease &&
    runtime.lifecycle === "serving" && runtime.heartbeat.status === "ready" &&
    heartbeatAt !== null && heartbeatAt <= now && now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}

async function assertStartupReturnAuthority(
  input: PlacementMigrationEnqueueInput,
  transaction: PlatformStateTransaction,
  builder: Stored<BuilderRecord> | null,
  request: EnqueuePlacementMigrationInput,
) {
  const [assignment, roots, runtime, pool, targetAssignment] = await Promise.all([
    transaction.gateways.assignments.get(request.fromGatewayId, request.uid),
    transaction.gateways.roots.getMany([request.fromGatewayId, request.toGatewayId]),
    transaction.fleetRegistry.get(request.toGatewayId),
    readSharedGatewayPoolConfigInStore(transaction),
    transaction.gateways.assignments.get(request.toGatewayId, request.uid),
  ]);
  const source = roots.get(request.fromGatewayId) ?? null;
  const target = roots.get(request.toGatewayId) ?? null;
  const lease = activationLeaseOf(builder?.activationLease);
  const sourceRoot = projectGatewayDesiredRootForGateway(source, request.fromGatewayId);
  const targetRoot = projectGatewayDesiredRootForGateway(target, request.toGatewayId);
  const exact = targetAssignment === null && startupReturnLeaseMatches(builder, lease, request) &&
    startupReturnSourceMatches(sourceRoot, lease, request) && retrySourceAssignmentMatches(assignment, request) &&
    pool?.sharedGatewayIds.includes(request.toGatewayId) && sharedReturnTargetReady(targetRoot, runtime, request, input.now());
  if (!exact) throw new Error("Builder startup return retry authority changed");
  return { assignment, source, target };
}

async function assertSharedRevisionReturnAuthority(
  input: PlacementMigrationEnqueueInput,
  transaction: PlatformStateTransaction,
  builder: Stored<BuilderRecord> | null,
  request: EnqueuePlacementMigrationInput & { previousTargetGatewayId: string },
): Promise<void> {
  const authority = await assertStartupReturnAuthority(input, transaction, builder, request);
  const previousTargetAssignment = await transaction.gateways.assignments.get(request.previousTargetGatewayId, request.uid);
  const rootsUnfenced = [authority.source, authority.target].every(root =>
    root?.runtimeRestartFence === undefined && root?.retirementClaim === undefined);
  const exact = rootsUnfenced && authority.source?.desiredStatus === "running" &&
    authority.assignment?.slug === request.builderSlug && builder?.fences.migration === undefined &&
    previousTargetAssignment === null;
  if (!exact) throw new Error("Builder revision return retry authority changed");
}

function proofRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(row => record(row) !== null) ? value : [];
}
function capturedPostgresRosterMatches(source: Record<string, unknown>): boolean {
  const assignments = proofRows(source.assignments), stores = proofRows(source.postgresAgentStores);
  return [stores.length > 0, assignments.length > 0,
    stores.every(store => {
      const owner = assignments.find(row => row.uid === store.uid);
      return owner && store.slug === owner.slug && store.assignmentEpoch === owner.assignmentEpoch &&
        typeof store.agentId === "string" && typeof owner.slug === "string" && agentIdBelongsToSlug(store.agentId, owner.slug) &&
        typeof store.storeId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(store.storeId) &&
        typeof store.schema === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(store.schema);
    }),
    assignments.every(owner => stores.some(store => store.uid === owner.uid && store.agentId === owner.agentId)),
    new Set(stores.map(store => store.agentId)).size === stores.length, new Set(stores.map(store => store.storeId)).size === stores.length,
    new Set(stores.map(store => store.schema)).size === stores.length].every(Boolean);
}

function completedPostgresDoctorMatches(input: { source: Record<string, unknown>; completed: Record<string, unknown>; repairId: unknown }): boolean {
  const { source, completed, repairId } = input, doctor = record(completed.doctor) ?? {};
  const expectedIds = proofRows(source.postgresAgentStores).map(store => store.agentId).sort();
  return [Array.isArray(doctor.verifiedAgentIds) && isDeepStrictEqual([...doctor.verifiedAgentIds].sort(), expectedIds),
    doctor.requestId === repairId, Number.isSafeInteger(doctor.startedAt) && Number(doctor.startedAt) > 0,
    Number.isSafeInteger(doctor.completedAt) && Number(doctor.completedAt) >= Number(doctor.startedAt) && Number(doctor.completedAt) <= Number(completed.completedAt),
    typeof doctor.releaseKey === "string" && doctor.releaseKey.length > 0].every(Boolean);
}

function completedPostgresImageMatches(source: Record<string, unknown>, completed: Record<string, unknown>): boolean {
  const doctor = record(completed.doctor) ?? {}, installed = record(completed.installedImage) ?? {}, images = record(source.images) ?? {};
  const digest = typeof images.gateway === "string" ? /@(sha256:[a-f0-9]{64})$/.exec(images.gateway)?.[1] : undefined;
  return [typeof completed.podUid === "string" && completed.podUid.length > 0 && installed.podUid === completed.podUid,
    digest !== undefined && typeof installed.gatewayImageId === "string" && installed.gatewayImageId.endsWith("@" + digest),
    Number.isSafeInteger(installed.verifiedAt) && Number(installed.verifiedAt) > 0 && Number(installed.verifiedAt) <= Number(doctor.startedAt),
    typeof record(completed.managementHealth)?.bootId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(String(record(completed.managementHealth)?.bootId))].every(Boolean);
}

export function repairedPlacementProofMatches(data: Record<string, unknown>, repair: Record<string, unknown>, request: EnqueuePlacementMigrationInput): boolean {
  const source = record(record(repair.input)?.sourceRecovery) ?? {}, completed = record(repair.sourceRuntimeRecovery) ?? {};
  const assignment = proofRows(source.assignments).find(row => row.uid === request.uid);
  return [isAutomaticRolledBackPlacement(data, request), data.cutoverCommittedAt === undefined,
    repair.kind === 'restart-gateway', ['running', 'succeeded'].includes(String(repair.status)), repair.cancellationRequestedAt === undefined,
    record(repair.input)?.gatewayId === request.fromGatewayId, completed.gatewayId === request.fromGatewayId,
    Number.isSafeInteger(repair.startedAt) && Number(repair.startedAt) >= Number(data.completedAt),
    Number.isSafeInteger(completed.completedAt) && Number(completed.completedAt) >= Number(repair.startedAt),
    assignment?.slug === request.builderSlug, capturedPostgresRosterMatches(source),
    typeof source.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(source.sourceSha), source.sourceSha === completed.sourceSha,
    isDeepStrictEqual(source.images, completed.images), completedPostgresDoctorMatches({ source, completed, repairId: repair.id }),
    completedPostgresImageMatches(source, completed), record(completed.managementHealth)?.attemptId === repair.id,
    record(completed.managementHealth)?.health === true].every(Boolean);
}
async function assertCurrentRepairTarget(
  input: PlacementMigrationEnqueueInput,
  transaction: PlatformStateTransaction,
  builder: Stored<BuilderRecord> | null,
  request: EnqueuePlacementMigrationInput,
  sourceImage: string,
): Promise<void> {
  const [target, runtime, pool] = await Promise.all([
    transaction.gateways.roots.get(request.toGatewayId),
    transaction.fleetRegistry.get(request.toGatewayId),
    readSharedGatewayPoolConfigInStore(transaction),
  ]);
  const root = projectGatewayDesiredRootForGateway(target, request.toGatewayId);
  const release = root?.liveRelease != null
    ? await transaction.gateways.releases.get(request.toGatewayId, root.liveRelease)
    : null;
  const payload = release?.payload;
  const exact = [sharedReturnTargetReady(root, runtime, request, input.now()), pool?.sharedGatewayIds.includes(request.toGatewayId),
    target?.runtimeRestartFence === undefined, target?.retirementClaim == null,
    isReleasePayload(payload) && releasePayloadHash(payload) === releasePayloadHash(input.platformArtifact) &&
      sourceImage.startsWith(payload.imageRepository + ':') && sourceImage.endsWith('@' + payload.imageTag.split('@')[1]),
    builder?.slug === request.builderSlug, builder?.openclaw.status === 'complete'].every(Boolean);
  if (!exact) throw new Error('repaired source placement current target authority changed');
}
interface RepairedPostgresSourceObservation {
  source: Record<string, unknown>; runtime: Record<string, unknown>; release: Record<string, unknown>;
  repair: Record<string, unknown>; request: EnqueuePlacementMigrationInput; now: number;
}

function postgresRepairSourceRootMatches(source: Record<string, unknown>, adopted: Record<string, unknown>, request: EnqueuePlacementMigrationInput): boolean {
  return [Number.isSafeInteger(adopted.release), Number(adopted.release) > 0,
    typeof adopted.operationId === "string" && adopted.operationId.length > 0 && !adopted.operationId.includes("/"),
    source.gatewayId === request.fromGatewayId, source.gatewayClass === "shared", source.ownerUid === null, source.builderSlug === null,
    ["running", "draining"].includes(String(source.desiredStatus)), source.runtimeRestartFence === undefined, source.retirementClaim == null,
    source.latestRelease === adopted.release, source.desiredRelease === adopted.release, source.liveRelease === adopted.release].every(Boolean);
}

function postgresRepairSourceRuntimeMatches(input: {
  runtime: Record<string, unknown>; adopted: Record<string, unknown>; request: EnqueuePlacementMigrationInput; now: number;
}): boolean {
  const { runtime, adopted, request, now } = input, heartbeat = record(runtime.heartbeat) ?? {};
  const heartbeatAt = millis(heartbeat.lastHeartbeatAt);
  return [runtime.gatewayId === request.fromGatewayId, runtime.release === adopted.release, runtime.lifecycle === "serving", heartbeat.status === "ready",
    heartbeatAt !== null && heartbeatAt <= now && now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS].every(Boolean);
}

function postgresRepairSourcePayloadMatches(input: {
  release: Record<string, unknown>; captured: Record<string, unknown>; runtime: Record<string, unknown>;
  adopted: Record<string, unknown>; request: EnqueuePlacementMigrationInput;
}): boolean {
  const { release, captured, runtime, adopted, request } = input, helm = record(runtime.helm) ?? {};
  const payload = release.payload, expected = captured.payload;
  return [release.gatewayId === request.fromGatewayId && release.release === adopted.release,
    isReleasePayload(payload) && isReleasePayload(expected) && release.payloadHash === releasePayloadHash(payload) &&
      releasePayloadHash(payload) === releasePayloadHash(expected) && helm.imageRepository === payload.imageRepository && helm.imageTag === payload.imageTag,
    isReleasePayload(payload) && record(captured.images)?.gateway === `${payload.imageRepository}:${payload.imageTag}`].every(Boolean);
}

export function repairedPostgresSourceConverged(input: RepairedPostgresSourceObservation): boolean {
  const { source, runtime, release, repair, request, now } = input;
  const completed = record(repair.sourceRuntimeRecovery) ?? {}, captured = record(record(repair.input)?.sourceRecovery) ?? {};
  const adopted = record(completed.release) ?? {};
  return [postgresRepairSourceRootMatches(source, adopted, request), postgresRepairSourceRuntimeMatches({ runtime, adopted, request, now }),
    postgresRepairSourcePayloadMatches({ release, captured, runtime, adopted, request })].every(Boolean);
}

async function assertCurrentPostgresRepairSource(
  input: PlacementMigrationEnqueueInput,
  transaction: PlatformStateTransaction,
  repair: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): Promise<void> {
  const completed = record(repair.sourceRuntimeRecovery) ?? {}, adopted = record(completed.release) ?? {};
  const adoptedRelease = positiveInteger(adopted.release);
  const [source, runtime, release] = await Promise.all([
    transaction.gateways.roots.get(request.fromGatewayId),
    transaction.fleetRegistry.get(request.fromGatewayId),
    adoptedRelease === null ? null : transaction.gateways.releases.get(request.fromGatewayId, adoptedRelease),
  ]);
  if (!projectGatewayDesiredRootForGateway(source, request.fromGatewayId) || runtime === null ||
      !repairedPostgresSourceConverged({
        source: source as unknown as Record<string, unknown>,
        runtime: runtime as unknown as Record<string, unknown>,
        release: (release ?? {}) as unknown as Record<string, unknown>,
        repair, request, now: input.now(),
      })) {
    throw new SharedDrainSupersededError(request.fromGatewayId, "the repaired source release has not converged; retry placement after it is ready");
  }
}

async function findRepairedSourcePlacement(
  input: PlacementMigrationEnqueueInput,
  transaction: PlatformStateTransaction,
  builder: Stored<BuilderRecord> | null,
  request: EnqueuePlacementMigrationInput,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (!isAutomaticRolledBackPlacement(data, request)) return false;
  const candidates = await transaction.journal.operations.listByInputGateway(request.fromGatewayId);
  const repair = candidates.map((operation) => operation as unknown as Record<string, unknown>)
    .filter(row => repairedPlacementProofMatches(data, row, request))
    .sort((left, right) => Number(record(right.sourceRuntimeRecovery)?.completedAt) - Number(record(left.sourceRuntimeRecovery)?.completedAt))[0];
  if (!repair) return false;
  const assignment = await assertPreRpcRetryAuthority(transaction, builder, request);
  const captured = record(record(repair.input)?.sourceRecovery) ?? {};
  const owner = proofRows(captured.assignments).find(row => row.uid === request.uid);
  if (assignment.epoch !== owner?.assignmentEpoch || assignment.slug !== request.builderSlug) throw new Error('source repair assignment changed');
  const sourceImage = record(record(repair.sourceRuntimeRecovery)?.images)?.gateway;
  if (typeof sourceImage !== 'string') throw new Error('source repair image receipt is unavailable');
  await assertCurrentPostgresRepairSource(input, transaction, repair, request);
  await assertCurrentRepairTarget(input, transaction, builder, request, sourceImage);
  return true;
}

const CLEAR = { clear: true } as const;

function rearmedPlacementMigrationPatch(): OperationPatch {
  return {
    status: "pending",
    startedAt: null,
    completedAt: null,
    steps: [],
    error: CLEAR,
    expireAt: CLEAR,
    rolledBack: CLEAR,
    output: CLEAR,
    lastProgressAt: CLEAR,
    waitingOn: CLEAR,
    nextAttemptAt: CLEAR,
  };
}

async function assertSharedDrainAuthority(
  transaction: PlatformStateTransaction,
  request: EnqueuePlacementMigrationInput & { sharedDrain: { pairedTargetGatewayId: string | null } },
): Promise<void> {
  const [roots, replacements] = await Promise.all([
    transaction.gateways.roots.getMany([request.fromGatewayId, request.toGatewayId]),
    readSharedPoolReplacements(transaction),
  ]);
  const source = roots.get(request.fromGatewayId);
  const target = roots.get(request.toGatewayId);
  if (source?.runtimeRestartFence !== undefined) {
    throw new SharedDrainSupersededError(request.fromGatewayId, "the source runtime restart is unresolved");
  }
  if (source?.desiredStatus !== "draining") {
    throw new SharedDrainSupersededError(request.fromGatewayId, "the source is no longer draining");
  }
  if (target?.desiredStatus !== "running") {
    throw new SharedDrainSupersededError(request.fromGatewayId, `target ${request.toGatewayId} is no longer running`);
  }
  const pairedTargetGatewayId = pairedReplacementTarget(replacements, request.fromGatewayId);
  if (pairedTargetGatewayId !== request.sharedDrain.pairedTargetGatewayId) {
    throw new SharedDrainSupersededError(request.fromGatewayId, "its replacement pairing changed");
  }
  if (pairedTargetGatewayId !== null && pairedTargetGatewayId !== request.toGatewayId) {
    throw new SharedDrainSupersededError(request.fromGatewayId, `it is paired with ${pairedTargetGatewayId}`);
  }
}

function sharedDrainMoveNeverClaimed(data: Record<string, unknown>): boolean {
  const history = data.attemptHistory;
  return [
    data.status === "pending",
    data.startedAt === null,
    data.firstStartedAt === undefined,
    data.attempts === undefined,
    data.resumeCount === undefined,
    history === undefined || (Array.isArray(history) && history.length === 0),
    Array.isArray(data.steps) && data.steps.length === 0,
    data.cutoverCommittedAt === undefined,
    data.customerMigrationV2 === undefined,
    data.cancellationRequestedAt === undefined,
    data.sourceTransferExecution === undefined,
    data.schedulerHandoff === undefined,
  ].every(Boolean);
}

function neverClaimedSharedDrainMove(
  data: Record<string, unknown> | undefined,
  request: SupersedePendingSharedDrainMoveInput,
): boolean {
  if (data === undefined) return false;
  const operationInput = record(data.input);
  return [
    data.kind === MIGRATE_CUSTOMER_KIND,
    data.origin === "automatic",
    data.createdBy === PLACEMENT_POLICY_ACTOR,
    sharedDrainMoveNeverClaimed(data),
    operationInput?.uid === request.uid,
    operationInput?.builderSlug === request.builderSlug,
    operationInput?.fromGatewayId === request.fromGatewayId,
    operationInput?.toGatewayId === request.toGatewayId,
    operationInput?.source === CONTINUOUS_PLACEMENT_POLICY_SOURCE,
  ].every(Boolean);
}

function supersedingActivationLeaseHolds(
  builder: Stored<BuilderRecord> | null,
  request: SupersedePendingSharedDrainMoveInput,
): boolean {
  const lease = activationLeaseOf(builder?.activationLease);
  return builderGatewayId(builder) === request.fromGatewayId &&
    lease?.leaseId === request.leaseId &&
    lease.generation === request.generation &&
    lease.status === "provisioning" &&
    lease.targetGatewayId === request.targetGatewayId;
}

export async function supersedePendingSharedDrainMove(
  input: Pick<FirestorePlacementPolicyInput, "store" | "now">,
  request: SupersedePendingSharedDrainMoveInput,
): Promise<boolean> {
  try {
    return await input.store.transaction({ label: "placement-policy.supersede-shared-drain-move" }, async (transaction) => {
      const [operation, builder, source] = await Promise.all([
        transaction.journal.operations.get(request.operationId),
        transaction.builders.records.get(request.uid),
        transaction.gateways.roots.get(request.fromGatewayId),
      ]);
      if (
        !neverClaimedSharedDrainMove(operation === null ? undefined : operation as unknown as Record<string, unknown>, request) ||
        !supersedingActivationLeaseHolds(builder, request) ||
        source?.desiredStatus !== "draining"
      ) {
        return false;
      }
      const now = input.now();
      await transaction.journal.operations.patch(request.operationId, {
        status: "failed",
        completedAt: now,
        expireAt: now + OPERATION_JOURNAL_RETENTION_MS,
        rolledBack: false,
        error: `superseded before claim by Builder activation lease ${request.leaseId} ` +
          `generation ${request.generation} (operation ${request.activationOperationId})`,
        supersededBy: {
          kind: "builder-activation",
          leaseId: request.leaseId,
          generation: request.generation,
          targetGatewayId: request.targetGatewayId,
          operationId: request.activationOperationId,
          at: now,
        },
        waitingOn: CLEAR,
        nextAttemptAt: CLEAR,
        queuedAt: CLEAR,
      }, { status: ["pending"], startedAt: null });
      return true;
    });
  } catch (error) {
    if (error instanceof FenceMismatchError) return false;
    throw error;
  }
}

function supersededSharedDrainMoveCanRearm(
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): boolean {
  return request.sharedDrain !== undefined &&
    data.status === "failed" &&
    record(data.supersededBy)?.kind === "builder-activation" &&
    data.startedAt === null &&
    data.attempts === undefined &&
    data.cutoverCommittedAt === undefined &&
    data.customerMigrationV2 === undefined;
}

function assertBuilderPlacementNotHeld(builder: Stored<BuilderRecord> | null, uid: string): void {
  if (builder?.openclaw.managedBy === "operator") throw new HeldBuilderPlacementError(uid);
}

function operationInputWithout(
  operation: Stored<OperationRecord>,
  removed: readonly string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...operation.input, ...overrides };
  for (const field of removed) delete next[field];
  return next;
}

function nativeReturnRecoveryCompleted(operation: Stored<OperationRecord>): boolean {
  const recovery = record(operation.input.nativeReturnSourceRecovery);
  return typeof recovery?.completedAt === "number" && recovery.completedAt > 0;
}

type PlacementMigrationEnqueueInput = Pick<FirestorePlacementPolicyInput, "store" | "now" | "platformArtifact">;

async function placementMigrationRearm(
  input: PlacementMigrationEnqueueInput,
  transaction: PlatformStateTransaction,
  builder: Stored<BuilderRecord> | null,
  request: EnqueuePlacementMigrationInput,
  existing: Stored<OperationRecord>,
): Promise<OperationPatch | null> {
  const data = existing as unknown as Record<string, unknown>;
  const retarget = { input: operationInputWithout(existing, [], { toGatewayId: request.toGatewayId }), gatewayId: request.toGatewayId };
  if (sharedRevisionReturnMatchesDemand(data, request)) {
    await assertSharedRevisionReturnAuthority(input, transaction, builder, {
      ...request, previousTargetGatewayId: existing.input.toGatewayId as string,
    });
    return { ...rearmedPlacementMigrationPatch(), ...retarget };
  }
  if (startupFailedReturnMatchesDemand(data, request)) {
    await assertStartupReturnAuthority(input, transaction, builder, request);
    return { ...rearmedPlacementMigrationPatch(), ...retarget };
  }
  if (operatorRetriedBuilderReturnMatchesDemand(data, request)) {
    const removed = nativeReturnRecoveryCompleted(existing) ? ["recoverSourceOnly", "nativeReturnSourceRecovery"] : [];
    return {
      ...rearmedPlacementMigrationPatch(),
      input: operationInputWithout(existing, removed, { toGatewayId: request.toGatewayId }),
      gatewayId: request.toGatewayId,
      retryRequestedAt: CLEAR,
      retryRequestedBy: CLEAR,
    };
  }
  if (!existingPlacementMigrationMatchesDemand(data, request)) {
    throw new Error(`migration operation ${request.operationId} does not match activation demand`);
  }
  if (placementMigrationIsNonTerminal(data)) return null;
  if (supersededSharedDrainMoveCanRearm(data, request)) {
    return { ...rearmedPlacementMigrationPatch(), supersededBy: CLEAR };
  }
  if (await findRepairedSourcePlacement(input, transaction, builder, request, data)) {
    return rearmedPlacementMigrationPatch();
  }
  if (preRpcAuthorityFailure(data, request) || sourceOnlyRollbackCompleted(data, request)) {
    await assertPreRpcRetryAuthority(transaction, builder, request);
    return {
      ...rearmedPlacementMigrationPatch(),
      schedulerHandoff: CLEAR,
      schedulerHandoffReleased: CLEAR,
      schedulerHandoffReleasedAt: CLEAR,
      input: operationInputWithout(existing, ["recoverSourceOnly"]),
    };
  }
  if (!rolledBackTransientPlacementCanRearm(data, request)) {
    throw new TerminalPlacementMigrationConflictError(request.operationId, String(data.status));
  }
  return rearmedPlacementMigrationPatch();
}

export async function enqueuePlacementMigration(
  input: PlacementMigrationEnqueueInput,
  request: EnqueuePlacementMigrationInput,
): Promise<string> {
  const now = input.now();
  const operation: OperationRecord = {
    id: request.operationId,
    kind: MIGRATE_CUSTOMER_KIND,
    status: "pending",
    origin: "automatic",
    createdBy: PLACEMENT_POLICY_ACTOR,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    input: {
      uid: request.uid,
      builderSlug: request.builderSlug,
      fromGatewayId: request.fromGatewayId,
      toGatewayId: request.toGatewayId,
      source: request.source,
    },
    steps: [],
    gatewayId: request.toGatewayId,
    inputUid: request.uid,
  };
  await input.store.transaction({ label: "placement-policy.enqueue-migration" }, async (transaction) => {
    const builder = await transaction.builders.records.get(request.uid);
    assertBuilderPlacementNotHeld(builder, request.uid);
    const sharedDrain = request.sharedDrain;
    if (sharedDrain) await assertSharedDrainAuthority(transaction, { ...request, sharedDrain });
    const existing = await transaction.journal.operations.get(request.operationId);
    if (existing === null) {
      await transaction.journal.operations.create(operation);
      return;
    }
    const rearm = await placementMigrationRearm(input, transaction, builder, request, existing);
    if (rearm === null) return;
    await transaction.journal.operations.patch(request.operationId, rearm, {
      status: [existing.status],
      startedAt: existing.startedAt,
    });
  });
  return request.operationId;
}

function recoveryTargetMatchesRequest(
  root: ReturnType<typeof projectGatewayDesiredRootForGateway>,
  request: RecoverUnreachableDisposableGatewayInput,
): root is NonNullable<ReturnType<typeof projectGatewayDesiredRootForGateway>> {
  const allocation = root?.allocation;
  return root !== null &&
    root.ownerUid === request.uid &&
    root.gatewayClass !== "shared" &&
    root.desiredStatus !== "retired" &&
    allocation?.kind === DISPOSABLE_BUILDER_ALLOCATION_KIND &&
    allocation.claimedByUid === request.uid &&
    allocation.leaseId === request.leaseId &&
    allocation.generation === request.generation;
}

function recoveryTargetBecameReady(input: {
  root: NonNullable<ReturnType<typeof projectGatewayDesiredRootForGateway>>;
  runtime: Stored<FleetRegistryRecord> | null;
  request: RecoverUnreachableDisposableGatewayInput;
  now: () => number;
}): boolean {
  const { root, runtime, request, now } = input;
  const heartbeatAt = runtime === null ? null : millis(runtime.heartbeat.lastHeartbeatAt);
  return root.desiredStatus === "running" &&
    runtime !== null &&
    runtime.gatewayId === request.gatewayId &&
    root.liveRelease !== null &&
    runtime.release === root.liveRelease &&
    runtime.lifecycle === "serving" &&
    runtime.heartbeat.status === "ready" &&
    heartbeatAt !== null &&
    now() - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}

function recoveryAuthorityMatches(input: {
  builder: Stored<BuilderRecord> | null;
  assignment: Stored<GatewayAssignment> | null;
  request: RecoverUnreachableDisposableGatewayInput;
}): boolean {
  const { builder, assignment, request } = input;
  const lease = activationLeaseOf(builder?.activationLease);
  return (!request.sourceUnavailable || (
    lease?.leaseId === request.leaseId &&
    lease.generation === request.generation &&
    lease.status === "returning" &&
    lease.raw.returnReason === "source-unavailable"
  )) &&
    builderGatewayId(builder) === request.authoritativeGatewayId &&
    assignment?.uid === request.uid &&
    assignment.gatewayId === request.authoritativeGatewayId &&
    assignment.state === "serving";
}

async function exactRecoveryState(
  input: FirestorePlacementPolicyInput,
  transaction: PlatformStateTransaction,
  request: RecoverUnreachableDisposableGatewayInput,
): Promise<Stored<GatewayRoot>> {
  const [stored, builder, assignment, runtime] = await Promise.all([
    transaction.gateways.roots.get(request.gatewayId),
    transaction.builders.records.get(request.uid),
    transaction.gateways.assignments.get(request.authoritativeGatewayId, request.uid),
    transaction.fleetRegistry.get(request.gatewayId),
  ]);
  const root = projectGatewayDesiredRootForGateway(stored, request.gatewayId);
  if (stored === null || !recoveryTargetMatchesRequest(root, request)) {
    throw new GatewayRetirementConflictError(
      `gateway ${request.gatewayId} no longer matches unreachable recovery demand`,
    );
  }
  if (!request.sourceUnavailable && recoveryTargetBecameReady({ root, runtime, request, now: input.now })) {
    throw new GatewayRetirementConflictError(
      `gateway ${request.gatewayId} became ready before recovery`,
    );
  }
  if (!recoveryAuthorityMatches({ builder, assignment, request })) {
    throw new GatewayRetirementConflictError(
      `Builder ${request.uid} is no longer authoritative on ${request.authoritativeGatewayId}`,
    );
  }
  return stored;
}

function assertPendingRecoveryReceiptMatches(
  receipt: Stored<GatewayRecoveryReceipt>,
  request: RecoverUnreachableDisposableGatewayInput,
): void {
  const receiptInput = receipt.input;
  if (
    receipt.kind !== "recover-unreachable-disposable" ||
    receiptInput.uid !== request.uid ||
    receiptInput.gatewayId !== request.gatewayId ||
    receiptInput.leaseId !== request.leaseId ||
    receiptInput.generation !== request.generation
  ) {
    throw new GatewayRetirementConflictError(
      `recovery operation ${receipt.id} does not match unreachable demand`,
    );
  }
}

function newRecoveryReceipt(
  operationId: string,
  request: RecoverUnreachableDisposableGatewayInput,
  startedAt: number,
): GatewayRecoveryReceipt {
  return {
    id: operationId,
    kind: "recover-unreachable-disposable",
    status: "pending",
    origin: "automatic",
    createdBy: PLACEMENT_POLICY_ACTOR,
    createdAt: startedAt,
    startedAt,
    firstStartedAt: startedAt,
    completedAt: null,
    input: {
      uid: request.uid,
      builderSlug: request.builderSlug,
      gatewayId: request.gatewayId,
      leaseId: request.leaseId,
      generation: request.generation,
      authoritativeGatewayId: request.authoritativeGatewayId,
    },
    steps: [],
    gatewayId: request.gatewayId,
    inputUid: request.uid,
  };
}

async function reserveUnreachableDisposableRecovery(
  input: FirestorePlacementPolicyInput,
  request: RecoverUnreachableDisposableGatewayInput,
  operationId: string,
): Promise<void> {
  await input.store.transaction({ label: "placement-policy.recovery-reserve" }, async (transaction) => {
    const root = await exactRecoveryState(input, transaction, request);
    const receipt = await transaction.journal.recoveryReceipts.get(operationId);
    if (receipt !== null) {
      assertPendingRecoveryReceiptMatches(receipt, request);
      if (receipt.status === "succeeded") return;
      if (receipt.status !== "pending") {
        throw new GatewayRetirementConflictError(
          `recovery operation ${operationId} ended with ${receipt.status}`,
        );
      }
    } else {
      await transaction.journal.recoveryReceipts.create(newRecoveryReceipt(operationId, request, input.now()));
    }
    await transaction.gateways.roots.patch(request.gatewayId, {
      desiredStatus: "paused",
      updatedAt: input.now(),
      updatedBy: `${PLACEMENT_POLICY_ACTOR}:${operationId}`,
    }, { updatedAt: root.updatedAt, allocationGeneration: root.allocation?.generation ?? null });
  });
}

async function completeUnreachableDisposableRecovery(
  input: FirestorePlacementPolicyInput,
  request: RecoverUnreachableDisposableGatewayInput,
  operationId: string,
): Promise<void> {
  await input.store.transaction({ label: "placement-policy.recovery-complete" }, async (transaction) => {
    await exactRecoveryState(input, transaction, request);
    const receipt = await transaction.journal.recoveryReceipts.get(operationId);
    if (receipt?.status !== "pending") {
      if (receipt?.status === "succeeded") return;
      throw new GatewayRetirementConflictError(
        `recovery operation ${operationId} is unavailable`,
      );
    }
    await transaction.journal.recoveryReceipts.patch(operationId, {
      status: "succeeded",
      completedAt: input.now(),
      recoveryReceipt: {
        schemaVersion: 1,
        observedAt: input.now(),
        pods: 0,
      },
    }, { revision: receipt.revision });
  });
}

async function recoverUnreachableDisposableGatewayFirestore(
  input: FirestorePlacementPolicyInput,
  request: RecoverUnreachableDisposableGatewayInput,
): Promise<{ recovered: boolean; operationId: string }> {
  const operationId = builderRecoverOperationId(request.gatewayId, request.generation);
  await reserveUnreachableDisposableRecovery(input, request, operationId);
  const diagnostics = await input.readGatewayPodDiagnostics({
    namespace: input.namespace,
    gatewayId: request.gatewayId,
  });
  if (
    diagnostics.error ||
    diagnostics.status !== "missing" ||
    diagnostics.totalPods !== 0
  ) {
    const diagnosticError = diagnostics.error ? ` error=${diagnostics.error}` : "";
    input.log(
      `[placement-policy] recovery ${operationId} waiting for pod absence; status=${diagnostics.status} pods=${diagnostics.totalPods}${diagnosticError}`,
    );
    return { recovered: false, operationId };
  }
  await completeUnreachableDisposableRecovery(input, request, operationId);
  return { recovered: true, operationId };
}

function retirementAllocationMatches(
  root: Record<string, unknown>,
  request: RetireOwnedGatewayInput,
): boolean {
  const allocation = record(root.allocation);
  const allocationIdentityMatches = request.leaseId === undefined ||
    (
      allocation?.kind === DISPOSABLE_BUILDER_ALLOCATION_KIND &&
      allocation.claimedByUid === request.uid &&
      allocation.leaseId === request.leaseId &&
      allocation.generation === request.generation
    );
  return root.ownerUid === request.uid &&
    root.gatewayClass !== "shared" &&
    allocation?.kind === DISPOSABLE_BUILDER_ALLOCATION_KIND &&
    allocation.generation === request.generation &&
    allocationIdentityMatches;
}

async function assertRetirementAuthorityFence(
  transaction: PlatformStateTransaction,
  request: RetireOwnedGatewayInput,
): Promise<void> {
  if (!request.authoritativeGatewayId) return;
  const [builder, assignment] = await Promise.all([
    transaction.builders.records.get(request.uid),
    transaction.gateways.assignments.get(request.authoritativeGatewayId, request.uid),
  ]);
  if (!retirementAuthorityFenceAllows({
    uid: request.uid,
    authoritativeGatewayId: request.authoritativeGatewayId,
    targetGatewayId: request.gatewayId,
    leaseId: request.leaseId,
    generation: request.generation,
    expectedLeaseStatus: request.authoritativeLeaseStatus ?? "returning",
    builder,
    assignment,
  })) {
    throw new GatewayRetirementConflictError(
      `Builder ${request.uid} is no longer authoritatively returned to ${request.authoritativeGatewayId}`,
    );
  }
}

function zeroWorkloadRecoveryReceiptMatches(
  recovery: Stored<GatewayRecoveryReceipt> | null,
  request: RetireOwnedGatewayInput,
): boolean {
  const recoveryInput = recovery?.input;
  const receipt = record(recovery?.recoveryReceipt);
  return recovery?.kind === "recover-unreachable-disposable" &&
    recovery.status === "succeeded" &&
    recoveryInput?.uid === request.uid &&
    recoveryInput.gatewayId === request.gatewayId &&
    recoveryInput.leaseId === request.leaseId &&
    recoveryInput.generation === request.generation &&
    receipt?.schemaVersion === 1 &&
    receipt.pods === 0;
}

async function assertZeroWorkloadRecoveryReceipt(
  transaction: PlatformStateTransaction,
  request: RetireOwnedGatewayInput,
): Promise<void> {
  if (!request.zeroWorkloadRecoveryOperationId) return;
  const recovery = await transaction.journal.recoveryReceipts.get(request.zeroWorkloadRecoveryOperationId);
  if (!zeroWorkloadRecoveryReceiptMatches(recovery, request)) {
    throw new GatewayRetirementConflictError(
      `gateway ${request.gatewayId} zero-workload recovery receipt is unavailable`,
    );
  }
}

async function readRetirementTelemetryFence(
  input: FirestorePlacementPolicyInput,
  request: RetireOwnedGatewayInput,
): Promise<{ blocked: true } | { blocked: false; observedAfter?: number }> {
  if (request.telemetryFenceOperationId === undefined) return { blocked: false };
  const returnOperationId = request.telemetryFenceOperationId;
  const returnOperation = await input.store.journal.operations.get(returnOperationId);
  const completedAt = millis(returnOperation?.completedAt);
  const terminalStatus = returnOperation?.status;
  const expectedStatusMatches = request.telemetryFenceStatus === "terminal-failure"
    ? terminalStatus === "failed" || terminalStatus === ROLLED_BACK_STATUS
    : terminalStatus === "succeeded";
  if (returnOperation === null || !expectedStatusMatches || completedAt === null) {
    input.log(
      `[placement-policy] retirement blocked for ${request.gatewayId}: return operation ${returnOperationId} is incomplete`,
    );
    return { blocked: true };
  }
  return { blocked: false, observedAfter: completedAt };
}

async function retireOwnedGatewayFirestore(
  input: FirestorePlacementPolicyInput,
  request: RetireOwnedGatewayInput,
): Promise<boolean> {
  const operationId = placementRetireOperationId(request.uid, request.gatewayId, request.generation);
  const now = input.now();
  const telemetry = await readRetirementTelemetryFence(input, request);
  if (telemetry.blocked) return false;
  try {
    await claimGatewayRetirementInStore({
      store: input.store,
      gatewayId: request.gatewayId,
      operationId,
      operation: {
        kind: "retire-gateway",
        status: "pending",
        origin: "automatic",
        createdBy: PLACEMENT_POLICY_ACTOR,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        input: {
          gatewayId: request.gatewayId,
          uid: request.uid,
          builderSlug: request.builderSlug,
          reason: request.reason,
        },
        steps: [],
        gatewayId: request.gatewayId,
      },
      now,
      updatedBy: PLACEMENT_POLICY_ACTOR,
      ...(telemetry.observedAfter === undefined ? {} : { telemetryObservedAfter: telemetry.observedAfter }),
      claimGuard: async ({ transaction, root }) => {
        const rootRecord = root as unknown as Record<string, unknown>;
        if (!retirementAllocationMatches(rootRecord, request)) {
          throw new GatewayRetirementConflictError(
            `gateway ${request.gatewayId} no longer matches disposable allocation for ${request.uid}`,
          );
        }
        await assertRetirementAuthorityFence(transaction, request);
        await assertZeroWorkloadRecoveryReceipt(transaction, request);
      },
    });
    return true;
  } catch (error) {
    if (!(error instanceof GatewayRetirementConflictError) && !(error instanceof FenceMismatchError)) throw error;
    input.log(`[placement-policy] retirement blocked for ${request.gatewayId}: ${error.message}`);
    return false;
  }
}

interface RetirementAuthorityFenceInput {
  uid: string;
  authoritativeGatewayId: string;
  targetGatewayId: string;
  leaseId: string | undefined;
  generation: number | undefined;
  expectedLeaseStatus: AuthoritativeLeaseStatus;
  builder: Pick<BuilderRecord, "gateway" | "activationLease"> | null;
  assignment: Pick<GatewayAssignment, "uid" | "gatewayId" | "state"> | null;
}

function retirementLeaseFenceAllows(input: RetirementAuthorityFenceInput): boolean {
  const lease = input.builder?.activationLease;
  return input.builder !== null &&
    input.builder.gateway?.gatewayId === input.authoritativeGatewayId &&
    lease?.leaseId === input.leaseId &&
    lease?.generation === input.generation &&
    lease?.status === input.expectedLeaseStatus &&
    lease?.targetGatewayId === input.targetGatewayId;
}

function retirementAssignmentFenceAllows(input: RetirementAuthorityFenceInput): boolean {
  return input.assignment?.uid === input.uid &&
    input.assignment.gatewayId === input.authoritativeGatewayId &&
    input.assignment.state === "serving";
}

export function retirementAuthorityFenceAllows(input: RetirementAuthorityFenceInput): boolean {
  return retirementLeaseFenceAllows(input) && retirementAssignmentFenceAllows(input);
}

type RetiredDisposableGatewayVerdict = "delete" | "rearmed" | "handoff-pending" | "skip";

function retiredDisposableGatewayVerdict(input: {
  request: DeleteRetiredDisposableGatewayInput;
  operationId: string;
  root: ReturnType<typeof projectGatewayDesiredRootForGateway>;
  claimOperationId: unknown;
  operation: Stored<OperationRecord> | null;
  ownerMirrorGatewayId: string | null;
  unreleasedHandoffOperationId: string | null;
}): RetiredDisposableGatewayVerdict {
  const { request, root, operation } = input;
  const fenced = [
    root !== null,
    root?.desiredStatus === "retired",
    root?.ownerUid === request.ownerUid,
    root?.allocation?.kind === DISPOSABLE_BUILDER_ALLOCATION_KIND,
    root?.allocation?.generation === request.generation,
    input.claimOperationId === input.operationId,
    operation !== null,
    operation?.kind === "retire-gateway",
    input.ownerMirrorGatewayId !== request.gatewayId,
  ].every(Boolean);
  if (!fenced) return "skip";
  if (operation?.status === "succeeded") {
    return input.unreleasedHandoffOperationId === null ? "delete" : "handoff-pending";
  }
  if (operation?.status === "failed" && isRetryableBuilderRetirementFailure(operation.error, request.gatewayId)) return "rearmed";
  return "skip";
}

function isRetryableBuilderRetirementFailure(error: unknown, gatewayId: string): boolean {
  return isReapedOperationError(error) || isAgentStoreRetirementSessionDrain(error, gatewayId);
}

interface RetiredDisposableGatewayReading {
  verdict: RetiredDisposableGatewayVerdict;
  retirementVersion: number | null;
  unreleasedHandoffOperationId: string | null;
}

async function readRetiredDisposableGatewayVerdict(
  store: PlatformStateStore,
  request: DeleteRetiredDisposableGatewayInput,
  operationId: string,
): Promise<RetiredDisposableGatewayReading> {
  const handoffOperationIds = [
    builderActivateOperationId(request.gatewayId, request.generation),
    builderReturnOperationId(request.gatewayId, request.generation),
  ];
  return store.transaction({ label: "placement-policy.retired-disposable-verdict" }, async (transaction) => {
    const [stored, operation, owner, handoffs] = await Promise.all([
      transaction.gateways.roots.get(request.gatewayId),
      transaction.journal.operations.get(operationId),
      transaction.builders.records.get(request.ownerUid),
      transaction.journal.operations.getMany(handoffOperationIds),
    ]);
    const unreleasedHandoffOperationId = handoffOperationIds.find((id) => {
      const handoff = handoffs.get(id);
      return handoff !== undefined && schedulerHandoffAwaitingRelease(handoff as unknown as Record<string, unknown>);
    }) ?? null;
    const verdict = retiredDisposableGatewayVerdict({
      request,
      operationId,
      root: projectGatewayDesiredRootForGateway(stored, request.gatewayId),
      claimOperationId: record(stored?.retirementClaim)?.operationId,
      operation,
      ownerMirrorGatewayId: builderGatewayId(owner),
      unreleasedHandoffOperationId,
    });
    if (verdict === "rearmed") {
      await transaction.journal.operations.patch(operationId, REARMED_RETIRE_OPERATION, { status: ["failed"] });
    }
    return { verdict, retirementVersion: stored?.retirementVersion ?? null, unreleasedHandoffOperationId };
  });
}

async function deleteRetiredDisposableGatewayFirestore(
  input: FirestorePlacementPolicyInput,
  request: DeleteRetiredDisposableGatewayInput,
): Promise<boolean> {
  const { store } = input;
  const operationId = placementRetireOperationId(request.ownerUid, request.gatewayId, request.generation);
  const recoverOperationId = builderRecoverOperationId(request.gatewayId, request.generation);
  const reading = await readRetiredDisposableGatewayVerdict(store, request, operationId);
  if (reading.verdict === "rearmed") {
    input.log(
      `[placement-policy] re-armed retirement ${operationId} for ${request.gatewayId}: it failed retryably (reaped after a controller restart or draining PostgreSQL sessions); the op runner re-drives it`,
    );
    return false;
  }
  if (reading.verdict === "handoff-pending") {
    input.log(
      `[placement-policy] kept retired disposable runtime ${request.gatewayId}: ${reading.unreleasedHandoffOperationId} has an unreleased scheduler handoff; the handoff release sweep must settle it first`,
    );
    return false;
  }
  if (reading.verdict !== "delete") return false;
  const preparationCleared = await clearRetiredBuilderActivationPreparation({ store }, { uid: request.ownerUid, targetGatewayId: request.gatewayId, generation: request.generation, retirementOperationId: operationId });
  if (preparationCleared) input.log(`[placement-policy] cleared failed preparation for retired target ${request.gatewayId}`);
  await Promise.all([
    store.journal.operations.delete(recoverOperationId),
    store.journal.recoveryReceipts.delete(recoverOperationId),
  ]);
  try {
    await store.gateways.roots.delete(request.gatewayId, {
      retirementVersion: reading.retirementVersion,
      desiredStatus: ["retired"],
    });
  } catch (error) {
    if (!(error instanceof FenceMismatchError)) throw error;
    input.log(
      `[placement-policy] kept retired disposable runtime ${request.gatewayId}: its root changed after the deletion verdict (${error.message})`,
    );
    return false;
  }
  input.log(
    `[placement-policy] deleted retired disposable runtime ${request.gatewayId} for ${request.ownerUid}`,
  );
  return true;
}

export function createFirestorePlacementPolicyReconcilerDeps(
  input: FirestorePlacementPolicyInput,
): PlacementPolicyReconcilerDeps {
  const { store } = input;
  return {
    now: input.now,
    log: input.log,
    debug: input.debug,
    readSnapshot: () => readPlacementPolicySnapshot(input),
    decidePlacementAdmission: (uid) => input.placementAdmission.decide(uid),
    assignInitialPlacement: (request) => assignInitialPlacementInStore(input, request),
    allocateDisposableGateway: async (request) => {
      if (await refreshRequestedAllocationFirestore(input, request)) return null;
      if (input.prepareBuilderHome && !await input.prepareBuilderHome(request)) return null;
      return allocateDisposableGatewayFirestore({
        ...input,
        retireParkedGateway: (parked) =>
          retireOwnedGatewayFirestore(input, { ...parked, reason: "parked-computer-replaced" }),
      }, request);
    },
    advanceActivationLease: (request) => advanceActivationLeaseFirestore(input, request),
    requestTierTransition: (request) => requestTierTransitionFirestore(input, request),
    completeActivationLease: (request) => completeActivationLeaseFirestore(input, request),
    failActivationLease: (request) => failActivationLeaseFirestore(input, request),
    recoverUnavailableGateway: (request) => commitUnavailableGatewayRecoveryAtomic({
      store,
      now: () => new Date(input.now()),
    }, {
      ...request,
      validateTarget: unavailableRecoveryTargetFence(request),
    }),
    recoverDisposableRuntimeReset: (request) =>
      commitRecoveredDisposableRuntimeResetAtomic({
        store,
        now: () => new Date(input.now()),
      }, request),
    supersedeRollingSharedGateway: (request) => supersedeRollingSharedGatewayRoll({ store, now: input.now }, request),
    recoverUnreachableDisposableGateway: (request) =>
      recoverUnreachableDisposableGatewayFirestore(input, request),
    readBuilderActivity: (request) => readBuilderActivityFirestore(input, request),
    enqueueMigration: (request) => enqueuePlacementMigration(input, request),
    supersedePendingSharedDrainMove: (request) => supersedePendingSharedDrainMove(input, request),
    retireOwnedGateway: (request) => retireOwnedGatewayFirestore(input, request),
    deleteRetiredDisposableGateway: (request) =>
      deleteRetiredDisposableGatewayFirestore(input, request),
  };
}

export const PLACEMENT_POLICY_PASS_DEADLINE_MS = 5 * 60_000;
export const PLACEMENT_POLICY_MAX_ABANDONED_PASSES = 3;

interface PlacementPolicyAttempt {
  startedAt: number;
  abandoned: boolean;
}

export function startPlacementPolicyReconciler(
  deps: PlacementPolicyReconcilerDeps,
  intervalMs = PLACEMENT_POLICY_RECONCILE_MS_DEFAULT,
  options?: {
    passDeadlineMs?: number;
    maxAbandonedPasses?: number;
    subscribe?: (wake: () => void) => () => void;
    runPass?: (deps: PlacementPolicyReconcilerDeps) => Promise<unknown>;
  },
): () => void {
  if (intervalMs <= 0) return () => undefined;
  const passDeadlineMs = options?.passDeadlineMs ?? PLACEMENT_POLICY_PASS_DEADLINE_MS;
  const maxAbandonedPasses = options?.maxAbandonedPasses ?? PLACEMENT_POLICY_MAX_ABANDONED_PASSES;
  const runPass = options?.runPass ?? reconcilePlacementPolicyOnce;
  let stopped = false;
  let pending = false;
  let current: PlacementPolicyAttempt | null = null;
  let abandonedOutstanding = 0;
  let haltLogged = false;
  const tick = async () => {
    if (stopped) return;
    if (current) {
      const heldMs = deps.now() - current.startedAt;
      if (heldMs < passDeadlineMs) return;
      current.abandoned = true;
      current = null;
      abandonedOutstanding += 1;
      deps.log(
        `[placement-policy] ⚠ pass exceeded its ${passDeadlineMs}ms deadline (held ${heldMs}ms) — ` +
          `releasing the tick gate (${abandonedOutstanding} abandoned outstanding)`,
      );
    }
    if (abandonedOutstanding >= maxAbandonedPasses) {
      if (!haltLogged) {
        haltLogged = true;
        deps.log(
          `[placement-policy] ⚠ halted: ${abandonedOutstanding} abandoned passes outstanding — ` +
            `no new passes until one settles`,
        );
      }
      return;
    }
    pending = false;
    const attempt: PlacementPolicyAttempt = { startedAt: deps.now(), abandoned: false };
    current = attempt;
    try {
      await runPass(deps);
    } catch (error) {
      deps.log(`[placement-policy] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (attempt.abandoned) {
        abandonedOutstanding -= 1;
        haltLogged = false;
        deps.log(
          `[placement-policy] abandoned pass settled after ${deps.now() - attempt.startedAt}ms ` +
            `(${abandonedOutstanding} still outstanding)`,
        );
      }
      if (current === attempt) current = null;
      if (pending && !current && !stopped) void tick();
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  const unsubscribe = options?.subscribe?.(() => { pending = true; void tick(); });
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe?.();
  };
}
