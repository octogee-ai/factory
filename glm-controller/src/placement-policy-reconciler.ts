import type {
  Firestore,
  QueryDocumentSnapshot,
  Transaction,
} from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { createHash } from "node:crypto";

import {
  GatewayRetirementConflictError,
  claimGatewayRetirementAtomic,
} from "@octogee/core/gateway-retirement-claim";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { resolveBuilderTier } from "@octogee/shared/types/billing";
import {
  GATEWAY_UNREACHABLE_AFTER_MS,
  GATEWAYS_COLLECTION,
} from "@octogee/shared/types/fleet-controller";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  isOperatorManaged,
  resolveUserGatewayShellState,
  type OperationAttemptRecord,
} from "@octogee/shared/types/glm";
import {
  commitPlacementAtomic,
  isGatewayRuntimeDoc,
  projectGatewayDesiredRootForGateway,
  type PlacementFirestore,
} from "@octogee/shared/types/gateway-releases";
import { isGatewayPodReplacements } from "@octogee/shared/types/gateway-pod-replacements";
import {
  gatewayPlanToken,
  nextPodReplacementTransition,
  observedPodUids,
} from "./pod-replacement-tracking.js";
import {
  parseSharedGatewayPoolConfig,
  planSharedGatewayRebalance,
  selectSharedGateway,
  type SharedGatewayPoolCandidate,
} from "@octogee/shared/types/shared-gateway-pool";
import {
  commitUnavailableGatewayRecoveryAtomic,
  type FleetStateFirestore,
  type UnavailableGatewayRecoveryParams,
  type UnavailableGatewayRecoveryTargetValidationContext,
} from "@octogee/core/fleet-state";
import { supersedeRollingSharedGatewayRoll } from "@octogee/core/shared-gateway-roll-recovery";
import {
  resolveContinuousBuilderPlacement,
  resolveLiveActivationTargetGatewayId,
  resolveOnboardingPlacementEligibility,
  type ContinuousPlacementOwnedGateway,
} from "@octogee/shared/types/orchestrator-placement";
import type { SizingTier } from "@octogee/shared/types/sizing";
import type { BuilderTierName } from "@octogee/shared/types/billing-tiers";
import {
  advanceActivationLeaseFirestore,
  allocateDisposableGatewayFirestore,
  completeActivationLeaseFirestore,
  failActivationLeaseFirestore,
  publishIdleSleepFirestore,
  readBuilderActivityFirestore,
  readShellsAtRiskFirestore,
} from "./disposable-gateway-lifecycle.js";
import {
  automaticBuilderOperationFenceReason,
  automaticGatewayOperationFenceReason,
  MIGRATE_CUSTOMER_KIND,
} from "./automatic-operation-fence.js";
import { mirroredOrScan, type FleetInformer } from "./fleet-informer.js";
import {
  classifyOperationFailure,
  MAX_OPERATION_ATTEMPT_HISTORY,
} from "./operation-retry.js";

export const PLACEMENT_POLICY_RECONCILE_MS_DEFAULT = 15_000;
export const DISPOSABLE_GATEWAY_PROVISION_TIMEOUT_MS = 10 * 60_000;
export const SHARED_GATEWAY_REBALANCE_STABILITY_MS = 10 * 60_000;
export const DISPOSABLE_GATEWAY_RECOVERY_RECEIPTS_COLLECTION =
  "gatewayRecoveryReceipts";
const PLACEMENT_POLICY_ACTOR = "glm-controller-placement-policy";
const BUILDER_ACTIVATION_LEASE_SOURCE = "builder-activation-lease";
const DISPOSABLE_BUILDER_ALLOCATION_KIND = "disposable-builder";
const ROLLED_BACK_STATUS = "rolled-back";
const ORCHESTRATOR_CONFIG_DOC_PATH = "config/orchestrator";
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
}

export type PlacementPolicyKubernetesStatus = "ready" | "not-ready" | "missing" | "unknown";

export interface PlacementPolicyPodDiagnostics {
  status: string;
  totalPods: number;
  readyPods: number;
  pods?: ReadonlyArray<{ uid?: string | null }>;
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
  kubernetesStatus?: PlacementPolicyKubernetesStatus;
  serving?: boolean;
  heartbeatFresh?: boolean;
  runtimeStartedAt?: number | null;
  liveReleaseReady?: boolean;
  rosterComplete?: boolean;
  assignmentCount?: number;
  latestRelease?: number;
  desiredRelease?: number;
  liveRelease?: number | null;
  rollActive?: boolean;
  recoveryGraceUntil?: number;
}

export const SHARED_GATEWAY_RECOVERY_GRACE_MS = GATEWAY_UNREACHABLE_AFTER_MS;

export interface PlacementPolicyAssignment {
  uid: string;
  slug: string;
  gatewayId: string;
  state: string;
  epoch: number | null;
}

export interface PlacementPolicySnapshot {
  defaultGatewayId: string;
  sharedGatewayIds: readonly string[];
  idleMs: number;
  idleWarningMs: number;
  liveRunBuilderSlugs: string[];
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
  liveRun: boolean;
  liveShell: boolean;
}

// Client-facing warning read model at users/{uid}.provisioning.openclaw.idleSleep.
// Cowboy is the sole writer; the PWA renders the countdown from deadlineAt and
// the keepalive ack resets the clock through normal demand, never this field.
export interface IdleSleepProjection {
  deadlineAt: number;
  leaseId: string;
  generation: number;
  shellSessions: number;
  updatedAt: number;
}

export interface RuntimeSleepWarningInput {
  uid: string;
  eventId: string;
  deadlineAt: number;
  shellSessions: number;
}

type AuthoritativeLeaseStatus = "provisioning" | "activating" | "returning";

export interface RetireOwnedGatewayInput {
  uid: string;
  builderSlug: string;
  gatewayId: string;
  legacyNonDisposable?: boolean;
  leaseId?: string;
  generation?: number;
  telemetryFenceOperationId?: string;
  telemetryFenceStatus?: "succeeded" | "terminal-failure";
  authoritativeGatewayId?: string;
  authoritativeLeaseStatus?: AuthoritativeLeaseStatus;
  zeroWorkloadRecoveryOperationId?: string;
}

export interface AssignInitialPlacementInput {
  uid: string;
  builderSlug: string;
  gatewayId: string;
  gateway: ContinuousPlacementOwnedGateway;
}

export interface PlacementPolicyReconcilerDeps {
  now(): number;
  log(message: string): void;
  maintenanceGate?: { state(): Promise<{ frozen: boolean; reason: string | null }> };
  readSnapshot(): Promise<PlacementPolicySnapshot>;
  assignInitialPlacement(input: AssignInitialPlacementInput): Promise<void>;
  allocateDisposableGateway(input: AllocateDisposableGatewayInput): Promise<string>;
  advanceActivationLease(input: AdvanceActivationLeaseInput): Promise<void>;
  completeActivationLease(input: CompleteActivationLeaseInput): Promise<void>;
  failActivationLease(input: FailActivationLeaseInput): Promise<void>;
  recoverUnavailableGateway(input: RecoverUnavailableGatewayInput): Promise<{ operationId: string }>;
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
    liveRun: boolean;
  }): Promise<BuilderRuntimeActivity>;
  readShellsAtRisk(input: { builderSlug: string; gatewayId: string }): Promise<number>;
  publishIdleSleep(input: { uid: string; projection: IdleSleepProjection | null }): Promise<void>;
  sendRuntimeSleepWarning(input: RuntimeSleepWarningInput): Promise<void>;
  enqueueMigration(input: EnqueuePlacementMigrationInput): Promise<string>;
  retireOwnedGateway(input: RetireOwnedGatewayInput): Promise<boolean>;
  deleteRetiredDisposableGateway(
    input: DeleteRetiredDisposableGatewayInput,
  ): Promise<boolean>;
}

export interface DeleteRetiredDisposableGatewayInput {
  gatewayId: string;
  ownerUid: string;
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
  target: ContinuousPlacementOwnedGateway;
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
  const targetGatewayId = builderActivationLease(userData)?.targetGatewayId;
  if (!targetGatewayId) return [];
  return [`builder-activate-${targetGatewayId}`, `builder-return-${targetGatewayId}`];
}

function builderActivationLease(data: Record<string, unknown>): BuilderActivationLease | null {
  const provisioning = record(data.provisioning);
  const openclaw = record(provisioning?.openclaw);
  const raw = record(openclaw?.activationLease);
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

function transientRecoveryFence(
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
      managedBy: gateway.managedBy,
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
    !isOperatorManaged(candidate.managedBy),
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

function selectAcceptingSharedGateway(
  context: PlacementPolicyReconcileContext,
  uid: string,
  currentGatewayId?: string | null,
): string | null {
  const selection = selectSharedGateway({
    uid,
    config: {
      defaultGatewayId: context.state.defaultGatewayId,
      sharedGatewayIds: context.state.sharedGatewayIds,
    },
    candidates: sharedGatewayCandidates(context),
    ...(currentGatewayId === undefined ? {} : { currentGatewayId }),
  });
  return selection.kind === "selected" ? selection.gatewayId : null;
}

function sharedAuthorityGatewayId(
  context: PlacementPolicyReconcileContext,
  currentGatewayId: string | null,
): string | null {
  if (isSharedPoolGateway(context, currentGatewayId)) return currentGatewayId;
  return selectAcceptingSharedGateway(context, "placement-policy-authority");
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

async function retireUnentitledOwnedGateways(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
): Promise<void> {
  const ownedGateways = context.state.gateways.filter(
    (gateway) => gateway.ownerUid === user.uid &&
      gateway.gatewayClass !== "shared" &&
      !isOperatorManaged(gateway.managedBy) &&
      gateway.desiredStatus !== "retired",
  );
  for (const gateway of ownedGateways) {
    const retired = await context.deps.retireOwnedGateway({
      uid: user.uid,
      builderSlug,
      gatewayId: gateway.gatewayId,
      ...(gateway.disposable ? {} : {
        legacyNonDisposable: true,
        authoritativeGatewayId: sharedAuthorityGatewayId(
          context,
          currentGatewayId(user.data),
        ) ?? context.state.defaultGatewayId,
      }),
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

function legacyLeaseTarget(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  lease: BuilderActivationLease,
): ContinuousPlacementOwnedGateway | null {
  const targetGatewayId = lease.targetGatewayId;
  const target = targetGatewayId ? context.gateways.get(targetGatewayId) : null;
  return target &&
    target.ownerUid === user.uid &&
    target.gatewayClass !== "shared" &&
    target.disposable !== true
    ? target
    : null;
}

async function reconcileLegacyOwnerLease(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
  target: ContinuousPlacementOwnedGateway,
): Promise<void> {
  const sharedGatewayId = sharedAuthorityGatewayId(context, current);
  if (!sharedGatewayId) {
    blockPlacement(context, {
      uid: user.uid,
      code: NO_ACCEPTING_SHARED_GATEWAY,
      reason: "no configured shared gateway can receive the legacy owner runtime",
    });
    return;
  }
  if (current !== sharedGatewayId) {
    if (adoptActiveMigration(context, user.uid, sharedGatewayId)) return;
    const fromGatewayId = current ?? target.gatewayId;
    const sourceEpoch = sourceAssignmentEpoch(context, fromGatewayId, user.uid);
    await context.deps.enqueueMigration({
      uid: user.uid,
      builderSlug,
      fromGatewayId,
      toGatewayId: sharedGatewayId,
      source: CONTINUOUS_PLACEMENT_POLICY_SOURCE,
      operationId: continuousPlacementMigrationOperationId({
        uid: user.uid,
        builderSlug,
        fromGatewayId,
        toGatewayId: sharedGatewayId,
        sourceAssignmentEpoch: sourceEpoch,
      }),
    });
    projectSharedGatewayPlacement(context, sharedGatewayId);
    context.result.enqueued += 1;
    return;
  }
  const retired = await context.deps.retireOwnedGateway({
    uid: user.uid,
    builderSlug,
    gatewayId: target.gatewayId,
    legacyNonDisposable: true,
    authoritativeGatewayId: sharedGatewayId,
  });
  if (retired) {
    context.result.retired += 1;
    return;
  }
  blockPlacement(context, {
    uid: user.uid,
    code: "legacy-owner-runtime-retirement-fence",
    reason: `legacy owner runtime ${target.gatewayId} did not satisfy retirement fences`,
  });
}

async function assignMissingPlacement(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  placement: ReturnType<typeof resolveContinuousBuilderPlacement>,
): Promise<void> {
  const targetGateway = context.gateways.get(placement.targetGatewayId);
  if (!targetGateway) throw new Error(`placement target ${placement.targetGatewayId} is missing`);
  await context.deps.assignInitialPlacement({
    uid: user.uid,
    builderSlug,
    gatewayId: placement.targetGatewayId,
    gateway: targetGateway,
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

async function reconcileUnavailableServingGateway(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  currentGatewayId: string | null,
): Promise<boolean> {
  const source = currentGatewayId ? context.gateways.get(currentGatewayId) : null;
  if (!source || !knownKubernetesUnavailable(source)) return false;

  const transientFence = transientRecoveryFence(context, source);
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

  const lease = builderActivationLease(user.data);
  const kind = unavailableRecoveryKind(context, source, user, lease);
  if (!kind) return false;

  const targetGatewayId = selectAcceptingSharedGateway(context, user.uid, source.gatewayId);
  if (!targetGatewayId) {
    await scheduleRollingSharedPeerRecovery(context, source, kind);
    blockPlacement(context, {
      uid: user.uid,
      lease: lease ?? undefined,
      code: NO_ACCEPTING_SHARED_GATEWAY,
      reason: `source ${source.gatewayId} has known Kubernetes status ${source.kubernetesStatus}`,
    });
    return true;
  }
  const operationId = kind === "recover-shared-customer"
    ? `recover-shared-${user.uid}-${source.gatewayId}-${assignment.epoch}`
    : `recover-disposable-${user.uid}-${source.gatewayId}-${assignment.epoch}`;
  await context.deps.recoverUnavailableGateway({
    operationId,
    kind,
    uid: user.uid,
    slug: builderSlug,
    fromGatewayId: source.gatewayId,
    toGatewayId: targetGatewayId,
    expectedSourceEpoch: assignment.epoch,
    sharedGatewayIds: context.state.sharedGatewayIds,
    targetHeartbeatMaxAgeMs: GATEWAY_UNREACHABLE_AFTER_MS,
    ...(kind === "recover-disposable-customer"
      ? { disposableLease: { leaseId: lease!.leaseId, generation: lease!.generation } }
      : {}),
  });
  projectSharedGatewayPlacement(context, targetGatewayId);
  return true;
}

async function scheduleRollingSharedPeerRecovery(
  context: PlacementPolicyReconcileContext,
  source: PlacementPolicyGateway,
  kind: UnavailableGatewayRecoveryParams["kind"],
): Promise<void> {
  if (kind !== "recover-shared-customer") return;
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

function unavailableRecoveryKind(
  context: PlacementPolicyReconcileContext,
  source: ContinuousPlacementOwnedGateway,
  user: PlacementPolicyUser,
  lease: BuilderActivationLease | null,
): UnavailableGatewayRecoveryParams["kind"] | null {
  if (isSharedPoolGateway(context, source.gatewayId) && source.gatewayClass === "shared") {
    return "recover-shared-customer";
  }
  if (lease?.status !== "active") return null;
  return disposableTargetIdentityMatchesLease(source, user, lease)
    ? "recover-disposable-customer"
    : null;
}

function authoritativeLeaseStatus(
  lease: BuilderActivationLease,
): AuthoritativeLeaseStatus {
  if (lease.status === "activating") return "activating";
  if (lease.status === "returning") return "returning";
  return "provisioning";
}

async function recoverAndRetireUnreachableTarget(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  lease: BuilderActivationLease,
  target: ContinuousPlacementOwnedGateway,
): Promise<string | null> {
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

async function cleanupUnreachableProvisioningTarget(
  input: ActivationTargetContext,
): Promise<boolean> {
  const { context, user, builderSlug, current, lease, target } = input;
  if (target.desiredStatus === "running" && target.ready) return false;
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
    if (context.deps.now() - provisionedAt < DISPOSABLE_GATEWAY_PROVISION_TIMEOUT_MS) {
      return true;
    }
  }
  const recoveryOperationId = await recoverAndRetireUnreachableTarget(
    context,
    user,
    builderSlug,
    lease,
    target,
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
  await context.deps.allocateDisposableGateway({
    uid: user.uid,
    builderSlug,
    leaseId: lease.leaseId,
    generation: lease.generation,
    sourceGatewayId,
    sourceAssignmentEpoch,
    entitlementTier,
    sizingTier,
  });
}

async function cleanupUnauthorizedProvisioningTarget(
  input: ActivationTargetContext,
): Promise<boolean> {
  const { context, user, builderSlug, lease, target } = input;
  const authorized = accountAllowsInteractiveAccess(user.data) &&
    resolveBuilderTier(user.data, new Date(context.deps.now())) !== null;
  if (authorized) return false;
  const retired = target.ready
    ? await context.deps.retireOwnedGateway({
        uid: user.uid,
        builderSlug,
        gatewayId: target.gatewayId,
        leaseId: lease.leaseId,
        generation: lease.generation,
        authoritativeGatewayId: sharedAuthorityGatewayId(
          context,
          currentGatewayId(user.data),
        ) ?? context.state.defaultGatewayId,
        authoritativeLeaseStatus: "provisioning",
      })
    : Boolean(await recoverAndRetireUnreachableTarget(
        context,
        user,
        builderSlug,
        lease,
        target,
      ));
  if (!retired) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "provisioning-authorization-cleanup-pending",
      reason: `target ${target.gatewayId} is awaiting safe cleanup after authorization ended`,
    });
    return true;
  }
  if (target.ready) context.result.retired += 1;
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

async function advanceReadyProvisioningTarget(
  input: ActivationTargetContext,
): Promise<void> {
  const { context, user, builderSlug, current, lease, target } = input;
  const operationId = `builder-activate-${lease.targetGatewayId!}`;
  const active = context.migrations.get(user.uid);
  if (active) {
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
      operationId: `placement-retire-${user.uid}-${target.gatewayId}`,
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
  if (!target.ready) return;
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
  const operationId = `builder-activate-${target.gatewayId}`;
  const operation = context.operations.get(operationId);
  if (!operation || (operation.status !== "failed" && operation.status !== ROLLED_BACK_STATUS)) {
    return false;
  }
  if (target.desiredStatus !== "retired") {
    const recoveredRetirement = isSharedPoolGateway(context, current) && !target.ready;
    const retired = recoveredRetirement
      ? Boolean(await recoverAndRetireUnreachableTarget(
          context,
          user,
          builderSlug,
          lease,
          target,
        ))
      : await context.deps.retireOwnedGateway({
          uid: user.uid,
          builderSlug,
          gatewayId: target.gatewayId,
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
      id: `builder-return-${targetGatewayId}`,
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
  const sharedGatewayId = selectAcceptingSharedGateway(context, user.uid);
  if (!sharedGatewayId) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: NO_ACCEPTING_SHARED_GATEWAY,
      reason: "no configured shared gateway can receive the returning Builder",
    });
    return;
  }
  const operationId = await context.deps.enqueueMigration({
    uid: user.uid,
    builderSlug,
    fromGatewayId: targetGatewayId,
    toGatewayId: sharedGatewayId,
    source: BUILDER_ACTIVATION_LEASE_SOURCE,
    operationId: `builder-return-${targetGatewayId}`,
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
  const operationId = `builder-return-${lease.targetGatewayId!}`;
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
  return activity.liveRun ||
    activity.liveShell ||
    (!returnRequested && (
      activity.lastActiveAt === null ||
      now() - activity.lastActiveAt < idleMs
    ));
}

function publishedIdleSleep(userData: Record<string, unknown>): IdleSleepProjection | null {
  const provisioning = userData.provisioning as Record<string, unknown> | undefined;
  const openclaw = provisioning?.openclaw as Record<string, unknown> | undefined;
  const value = openclaw?.idleSleep as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return typeof value.deadlineAt === "number" &&
      typeof value.leaseId === "string" &&
      typeof value.generation === "number" &&
      typeof value.shellSessions === "number" &&
      typeof value.updatedAt === "number"
    ? value as unknown as IdleSleepProjection
    : null;
}

async function ensureIdleSleepCleared(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
): Promise<void> {
  if (!publishedIdleSleep(user.data)) return;
  await context.deps.publishIdleSleep({ uid: user.uid, projection: null });
}

interface IdleSleepWarningWindow {
  deadlineAt: number;
  at: number;
}

// Pure window decision. `now` stays a thunk so veto paths never sample the
// clock — reconcile tests pin the per-user now() call count.
function idleSleepWarningWindow(input: {
  idleMs: number;
  idleWarningMs: number;
  returnRequested: boolean;
  activity: BuilderRuntimeActivity;
  now: () => number;
}): IdleSleepWarningWindow | null {
  const { idleMs, idleWarningMs, returnRequested, activity } = input;
  const eligible = idleWarningMs > 0 &&
    idleMs > 0 &&
    !returnRequested &&
    !activity.liveRun &&
    !activity.liveShell &&
    activity.lastActiveAt !== null;
  if (!eligible) return null;
  const deadlineAt = activity.lastActiveAt! + idleMs;
  const at = input.now();
  return at >= deadlineAt - idleWarningMs && at < deadlineAt
    ? { deadlineAt, at }
    : null;
}

async function reconcileIdleSleepWarning(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  lease: BuilderActivationLease,
  input: {
    activity: BuilderRuntimeActivity;
    returnRequested: boolean;
    builderSlug: string;
    gatewayId: string;
  },
): Promise<void> {
  const window = idleSleepWarningWindow({
    idleMs: context.state.idleMs,
    idleWarningMs: context.state.idleWarningMs,
    returnRequested: input.returnRequested,
    activity: input.activity,
    now: context.deps.now,
  });
  if (!window) {
    await ensureIdleSleepCleared(context, user);
    return;
  }
  const { deadlineAt, at } = window;
  const existing = publishedIdleSleep(user.data);
  const shellSessions = await context.deps.readShellsAtRisk({
    builderSlug: input.builderSlug,
    gatewayId: input.gatewayId,
  });
  const changed = !existing ||
    existing.deadlineAt !== deadlineAt ||
    existing.shellSessions !== shellSessions ||
    existing.leaseId !== lease.leaseId ||
    existing.generation !== lease.generation;
  if (changed) {
    await context.deps.publishIdleSleep({
      uid: user.uid,
      projection: {
        deadlineAt,
        leaseId: lease.leaseId,
        generation: lease.generation,
        shellSessions,
        updatedAt: at,
      },
    });
  }
  // One notification per deadline, and only when sleep would destroy state:
  // live tmux sessions die with the pod. A shell-free sleep is silent — wake
  // is cheap and the modal covers the at-keyboard case.
  const newDeadline = !existing || existing.deadlineAt !== deadlineAt;
  if (newDeadline && shellSessions > 0) {
    await context.deps.sendRuntimeSleepWarning({
      uid: user.uid,
      eventId: `runtime-sleep:${user.uid}:${lease.leaseId}:${lease.generation}:${deadlineAt}`,
      deadlineAt,
      shellSessions,
    });
  }
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
  const authorized = accountAllowsInteractiveAccess(user.data) &&
    resolveBuilderTier(user.data, new Date(context.deps.now())) !== null;
  if (!authorized) {
    await queueLeaseReturn(context, user, builderSlug, lease);
    return;
  }
  const returnRequested = millis(lease.raw.returnRequestedAt) !== null;
  if (!returnRequested && context.state.idleMs <= 0) {
    await ensureIdleSleepCleared(context, user);
    return;
  }
  const activity = await context.deps.readBuilderActivity({
    uid: user.uid,
    builderSlug,
    gatewayId: targetGatewayId!,
    userData: user.data,
    liveRun: context.state.liveRunBuilderSlugs.includes(builderSlug),
  });
  await reconcileIdleSleepWarning(context, user, lease, {
    activity,
    returnRequested,
    builderSlug,
    gatewayId: targetGatewayId!,
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
  const operationId = `builder-return-${targetGatewayId}`;
  const returnOperation = context.operations.get(operationId);
  if (
    returnOperation?.status === "failed" ||
    returnOperation?.status === ROLLED_BACK_STATUS
  ) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "return-operation-failed",
      reason: `return operation ended with ${returnOperation.status}: ${returnOperation.error ?? "unknown error"}`,
    });
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
  const sharedGatewayId = selectAcceptingSharedGateway(context, user.uid);
  if (!sharedGatewayId) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: NO_ACCEPTING_SHARED_GATEWAY,
      reason: "no configured shared gateway can receive the returning Builder",
    });
    return true;
  }
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

async function completeReturnedLease(
  input: ActivationTargetContext,
): Promise<void> {
  const { context, user, builderSlug, lease, target } = input;
  const targetGatewayId = lease.targetGatewayId!;
  if (target.desiredStatus === "retired") {
    await context.deps.completeActivationLease({
      uid: user.uid,
      leaseId: lease.leaseId,
      generation: lease.generation,
      targetGatewayId,
    });
    return;
  }
  if (
    lease.raw.returnReason === "source-unavailable" ||
    !target.ready ||
    target.desiredStatus === "paused"
  ) {
    const recoveryOperationId = await recoverAndRetireUnreachableTarget(
      context,
      user,
      builderSlug,
      lease,
      target,
    );
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
    leaseId: lease.leaseId,
    generation: lease.generation,
    ...(operatorTermination
      ? {}
      : {
          telemetryFenceOperationId: `builder-return-${targetGatewayId}`,
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
  const target = lease.targetGatewayId
    ? context.gateways.get(lease.targetGatewayId)
    : null;
  const legacyTarget = legacyLeaseTarget(context, user, lease);
  if (legacyTarget) {
    await reconcileLegacyOwnerLease(context, user, builderSlug, current, legacyTarget);
    return true;
  }
  if (isOperatorManaged(target?.managedBy)) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "operator-managed-gateway",
      reason: `gateway ${target!.gatewayId} is operator-managed`,
    });
    return true;
  }
  if (lease.status !== "active") {
    await ensureIdleSleepCleared(context, user);
  }
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

async function reconcileEligibleBuilder(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
): Promise<void> {
  const current = currentGatewayId(user.data);
  const currentGateway = current ? context.gateways.get(current) : null;
  if (isOperatorManaged(currentGateway?.managedBy)) {
    blockPlacement(context, {
      uid: user.uid,
      code: "operator-managed-gateway",
      reason: `gateway ${currentGateway!.gatewayId} is operator-managed`,
    });
    return;
  }
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
  return selectAcceptingSharedGateway(context, uid, currentGatewayId);
}

async function reconcileResolvedPlacement(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
  placement: ReturnType<typeof resolveContinuousBuilderPlacement>,
): Promise<void> {
  const targetGateway = context.gateways.get(placement.targetGatewayId);
  if (isOperatorManaged(targetGateway?.managedBy)) {
    blockPlacement(context, {
      uid: user.uid,
      code: "operator-managed-gateway",
      reason: `gateway ${targetGateway!.gatewayId} is operator-managed`,
    });
    return;
  }
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
  const openclaw = record(record(user.data.provisioning)?.openclaw);
  if (isOperatorManaged(openclaw?.managedBy)) {
    context.deps.log(`[placement-policy] ${user.uid} is operator-managed — observing only`);
    return;
  }
  const eligibility = resolveOnboardingPlacementEligibility(user.data);
  if (!eligibility.eligible) return;
  await reconcileEligibleBuilder(context, user, eligibility.slug);
}

function sharedRebalanceBuilder(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  fromGatewayId: string,
  scheduled: ReadonlySet<string>,
): { uid: string; builderSlug: string; sourceAssignmentEpoch: number } | null {
  if (scheduled.has(user.uid) || currentGatewayId(user.data) !== fromGatewayId) return null;
  if (isOperatorManaged(record(record(user.data.provisioning)?.openclaw)?.managedBy)) return null;
  const lease = builderActivationLease(user.data);
  if (lease && LIVE_LEASE_STATUSES.has(lease.status)) return null;
  const eligibility = resolveOnboardingPlacementEligibility(user.data);
  if (!eligibility.eligible || context.migrations.has(user.uid)) return null;
  const assignment = context.assignments.get(
    placementAssignmentKey(fromGatewayId, user.uid),
  );
  if (assignment?.state !== "serving") return null;
  const sourceAssignmentEpoch = nonNegativeInteger(assignment.epoch);
  if (sourceAssignmentEpoch === null) return null;
  return { uid: user.uid, builderSlug: eligibility.slug, sourceAssignmentEpoch };
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

async function reconcileSharedGatewayRebalance(
  context: PlacementPolicyReconcileContext,
): Promise<void> {
  const config = {
    defaultGatewayId: context.state.defaultGatewayId,
    sharedGatewayIds: context.state.sharedGatewayIds,
  };
  const candidates = sharedGatewayCandidates(context).map((candidate) => ({ ...candidate }));
  if (!planSharedGatewayRebalance({ config, candidates })) return;
  if (!sharedGatewayPoolStableForRebalance(context)) return;
  const users = [...context.state.users].sort((left, right) => left.uid.localeCompare(right.uid));
  const scheduled = new Set<string>();
  while (true) {
    const plan = planSharedGatewayRebalance({ config, candidates });
    if (!plan) return;
    const builder = users
      .map((user) => sharedRebalanceBuilder(context, user, plan.fromGatewayId, scheduled))
      .find((candidate) => candidate !== null);
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
      if (!(error instanceof TerminalPlacementMigrationConflictError)) throw error;
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
  const openclaw = record(record(user.data.provisioning)?.openclaw);
  if (isOperatorManaged(openclaw?.managedBy)) return null;
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
  const config = {
    defaultGatewayId: context.state.defaultGatewayId,
    sharedGatewayIds: context.state.sharedGatewayIds,
  };
  const projectedCandidates = sharedGatewayCandidates(context).map((candidate) => ({
    ...candidate,
  }));

  for (const fromGatewayId of drainingGatewayIds) {
    for (const user of [...context.state.users].sort((left, right) =>
      left.uid.localeCompare(right.uid))) {
      const builder = drainingSharedGatewayBuilder(context, user, fromGatewayId);
      if (!builder) continue;
      const selection = selectSharedGateway({
        uid: user.uid,
        config,
        candidates: projectedCandidates,
      });
      if (selection.kind !== "selected") continue;
      await context.deps.enqueueMigration({
        uid: builder.uid,
        builderSlug: builder.builderSlug,
        fromGatewayId,
        toGatewayId: selection.gatewayId,
        source: CONTINUOUS_PLACEMENT_POLICY_SOURCE,
        operationId: continuousPlacementMigrationOperationId({
          ...builder,
          fromGatewayId,
          toGatewayId: selection.gatewayId,
        }),
      });
      const target = projectedCandidates.find(
        (candidate) => candidate.gatewayId === selection.gatewayId,
      )!;
      target.assignmentCount += 1;
      context.result.enqueued += 1;
    }
  }
  return true;
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
  if (await placementMaintenanceFrozen(deps)) return result;
  const state = await deps.readSnapshot();
  const pool = parseSharedGatewayPoolConfig({
    defaultGatewayId: state.defaultGatewayId,
    sharedGatewayIds: state.sharedGatewayIds,
  });
  if (!pool) {
    deps.log("[placement-policy] disabled: config/orchestrator shared gateway pool is invalid");
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
      !isOperatorManaged(gateway.managedBy) &&
      gateway.ownerUid !== null &&
      !liveTargets.has(gateway.gatewayId))
    .sort((a, b) => a.gatewayId.localeCompare(b.gatewayId));
  for (const gateway of candidates) {
    const deleted = await context.deps.deleteRetiredDisposableGateway({
      gatewayId: gateway.gatewayId,
      ownerUid: gateway.ownerUid!,
    });
    if (deleted) {
      context.result.swept += 1;
    }
  }
}

async function placementMaintenanceFrozen(
  deps: PlacementPolicyReconcilerDeps,
): Promise<boolean> {
  if (!deps.maintenanceGate) return false;
  try {
    const gate = await deps.maintenanceGate.state();
    if (!gate.frozen) return false;
    const reason = gate.reason ? `: ${gate.reason}` : "";
    deps.log(`[placement-policy] maintenance freeze blocks reconciliation${reason}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`[placement-policy] maintenance gate unreadable; blocking reconciliation: ${message}`);
    return true;
  }
}

function docsById(docs: QueryDocumentSnapshot[]): Map<string, Record<string, unknown>> {
  return new Map(docs.map((doc) => [doc.id, doc.data() as Record<string, unknown>]));
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

function activeMigration(doc: QueryDocumentSnapshot): PlacementPolicyMigration | null {
  const data = doc.data() as Record<string, unknown>;
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
    id: doc.id,
    uid,
    builderSlug,
    fromGatewayId,
    toGatewayId,
    source,
    status,
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
}

interface FirestorePlacementPolicyInput {
  db: Firestore;
  informer: FleetInformer;
  namespace: string;
  idleMs: number;
  idleWarningMs: number;
  sendRuntimeSleepWarning(input: RuntimeSleepWarningInput): Promise<void>;
  now(): number;
  log(message: string): void;
  maintenanceGate?: { state(): Promise<{ frozen: boolean; reason: string | null }> };
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
  }): Promise<Record<string, PlacementPolicyPodDiagnostics>>;
}

async function readCompletedReturnSnapshots(
  db: Firestore,
  userDocuments: ReadonlyArray<QueryDocumentSnapshot>,
  sharedGatewayIds: readonly string[],
) {
  const refs = userDocuments.flatMap((doc) => {
    const userData = doc.data() as Record<string, unknown>;
    const lease = builderActivationLease(userData);
    const completedReturn = [
      lease?.status === "active",
      Boolean(lease?.targetGatewayId),
      sharedGatewayIds.includes(currentGatewayId(userData) ?? ""),
    ].every(Boolean);
    if (!completedReturn || !lease?.targetGatewayId) return [];
    return [
      db.collection(GLM_OPERATIONS_COLLECTION)
        .doc(`builder-return-${lease.targetGatewayId}`),
    ];
  });
  return refs.length === 0 ? [] : db.getAll(...refs);
}

// A failed or rolled-back activation/return operation stays reconcile-relevant
// until its lease is cleaned up, so it is read by deterministic id rather than
// left in the tick's collection scan.
async function readTerminalLeaseOperationSnapshots(
  db: Firestore,
  userDocuments: ReadonlyArray<QueryDocumentSnapshot>,
) {
  const operationIds = [...new Set(
    userDocuments.flatMap((doc) => leaseJournalOperationIds(doc.data() as Record<string, unknown>)),
  )];
  if (operationIds.length === 0) return [];
  const snapshots = await db.getAll(
    ...operationIds.map((operationId) =>
      db.collection(GLM_OPERATIONS_COLLECTION).doc(operationId)),
  );
  return snapshots.filter((snapshot) => {
    if (!snapshot.exists) return false;
    const status = (snapshot.data() as Record<string, unknown> | undefined)?.status;
    return typeof status === "string" && TERMINAL_LEASE_OPERATION_STATUSES.has(status);
  });
}

function placementPolicyIdleMs(value: unknown, fallbackIdleMs: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallbackIdleMs;
}

// Must stay a reconcile tick inside GATEWAY_UNREACHABLE_AFTER_MS.
export const KUBERNETES_OBSERVATION_REFRESH_MS = 120_000;

interface KubernetesObservation {
  status: string;
  totalPods: number;
  readyPods: number;
}

function storedPodUids(stored: Record<string, unknown> | null): string[] | null {
  const uids = stored?.podUids;
  if (!Array.isArray(uids)) return null;
  return uids.every((uid) => typeof uid === "string") ? uids as string[] : null;
}

// A Spot preemption replaces the pod without changing readyPods or the restart
// count, so pod identity has to be part of the freshness comparison — otherwise
// a replacement inside the refresh interval is skipped and never recorded.
function samePodUids(
  stored: Record<string, unknown> | null,
  observed: readonly string[] | null,
): boolean {
  if (observed === null) return true;
  const previous = storedPodUids(stored);
  if (previous === null) return false;
  return previous.length === observed.length &&
    previous.every((uid, index) => uid === observed[index]);
}

function kubernetesObservationIsCurrent(input: {
  stored: unknown;
  observed: KubernetesObservation;
  observedUids: readonly string[] | null;
  planToken: string | null;
  now: number;
}): boolean {
  const { observed, observedUids, planToken, now } = input;
  const current = record(input.stored);
  if (!current) return false;
  const observedAt = current.observedAt;
  if (typeof observedAt !== "number") return false;
  if (observedAt > now || now - observedAt >= KUBERNETES_OBSERVATION_REFRESH_MS) return false;
  return current.status === observed.status &&
    current.totalPods === observed.totalPods &&
    current.readyPods === observed.readyPods &&
    samePodUids(current, observedUids) &&
    (planToken === null || current.planToken === planToken);
}

export async function persistKubernetesObservations(
  db: Firestore,
  runtimeDocuments: ReadonlyArray<QueryDocumentSnapshot>,
  kubernetesByGatewayId: Readonly<Record<string, PlacementPolicyPodDiagnostics>>,
  now: number,
  options: {
    planTokenByGatewayId?: Readonly<Record<string, string>>;
    log?: (message: string) => void;
  } = {},
): Promise<void> {
  if (runtimeDocuments.length === 0) return;
  await Promise.all(runtimeDocuments.map(async (runtimeDocument) => {
    const diagnostics = kubernetesByGatewayId[runtimeDocument.id];
    const observed: KubernetesObservation = {
      status: placementKubernetesStatus(diagnostics),
      totalPods: diagnostics?.totalPods ?? 0,
      readyPods: diagnostics?.readyPods ?? 0,
    };
    const observedUids = observedPodUids(diagnostics);
    const planToken = options.planTokenByGatewayId?.[runtimeDocument.id] ?? null;
    const scanned = record(runtimeDocument.data());
    if (kubernetesObservationIsCurrent({
      stored: scanned?.kubernetes,
      observed,
      observedUids,
      planToken,
      now,
    })) return;
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(runtimeDocument.ref);
      const data = current.data();
      if (!current.exists || !isGatewayRuntimeDoc(data)) return;
      const storedKubernetes = record(data.kubernetes);
      const transition = planToken === null ? null : nextPodReplacementTransition({
        previousPodUids: storedPodUids(storedKubernetes),
        previousPlanToken: typeof storedKubernetes?.planToken === "string"
          ? storedKubernetes.planToken
          : null,
        previous: isGatewayPodReplacements(data.podReplacements) ? data.podReplacements : null,
        observedPodUids: observedUids,
        planToken,
        now,
      });
      if (transition !== null && transition.replacedCount > 0) {
        options.log?.(
          `[placement-policy] ${runtimeDocument.id} observed ${transition.replacedCount} ` +
            `unplanned pod replacement(s) at plan ${planToken}; ` +
            `pod=${transition.replacements.lastPodUid} total=${transition.replacements.total}`,
        );
      }
      transaction.set(runtimeDocument.ref, transition === null
        ? { kubernetes: { ...observed, observedAt: now } }
        : {
            kubernetes: {
              ...observed,
              observedAt: now,
              podUids: transition.podUids,
              planToken: transition.planToken,
            },
            podReplacements: transition.replacements,
          }, { merge: true });
    });
  }));
}

function placementAssignmentFromDocument(
  doc: QueryDocumentSnapshot,
): PlacementPolicyAssignment | null {
  const data = doc.data() as Record<string, unknown>;
  const gatewayId = nonEmptyString(data.gatewayId) ?? doc.ref.parent.parent?.id ?? null;
  const uid = nonEmptyString(data.uid) ?? doc.id;
  const slug = nonEmptyString(data.slug);
  const state = nonEmptyString(data.state);
  const rawEpoch = data.epoch;
  const epoch = typeof rawEpoch === "number" &&
    Number.isSafeInteger(rawEpoch) && rawEpoch >= 0
    ? rawEpoch
    : null;
  if (!gatewayId || !uid || !slug || !state) return null;
  return { uid, slug, gatewayId, state, epoch };
}

function gatewayRuntimeStartedAt(value: unknown): number | null {
  return isGatewayRuntimeDoc(value) ? millis(value.heartbeat.startedAt) : null;
}

function placementGatewayFromDocument(input: {
  doc: QueryDocumentSnapshot;
  runtimes: ReadonlyMap<string, Record<string, unknown>>;
  assignments: readonly PlacementPolicyAssignment[];
  kubernetesByGatewayId: Readonly<Record<string, PlacementPolicyPodDiagnostics>>;
  now: number;
}): PlacementPolicyGateway | null {
  const { doc, runtimes, assignments, kubernetesByGatewayId, now } = input;
  const root = projectGatewayDesiredRootForGateway(doc.data(), doc.id);
  if (!root) return null;
  const runtimeData = runtimes.get(doc.id);
  const runtime = isGatewayRuntimeDoc(runtimeData) ? runtimeData : null;
  const heartbeatAt = millis(runtime?.heartbeat.lastHeartbeatAt);
  const heartbeatFresh = heartbeatAt === null
    ? false
    : now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS;
  const runtimeReady = [
    runtime !== null,
    runtime?.gatewayId === doc.id,
    root.liveRelease !== null,
    root.desiredRelease === root.liveRelease,
    runtime?.release === root.liveRelease,
    runtime?.lifecycle === "serving",
    runtime?.heartbeat.status === "ready",
    heartbeatFresh,
  ].every(Boolean);
  const assigned = assignments.filter((assignment) => assignment.gatewayId === doc.id);
  const mounted = new Set(runtime?.heartbeat.mountedCustomers ?? []);
  return {
    gatewayId: doc.id,
    gatewayClass: root.gatewayClass,
    ownerUid: root.ownerUid,
    desiredStatus: root.desiredStatus,
    managedBy: root.managedBy,
    disposable: root.allocation?.kind === DISPOSABLE_BUILDER_ALLOCATION_KIND,
    allocation: root.allocation ?? null,
    ready: runtimeReady,
    kubernetesStatus: placementKubernetesStatus(kubernetesByGatewayId[doc.id]),
    serving: runtime?.lifecycle === "serving",
    heartbeatFresh,
    runtimeStartedAt: gatewayRuntimeStartedAt(runtime),
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
  };
}

export function assertConfiguredSharedGateways(
  sharedGatewayIds: readonly string[],
  gateways: readonly PlacementPolicyGateway[],
): void {
  const automaticSharedStatuses = new Set(["running", "draining", "paused"]);
  for (const gatewayId of sharedGatewayIds) {
    const gateway = gateways.find((item) => item.gatewayId === gatewayId);
    const invalid = [
      !gateway,
      gateway?.gatewayClass !== "shared",
      !automaticSharedStatuses.has(gateway?.desiredStatus ?? ""),
      isOperatorManaged(gateway?.managedBy),
    ].some(Boolean);
    if (invalid) {
      throw new Error(`configured shared gateway ${gatewayId} is not a Cowboy-managed shared root`);
    }
  }
}

async function readPlacementPolicySnapshot(
  input: FirestorePlacementPolicyInput,
): Promise<PlacementPolicySnapshot> {
  const { db, idleMs: fallbackIdleMs, now: nowFn, informer } = input;
  const now = nowFn();
  const [configSnap, userDocs, gatewayDocs, runtimeDocs, opsSnap, liveRunsSnap, assignmentDocs] =
    await Promise.all([
      db.doc("config/orchestrator").get(),
      mirroredOrScan(informer.users(), () => db.collection("users").get()),
      mirroredOrScan(informer.gateways(), () => db.collection(GATEWAYS_COLLECTION).get()),
      mirroredOrScan(informer.glmGateways(), () => db.collection(GLM_GATEWAYS_COLLECTION).get()),
      db.collection(GLM_OPERATIONS_COLLECTION)
        .where("status", "in", [...PLACEMENT_ACTIVE_OPERATION_STATUSES])
        .get(),
      db.collectionGroup("liveRuns").where("expiresAt", ">", now).get(),
      mirroredOrScan(informer.assignments(), () => db.collectionGroup("assignments").get()),
    ]);
  const pool = parseSharedGatewayPoolConfig(configSnap.data());
  if (!pool) throw new Error("config/orchestrator shared gateway pool is invalid");
  const { defaultGatewayId, sharedGatewayIds } = pool;
  const [completedReturnSnapshots, terminalLeaseSnapshots] = await Promise.all([
    readCompletedReturnSnapshots(db, userDocs, sharedGatewayIds),
    readTerminalLeaseOperationSnapshots(db, userDocs),
  ]);
  const idleMs = placementPolicyIdleMs(
    configSnap.data()?.disposableGatewayIdleMs,
    fallbackIdleMs,
  );
  const idleWarningMs = placementPolicyIdleMs(
    configSnap.data()?.disposableGatewayIdleWarningMs,
    input.idleWarningMs,
  );
  const runtimes = docsById(runtimeDocs);
  const kubernetesByGatewayId = await input.readGatewayPodDiagnosticsBatch({
    namespace: input.namespace,
    gatewayIds: gatewayDocs.map((doc) => doc.id),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    input.log(`[placement-policy] Kubernetes diagnostics unreadable; treating fleet as unknown: ${message}`);
    return Object.fromEntries(gatewayDocs.map((doc) => [doc.id, {
      status: "unknown",
      totalPods: 0,
      readyPods: 0,
    }]));
  });
  await persistKubernetesObservations(db, runtimeDocs, kubernetesByGatewayId, now, {
    planTokenByGatewayId: Object.fromEntries(gatewayDocs.flatMap((doc) => {
      const root = projectGatewayDesiredRootForGateway(doc.data(), doc.id);
      return root ? [[doc.id, gatewayPlanToken(root)]] : [];
    })),
    log: input.log,
  });
  const assignments = assignmentDocs
    .map(placementAssignmentFromDocument)
    .filter((assignment): assignment is PlacementPolicyAssignment => assignment !== null);
  const gateways = gatewayDocs
    .map((doc) => placementGatewayFromDocument({
      doc,
      runtimes,
      assignments,
      kubernetesByGatewayId,
      now,
    }))
    .filter((gateway): gateway is PlacementPolicyGateway => gateway !== null);
  assertConfiguredSharedGateways(sharedGatewayIds, gateways);
  return {
    defaultGatewayId,
    sharedGatewayIds,
    idleMs,
    idleWarningMs,
    liveRunBuilderSlugs: [...new Set(liveRunsSnap.docs.flatMap((doc) => {
      const parts = doc.ref.path.split("/");
      return parts[0] === "workspaces" && parts[1] ? [parts[1]] : [];
    }))],
    users: userDocs.map((doc) => ({ uid: doc.id, data: doc.data() as Record<string, unknown> })),
    gateways,
    assignments,
    activeMigrations: [
      ...opsSnap.docs,
      ...completedReturnSnapshots.filter(
        (snapshot) => snapshot.exists && snapshot.data()?.status === "succeeded",
      ),
      ...terminalLeaseSnapshots,
    ].flatMap((doc) => activeMigration(doc as QueryDocumentSnapshot) ?? []),
  };
}

function unavailableRecoveryTargetFence(
  input: FirestorePlacementPolicyInput,
  request: UnavailableGatewayRecoveryParams,
): (context: UnavailableGatewayRecoveryTargetValidationContext) => Promise<void> {
  return async (context) => {
    const transaction = context.txn as unknown as Transaction;
    const configSnapshot = await transaction.get(input.db.doc(ORCHESTRATOR_CONFIG_DOC_PATH));
    const pool = parseSharedGatewayPoolConfig(
      configSnapshot.exists ? configSnapshot.data() : undefined,
    );
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

async function assignInitialPlacementFirestore(
  input: FirestorePlacementPolicyInput,
  request: AssignInitialPlacementInput,
): Promise<void> {
  const shellState = resolveUserGatewayShellState(request.gateway, request.uid);
  const placement = await commitPlacementAtomic(input.db as unknown as PlacementFirestore, {
    uid: request.uid,
    slug: request.builderSlug,
    gatewayId: request.gatewayId,
    source: "repair",
    now: input.now(),
    requireDurableGateway: true,
    automatic: true,
    mirrorPatch: {
      "provisioning.openclaw.gatewayId": request.gatewayId,
      "provisioning.openclaw.gatewayProfile": shellState.gatewayProfile,
      "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
    },
  });
  if (placement.kind !== "assigned") {
    const reason = placement.kind === "rejected" ? placement.reason : placement.kind;
    throw new Error(`initial placement onto ${request.gatewayId} failed: ${reason}`);
  }
}

function automaticPlacementOperatorFenceReasons(
  request: EnqueuePlacementMigrationInput,
): ReadonlySet<string> {
  return new Set([
    automaticGatewayOperationFenceReason(MIGRATE_CUSTOMER_KIND, request.fromGatewayId),
    automaticGatewayOperationFenceReason(MIGRATE_CUSTOMER_KIND, request.toGatewayId),
    automaticBuilderOperationFenceReason(MIGRATE_CUSTOMER_KIND, request.uid),
  ]);
}

function operatorFenceAttemptMatches(
  attempt: Record<string, unknown>,
  error: string,
  reasons: ReadonlySet<string>,
): boolean {
  return reasons.has(error) &&
    attempt.classification === "terminal" &&
    Array.isArray(attempt.steps) &&
    attempt.steps.length === 0;
}

function operatorFenceAttempt(
  value: unknown,
  reasons: ReadonlySet<string>,
): OperationAttemptRecord | null {
  const attempt = record(value);
  const attemptNumber = positiveInteger(attempt?.attempt);
  const startedAt = millis(attempt?.startedAt);
  const completedAt = millis(attempt?.completedAt);
  const error = typeof attempt?.error === "string" ? attempt.error : null;
  if (
    !attempt ||
    attemptNumber === null ||
    startedAt === null ||
    completedAt === null ||
    error === null ||
    !operatorFenceAttemptMatches(attempt, error, reasons)
  ) {
    return null;
  }
  return {
    attempt: attemptNumber,
    startedAt,
    completedAt,
    error,
    classification: "terminal",
    steps: [],
  };
}

function operatorFenceAttemptHistory(
  value: unknown,
  reasons: ReadonlySet<string>,
): OperationAttemptRecord[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const history = value.map((entry) => operatorFenceAttempt(entry, reasons));
  return history.every((attempt): attempt is OperationAttemptRecord => attempt !== null)
    ? history
    : null;
}

function operatorFenceHistoryIsContiguous(
  history: readonly OperationAttemptRecord[],
  attempts: number,
): boolean {
  if (history.length === 0) return attempts === 0;
  return history.at(-1)?.attempt === attempts && history.every(
    (attempt, index) => index === 0 || attempt.attempt === history[index - 1]!.attempt + 1,
  );
}

function automaticPlacementFenceError(
  data: Record<string, unknown>,
  reasons: ReadonlySet<string>,
): string | null {
  const error = typeof data.error === "string" ? data.error : null;
  return data.status === "failed" &&
      data.origin === "automatic" &&
      data.createdBy === PLACEMENT_POLICY_ACTOR &&
      error !== null &&
      reasons.has(error)
    ? error
    : null;
}

function operatorFenceHasNoExecutionEvidence(data: Record<string, unknown>): boolean {
  return Array.isArray(data.steps) &&
    data.steps.length === 0 &&
    data.customerMigrationV2 === undefined &&
    data.output === undefined &&
    data.rolledBack !== true;
}

function operatorFenceRearm(
  data: Record<string, unknown>,
  request: EnqueuePlacementMigrationInput,
): { attempts: number; attemptHistory: OperationAttemptRecord[] } | null {
  const reasons = automaticPlacementOperatorFenceReasons(request);
  const history = operatorFenceAttemptHistory(data.attemptHistory, reasons);
  const attempts = nonNegativeInteger(data.attempts ?? 0);
  const completedAt = millis(data.completedAt);
  const startedAt = data.startedAt === null ? completedAt : millis(data.startedAt);
  const error = automaticPlacementFenceError(data, reasons);
  if (
    completedAt === null ||
    startedAt === null ||
    error === null ||
    attempts === null ||
    history === null ||
    !operatorFenceHistoryIsContiguous(history, attempts) ||
    !operatorFenceHasNoExecutionEvidence(data)
  ) {
    return null;
  }
  const nextAttempt = attempts + 1;
  return {
    attempts: nextAttempt,
    attemptHistory: [...history, {
      attempt: nextAttempt,
      startedAt,
      completedAt,
      error,
      classification: "terminal" as const,
      steps: [],
    }].slice(-MAX_OPERATION_ATTEMPT_HISTORY),
  };
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

export async function enqueuePlacementMigration(
  input: FirestorePlacementPolicyInput,
  request: EnqueuePlacementMigrationInput,
): Promise<string> {
  const ref = input.db.collection(GLM_OPERATIONS_COLLECTION).doc(request.operationId);
  const now = input.now();
  const operation = {
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
  await input.db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) {
      const data = existing.data() as Record<string, unknown>;
      const operationInput = record(data.input);
      if (
        data.kind !== MIGRATE_CUSTOMER_KIND ||
        operationInput?.uid !== request.uid ||
        operationInput.builderSlug !== request.builderSlug ||
        operationInput.fromGatewayId !== request.fromGatewayId ||
        operationInput.toGatewayId !== request.toGatewayId ||
        operationInput.source !== request.source
      ) {
        throw new Error(`migration operation ${ref.id} does not match activation demand`);
      }
      if (
        data.status !== "pending" &&
        data.status !== "running" &&
        data.status !== "succeeded"
      ) {
        const operatorFence = operatorFenceRearm(data, request);
        const rolledBackTransient = rolledBackTransientPlacementCanRearm(data, request);
        if (operatorFence || rolledBackTransient) {
          await assertAutomaticPlacementMutationAllowed({
            db: input.db,
            transaction,
            uid: request.uid,
            gatewayIds: [request.fromGatewayId, request.toGatewayId],
            action: `migration ${ref.id}`,
          });
          transaction.update(ref, {
            status: "pending",
            startedAt: null,
            completedAt: null,
            steps: [],
            error: FieldValue.delete(),
            expireAt: FieldValue.delete(),
            rolledBack: FieldValue.delete(),
            output: FieldValue.delete(),
            lastProgressAt: FieldValue.delete(),
            waitingOn: FieldValue.delete(),
            nextAttemptAt: FieldValue.delete(),
            ...(operatorFence ?? {}),
          });
          return;
        }
        throw new TerminalPlacementMigrationConflictError(ref.id, String(data.status));
      }
      return;
    }
    await assertAutomaticPlacementMutationAllowed({
      db: input.db,
      transaction,
      uid: request.uid,
      gatewayIds: [request.fromGatewayId, request.toGatewayId],
      action: `migration ${ref.id}`,
    });
    transaction.create(ref, operation);
  });
  return ref.id;
}

async function assertAutomaticPlacementMutationAllowed(input: {
  db: Firestore;
  transaction: Transaction;
  uid: string;
  gatewayIds: readonly string[];
  action: string;
}): Promise<void> {
  const gatewayIds = [...new Set(input.gatewayIds)];
  const [userSnapshot, ...gatewaySnapshots] = await Promise.all([
    input.transaction.get(input.db.collection("users").doc(input.uid)),
    ...gatewayIds.map((gatewayId) =>
      input.transaction.get(input.db.collection(GATEWAYS_COLLECTION).doc(gatewayId))),
  ]);
  const user = userSnapshot.exists
    ? userSnapshot.data() as Record<string, unknown> | undefined
    : undefined;
  if (isOperatorManaged(record(record(user?.provisioning)?.openclaw)?.managedBy)) {
    throw new GatewayRetirementConflictError(
      `${input.action} is fenced: builder ${input.uid} is operator-managed`,
    );
  }
  for (let index = 0; index < gatewayIds.length; index += 1) {
    const root = gatewaySnapshots[index];
    if (root.exists && isOperatorManaged(root.data()?.managedBy)) {
      throw new GatewayRetirementConflictError(
        `${input.action} is fenced: gateway ${gatewayIds[index]} is operator-managed`,
      );
    }
  }
}

function recoveryTargetMatchesRequest(
  root: ReturnType<typeof projectGatewayDesiredRootForGateway>,
  request: RecoverUnreachableDisposableGatewayInput,
): root is NonNullable<ReturnType<typeof projectGatewayDesiredRootForGateway>> {
  const allocation = root?.allocation;
  return root !== null &&
    !isOperatorManaged(root.managedBy) &&
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
  runtime: Record<string, unknown> | undefined;
  request: RecoverUnreachableDisposableGatewayInput;
  now: () => number;
}): boolean {
  const { root, runtime, request, now } = input;
  const heartbeatAt = isGatewayRuntimeDoc(runtime)
    ? millis(runtime.heartbeat.lastHeartbeatAt)
    : null;
  return root.desiredStatus === "running" &&
    isGatewayRuntimeDoc(runtime) &&
    runtime.gatewayId === request.gatewayId &&
    root.liveRelease !== null &&
    runtime.release === root.liveRelease &&
    runtime.lifecycle === "serving" &&
    runtime.heartbeat.status === "ready" &&
    heartbeatAt !== null &&
    now() - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}

function recoveryAuthorityMatches(input: {
  userData: Record<string, unknown> | undefined;
  assignmentExists: boolean;
  assignment: Record<string, unknown> | undefined;
  request: RecoverUnreachableDisposableGatewayInput;
}): boolean {
  const { userData, assignmentExists, assignment, request } = input;
  const lease = builderActivationLease(userData ?? {});
  return (!request.sourceUnavailable || (
    lease?.leaseId === request.leaseId &&
    lease.generation === request.generation &&
    lease.status === "returning" &&
    lease.raw.returnReason === "source-unavailable"
  )) &&
    currentGatewayId(userData ?? {}) === request.authoritativeGatewayId &&
    assignmentExists &&
    assignment?.uid === request.uid &&
    assignment.gatewayId === request.authoritativeGatewayId &&
    assignment.state === "serving";
}

async function recoverUnreachableDisposableGatewayFirestore(
  input: FirestorePlacementPolicyInput,
  request: RecoverUnreachableDisposableGatewayInput,
): Promise<{ recovered: boolean; operationId: string }> {
  const operationId = `builder-recover-${request.gatewayId}`;
  const gatewayRef = input.db.collection(GATEWAYS_COLLECTION).doc(request.gatewayId);
  const userRef = input.db.collection("users").doc(request.uid);
  const assignmentRef = input.db
    .collection(GATEWAYS_COLLECTION)
    .doc(request.authoritativeGatewayId)
    .collection("assignments")
    .doc(request.uid);
  const operationRef = input.db
    .collection(DISPOSABLE_GATEWAY_RECOVERY_RECEIPTS_COLLECTION)
    .doc(operationId);
  const runtimeRef = input.db.collection(GLM_GATEWAYS_COLLECTION).doc(request.gatewayId);
  const exactRecoveryState = async (
    transaction: Transaction,
  ): Promise<void> => {
    const [gatewaySnapshot, userSnapshot, assignmentSnapshot, runtimeSnapshot] =
      await Promise.all([
      transaction.get(gatewayRef),
      transaction.get(userRef),
      transaction.get(assignmentRef),
      transaction.get(runtimeRef),
    ]);
    const root = projectGatewayDesiredRootForGateway(
      gatewaySnapshot.data(),
      request.gatewayId,
    );
    const userData = userSnapshot.data() as Record<string, unknown> | undefined;
    const assignment = assignmentSnapshot.data() as Record<string, unknown> | undefined;
    if (!recoveryTargetMatchesRequest(root, request)) {
      throw new GatewayRetirementConflictError(
        `gateway ${request.gatewayId} no longer matches unreachable recovery demand`,
      );
    }
    if (isOperatorManaged(record(record(userData?.provisioning)?.openclaw)?.managedBy)) {
      throw new GatewayRetirementConflictError(
        `Builder ${request.uid} is operator-managed`,
      );
    }
    const runtime = runtimeSnapshot.data() as Record<string, unknown> | undefined;
    if (!request.sourceUnavailable && recoveryTargetBecameReady({
      root,
      runtime,
      request,
      now: input.now,
    })) {
      throw new GatewayRetirementConflictError(
        `gateway ${request.gatewayId} became ready before recovery`,
      );
    }
    if (!recoveryAuthorityMatches({
      userData,
      assignmentExists: assignmentSnapshot.exists,
      assignment,
      request,
    })) {
      throw new GatewayRetirementConflictError(
        `Builder ${request.uid} is no longer authoritative on ${request.authoritativeGatewayId}`,
      );
    }
  };
  await input.db.runTransaction(async (transaction) => {
    await exactRecoveryState(transaction);
    const operationSnapshot = await transaction.get(operationRef);
    if (operationSnapshot.exists) {
      const operation = operationSnapshot.data() as Record<string, unknown>;
      const operationInput = record(operation.input);
      if (
        operation.kind !== "recover-unreachable-disposable" ||
        operationInput?.uid !== request.uid ||
        operationInput.gatewayId !== request.gatewayId ||
        operationInput.leaseId !== request.leaseId ||
        operationInput.generation !== request.generation
      ) {
        throw new GatewayRetirementConflictError(
          `recovery operation ${operationId} does not match unreachable demand`,
        );
      }
      if (operation.status === "succeeded") return;
      if (operation.status !== "pending") {
        throw new GatewayRetirementConflictError(
          `recovery operation ${operationId} ended with ${String(operation.status)}`,
        );
      }
    } else {
      transaction.create(operationRef, {
        kind: "recover-unreachable-disposable",
        status: "pending",
        origin: "automatic",
        createdBy: PLACEMENT_POLICY_ACTOR,
        createdAt: input.now(),
        startedAt: input.now(),
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
      });
    }
    transaction.set(gatewayRef, {
      desiredStatus: "paused",
      updatedAt: input.now(),
      updatedBy: `${PLACEMENT_POLICY_ACTOR}:${operationId}`,
    }, { merge: true });
  });
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
  await input.db.runTransaction(async (transaction) => {
    await exactRecoveryState(transaction);
    const operationSnapshot = await transaction.get(operationRef);
    const operation = operationSnapshot.data() as Record<string, unknown> | undefined;
    if (!operationSnapshot.exists || operation?.status !== "pending") {
      if (operation?.status === "succeeded") return;
      throw new GatewayRetirementConflictError(
        `recovery operation ${operationId} is unavailable`,
      );
    }
    transaction.update(operationRef, {
      status: "succeeded",
      completedAt: input.now(),
      recoveryReceipt: {
        schemaVersion: 1,
        observedAt: input.now(),
        pods: 0,
      },
    });
  });
  return { recovered: true, operationId };
}

function retirementAllocationMatches(
  root: Record<string, unknown>,
  request: RetireOwnedGatewayInput,
): boolean {
  const allocation = record(root.allocation);
  if (request.legacyNonDisposable) {
    return root.ownerUid === request.uid &&
      root.gatewayClass !== "shared" &&
      allocation?.kind !== DISPOSABLE_BUILDER_ALLOCATION_KIND;
  }
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
    allocationIdentityMatches;
}

async function assertRetirementAuthorityFence(input: {
  db: Firestore;
  transaction: Transaction;
  request: RetireOwnedGatewayInput;
}): Promise<void> {
  const { db, transaction, request } = input;
  if (!request.authoritativeGatewayId) return;
  const userRef = db.collection("users").doc(request.uid);
  const assignmentRef = db
    .collection(GATEWAYS_COLLECTION)
    .doc(request.authoritativeGatewayId)
    .collection("assignments")
    .doc(request.uid);
  const [userSnapshot, assignmentSnapshot] = await Promise.all([
    transaction.get(userRef),
    transaction.get(assignmentRef),
  ]);
  const userData = userSnapshot.data() as Record<string, unknown> | undefined;
  const assignment = assignmentSnapshot.data() as Record<string, unknown> | undefined;
  if (!retirementAuthorityFenceAllows({
    uid: request.uid,
    authoritativeGatewayId: request.authoritativeGatewayId,
    targetGatewayId: request.gatewayId,
    leaseId: request.leaseId,
    generation: request.generation,
    expectedLeaseStatus: request.authoritativeLeaseStatus ?? "returning",
    userExists: userSnapshot.exists,
    userData,
    assignmentExists: assignmentSnapshot.exists,
    assignmentData: assignment,
  })) {
    throw new GatewayRetirementConflictError(
      `Builder ${request.uid} is no longer authoritatively returned to ${request.authoritativeGatewayId}`,
    );
  }
}

async function assertLegacyRetirementAuthorityFence(input: {
  db: Firestore;
  transaction: Transaction;
  request: RetireOwnedGatewayInput;
  now: number;
}): Promise<void> {
  const { db, transaction, request, now } = input;
  if (!request.authoritativeGatewayId) {
    throw new GatewayRetirementConflictError(
      `legacy owner runtime ${request.gatewayId} has no shared authority target`,
    );
  }
  const userRef = db.collection("users").doc(request.uid);
  const assignmentRef = db
    .collection(GATEWAYS_COLLECTION)
    .doc(request.authoritativeGatewayId)
    .collection("assignments")
    .doc(request.uid);
  const [userSnapshot, assignmentSnapshot] = await Promise.all([
    transaction.get(userRef),
    transaction.get(assignmentRef),
  ]);
  const userData = userSnapshot.data() as Record<string, unknown> | undefined;
  const openclaw = record(record(userData?.provisioning)?.openclaw);
  const assignment = assignmentSnapshot.data() as Record<string, unknown> | undefined;
  if (
    !userSnapshot.exists ||
    openclaw?.gatewayId !== request.authoritativeGatewayId ||
    assignment?.uid !== request.uid ||
    assignment.gatewayId !== request.authoritativeGatewayId ||
    assignment.state !== "serving"
  ) {
    throw new GatewayRetirementConflictError(
      `Builder ${request.uid} is no longer authoritatively returned to ${request.authoritativeGatewayId}`,
    );
  }
  const lease = record(openclaw.activationLease);
  if (lease?.targetGatewayId === request.gatewayId) {
    transaction.update(userRef, {
      "provisioning.openclaw.activationLease": {
        ...lease,
        status: "parked",
        parkedAt: now,
      },
    });
  }
}

function zeroWorkloadRecoveryReceiptMatches(input: {
  recoveryExists: boolean;
  recovery: Record<string, unknown> | undefined;
  request: RetireOwnedGatewayInput;
}): boolean {
  const { recoveryExists, recovery, request } = input;
  const recoveryInput = record(recovery?.input);
  const receipt = record(recovery?.recoveryReceipt);
  return recoveryExists &&
    recovery?.kind === "recover-unreachable-disposable" &&
    recovery.status === "succeeded" &&
    recoveryInput?.uid === request.uid &&
    recoveryInput.gatewayId === request.gatewayId &&
    recoveryInput.leaseId === request.leaseId &&
    recoveryInput.generation === request.generation &&
    receipt?.schemaVersion === 1 &&
    receipt.pods === 0;
}

async function assertZeroWorkloadRecoveryReceipt(input: {
  db: Firestore;
  transaction: Transaction;
  request: RetireOwnedGatewayInput;
}): Promise<void> {
  const { db, transaction, request } = input;
  if (!request.zeroWorkloadRecoveryOperationId) return;
  const recoverySnapshot = await transaction.get(
    db
      .collection(DISPOSABLE_GATEWAY_RECOVERY_RECEIPTS_COLLECTION)
      .doc(request.zeroWorkloadRecoveryOperationId),
  );
  const recovery = recoverySnapshot.data() as Record<string, unknown> | undefined;
  if (!zeroWorkloadRecoveryReceiptMatches({
    recoveryExists: recoverySnapshot.exists,
    recovery,
    request,
  })) {
    throw new GatewayRetirementConflictError(
      `gateway ${request.gatewayId} zero-workload recovery receipt is unavailable`,
    );
  }
}

async function retireOwnedGatewayFirestore(
  input: FirestorePlacementPolicyInput,
  request: RetireOwnedGatewayInput,
): Promise<boolean> {
  const operationId = `placement-retire-${request.uid}-${request.gatewayId}`;
  const now = input.now();
  let telemetryObservedAfter: number | undefined;
  if (request.telemetryFenceOperationId !== undefined) {
    const returnOperationId = request.telemetryFenceOperationId;
    const returnSnapshot = await input.db
      .collection(GLM_OPERATIONS_COLLECTION)
      .doc(returnOperationId)
      .get();
    const completedAt = millis(returnSnapshot.data()?.completedAt);
    const terminalStatus = returnSnapshot.data()?.status;
    const expectedStatusMatches = request.telemetryFenceStatus === "terminal-failure"
      ? terminalStatus === "failed" || terminalStatus === ROLLED_BACK_STATUS
      : terminalStatus === "succeeded";
    if (!returnSnapshot.exists || !expectedStatusMatches || completedAt === null) {
      input.log(
        `[placement-policy] retirement blocked for ${request.gatewayId}: return operation ${returnOperationId} is incomplete`,
      );
      return false;
    }
    telemetryObservedAfter = completedAt;
  }
  try {
    await claimGatewayRetirementAtomic({
      db: input.db,
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
          reason: request.legacyNonDisposable
            ? "legacy-owner-runtime-removed"
            : "builder-activity-ended",
        },
        steps: [],
        gatewayId: request.gatewayId,
      },
      now,
      updatedBy: PLACEMENT_POLICY_ACTOR,
      ...(telemetryObservedAfter === undefined ? {} : { telemetryObservedAfter }),
      claimGuard: async ({ transaction, root }) => {
        const rootRecord = root as unknown as Record<string, unknown>;
        await assertAutomaticPlacementMutationAllowed({
          db: input.db,
          transaction,
          uid: request.uid,
          gatewayIds: [request.gatewayId],
          action: `retirement ${request.gatewayId}`,
        });
        if (!retirementAllocationMatches(rootRecord, request)) {
          throw new GatewayRetirementConflictError(
            `gateway ${request.gatewayId} no longer matches disposable allocation for ${request.uid}`,
          );
        }
        if (request.legacyNonDisposable) {
          await assertLegacyRetirementAuthorityFence({
            db: input.db,
            transaction,
            request,
            now,
          });
        } else {
          await assertRetirementAuthorityFence({
            db: input.db,
            transaction,
            request,
          });
        }
        await assertZeroWorkloadRecoveryReceipt({
          db: input.db,
          transaction,
          request,
        });
      },
    });
    return true;
  } catch (error) {
    if (!(error instanceof GatewayRetirementConflictError)) throw error;
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
  userExists: boolean;
  userData: Record<string, unknown> | undefined;
  assignmentExists: boolean;
  assignmentData: Record<string, unknown> | undefined;
}

function retirementLeaseFenceAllows(
  input: RetirementAuthorityFenceInput,
  openclaw: Record<string, unknown> | null,
  lease: Record<string, unknown> | null,
): boolean {
  return input.userExists &&
    openclaw?.gatewayId === input.authoritativeGatewayId &&
    lease?.leaseId === input.leaseId &&
    lease?.generation === input.generation &&
    lease?.status === input.expectedLeaseStatus &&
    lease?.targetGatewayId === input.targetGatewayId;
}

function retirementAssignmentFenceAllows(
  input: RetirementAuthorityFenceInput,
): boolean {
  return input.assignmentExists &&
    input.assignmentData?.uid === input.uid &&
    input.assignmentData.gatewayId === input.authoritativeGatewayId &&
    input.assignmentData.state === "serving";
}

export function retirementAuthorityFenceAllows(
  input: RetirementAuthorityFenceInput,
): boolean {
  const openclaw = record(record(input.userData?.provisioning)?.openclaw);
  const lease = record(openclaw?.activationLease);
  return retirementLeaseFenceAllows(input, openclaw, lease) &&
    retirementAssignmentFenceAllows(input);
}

async function deleteRetiredDisposableGatewayFirestore(
  input: FirestorePlacementPolicyInput,
  request: DeleteRetiredDisposableGatewayInput,
): Promise<boolean> {
  const operationId = `placement-retire-${request.ownerUid}-${request.gatewayId}`;
  const gatewayRef = input.db.collection(GATEWAYS_COLLECTION).doc(request.gatewayId);
  const operationRef = input.db.collection(GLM_OPERATIONS_COLLECTION).doc(operationId);
  const ownerRef = input.db.collection("users").doc(request.ownerUid);
  const deletable = await input.db.runTransaction(async (transaction) => {
    const [rootSnapshot, operationSnapshot, ownerSnapshot] = await Promise.all([
      transaction.get(gatewayRef),
      transaction.get(operationRef),
      transaction.get(ownerRef),
    ]);
    const root = projectGatewayDesiredRootForGateway(
      rootSnapshot.exists ? rootSnapshot.data() : undefined,
      request.gatewayId,
    );
    const claim = record(
      (rootSnapshot.data() as Record<string, unknown> | undefined)?.retirementClaim,
    );
    const operation = operationSnapshot.data() as Record<string, unknown> | undefined;
    // A user mirror still pointing at the runtime would trip the reconciler's
    // missing-gateway guard after deletion — the record must outlive the pointer.
    const ownerMirrorGatewayId = ownerSnapshot.exists
      ? currentGatewayId(ownerSnapshot.data() as Record<string, unknown>)
      : null;
    return [
      root !== null,
      root?.desiredStatus === "retired",
      root?.ownerUid === request.ownerUid,
      root?.allocation?.kind === DISPOSABLE_BUILDER_ALLOCATION_KIND,
      !isOperatorManaged(root?.managedBy),
      claim?.operationId === operationId,
      operationSnapshot.exists,
      operation?.kind === "retire-gateway",
      operation?.status === "succeeded",
      ownerMirrorGatewayId !== request.gatewayId,
    ].every(Boolean);
  });
  if (!deletable) return false;
  // Deletion order makes every partial failure re-drivable: auxiliary docs
  // first (idempotent), the root next (its claim + the retire op are the
  // re-verification fence), and the retire op only once nothing else remains.
  await Promise.all([
    input.db.collection(GLM_OPERATIONS_COLLECTION).doc(`builder-activate-${request.gatewayId}`).delete(),
    input.db.collection(GLM_OPERATIONS_COLLECTION).doc(`builder-return-${request.gatewayId}`).delete(),
    input.db.collection(GLM_OPERATIONS_COLLECTION).doc(`builder-recover-${request.gatewayId}`).delete(),
    input.db
      .collection(DISPOSABLE_GATEWAY_RECOVERY_RECEIPTS_COLLECTION)
      .doc(`builder-recover-${request.gatewayId}`)
      .delete(),
  ]);
  await input.db.recursiveDelete(gatewayRef);
  await operationRef.delete();
  input.log(
    `[placement-policy] deleted retired disposable runtime ${request.gatewayId} for ${request.ownerUid}`,
  );
  return true;
}

export function createFirestorePlacementPolicyReconcilerDeps(
  input: FirestorePlacementPolicyInput,
): PlacementPolicyReconcilerDeps {
  return {
    now: input.now,
    log: input.log,
    maintenanceGate: input.maintenanceGate,
    readSnapshot: () => readPlacementPolicySnapshot(input),
    assignInitialPlacement: (request) => assignInitialPlacementFirestore(input, request),
    allocateDisposableGateway: (request) => allocateDisposableGatewayFirestore(input, request),
    advanceActivationLease: (request) => advanceActivationLeaseFirestore(input, request),
    completeActivationLease: (request) => completeActivationLeaseFirestore(input, request),
    failActivationLease: (request) => failActivationLeaseFirestore(input, request),
    recoverUnavailableGateway: (request) => commitUnavailableGatewayRecoveryAtomic({
      db: input.db as unknown as FleetStateFirestore,
      now: () => new Date(input.now()),
      serverTimestamp: () => FieldValue.serverTimestamp(),
    }, {
      ...request,
      validateTarget: unavailableRecoveryTargetFence(input, request),
    }),
    supersedeRollingSharedGateway: (request) => supersedeRollingSharedGatewayRoll({
      db: input.db,
      now: input.now,
    }, request),
    recoverUnreachableDisposableGateway: (request) =>
      recoverUnreachableDisposableGatewayFirestore(input, request),
    readBuilderActivity: (request) => readBuilderActivityFirestore(input, request),
    readShellsAtRisk: (request) => readShellsAtRiskFirestore(input, request),
    publishIdleSleep: (request) => publishIdleSleepFirestore(input, request),
    sendRuntimeSleepWarning: (request) => input.sendRuntimeSleepWarning(request),
    enqueueMigration: (request) => enqueuePlacementMigration(input, request),
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

function attemptFencedDeps(
  deps: PlacementPolicyReconcilerDeps,
  attempt: PlacementPolicyAttempt,
): PlacementPolicyReconcilerDeps {
  return {
    ...deps,
    publishIdleSleep: async (input) => {
      if (attempt.abandoned) {
        deps.log(`[placement-policy] dropped idle-sleep publish from an abandoned pass uid=${input.uid}`);
        return;
      }
      await deps.publishIdleSleep(input);
    },
    sendRuntimeSleepWarning: async (input) => {
      if (attempt.abandoned) {
        deps.log(`[placement-policy] dropped sleep warning from an abandoned pass uid=${input.uid}`);
        return;
      }
      await deps.sendRuntimeSleepWarning(input);
    },
  };
}

export function startPlacementPolicyReconciler(
  deps: PlacementPolicyReconcilerDeps,
  intervalMs = PLACEMENT_POLICY_RECONCILE_MS_DEFAULT,
  options?: {
    passDeadlineMs?: number;
    maxAbandonedPasses?: number;
    runPass?: (deps: PlacementPolicyReconcilerDeps) => Promise<unknown>;
  },
): () => void {
  if (intervalMs <= 0) return () => undefined;
  const passDeadlineMs = options?.passDeadlineMs ?? PLACEMENT_POLICY_PASS_DEADLINE_MS;
  const maxAbandonedPasses = options?.maxAbandonedPasses ?? PLACEMENT_POLICY_MAX_ABANDONED_PASSES;
  const runPass = options?.runPass ?? reconcilePlacementPolicyOnce;
  let stopped = false;
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
    const attempt: PlacementPolicyAttempt = { startedAt: deps.now(), abandoned: false };
    current = attempt;
    try {
      await runPass(attemptFencedDeps(deps, attempt));
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
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
