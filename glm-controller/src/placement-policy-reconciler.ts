import type {
  Firestore,
  QueryDocumentSnapshot,
  Transaction,
} from "firebase-admin/firestore";

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
  resolveUserGatewayShellState,
} from "@octogee/shared/types/glm";
import {
  commitPlacementAtomic,
  isGatewayRuntimeDoc,
  projectGatewayDesiredRootForGateway,
  type PlacementFirestore,
} from "@octogee/shared/types/gateway-releases";
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
  readBuilderActivityFirestore,
} from "./disposable-gateway-lifecycle.js";

export const PLACEMENT_POLICY_RECONCILE_MS_DEFAULT = 15_000;
export const DISPOSABLE_GATEWAY_PROVISION_TIMEOUT_MS = 10 * 60_000;
export const DISPOSABLE_GATEWAY_RECOVERY_RECEIPTS_COLLECTION =
  "gatewayRecoveryReceipts";
const PLACEMENT_POLICY_ACTOR = "glm-controller-placement-policy";

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

export interface PlacementPolicyAdmission {
  schemaVersion: 1;
  reportId: string;
  classifiedAt: number;
  legacyGatewayIds: string[];
  staticGatewayIds: string[];
}

export interface PlacementPolicySnapshot {
  defaultGatewayId: string;
  admission: PlacementPolicyAdmission | null;
  idleMs: number;
  liveRunBuilderSlugs: string[];
  users: PlacementPolicyUser[];
  gateways: ContinuousPlacementOwnedGateway[];
  activeMigrations: PlacementPolicyMigration[];
}

export interface EnqueuePlacementMigrationInput {
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  source: "continuous-placement-policy" | "builder-activation-lease";
  operationId?: string;
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
}

export interface BuilderRuntimeActivity {
  lastActiveAt: number | null;
  liveRun: boolean;
  liveShell: boolean;
}

export interface RetireOwnedGatewayInput {
  uid: string;
  builderSlug: string;
  gatewayId: string;
  leaseId?: string;
  generation?: number;
  telemetryFenceOperationId?: string;
  telemetryFenceStatus?: "succeeded" | "terminal-failure";
  authoritativeGatewayId?: string;
  authoritativeLeaseStatus?: "provisioning" | "activating" | "returning";
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
  readSnapshot(): Promise<PlacementPolicySnapshot>;
  assignInitialPlacement(input: AssignInitialPlacementInput): Promise<void>;
  allocateDisposableGateway(input: AllocateDisposableGatewayInput): Promise<string>;
  advanceActivationLease(input: AdvanceActivationLeaseInput): Promise<void>;
  completeActivationLease(input: CompleteActivationLeaseInput): Promise<void>;
  failActivationLease(input: FailActivationLeaseInput): Promise<void>;
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
  enqueueMigration(input: EnqueuePlacementMigrationInput): Promise<string>;
  retireOwnedGateway(input: RetireOwnedGatewayInput): Promise<boolean>;
}

export interface PlacementPolicyReconcileResult {
  assigned: number;
  enqueued: number;
  adopted: number;
  retired: number;
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
  gateways: Map<string, ContinuousPlacementOwnedGateway>;
  migrations: Map<string, PlacementPolicyMigration>;
  operations: Map<string, PlacementPolicyMigration>;
  result: PlacementPolicyReconcileResult;
  mutations: number;
  mutationLimitLogged: boolean;
}

const PLACEMENT_POLICY_MUTATION_LIMIT = 10;

function claimPlacementMutation(context: PlacementPolicyReconcileContext): boolean {
  if (context.mutations < PLACEMENT_POLICY_MUTATION_LIMIT) {
    context.mutations += 1;
    return true;
  }
  if (!context.mutationLimitLogged) {
    context.deps.log(
      `[placement-policy] mutation limit ${PLACEMENT_POLICY_MUTATION_LIMIT} reached`,
    );
    context.mutationLimitLogged = true;
  }
  return false;
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

async function retireUnentitledOwnedGateways(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
): Promise<void> {
  const ownedGateways = context.state.gateways.filter(
    (gateway) => gateway.ownerUid === user.uid &&
      gateway.gatewayClass !== "shared" &&
      gateway.disposable === true &&
      gateway.desiredStatus !== "retired",
  );
  for (const gateway of ownedGateways) {
    if (!claimPlacementMutation(context)) return;
    const retired = await context.deps.retireOwnedGateway({
      uid: user.uid,
      builderSlug,
      gatewayId: gateway.gatewayId,
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
  if (!claimPlacementMutation(context)) return;
  const targetGateway = context.gateways.get(placement.targetGatewayId);
  if (!targetGateway) throw new Error(`placement target ${placement.targetGatewayId} is missing`);
  await context.deps.assignInitialPlacement({
    uid: user.uid,
    builderSlug,
    gatewayId: placement.targetGatewayId,
    gateway: targetGateway,
  });
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
    operation.source === "builder-activation-lease";
}

function disposableTargetIdentityMatchesLease(
  gateway: ContinuousPlacementOwnedGateway,
  user: PlacementPolicyUser,
  lease: BuilderActivationLease,
): boolean {
  const allocation = gateway.allocation;
  return gateway.gatewayClass === "operator" &&
    gateway.ownerUid === user.uid &&
    gateway.disposable === true &&
    allocation?.kind === "disposable-builder" &&
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

async function recoverAndRetireUnreachableTarget(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  lease: BuilderActivationLease,
  target: ContinuousPlacementOwnedGateway,
): Promise<string | null> {
  if (!claimPlacementMutation(context)) return null;
  const recovery = await context.deps.recoverUnreachableDisposableGateway({
    uid: user.uid,
    builderSlug,
    gatewayId: target.gatewayId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    authoritativeGatewayId: context.state.defaultGatewayId,
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
    authoritativeGatewayId: context.state.defaultGatewayId,
    authoritativeLeaseStatus:
      lease.status === "activating" ? "activating"
      : lease.status === "returning" ? "returning"
      : "provisioning",
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
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
  lease: BuilderActivationLease,
  target: ContinuousPlacementOwnedGateway,
): Promise<boolean> {
  if (target.desiredStatus === "running" && target.ready) return false;
  if (target.desiredStatus !== "running" && target.desiredStatus !== "paused") return false;
  if (current !== context.state.defaultGatewayId) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "unreachable-target-authority-fence",
      reason: `Builder is assigned to ${current ?? "missing"}, not ${context.state.defaultGatewayId}`,
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
  if (!claimPlacementMutation(context)) return;
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
  if (await cleanupFailedActivation(context, user, builderSlug, current, lease, target)) return;
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
  const authorized = accountAllowsInteractiveAccess(user.data) &&
    resolveBuilderTier(user.data, new Date(context.deps.now())) !== null;
  if (!authorized) {
    const retired = target.ready
      ? await context.deps.retireOwnedGateway({
          uid: user.uid,
          builderSlug,
          gatewayId: target.gatewayId,
          leaseId: lease.leaseId,
          generation: lease.generation,
          authoritativeGatewayId: context.state.defaultGatewayId,
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
      return;
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
    return;
  }
  if (
    await cleanupUnreachableProvisioningTarget(
      context,
      user,
      builderSlug,
      current,
      lease,
      target,
    )
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
  const active = context.migrations.get(user.uid);
  if (active) {
    if (!activationMigrationMatches(active, {
      id: `builder-activate-${targetGatewayId}`,
      uid: user.uid,
      builderSlug,
      fromGatewayId: current ?? context.state.defaultGatewayId,
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
  if (!claimPlacementMutation(context)) return;
  const operationId = await context.deps.enqueueMigration({
    uid: user.uid,
    builderSlug,
    fromGatewayId: current ?? context.state.defaultGatewayId,
    toGatewayId: targetGatewayId!,
    source: "builder-activation-lease",
    operationId: `builder-activate-${targetGatewayId}`,
  });
  context.result.enqueued += 1;
  await context.deps.advanceActivationLease({
    uid: user.uid,
    leaseId: lease.leaseId,
    generation: lease.generation,
    fromStatus: "provisioning",
    toStatus: "activating",
    operationId,
  });
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
  if (await cleanupFailedActivation(context, user, builderSlug, current, lease, target)) return;
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
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
  lease: BuilderActivationLease,
  target: ContinuousPlacementOwnedGateway,
): Promise<boolean> {
  const operationId = `builder-activate-${target.gatewayId}`;
  const operation = context.operations.get(operationId);
  if (!operation || (operation.status !== "failed" && operation.status !== "rolled-back")) {
    return false;
  }
  if (target.desiredStatus !== "retired") {
    const recoveredRetirement =
      current === context.state.defaultGatewayId && !target.ready;
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
      toGatewayId: context.state.defaultGatewayId,
    })) {
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
  if (!claimPlacementMutation(context)) return;
  const operationId = await context.deps.enqueueMigration({
    uid: user.uid,
    builderSlug,
    fromGatewayId: targetGatewayId,
    toGatewayId: context.state.defaultGatewayId,
    source: "builder-activation-lease",
    operationId: `builder-return-${targetGatewayId}`,
  });
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

async function reconcileActiveLease(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
  lease: BuilderActivationLease,
): Promise<void> {
  const targetGatewayId = lease.targetGatewayId;
  const target = targetGatewayId ? context.gateways.get(targetGatewayId) : null;
  const returnOperationId = targetGatewayId
    ? `builder-return-${targetGatewayId}`
    : null;
  const completedReturn = returnOperationId
    ? context.operations.get(returnOperationId)
    : undefined;
  if (
    current === context.state.defaultGatewayId &&
    target &&
    completedReturn?.status === "succeeded" &&
    disposableTargetIdentityMatchesLease(target, user, lease) &&
    activationMigrationMatches(completedReturn, {
      id: returnOperationId!,
      uid: user.uid,
      builderSlug,
      fromGatewayId: target.gatewayId,
      toGatewayId: context.state.defaultGatewayId,
    })
  ) {
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
  if (!returnRequested && context.state.idleMs <= 0) return;
  const activity = await context.deps.readBuilderActivity({
    uid: user.uid,
    builderSlug,
    gatewayId: targetGatewayId!,
    userData: user.data,
    liveRun: context.state.liveRunBuilderSlugs.includes(builderSlug),
  });
  if (
    activity.liveRun ||
    activity.liveShell ||
    (!returnRequested && (
      activity.lastActiveAt === null ||
      context.deps.now() - activity.lastActiveAt < context.state.idleMs
    ))
  ) {
    return;
  }
  await queueLeaseReturn(context, user, builderSlug, lease);
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
  if (current === targetGatewayId) {
    const returnOperation = context.operations.get(`builder-return-${targetGatewayId}`);
    if (
      returnOperation?.status === "failed" ||
      returnOperation?.status === "rolled-back"
    ) {
      blockPlacement(context, {
        uid: user.uid,
        lease,
        code: "return-operation-failed",
        reason: `return operation ended with ${returnOperation.status}: ${returnOperation.error ?? "unknown error"}`,
      });
      return;
    }
    const active = context.migrations.get(user.uid);
    if (active) {
      if (activationMigrationMatches(active, {
        id: `builder-return-${targetGatewayId}`,
        uid: user.uid,
        builderSlug,
        fromGatewayId: targetGatewayId,
        toGatewayId: context.state.defaultGatewayId,
      })) {
        context.result.adopted += 1;
      } else {
        blockPlacement(context, {
          uid: user.uid,
          lease,
          code: "return-migration-conflict",
          reason: `active migration ${active.id} does not match return demand`,
        });
      }
      return;
    }
    if (!claimPlacementMutation(context)) return;
    await context.deps.enqueueMigration({
      uid: user.uid,
      builderSlug,
      fromGatewayId: targetGatewayId,
      toGatewayId: context.state.defaultGatewayId,
      source: "builder-activation-lease",
      operationId: `builder-return-${targetGatewayId}`,
    });
    context.result.enqueued += 1;
    return;
  }
  if (current !== context.state.defaultGatewayId) {
    blockPlacement(context, {
      uid: user.uid,
      lease,
      code: "return-authority-fence",
      reason: `Builder is assigned to ${current ?? "missing"}, not ${context.state.defaultGatewayId}`,
    });
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
  if (!target.ready || target.desiredStatus === "paused") {
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
    authoritativeGatewayId: context.state.defaultGatewayId,
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

async function reconcileEligibleBuilder(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
): Promise<void> {
  const current = currentGatewayId(user.data);
  const currentGateway = current ? context.gateways.get(current) : null;
  if (
    currentGateway &&
    currentGateway.gatewayClass !== "shared" &&
    currentGateway.disposable !== true
  ) {
    blockPlacement(context, {
      uid: user.uid,
      code: "legacy-gateway-operator-migration",
      reason: `legacy gateway ${currentGateway.gatewayId} requires operator migration`,
    });
    return;
  }
  if (await reconcileActivationLease(context, user, builderSlug, current)) return;
  const entitledOwned = resolveLiveActivationTargetGatewayId({
    userData: user.data,
    now: new Date(context.deps.now()),
  });
  const placement = resolveContinuousBuilderPlacement({
    uid: user.uid,
    userData: user.data,
    currentGatewayId: current,
    defaultGatewayId: context.state.defaultGatewayId,
    ownedGateway: entitledOwned ? context.gateways.get(entitledOwned) ?? null : null,
    now: new Date(context.deps.now()),
  });
  if (!current) {
    await assignMissingPlacement(context, user, builderSlug, placement);
    return;
  }
  if (placement.targetGatewayId === current) {
    if (placement.ownedGatewayId === null && current === context.state.defaultGatewayId) {
      await retireUnentitledOwnedGateways(context, user, builderSlug);
    }
    return;
  }
  if (adoptActiveMigration(context, user.uid, placement.targetGatewayId)) return;
  if (!claimPlacementMutation(context)) return;
  await context.deps.enqueueMigration({
    uid: user.uid,
    builderSlug,
    fromGatewayId: current,
    toGatewayId: placement.targetGatewayId,
    source: "continuous-placement-policy",
  });
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

export async function reconcilePlacementPolicyOnce(
  deps: PlacementPolicyReconcilerDeps,
): Promise<PlacementPolicyReconcileResult> {
  const state = await deps.readSnapshot();
  if (!state.defaultGatewayId) throw new Error("placement policy default gateway is missing");
  const result: PlacementPolicyReconcileResult = {
    assigned: 0,
    enqueued: 0,
    adopted: 0,
    retired: 0,
    blocked: 0,
  };
  if (!state.admission) {
    deps.log("[placement-policy] disabled: operator classification receipt is missing");
    return result;
  }
  const retainedNamedGatewayIds = state.gateways
    .filter(
      (gateway) =>
        gateway.gatewayClass !== "shared" &&
        gateway.disposable !== true &&
        gateway.desiredStatus !== "retired",
    )
    .map((gateway) => gateway.gatewayId)
    .sort();
  const approvedStaticGatewayIds = new Set(state.admission.staticGatewayIds);
  const unapprovedNamedGatewayIds = retainedNamedGatewayIds.filter(
    (gatewayId) => !approvedStaticGatewayIds.has(gatewayId),
  );
  if (
    state.admission.legacyGatewayIds.length > 0 ||
    unapprovedNamedGatewayIds.length > 0
  ) {
    deps.log(
      `[placement-policy] disabled: retained named gateways ${unapprovedNamedGatewayIds.join(",")}`,
    );
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

  const context = {
    deps,
    state,
    gateways,
    migrations,
    operations,
    result,
    mutations: 0,
    mutationLimitLogged: false,
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
  return result;
}

function docsById(docs: QueryDocumentSnapshot[]): Map<string, Record<string, unknown>> {
  return new Map(docs.map((doc) => [doc.id, doc.data() as Record<string, unknown>]));
}

function activeMigration(doc: QueryDocumentSnapshot): PlacementPolicyMigration | null {
  const data = doc.data() as Record<string, unknown>;
  if (data.kind !== "migrate-customer") return null;
  const input = data.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const uid = nonEmptyString((input as Record<string, unknown>).uid) ?? nonEmptyString(data.inputUid);
  const builderSlug = nonEmptyString((input as Record<string, unknown>).builderSlug);
  const fromGatewayId = nonEmptyString((input as Record<string, unknown>).fromGatewayId);
  const toGatewayId = nonEmptyString((input as Record<string, unknown>).toGatewayId);
  const source = (input as Record<string, unknown>).source;
  const status = data.status;
  if (
    status !== "pending" &&
    status !== "running" &&
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "rolled-back"
  ) {
    return null;
  }
  return uid &&
      builderSlug &&
      fromGatewayId &&
      toGatewayId &&
      (source === "continuous-placement-policy" || source === "builder-activation-lease")
    ? {
        id: doc.id,
        uid,
        builderSlug,
        fromGatewayId,
        toGatewayId,
        source,
        status,
        ...(typeof data.error === "string" ? { error: data.error } : {}),
      }
    : null;
}

function placementPolicyAdmission(value: unknown): PlacementPolicyAdmission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const reportId = nonEmptyString(raw.reportId);
  if (
    raw.schemaVersion !== 1 ||
    !reportId ||
    typeof raw.classifiedAt !== "number" ||
    !Number.isFinite(raw.classifiedAt) ||
    raw.classifiedAt <= 0 ||
    !Array.isArray(raw.legacyGatewayIds) ||
    raw.legacyGatewayIds.some((gatewayId) => !nonEmptyString(gatewayId)) ||
    new Set(raw.legacyGatewayIds).size !== raw.legacyGatewayIds.length ||
    !Array.isArray(raw.staticGatewayIds) ||
    raw.staticGatewayIds.some((gatewayId) => !nonEmptyString(gatewayId)) ||
    new Set(raw.staticGatewayIds).size !== raw.staticGatewayIds.length
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    reportId,
    classifiedAt: raw.classifiedAt,
    legacyGatewayIds: [...raw.legacyGatewayIds].sort() as string[],
    staticGatewayIds: [...raw.staticGatewayIds].sort() as string[],
  };
}

interface FirestorePlacementPolicyInput {
  db: Firestore;
  namespace: string;
  idleMs: number;
  now(): number;
  log(message: string): void;
  ensureAuthSecret(input: { namespace: string; gatewayId: string }): Promise<unknown>;
  readGatewayPodDiagnostics(input: {
    namespace: string;
    gatewayId: string;
  }): Promise<{
    status: string;
    totalPods: number;
    error?: string;
  }>;
}

async function readPlacementPolicySnapshot(
  db: Firestore,
  fallbackIdleMs: number,
  now: number,
): Promise<PlacementPolicySnapshot> {
  const [configSnap, usersSnap, gatewaysSnap, runtimeSnap, opsSnap, liveRunsSnap] =
    await Promise.all([
      db.doc("config/orchestrator").get(),
      db.collection("users").get(),
      db.collection(GATEWAYS_COLLECTION).get(),
      db.collection(GLM_GATEWAYS_COLLECTION).get(),
      db.collection(GLM_OPERATIONS_COLLECTION)
        .where("status", "in", ["pending", "running", "failed", "rolled-back"])
        .get(),
      db.collectionGroup("liveRuns").where("expiresAt", ">", now).get(),
    ]);
  const defaultGatewayId = nonEmptyString(configSnap.data()?.defaultGatewayId);
  if (!defaultGatewayId) throw new Error("config/orchestrator.defaultGatewayId is missing");
  const completedReturnRefs = usersSnap.docs.flatMap((doc) => {
    const userData = doc.data() as Record<string, unknown>;
    const lease = builderActivationLease(userData);
    return (
      lease?.status === "active" &&
      lease.targetGatewayId &&
      currentGatewayId(userData) === defaultGatewayId
    )
      ? [
          db.collection(GLM_OPERATIONS_COLLECTION)
            .doc(`builder-return-${lease.targetGatewayId}`),
        ]
      : [];
  });
  const completedReturnSnapshots = completedReturnRefs.length > 0
    ? await db.getAll(...completedReturnRefs)
    : [];
  const admission = placementPolicyAdmission(
    configSnap.data()?.disposableGatewayPlacementAdmission,
  );
  const configuredIdleMs = configSnap.data()?.disposableGatewayIdleMs;
  const idleMs = Number.isSafeInteger(configuredIdleMs) && configuredIdleMs >= 0
    ? configuredIdleMs
    : fallbackIdleMs;
  const runtimes = docsById(runtimeSnap.docs);
  const gateways = gatewaysSnap.docs.flatMap((doc) => {
    const root = projectGatewayDesiredRootForGateway(doc.data(), doc.id);
    if (!root) return [];
    const runtime = runtimes.get(doc.id);
    const heartbeatAt = isGatewayRuntimeDoc(runtime)
      ? millis(runtime.heartbeat.lastHeartbeatAt)
      : null;
    return [{
      gatewayId: doc.id,
      gatewayClass: root.gatewayClass,
      ownerUid: root.ownerUid,
      desiredStatus: root.desiredStatus,
      disposable: root.allocation?.kind === "disposable-builder",
      allocation: root.allocation ?? null,
      ready: isGatewayRuntimeDoc(runtime) &&
        runtime.gatewayId === doc.id &&
        root.liveRelease !== null &&
        root.desiredRelease === root.liveRelease &&
        runtime.release === root.liveRelease &&
        runtime.lifecycle === "serving" &&
        runtime.heartbeat.status === "ready" &&
        heartbeatAt !== null &&
        now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS,
    }];
  });
  const defaultGateway = gateways.find((gateway) => gateway.gatewayId === defaultGatewayId);
  if (
    !defaultGateway ||
    defaultGateway.gatewayClass !== "shared" ||
    defaultGateway.desiredStatus !== "running"
  ) {
    throw new Error(`configured default gateway ${defaultGatewayId} is unavailable`);
  }
  return {
    defaultGatewayId,
    admission,
    idleMs,
    liveRunBuilderSlugs: [...new Set(liveRunsSnap.docs.flatMap((doc) => {
      const parts = doc.ref.path.split("/");
      return parts[0] === "workspaces" && parts[1] ? [parts[1]] : [];
    }))],
    users: usersSnap.docs.map((doc) => ({ uid: doc.id, data: doc.data() as Record<string, unknown> })),
    gateways,
    activeMigrations: [
      ...opsSnap.docs,
      ...completedReturnSnapshots.filter(
        (snapshot) => snapshot.exists && snapshot.data()?.status === "succeeded",
      ),
    ].flatMap((doc) => activeMigration(doc as QueryDocumentSnapshot) ?? []),
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

async function enqueuePlacementMigration(
  input: FirestorePlacementPolicyInput,
  request: EnqueuePlacementMigrationInput,
): Promise<string> {
  const ref = request.operationId
    ? input.db.collection(GLM_OPERATIONS_COLLECTION).doc(request.operationId)
    : input.db.collection(GLM_OPERATIONS_COLLECTION).doc();
  const now = input.now();
  const operation = {
    kind: "migrate-customer",
    status: "pending",
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
  if (!request.operationId) {
    await ref.set(operation);
    return ref.id;
  }
  await input.db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) {
      const data = existing.data() as Record<string, unknown>;
      const operationInput = record(data.input);
      if (
        data.kind !== "migrate-customer" ||
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
        throw new Error(`migration operation ${ref.id} ended with status ${String(data.status)}`);
      }
      return;
    }
    transaction.create(ref, operation);
  });
  return ref.id;
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
    const allocation = root?.allocation;
    const userData = userSnapshot.data() as Record<string, unknown> | undefined;
    const assignment = assignmentSnapshot.data() as Record<string, unknown> | undefined;
    if (
      !root ||
      root.ownerUid !== request.uid ||
      root.gatewayClass === "shared" ||
      root.desiredStatus === "retired" ||
      allocation?.kind !== "disposable-builder" ||
      allocation.claimedByUid !== request.uid ||
      allocation.leaseId !== request.leaseId ||
      allocation.generation !== request.generation
    ) {
      throw new GatewayRetirementConflictError(
        `gateway ${request.gatewayId} no longer matches unreachable recovery demand`,
      );
    }
    const runtime = runtimeSnapshot.data() as Record<string, unknown> | undefined;
    const heartbeatAt = isGatewayRuntimeDoc(runtime)
      ? millis(runtime.heartbeat.lastHeartbeatAt)
      : null;
    if (
      root.desiredStatus === "running" &&
      isGatewayRuntimeDoc(runtime) &&
      runtime.gatewayId === request.gatewayId &&
      root.liveRelease !== null &&
      runtime.release === root.liveRelease &&
      runtime.lifecycle === "serving" &&
      runtime.heartbeat.status === "ready" &&
      heartbeatAt !== null &&
      input.now() - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS
    ) {
      throw new GatewayRetirementConflictError(
        `gateway ${request.gatewayId} became ready before recovery`,
      );
    }
    if (
      currentGatewayId(userData ?? {}) !== request.authoritativeGatewayId ||
      !assignmentSnapshot.exists ||
      assignment?.uid !== request.uid ||
      assignment.gatewayId !== request.authoritativeGatewayId ||
      assignment.state !== "serving"
    ) {
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
    input.log(
      `[placement-policy] recovery ${operationId} waiting for pod absence; status=${diagnostics.status} pods=${diagnostics.totalPods}${diagnostics.error ? ` error=${diagnostics.error}` : ""}`,
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
      ? terminalStatus === "failed" || terminalStatus === "rolled-back"
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
        createdBy: PLACEMENT_POLICY_ACTOR,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        input: {
          gatewayId: request.gatewayId,
          uid: request.uid,
          builderSlug: request.builderSlug,
          reason: "dedicated-entitlement-ended",
        },
        steps: [],
        gatewayId: request.gatewayId,
      },
      now,
      updatedBy: PLACEMENT_POLICY_ACTOR,
      ...(telemetryObservedAfter === undefined ? {} : { telemetryObservedAfter }),
      claimGuard: async ({ transaction, root }) => {
        const rootRecord = root as unknown as Record<string, unknown>;
        const allocation = rootRecord.allocation as Record<string, unknown> | null | undefined;
        const allocationMismatch = request.leaseId !== undefined &&
          (
            allocation?.kind !== "disposable-builder" ||
            allocation.claimedByUid !== request.uid ||
            allocation.leaseId !== request.leaseId ||
            allocation.generation !== request.generation
          );
        if (
          rootRecord.ownerUid !== request.uid ||
          rootRecord.gatewayClass === "shared" ||
          allocation?.kind !== "disposable-builder" ||
          allocationMismatch
        ) {
          throw new GatewayRetirementConflictError(
            `gateway ${request.gatewayId} no longer matches disposable allocation for ${request.uid}`,
          );
        }
        if (request.authoritativeGatewayId) {
          const userRef = input.db.collection("users").doc(request.uid);
          const assignmentRef = input.db
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
        if (request.zeroWorkloadRecoveryOperationId) {
          const recoverySnapshot = await transaction.get(
            input.db
              .collection(DISPOSABLE_GATEWAY_RECOVERY_RECEIPTS_COLLECTION)
              .doc(request.zeroWorkloadRecoveryOperationId),
          );
          const recovery = recoverySnapshot.data() as Record<string, unknown> | undefined;
          const recoveryInput = record(recovery?.input);
          const receipt = record(recovery?.recoveryReceipt);
          if (
            !recoverySnapshot.exists ||
            recovery?.kind !== "recover-unreachable-disposable" ||
            recovery.status !== "succeeded" ||
            recoveryInput?.uid !== request.uid ||
            recoveryInput.gatewayId !== request.gatewayId ||
            recoveryInput.leaseId !== request.leaseId ||
            recoveryInput.generation !== request.generation ||
            receipt?.schemaVersion !== 1 ||
            receipt.pods !== 0
          ) {
            throw new GatewayRetirementConflictError(
              `gateway ${request.gatewayId} zero-workload recovery receipt is unavailable`,
            );
          }
        }
      },
    });
    return true;
  } catch (error) {
    if (!(error instanceof GatewayRetirementConflictError)) throw error;
    input.log(`[placement-policy] retirement blocked for ${request.gatewayId}: ${error.message}`);
    return false;
  }
}

export function retirementAuthorityFenceAllows(input: {
  uid: string;
  authoritativeGatewayId: string;
  targetGatewayId: string;
  leaseId: string | undefined;
  generation: number | undefined;
  expectedLeaseStatus: "provisioning" | "activating" | "returning";
  userExists: boolean;
  userData: Record<string, unknown> | undefined;
  assignmentExists: boolean;
  assignmentData: Record<string, unknown> | undefined;
}): boolean {
  const openclaw = record(record(input.userData?.provisioning)?.openclaw);
  const lease = record(openclaw?.activationLease);
  return input.userExists &&
    openclaw?.gatewayId === input.authoritativeGatewayId &&
    lease?.leaseId === input.leaseId &&
    lease?.generation === input.generation &&
    lease?.status === input.expectedLeaseStatus &&
    lease?.targetGatewayId === input.targetGatewayId &&
    input.assignmentExists &&
    input.assignmentData?.uid === input.uid &&
    input.assignmentData.gatewayId === input.authoritativeGatewayId &&
    input.assignmentData.state === "serving";
}

export function createFirestorePlacementPolicyReconcilerDeps(
  input: FirestorePlacementPolicyInput,
): PlacementPolicyReconcilerDeps {
  return {
    now: input.now,
    log: input.log,
    readSnapshot: () => readPlacementPolicySnapshot(input.db, input.idleMs, input.now()),
    assignInitialPlacement: (request) => assignInitialPlacementFirestore(input, request),
    allocateDisposableGateway: (request) => allocateDisposableGatewayFirestore(input, request),
    advanceActivationLease: (request) => advanceActivationLeaseFirestore(input, request),
    completeActivationLease: (request) => completeActivationLeaseFirestore(input, request),
    failActivationLease: (request) => failActivationLeaseFirestore(input, request),
    recoverUnreachableDisposableGateway: (request) =>
      recoverUnreachableDisposableGatewayFirestore(input, request),
    readBuilderActivity: (request) => readBuilderActivityFirestore(input, request),
    enqueueMigration: (request) => enqueuePlacementMigration(input, request),
    retireOwnedGateway: (request) => retireOwnedGatewayFirestore(input, request),
  };
}

export function startPlacementPolicyReconciler(
  deps: PlacementPolicyReconcilerDeps,
  intervalMs = PLACEMENT_POLICY_RECONCILE_MS_DEFAULT,
): () => void {
  if (intervalMs <= 0) return () => undefined;
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await reconcilePlacementPolicyOnce(deps);
    } catch (error) {
      deps.log(`[placement-policy] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
