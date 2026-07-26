import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";

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
  status: "pending" | "running" | "failed" | "rolled-back";
  error?: string;
}

export interface PlacementPolicySnapshot {
  defaultGatewayId: string;
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
    const retired = await context.deps.retireOwnedGateway({
      uid: user.uid,
      builderSlug,
      gatewayId: gateway.gatewayId,
    });
    if (retired) context.result.retired += 1;
    else context.result.blocked += 1;
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
  else context.result.blocked += 1;
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
    context.result.blocked += 1;
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
    context.result.blocked += 1;
    return;
  }
  if (await cleanupFailedActivation(context, user, builderSlug, lease, target)) return;
  if (target.desiredStatus !== "running") {
    context.result.blocked += 1;
    return;
  }
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
      context.result.blocked += 1;
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
    context.result.blocked += 1;
    return;
  }
  if (await cleanupFailedActivation(context, user, builderSlug, lease, target)) return;
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
  lease: BuilderActivationLease,
  target: ContinuousPlacementOwnedGateway,
): Promise<boolean> {
  const operationId = `builder-activate-${target.gatewayId}`;
  const operation = context.operations.get(operationId);
  if (!operation || (operation.status !== "failed" && operation.status !== "rolled-back")) {
    return false;
  }
  if (target.desiredStatus !== "retired") {
    const retired = await context.deps.retireOwnedGateway({
      uid: user.uid,
      builderSlug,
      gatewayId: target.gatewayId,
      leaseId: lease.leaseId,
      generation: lease.generation,
      telemetryFenceOperationId: operationId,
      telemetryFenceStatus: "terminal-failure",
    });
    if (!retired) {
      context.result.blocked += 1;
      return true;
    }
    context.result.retired += 1;
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
      context.result.blocked += 1;
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
  if (
    current !== targetGatewayId ||
    !target ||
    !disposableTargetMatchesLease(target, user, lease)
  ) {
    context.result.blocked += 1;
    return;
  }
  const authorized = accountAllowsInteractiveAccess(user.data) &&
    resolveBuilderTier(user.data, new Date(context.deps.now())) !== null;
  if (!authorized) {
    await queueLeaseReturn(context, user, builderSlug, lease);
    return;
  }
  if (context.state.idleMs <= 0) return;
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
    activity.lastActiveAt === null ||
    context.deps.now() - activity.lastActiveAt < context.state.idleMs
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
    context.result.blocked += 1;
    return;
  }
  if (current === targetGatewayId) {
    const returnOperation = context.operations.get(`builder-return-${targetGatewayId}`);
    if (
      returnOperation?.status === "failed" ||
      returnOperation?.status === "rolled-back"
    ) {
      context.result.blocked += 1;
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
        context.result.blocked += 1;
      }
      return;
    }
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
    context.result.blocked += 1;
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
  if (target.desiredStatus !== "running") {
    context.result.blocked += 1;
    return;
  }
  const retired = await context.deps.retireOwnedGateway({
    uid: user.uid,
    builderSlug,
    gatewayId: targetGatewayId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    telemetryFenceOperationId: `builder-return-${targetGatewayId}`,
    telemetryFenceStatus: "succeeded",
    authoritativeGatewayId: context.state.defaultGatewayId,
  });
  if (!retired) {
    context.result.blocked += 1;
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
  const gateways = new Map(state.gateways.map((item) => [item.gatewayId, item]));
  const migrations = new Map(
    state.activeMigrations
      .filter((item) => item.status === "pending" || item.status === "running")
      .map((item) => [item.uid, item]),
  );
  const operations = new Map(state.activeMigrations.map((item) => [item.id, item]));
  const result: PlacementPolicyReconcileResult = {
    assigned: 0,
    enqueued: 0,
    adopted: 0,
    retired: 0,
    blocked: 0,
  };

  const context = { deps, state, gateways, migrations, operations, result };
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

interface FirestorePlacementPolicyInput {
  db: Firestore;
  namespace: string;
  idleMs: number;
  now(): number;
  log(message: string): void;
  ensureAuthSecret(input: { namespace: string; gatewayId: string }): Promise<unknown>;
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
    idleMs,
    liveRunBuilderSlugs: [...new Set(liveRunsSnap.docs.flatMap((doc) => {
      const parts = doc.ref.path.split("/");
      return parts[0] === "workspaces" && parts[1] ? [parts[1]] : [];
    }))],
    users: usersSnap.docs.map((doc) => ({ uid: doc.id, data: doc.data() as Record<string, unknown> })),
    gateways,
    activeMigrations: opsSnap.docs.flatMap((doc) => activeMigration(doc) ?? []),
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
          const openclaw = record(record(userData?.provisioning)?.openclaw);
          const lease = record(openclaw?.activationLease);
          const assignment = assignmentSnapshot.data() as Record<string, unknown> | undefined;
          if (
            !userSnapshot.exists ||
            openclaw?.gatewayId !== request.authoritativeGatewayId ||
            lease?.leaseId !== request.leaseId ||
            lease?.generation !== request.generation ||
            lease?.status !== "returning" ||
            lease?.targetGatewayId !== request.gatewayId ||
            !assignmentSnapshot.exists ||
            assignment?.uid !== request.uid ||
            assignment.gatewayId !== request.authoritativeGatewayId ||
            assignment.state !== "serving"
          ) {
            throw new GatewayRetirementConflictError(
              `Builder ${request.uid} is no longer authoritatively returned to ${request.authoritativeGatewayId}`,
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
