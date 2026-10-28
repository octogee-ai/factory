import {
  type GatewayStatus,
  GATEWAYS_COLLECTION,
} from "@octogee/shared/types/fleet-controller";
import { isDeepStrictEqual } from "node:util";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  type CustomerMigrationV2GatewayRootFence,
  resolveUserGatewayControlState,
  readSchedulerMigrationIdentity,
} from "@octogee/shared/types/glm";
import {
  GATEWAY_ASSIGNMENTS_SUBCOLLECTION,
  customerRestoreFencePresent,
  customerRuntimeMutationFenced,
  hasFreshReadyKubernetesObservation,
  isGatewayRuntimeDoc,
  projectGatewayDesiredRootForGateway,
  type AssignmentSource,
  type AssignmentState,
  type GatewayRuntimeDoc,
} from "@octogee/shared/types/gateway-releases";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import type { FleetBrokerCustomerRestoreAuthority } from "@octogee/shared/types/fleet-broker";
import { resolveBuilderTier } from "@octogee/shared/types/billing";
import { readWorkspaceMigrationMarker, type WorkspaceMigrationMarker, type WorkspaceMigrationPhase } from "@octogee/shared/types/workspace-migration";
import {
  customerMigrationV2GatewayRootFenceEqual,
  customerMigrationV2GatewayRootFenceMatches,
} from "./customer-migration-v2.js";

import { slugFromAssignedUser } from "./assigned-roster.js";
import { builderActivateOperationId } from "./builder-activation-lease.js";
import { gatewayAuthorizationFromRootDocument } from "./gateway-live-release.js";

const MIGRATE_CUSTOMER_OPERATION_KIND = "migrate-customer" as const;

export interface FleetStateDeps {
  db: FleetStateFirestore;
  serverTimestamp: () => unknown;
  deleteField: () => unknown;
  now?: () => Date;
  log?: (msg: string) => void;
}

const WORKSPACE_MIGRATION_MARKER_PATH = "provisioning.openclaw.migration";

function workspaceMigrationMarker(
  operationId: string | undefined,
  startedAt: number,
): WorkspaceMigrationMarker {
  return { state: "moving", startedAt, ...(operationId ? { operationId } : {}) };
}

export async function setWorkspaceMigrationPhase(
  deps: FleetStateDeps,
  params: { uid: string; sourceGatewayId: string; operationId: string; phase: WorkspaceMigrationPhase },
): Promise<void> {
  await deps.db.runTransaction(async (txn) => {
    const userRef = deps.db.collection("users").doc(params.uid);
    const [userSnapshot, operationSnapshot] = await Promise.all([
      txn.get(userRef),
      txn.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(params.operationId)),
    ]);
    const user = userSnapshot.data();
    assertRestoreUnfenced(user);
    const openclaw = recordOrEmpty(recordOrEmpty(user?.provisioning).openclaw);
    const operation = recordOrEmpty(operationSnapshot.data());
    const input = recordOrEmpty(operation.input);
    const prior = readWorkspaceMigrationMarker(openclaw);
    const expectedGateway = params.phase === "connecting" && typeof operation.cutoverCommittedAt === "number"
      ? input.toGatewayId : params.sourceGatewayId;
    const exact = [
      userSnapshot.exists, operationSnapshot.exists,
      operation.kind === "migrate-customer", operation.status === "running",
      operation.cancellationRequestedAt === undefined || migrationCancellationDeferred(operation, params.operationId), input.uid === params.uid,
      input.fromGatewayId === params.sourceGatewayId, openclaw.gatewayId === expectedGateway,
      !prior?.operationId || prior.operationId === params.operationId,
    ].every(Boolean);
    if (!exact) throw new Error("workspace migration phase authority changed");
    txn.update(userRef, {
      [WORKSPACE_MIGRATION_MARKER_PATH]: {
        state: params.phase === "preparing" || params.phase === "waiting" ? "preparing" : "moving",
        phase: params.phase,
        operationId: params.operationId,
        startedAt: prior?.startedAt ?? (deps.now ? deps.now().getTime() : Date.now()),
      } satisfies WorkspaceMigrationMarker,
    });
  });
}

export interface WorkspaceMigrationPreparationParams {
  uid: string;
  sourceGatewayId: string;
  operationId: string;
  sourceAssignmentMode: "assigned" | "unassigned-live";
  sourceRelease: number;
  sourceEpoch: number;
  sourceRootUpdatedAt?: number;
}

export interface WorkspaceMigrationRecoveryParams {
  uid: string;
  sourceGatewayId: string;
  operationId: string;
  sourceEpoch: number;
  claimStartedAt: number;
}

export interface WorkspaceMigrationSourcePreparationParams extends WorkspaceMigrationRecoveryParams {
  slug: string;
  targetGatewayId: string;
}

export async function assertWorkspaceMigrationSourcePreparationAuthority(deps: FleetStateDeps, params: WorkspaceMigrationSourcePreparationParams): Promise<void> {
  if (![params.uid, params.slug, params.sourceGatewayId, params.targetGatewayId, params.operationId].every(value =>
    typeof value === "string" && value.length > 0 && !value.includes("/")) ||
    params.sourceGatewayId === params.targetGatewayId || !Number.isSafeInteger(params.sourceEpoch) || params.sourceEpoch < 0 ||
    !Number.isSafeInteger(params.claimStartedAt) || params.claimStartedAt <= 0) {
    throw new Error("workspace migration source preparation identity is invalid");
  }
  await deps.db.runTransaction(async txn => {
    const [userSnapshot, operationSnapshot, sourceSnapshot, sourceRootSnapshot, targetSnapshot, targetRootSnapshot, targetRuntimeSnapshot] = await Promise.all([
      txn.get(deps.db.collection("users").doc(params.uid)),
      txn.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(params.operationId)),
      txn.get(assignmentRef(deps.db, params.sourceGatewayId, params.uid)),
      txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.sourceGatewayId)),
      txn.get(assignmentRef(deps.db, params.targetGatewayId, params.uid)),
      txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.targetGatewayId)),
      txn.get(deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(params.targetGatewayId)),
    ]);
    const user = userSnapshot.data();
    assertRestoreUnfenced(user);
    const openclaw = recordOrEmpty(recordOrEmpty(user?.provisioning).openclaw);
    const marker = readWorkspaceMigrationMarker(openclaw);
    const operation = recordOrEmpty(operationSnapshot.data());
    const input = recordOrEmpty(operation.input);
    const source = recordOrEmpty(sourceSnapshot.data());
    const sourceRoot = projectGatewayDesiredRootForGateway(sourceRootSnapshot.data(), params.sourceGatewayId);
    const targetRoot = projectGatewayDesiredRootForGateway(targetRootSnapshot.data(), params.targetGatewayId);
    const exact = [
      userSnapshot.exists, operationSnapshot.exists,
      openclaw.gatewayId === params.sourceGatewayId, slugFromAssignedUser(user) === params.slug,
      marker?.operationId === params.operationId, marker?.state === "preparing", marker?.phase === "preparing",
      operation.kind === MIGRATE_CUSTOMER_OPERATION_KIND, operation.status === "running", operation.startedAt === params.claimStartedAt,
      operation.cancellationRequestedAt === undefined, operation.cutoverCommittedAt === undefined,
      operation.customerMigrationV2 === undefined, operation.sourceTransferExecution === undefined,
      operation.restoreAttempt === undefined,
      operation.schedulerHandoffLost === undefined, input.recoverSourceOnly !== true, input.sourceTransferMode === undefined,
      input.uid === params.uid, input.fromGatewayId === params.sourceGatewayId, input.toGatewayId === params.targetGatewayId,
      input.builderSlug === undefined || input.builderSlug === params.slug,
      preparationAssignmentMatches(params, sourceSnapshot), source.slug === params.slug,
      sourceRoot?.gatewayClass === "shared", sourceRoot?.desiredStatus === "running" || sourceRoot?.desiredStatus === "draining",
      recordOrEmpty(sourceRootSnapshot.data()).runtimeRestartFence === undefined,
      recordOrEmpty(targetRootSnapshot.data()).runtimeRestartFence === undefined,
      targetRoot?.desiredStatus === "running", !targetSnapshot.exists,
      sourcePreparationAttemptClean(operation, params), sourcePreparationTargetUnadmitted(targetRuntimeSnapshot.data(), params),
    ].every(Boolean);
    if (!exact) throw new Error("workspace migration source preparation authority changed");
    assertRecoveryTarget({ operationId: params.operationId, input, openclaw, sourceEpoch: params.sourceEpoch, targetRoot: targetRootSnapshot.data(), schedulerHandoff: undefined });
  });
}

function sourcePreparationAttemptClean(operation: Record<string, unknown>, params: WorkspaceMigrationSourcePreparationParams): boolean {
  if (!Array.isArray(operation.steps) || operation.steps.length !== 0) return false;
  if (operation.schedulerHandoff === undefined) return operation.schedulerHandoffReleased === undefined && operation.schedulerHandoffReleasedAt === undefined;
  const handoff = recordOrEmpty(operation.schedulerHandoff);
  const identity = readSchedulerMigrationIdentity(params.operationId, handoff.migrationId);
  return [
    operation.schedulerHandoffReleased === true,
    Number.isSafeInteger(operation.schedulerHandoffReleasedAt),
    identity !== null && identity.claimStartedAt < params.claimStartedAt,
    identity !== null && Number(operation.schedulerHandoffReleasedAt) >= identity.claimStartedAt,
    handoff.uid === params.uid, handoff.slug === params.slug,
    handoff.fromGatewayId === params.sourceGatewayId, handoff.toGatewayId === params.targetGatewayId,
  ].every(Boolean);
}

function sourcePreparationTargetUnadmitted(runtime: Record<string, unknown> | undefined, params: WorkspaceMigrationSourcePreparationParams): boolean {
  if (runtime === undefined) return true;
  const heartbeat = recordOrEmpty(runtime.heartbeat);
  return isGatewayRuntimeDoc(runtime) && runtime.gatewayId === params.targetGatewayId &&
    Array.isArray(heartbeat.mountedCustomers) && !heartbeat.mountedCustomers.includes(params.slug) &&
    Array.isArray(heartbeat.migratingIn) && !heartbeat.migratingIn.includes(params.slug);
}

export async function assertWorkspaceMigrationRecoveryAuthority(deps: FleetStateDeps, params: WorkspaceMigrationRecoveryParams): Promise<void> {
  await workspaceMigrationRecovery(deps, params, false);
}

export function builderActivationRecoveryTargetMatches(params: {
  operationId: string;
  input: Record<string, unknown>;
  openclaw: Record<string, unknown>;
  sourceEpoch: number;
  targetRoot: unknown;
}): boolean {
  const { input, openclaw } = params;
  const lease = recordOrEmpty(openclaw.activationLease);
  const root = recordOrEmpty(params.targetRoot);
  const allocation = recordOrEmpty(root.allocation);
  const generationValid = Number.isSafeInteger(lease.generation) && Number(lease.generation) > 0;
  return [
    params.operationId === (generationValid && typeof input.toGatewayId === "string" && input.toGatewayId !== ""
      ? builderActivateOperationId(input.toGatewayId, lease.generation as number)
      : null),
    input.source === "builder-activation-lease",
    root.gatewayClass === "builder", root.gatewayId === input.toGatewayId, root.ownerUid === input.uid,
    allocation.kind === "disposable-builder", allocation.claimedByUid === input.uid,
    typeof lease.leaseId === "string", lease.leaseId !== "", allocation.leaseId === lease.leaseId,
    Number.isSafeInteger(lease.generation), Number(lease.generation) > 0, allocation.generation === lease.generation,
    lease.status === "activating" || lease.status === "failed",
    lease.sourceGatewayId === input.fromGatewayId, lease.sourceAssignmentEpoch === params.sourceEpoch,
    lease.targetGatewayId === input.toGatewayId,
  ].every(Boolean);
}

export async function completeWorkspaceMigrationRecovery(deps: FleetStateDeps, params: WorkspaceMigrationRecoveryParams): Promise<void> {
  await workspaceMigrationRecovery(deps, params, true);
}

export function sharedRecoveryTargetCleaned(input: Record<string, unknown>, schedulerHandoff: unknown): boolean {
  if (input.recoverSourceOnly !== true || input.source === "builder-activation-lease") return false;
  const steps = recordOrEmpty(recordOrEmpty(schedulerHandoff).sourceRecovery).steps;
  if (!Array.isArray(steps)) return false;
  return ["rollback:scheduler-abort", "rollback:unmount-target"].every(name => steps.some(value => {
    const step = recordOrEmpty(value);
    return step.name === name && step.status === "done";
  }));
}

function assertRecoveryTarget(params: Parameters<typeof builderActivationRecoveryTargetMatches>[0] & { schedulerHandoff: unknown }): void {
  const matches = params.input.source === "builder-activation-lease"
    ? builderActivationRecoveryTargetMatches(params)
    : sharedRecoveryTargetCleaned(params.input, params.schedulerHandoff) ||
      projectGatewayDesiredRootForGateway(params.targetRoot, String(params.input.toGatewayId))?.gatewayClass === "shared";
  if (!matches) throw new Error("workspace migration recovery target authority changed");
}

async function workspaceMigrationRecovery(
  deps: FleetStateDeps,
  params: WorkspaceMigrationRecoveryParams,
  complete: boolean,
): Promise<void> {
  await deps.db.runTransaction(async (txn) => {
    const userRef = deps.db.collection("users").doc(params.uid);
    const sourceRef = assignmentRef(deps.db, params.sourceGatewayId, params.uid);
    const operationRef = deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(params.operationId);
    const [userSnapshot, operationSnapshot, sourceSnapshot, sourceRootSnapshot] = await Promise.all([
      txn.get(userRef), txn.get(operationRef), txn.get(sourceRef),
      txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.sourceGatewayId)),
    ]);
    const user = userSnapshot.data();
    assertRestoreUnfenced(user);
    const openclaw = recordOrEmpty(recordOrEmpty(user?.provisioning).openclaw);
    const operation = recordOrEmpty(operationSnapshot.data());
    const input = recordOrEmpty(operation.input);
    const source = recordOrEmpty(sourceSnapshot.data());
    const marker = readWorkspaceMigrationMarker(openclaw);
    const handoff = recordOrEmpty(operation.schedulerHandoff);
    const recovery = recordOrEmpty(handoff.sourceRecovery);
    const handoffIdentity = readSchedulerMigrationIdentity(params.operationId, handoff.migrationId);
    const recoveryIntentMatches = input.recoverSourceOnly !== true || [
      handoff.uid === params.uid, handoff.fromGatewayId === params.sourceGatewayId, handoff.toGatewayId === input.toGatewayId,
      handoffIdentity !== null, recovery.migrationId === handoff.migrationId,
      recovery.sourceEpoch === params.sourceEpoch, Array.isArray(recovery.steps),
    ].every(Boolean);
    const exact = [
      recoveryIntentMatches,
      operation.kind === MIGRATE_CUSTOMER_OPERATION_KIND, operation.status === "running",
      operation.startedAt === params.claimStartedAt, Number.isFinite(params.claimStartedAt), params.claimStartedAt > 0,
      operation.cutoverCommittedAt === undefined, operation.customerMigrationV2 === undefined,
      operation.cancellationRequestedAt === undefined,
      input.uid === params.uid, input.fromGatewayId === params.sourceGatewayId,
      typeof input.toGatewayId === "string", input.toGatewayId !== params.sourceGatewayId,
      openclaw.gatewayId === params.sourceGatewayId,
      marker?.operationId === params.operationId || openclaw.migration === undefined && source.state === "serving" && source.updatedByOperationId === params.operationId,
      source.uid === params.uid, source.gatewayId === params.sourceGatewayId, source.epoch === params.sourceEpoch,
      Number.isSafeInteger(params.sourceEpoch), params.sourceEpoch >= 0,
      projectGatewayDesiredRootForGateway(sourceRootSnapshot.data(), params.sourceGatewayId)?.gatewayClass === "shared",
      source.state === "serving" || source.state === "quiescing" && source.updatedByOperationId === params.operationId,
    ].every(Boolean);
    if (!exact) throw new Error("workspace migration recovery authority changed");
    const [target, targetRoot] = await Promise.all([
      txn.get(assignmentRef(deps.db, String(input.toGatewayId), params.uid)),
      txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(String(input.toGatewayId))),
    ]);
    if (target.exists) throw new Error("workspace migration recovery target assignment remains");
    assertRecoveryTarget({ operationId: params.operationId, input, openclaw, sourceEpoch: params.sourceEpoch, targetRoot: targetRoot.data(), schedulerHandoff: handoff });
    if (!complete) return;
    const completedAt = deps.now ? deps.now().getTime() : Date.now();
    txn.update(sourceRef, { state: "serving", updatedByOperationId: params.operationId, updatedAt: completedAt });
    txn.update(operationRef, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: completedAt });
    clearWorkspaceMigrationMarker(txn, deps, params.uid);
  });
}

function preparationAssignmentMatches(
  params: Pick<WorkspaceMigrationPreparationParams, "uid" | "sourceGatewayId" | "sourceEpoch">,
  snapshot: Awaited<ReturnType<FleetStateTxn["get"]>>,
): boolean {
  const source = recordOrEmpty(snapshot.data());
  return snapshot.exists && source.uid === params.uid && source.gatewayId === params.sourceGatewayId &&
    source.state === "serving" && Number.isSafeInteger(params.sourceEpoch) && params.sourceEpoch >= 0 &&
    source.epoch === params.sourceEpoch;
}

async function preparationSourceMatches(
  deps: FleetStateDeps,
  txn: FleetStateTxn,
  params: WorkspaceMigrationPreparationParams,
  snapshot: Awaited<ReturnType<FleetStateTxn["get"]>>,
): Promise<boolean> {
  if (params.sourceAssignmentMode === "assigned") return preparationAssignmentMatches(params, snapshot);
  if (params.sourceAssignmentMode !== "unassigned-live" || snapshot.exists || params.sourceEpoch !== 0 ||
      !Number.isSafeInteger(params.sourceRelease) || params.sourceRelease < 1 ||
      !Number.isFinite(params.sourceRootUpdatedAt)) return false;
  const rootSnapshot = await txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.sourceGatewayId));
  const root = gatewayAuthorizationFromRootDocument(rootSnapshot.data(), params.sourceGatewayId)?.gateway;
  return root !== undefined && root.desiredStatus === "running" &&
    root.desiredRelease === params.sourceRelease && root.liveRelease === params.sourceRelease &&
    root.updatedAt === params.sourceRootUpdatedAt;
}

export async function clearWorkspaceMigrationPreparation(
  deps: FleetStateDeps,
  params: WorkspaceMigrationPreparationParams,
): Promise<void> {
  await deps.db.runTransaction(async (txn) => {
    const userRef = deps.db.collection("users").doc(params.uid);
    const [userSnapshot, operationSnapshot, sourceSnapshot] = await Promise.all([
      txn.get(userRef),
      txn.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(params.operationId)),
      txn.get(assignmentRef(deps.db, params.sourceGatewayId, params.uid)),
    ]);
    const user = userSnapshot.data();
    assertRestoreUnfenced(user);
    const openclaw = recordOrEmpty(recordOrEmpty(user?.provisioning).openclaw);
    const marker = readWorkspaceMigrationMarker(openclaw);
    const operation = recordOrEmpty(operationSnapshot.data());
    const input = recordOrEmpty(operation.input);
    const exact = [
      userSnapshot.exists, operationSnapshot.exists,
      marker?.state === "preparing", marker?.operationId === params.operationId,
      openclaw.gatewayId === params.sourceGatewayId,
      input.uid === params.uid, input.fromGatewayId === params.sourceGatewayId,
      typeof input.toGatewayId === "string", input.toGatewayId !== params.sourceGatewayId,
      await preparationSourceMatches(deps, txn, params, sourceSnapshot),
      preparationCleanupMatches(operation, marker?.phase),
    ].every(Boolean);
    if (!exact) throw new Error("workspace preparation cleanup authority changed");
    const target = await txn.get(assignmentRef(deps.db, String(input.toGatewayId), params.uid));
    if (target.exists) throw new Error("workspace preparation target assignment remains");
    clearWorkspaceMigrationMarker(txn, deps, params.uid);
  });
}

function transferringRollbackConfirmed(operation: Record<string, unknown>): boolean {
  const steps = (operation.steps as unknown[]).map(recordOrEmpty);
  const once = (name: string, statuses: string[]) => {
    const matches = steps.filter(step => step.name === name);
    return matches.length === 1 && statuses.includes(String(matches[0]?.status));
  };
  const abort = steps.filter(step => step.name === "rollback:scheduler-abort");
  return once("quiesce-source", ["done"]) &&
    (once("final-sync-state", ["failed"]) || once("verify-target", ["failed"])) &&
    once("rollback:unmount-target", ["done"]) && once("rollback:scheduler-resume", ["done"]) &&
    once("rollback:resume-ingress", ["done"]) && abort.length <= 1 &&
    (abort.length === 0 || ["done", "skipped"].includes(String(abort[0]?.status)));
}

function preparationCleanupMatches(operation: Record<string, unknown>, phase: unknown): boolean {
  if (phase === "preparing" && preparationStepsMatch(operation, "done")) return true;
  if (operation.kind !== MIGRATE_CUSTOMER_OPERATION_KIND ||
      !["running", "failed"].includes(String(operation.status)) ||
      operation.cutoverCommittedAt !== undefined || operation.customerMigrationV2 !== undefined ||
      operation.cancellationRequestedAt !== undefined || !Array.isArray(operation.steps)) return false;
  if (phase === "transferring" || phase === "connecting") {
    return transferringRollbackConfirmed(operation);
  }
  if (phase !== "preparing" && phase !== "waiting") return false;
  const expected = phase === "preparing" ? [["keys-sync-state", "failed"]] : [
    ["keys-sync-state", "done"], ["pre-sync-state", "done"], ["target-scheduler-ready", "done"],
    ["wait-for-active-work", "failed"], ["rollback:unmount-target", "done"],
  ];
  return isDeepStrictEqual(operation.steps.map(value => {
    const step = recordOrEmpty(value);
    return [step.name, step.status];
  }), expected);
}

export async function clearRetiredBuilderActivationPreparation(
  deps: FleetStateDeps,
  params: { uid: string; targetGatewayId: string; generation: number; retirementOperationId: string },
): Promise<boolean> {
  const operationId = builderActivateOperationId(params.targetGatewayId, params.generation);
  return deps.db.runTransaction(async (txn) => {
    const userRef = deps.db.collection("users").doc(params.uid);
    const [userSnapshot, operationSnapshot, targetRootSnapshot, retirementSnapshot, targetAssignment] = await Promise.all([
      txn.get(userRef),
      txn.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(operationId)),
      txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.targetGatewayId)),
      txn.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(params.retirementOperationId)),
      txn.get(assignmentRef(deps.db, params.targetGatewayId, params.uid)),
    ]);
    const user = userSnapshot.data();
    const openclaw = recordOrEmpty(recordOrEmpty(user?.provisioning).openclaw);
    const marker = readWorkspaceMigrationMarker(openclaw);
    if (marker?.operationId !== operationId) return false;
    assertRestoreUnfenced(user);
    const operation = recordOrEmpty(operationSnapshot.data());
    const input = recordOrEmpty(operation.input);
    if (typeof input.fromGatewayId !== "string" || input.fromGatewayId === "") throw new Error("retired activation preparation source is missing");
    const sourceGatewayId = input.fromGatewayId;
    const [sourceAssignment, sourceRoot] = await Promise.all([
      txn.get(assignmentRef(deps.db, sourceGatewayId, params.uid)),
      txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(sourceGatewayId)),
    ]);
    const lease = recordOrEmpty(openclaw.activationLease);
    const sourceEpoch = typeof lease.sourceAssignmentEpoch === "number" ? lease.sourceAssignmentEpoch : NaN;
    const targetRoot = targetRootSnapshot.data();
    const retirement = recordOrEmpty(retirementSnapshot.data());
    const handoff = recordOrEmpty(operation.schedulerHandoff);
    const exact = [
      marker.state === "preparing", marker.phase === "preparing",
      operation.status === "failed", operation.customerMigrationV2 === undefined,
      operation.schedulerHandoffReleased === true,
      preparationStepsMatch(operation, "failed"),
      input.uid === params.uid, input.toGatewayId === params.targetGatewayId,
      openclaw.gatewayId === sourceGatewayId,
      handoff.uid === params.uid, handoff.fromGatewayId === sourceGatewayId, handoff.toGatewayId === params.targetGatewayId,
      preparationAssignmentMatches({ uid: params.uid, sourceGatewayId, sourceEpoch }, sourceAssignment),
      projectGatewayDesiredRootForGateway(sourceRoot.data(), sourceGatewayId)?.gatewayClass === "shared",
      !targetAssignment.exists,
      builderActivationRecoveryTargetMatches({ operationId, input, openclaw, sourceEpoch, targetRoot }),
      projectGatewayDesiredRootForGateway(targetRoot, params.targetGatewayId)?.desiredStatus === "retired",
      recordOrEmpty(targetRoot?.retirementClaim).operationId === params.retirementOperationId,
      retirement.kind === "retire-gateway", retirement.status === "succeeded",
      recordOrEmpty(retirement.input).gatewayId === params.targetGatewayId,
    ].every(Boolean);
    if (!exact) throw new Error("retired activation preparation cleanup authority changed");
    clearWorkspaceMigrationMarker(txn, deps, params.uid);
    return true;
  });
}

function preparationStepsMatch(operation: Record<string, unknown>, unmountStatus: "done" | "failed"): boolean {
  if (operation.kind !== MIGRATE_CUSTOMER_OPERATION_KIND ||
      !["running", "failed"].includes(String(operation.status)) ||
      operation.cutoverCommittedAt !== undefined || !Array.isArray(operation.steps)) return false;
  const expected: Record<string, string> = {
    "keys-sync-state": "done",
    "pre-sync-state": "failed",
    "rollback:unmount-target": unmountStatus,
  };
  return operation.steps.length === Object.keys(expected).length &&
    operation.steps.every((value) => {
      const step = recordOrEmpty(value);
      return typeof step.name === "string" && Object.hasOwn(expected, step.name) && expected[step.name] === step.status;
    }) && new Set(operation.steps.map(value => recordOrEmpty(value).name)).size === Object.keys(expected).length;
}

function clearWorkspaceMigrationMarker(
  txn: FleetStateTxn,
  deps: FleetStateDeps,
  uid: string,
): void {
  txn.update(deps.db.collection("users").doc(uid), {
    [WORKSPACE_MIGRATION_MARKER_PATH]: deps.deleteField(),
  });
}

export interface FleetStateDocRef {
  set: (data: Record<string, unknown>, options?: { merge?: boolean }) => Promise<unknown>;
  update: (data: Record<string, unknown>) => Promise<unknown>;
  get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  // The atomic cutover reaches a subcollection ref (gateways/{gw}/assignments/{uid});
  // the real firebase-admin DocumentReference supports this.
  collection?: (name: string) => { doc: (id: string) => FleetStateDocRef };
}

export interface FleetStateTxn {
  get: (ref: FleetStateDocRef) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  update: (ref: FleetStateDocRef, data: Record<string, unknown>) => void;
  set: (ref: FleetStateDocRef, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
  delete: (ref: FleetStateDocRef) => void;
}

export interface FleetStateFirestore {
  collection: (name: string) => {
    doc: (id: string) => FleetStateDocRef;
  };
  runTransaction: <T>(body: (txn: FleetStateTxn) => Promise<T>) => Promise<T>;
}

export interface CustomerRestoreInput {
  fromGatewayId: string;
  uid: string;
  slug: string;
  gatewayId: string;
  assignmentEpoch: number;
  operationId: string;
  claimStartedAt: number;
  attemptId: string;
}

class CustomerRestoreAuthorityUnavailableError extends Error {}

function assertRestoreUnfenced(user: unknown): void {
  if (customerRestoreFencePresent(user)) throw new Error("customer restore outcome is unresolved");
  if (customerRuntimeMutationFenced(user)) throw new Error("customer source transfer outcome is unresolved");
}

function assertCustomerRestoreInput(input: CustomerRestoreInput): void {
  if (![input.uid, input.slug, input.gatewayId, input.fromGatewayId, input.operationId, input.attemptId].every(value => typeof value === "string" && value.length > 0) ||
      !Number.isSafeInteger(input.assignmentEpoch) || input.assignmentEpoch < 0 ||
      !Number.isSafeInteger(input.claimStartedAt) || input.claimStartedAt <= 0) {
    throw new CustomerRestoreAuthorityUnavailableError("customer restore identity is invalid");
  }
}

async function readCustomerRestoreAuthority(deps: Pick<FleetStateDeps, "db">, txn: FleetStateTxn, input: CustomerRestoreInput) {
  assertCustomerRestoreInput(input);
  const userRef = deps.db.collection("users").doc(input.uid);
  const operationRef = deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(input.operationId);
  const [userSnapshot, operationSnapshot, assignmentSnapshot, gatewaySnapshot] = await Promise.all([
    txn.get(userRef), txn.get(operationRef), txn.get(assignmentRef(deps.db, input.gatewayId, input.uid)),
    txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId)),
  ]);
  if (Object.hasOwn(recordOrEmpty(gatewaySnapshot.data()), "runtimeRestartFence")) throw new CustomerRestoreAuthorityUnavailableError("gateway runtime restart outcome is unresolved");
  const user = userSnapshot.data();
  const openclaw = recordOrEmpty(recordOrEmpty(user?.provisioning).openclaw);
  const operation = recordOrEmpty(operationSnapshot.data());
  const operationInput = recordOrEmpty(operation.input);
  const handoff = recordOrEmpty(operation.schedulerHandoff);
  const assignment = recordOrEmpty(assignmentSnapshot.data());
  const exact = [
    userSnapshot.exists, operationSnapshot.exists, assignmentSnapshot.exists,
    slugFromAssignedUser(user) === input.slug, accountAllowsInteractiveAccess(user),
    openclaw.gatewayId === input.gatewayId, openclaw.status === "complete",
    operation.kind === "migrate-customer", operation.status === "running",
    operation.startedAt === input.claimStartedAt,
    operation.cancellationRequestedAt === undefined || migrationCancellationDeferred(operation, input.operationId),
    operationInput.uid === input.uid, operationInput.toGatewayId === input.gatewayId,
    operationInput.fromGatewayId === input.fromGatewayId, input.fromGatewayId !== input.gatewayId,
    typeof operation.cutoverCommittedAt === "number" && Number.isFinite(operation.cutoverCommittedAt) && operation.cutoverCommittedAt > 0,
    handoff.uid === input.uid, handoff.slug === input.slug,
    handoff.fromGatewayId === input.fromGatewayId, handoff.toGatewayId === input.gatewayId,
    assignment.uid === input.uid, assignment.slug === input.slug,
    assignment.gatewayId === input.gatewayId, assignment.epoch === input.assignmentEpoch,
    assignment.state === "serving",
  ].every(Boolean);
  if (!exact) throw new CustomerRestoreAuthorityUnavailableError("customer restore authority changed");
  return { userRef, operationRef, user, openclaw, operation, gateway: recordOrEmpty(gatewaySnapshot.data()) };
}

function hasPriorCustomerRestoreWork(operation: Record<string, unknown>): boolean {
  const histories = Array.isArray(operation.attemptHistory) ? operation.attemptHistory : [];
  const attempts = [operation, ...histories.map(recordOrEmpty)];
  return attempts.some(attempt => Array.isArray(attempt.steps) &&
    attempt.steps.some(step => recordOrEmpty(step).name === "restore-target"));
}

function restoreDispatchClaim(operation: Record<string, unknown>, intent: Record<string, unknown>): number | null {
  if (intent.dispatchClaimStartedAt !== undefined) {
    return Number.isSafeInteger(intent.dispatchClaimStartedAt) && Number(intent.dispatchClaimStartedAt) > 0
      ? Number(intent.dispatchClaimStartedAt) : null;
  }
  if (Number(intent.dispatchedAt) >= Number(intent.claimStartedAt)) return Number(intent.claimStartedAt);
  const history = Array.isArray(operation.attemptHistory) ? operation.attemptHistory.map(recordOrEmpty) : [];
  const candidates = history.filter(attempt => Number.isSafeInteger(attempt.startedAt) &&
    Number(attempt.startedAt) > 0 && Number(attempt.startedAt) <= Number(intent.dispatchedAt) &&
    Array.isArray(attempt.steps) && attempt.steps.some(step => recordOrEmpty(step).name === "restore-target"));
  return candidates.length === 1 ? Number(candidates[0]!.startedAt) : null;
}

function resumedRestoreIntent(current: Awaited<ReturnType<typeof readCustomerRestoreAuthority>>, input: CustomerRestoreInput): CustomerRestoreInput & { dispatchClaimStartedAt: number } {
  const prior = recordOrEmpty(current.operation.restoreAttempt);
  const fence = recordOrEmpty(current.openclaw.restoreFence);
  const identity = ["uid", "slug", "gatewayId", "fromGatewayId", "assignmentEpoch", "operationId"] as const;
  const dispatchClaimStartedAt = restoreDispatchClaim(current.operation, prior);
  const validClock = [
    Number.isSafeInteger(prior.claimStartedAt), Number(prior.claimStartedAt) > 0,
    Number.isSafeInteger(prior.dispatchedAt), Number(prior.dispatchedAt) > 0,
    dispatchClaimStartedAt !== null, Number(dispatchClaimStartedAt) <= Number(prior.claimStartedAt),
    Number(prior.claimStartedAt) <= input.claimStartedAt, Number(prior.dispatchedAt) >= Number(dispatchClaimStartedAt),
  ].every(Boolean);
  const exact = prior.phase === "dispatched" && fence.phase === "dispatched" && validClock &&
    identity.every(key => prior[key] === input[key] && fence[key] === prior[key]) &&
    typeof prior.attemptId === "string" && prior.attemptId.trim().length > 0 &&
    ["attemptId", "claimStartedAt", "dispatchedAt", "dispatchClaimStartedAt"].every(key => fence[key] === prior[key]);
  if (!exact) throw new CustomerRestoreAuthorityUnavailableError("customer restore resumption does not own the dispatch intent");
  if (Object.hasOwn(current.openclaw, "sourceTransferFence")) throw new CustomerRestoreAuthorityUnavailableError("customer source transfer outcome is unresolved");
  return { ...input, attemptId: prior.attemptId as string, dispatchClaimStartedAt: dispatchClaimStartedAt! };
}

export async function readCustomerRestoreAuthoritySnapshot(
  deps: Pick<FleetStateDeps, "db">,
  scope: { uid: string; slug: string; gatewayId: string },
): Promise<FleetBrokerCustomerRestoreAuthority | undefined> {
  return deps.db.runTransaction<FleetBrokerCustomerRestoreAuthority | undefined>(async txn => {
    const user = (await txn.get(deps.db.collection("users").doc(scope.uid))).data();
    if (!customerRestoreFencePresent(user)) return undefined;
    const openclaw = recordOrEmpty(recordOrEmpty(user?.provisioning).openclaw);
    const fence = recordOrEmpty(openclaw.restoreFence);
    const operationId = fence.operationId;
    if (typeof operationId !== "string" || !operationId || operationId.includes("/")) {
      throw new CustomerRestoreAuthorityUnavailableError("customer restore authority is malformed");
    }
    const operation = recordOrEmpty((await txn.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(operationId))).data());
    const input: CustomerRestoreInput = {
      ...scope, operationId,
      fromGatewayId: fence.fromGatewayId as string,
      assignmentEpoch: fence.assignmentEpoch as number,
      attemptId: fence.attemptId as string,
      claimStartedAt: operation.startedAt as number,
    };
    const current = await readCustomerRestoreAuthority(deps, txn, input);
    if (current.gateway.gatewayClass !== "shared") throw new CustomerRestoreAuthorityUnavailableError("customer restore authority requires its assigned Shared gateway");
    const intent = recordOrEmpty(current.operation.restoreAttempt);
    if (fence.claimStartedAt !== input.claimStartedAt || intent.claimStartedAt !== input.claimStartedAt) {
      throw new CustomerRestoreAuthorityUnavailableError("customer restore authority has not resumed under its current claim");
    }
    const resumed = resumedRestoreIntent(current, input);
    return {
      ...resumed, phase: "dispatched", migrationId: `mig-${operationId}`,
      dispatchedAt: intent.dispatchedAt as number,
    };
  }).catch((error: unknown) => {
    if (error instanceof CustomerRestoreAuthorityUnavailableError) return undefined;
    throw error;
  });
}

export async function beginCustomerRestore(deps: FleetStateDeps, input: CustomerRestoreInput, options: { resume?: boolean } = {}): Promise<CustomerRestoreInput> {
  return deps.db.runTransaction(async txn => {
    const current = await readCustomerRestoreAuthority(deps, txn, input);
    if (options.resume === true) {
      const resumed = resumedRestoreIntent(current, input);
      const intent = { ...recordOrEmpty(current.operation.restoreAttempt), ...resumed };
      txn.update(current.userRef, { "provisioning.openclaw.restoreFence": intent });
      txn.update(current.operationRef, { restoreAttempt: intent });
      return resumed;
    }
    assertRestoreUnfenced(current.user);
    if (current.operation.restoreAttempt !== undefined ||
        hasPriorCustomerRestoreWork(current.operation)) {
      throw new Error("customer restore was already dispatched or has unknown prior work");
    }
    const now = deps.now?.().getTime() ?? Date.now();
    const intent = { ...input, dispatchClaimStartedAt: input.claimStartedAt, phase: "dispatched", dispatchedAt: now };
    txn.update(current.userRef, { "provisioning.openclaw.restoreFence": intent });
    txn.update(current.operationRef, { restoreAttempt: intent, lastProgressAt: now });
    return input;
  });
}

export async function acknowledgeCustomerRestore(deps: FleetStateDeps, input: CustomerRestoreInput): Promise<void> {
  await deps.db.runTransaction(async txn => {
    const current = await readCustomerRestoreAuthority(deps, txn, input);
    for (const value of [current.openclaw.restoreFence, current.operation.restoreAttempt]) {
      const intent = recordOrEmpty(value);
      if (intent.phase !== "dispatched" || Object.entries(input).some(([key, expected]) => intent[key] !== expected)) {
        throw new Error("customer restore acknowledgement does not own the dispatch intent");
      }
    }
    const now = deps.now?.().getTime() ?? Date.now();
    txn.update(current.userRef, { "provisioning.openclaw.restoreFence": deps.deleteField() });
    txn.update(current.operationRef, {
      restoreAttempt: { ...recordOrEmpty(current.operation.restoreAttempt), phase: "acknowledged", acknowledgedAt: now },
      lastProgressAt: now,
    });
  });
}

export interface HeartbeatSnapshot {
  gatewayId: string;
  status: GatewayStatus;
  version: string;
  openclawVersion: string;
  mountedCustomers: string[];
  internalUrl: string;
  startedAt: number;
}

export async function writeGatewayHeartbeat(
  deps: FleetStateDeps,
  snapshot: HeartbeatSnapshot,
): Promise<void> {
  if (!snapshot.gatewayId) {
    throw new Error("gatewayId is required for a gateway heartbeat");
  }

  const heartbeat = {
    status: snapshot.status,
    version: snapshot.version,
    openclawVersion: snapshot.openclawVersion,
    mountedCustomers: snapshot.mountedCustomers,
    internalUrl: snapshot.internalUrl,
    startedAt: snapshot.startedAt,
    lastHeartbeatAt: deps.serverTimestamp(),
  };
  await deps.db
    .collection(GLM_GATEWAYS_COLLECTION)
    .doc(snapshot.gatewayId)
    .set({ heartbeat }, { merge: true });
}

export interface CutoverCommitParams {
  uid: string;
  slug: string;
  // The bare gateway the cutover moves TO / FROM.
  toGatewayId: string;
  fromGatewayId: string;
  // Move the users/{uid} mirror — only when the bare gateway changed.
  flipMirror: boolean;
  // The assignment move to commit (null = legacy migration, no assignment layer).
  assignment: {
    source: AssignmentSource;
    updatedByOperationId: string | null;
  } | null;
  customerMigrationV2Fence?: {
    claimStartedAt?: number;
    operationId: string;
    migrationId: string;
    uid: string;
    slug: string;
    sourceGatewayId: string;
    sourceEpoch: number;
    sourceRelease: number;
    sourceAssignmentMode: "assigned" | "unassigned-live";
    sourceRootFence: CustomerMigrationV2GatewayRootFence;
    targetGatewayId: string;
    targetRelease: number;
    targetRootFence: CustomerMigrationV2GatewayRootFence;
  };
  automatic?: boolean;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function legacyForwardRecoveryMatches(operationId: string, input: Record<string, unknown>, handoff: Record<string, unknown>): boolean {
  const recovery = recordOrEmpty(handoff.forwardRecovery);
  return recovery.schemaVersion === 1 && recovery.phase === "source-flushed" &&
    readSchedulerMigrationIdentity(operationId, handoff.migrationId) !== null &&
    handoff.uid === input.uid && handoff.fromGatewayId === input.fromGatewayId && handoff.toGatewayId === input.toGatewayId &&
    Number.isSafeInteger(recovery.sourceEpoch) && Number(recovery.sourceEpoch) >= 0;
}

export function migrationCancellationDeferred(operation: Record<string, unknown>, operationId: string): boolean {
  const input = recordOrEmpty(operation.input);
  const state = recordOrEmpty(operation.customerMigrationV2);
  const durableV2 = state.operationId === operationId && state.uid === input.uid &&
    state.sourceGatewayId === input.fromGatewayId && state.targetGatewayId === input.toGatewayId &&
    ["sourceQuiesced", "finalSynced", "targetVerified", "cutover", "sourceRetired", "complete"].includes(String(state.phase));
  return legacyForwardRecoveryMatches(operationId, input, recordOrEmpty(operation.schedulerHandoff)) || durableV2;
}

function customerMigrationV2FenceIsExact(
  operation: Record<string, unknown> | undefined,
  fence: NonNullable<CutoverCommitParams["customerMigrationV2Fence"]>,
): boolean {
  const state = recordOrEmpty(operation?.customerMigrationV2);
  const sourceRootFence = state.sourceRootFence as CustomerMigrationV2GatewayRootFence;
  const targetRootFence = state.targetRootFence as CustomerMigrationV2GatewayRootFence;
  const claimBound = recordOrEmpty(operation?.input).sourceTransferMode === "retained-pod" || fence.claimStartedAt !== undefined;
  const claimCurrent = !claimBound || (
    Number.isSafeInteger(fence.claimStartedAt) && (fence.claimStartedAt ?? 0) > 0 &&
    operation?.startedAt === fence.claimStartedAt
  );
  return [
    operation?.status === "running",
    claimCurrent,
    state.phase === "targetVerified",
    state.operationId === fence.operationId,
    state.migrationId === fence.migrationId,
    state.uid === fence.uid,
    state.slug === fence.slug,
    state.sourceGatewayId === fence.sourceGatewayId,
    state.sourceEpoch === fence.sourceEpoch,
    state.sourceRelease === fence.sourceRelease,
    state.sourceAssignmentMode === fence.sourceAssignmentMode,
    customerMigrationV2GatewayRootFenceEqual(sourceRootFence, fence.sourceRootFence),
    state.targetGatewayId === fence.targetGatewayId,
    state.targetRelease === fence.targetRelease,
    customerMigrationV2GatewayRootFenceEqual(targetRootFence, fence.targetRootFence),
  ].every(Boolean);
}

// Atomic cutover (GATEWAY-RELEASES-SPEC, PR5 review P0). The mirror move AND the
// assignment write commit in ONE Firestore transaction, so a crash/throw leaves
// NEITHER — never a half-state where the mirror points at the target while the
// assignment still says source. Cross-gateway also drops the stale source
// assignment in the same transaction.
//
// The commit is also the ROSTER FLIP: the written assignment is stamped
// state:"serving" and its epoch is bumped past the customer's prior assignment —
// the per-customer monotonic epoch the edge's forwarding rides.
export async function commitCutoverAtomic(
  deps: FleetStateDeps,
  params: CutoverCommitParams,
): Promise<void> {
  const nowMs = deps.now ? deps.now().getTime() : Date.now();
  await deps.db.runTransaction(async (txn) => {
    const restoreOwner = await txn.get(deps.db.collection("users").doc(params.uid));
    assertRestoreUnfenced(restoreOwner.data());
    const prior = await readPriorAssignment(txn, deps.db, params);
    const targetRootRef = deps.db.collection(GATEWAYS_COLLECTION).doc(params.toGatewayId);
    const targetRootSnap = await txn.get(
      targetRootRef,
    );
    const targetRoot = targetRootSnap.exists ? targetRootSnap.data() : undefined;
    assertTargetAcceptsCutover(targetRoot, params.toGatewayId);
    if (params.customerMigrationV2Fence) {
      const alreadyCommitted = await assertCustomerMigrationV2FenceCurrent({
        txn,
        db: deps.db,
        params,
        targetRoot,
        prior,
        nowMs,
      });
      if (alreadyCommitted) return;
    }
    const activationSourcePatch = await builderActivationSourceCutoverPatch({
      txn, db: deps.db, params, user: restoreOwner.data(), prior, targetRoot,
    });
    updateUserMirror(txn, deps, params, targetRoot, activationSourcePatch);
    updateAssignment(txn, deps.db, params, prior.epoch, nowMs);
  });
}

interface PriorAssignment {
  exists: boolean;
  data: Record<string, unknown> | undefined;
  epoch: number;
}

async function builderActivationSourceCutoverPatch(input: {
  txn: FleetStateTxn;
  db: FleetStateFirestore;
  params: CutoverCommitParams;
  user: Record<string, unknown> | undefined;
  prior: PriorAssignment;
  targetRoot: Record<string, unknown> | undefined;
}): Promise<Record<string, unknown>> {
  const { params, prior } = input;
  const openclaw = recordOrEmpty(recordOrEmpty(input.user?.provisioning).openclaw);
  const lease = recordOrEmpty(openclaw.activationLease);
  const applies = [
    params.flipMirror, params.assignment !== null, params.fromGatewayId !== params.toGatewayId,
    input.targetRoot?.gatewayClass === "shared",
    ["requested", "provisioning", "activating"].includes(String(lease.status)),
  ].every(Boolean);
  if (!applies) return {};
  const source = await input.txn.get(input.db.collection(GATEWAYS_COLLECTION).doc(params.fromGatewayId));
  const exact = [
    lease.status !== "activating",
    source.data()?.gatewayClass === "shared",
    openclaw.gatewayId === params.fromGatewayId,
    lease.sourceGatewayId === params.fromGatewayId,
    lease.sourceAssignmentEpoch === prior.data?.epoch,
    prior.exists, prior.data?.uid === params.uid, prior.data?.gatewayId === params.fromGatewayId,
    Number.isSafeInteger(prior.data?.epoch), Number(prior.data?.epoch) >= 0,
    Number(prior.data?.epoch) < Number.MAX_SAFE_INTEGER,
    prior.data?.state === "serving" || prior.data?.state === "quiescing",
  ].every(Boolean);
  if (!exact) throw new Error("Builder activation source changed before Shared cutover");
  return {
    "provisioning.openclaw.activationLease.sourceGatewayId": params.toGatewayId,
    "provisioning.openclaw.activationLease.sourceAssignmentEpoch": prior.epoch + 1,
  };
}

async function readPriorAssignment(
  txn: FleetStateTxn,
  db: FleetStateFirestore,
  params: CutoverCommitParams,
): Promise<PriorAssignment> {
  if (!params.assignment) {
    return { exists: false, data: undefined, epoch: 0 };
  }
  const snapshot = await txn.get(assignmentRef(db, params.fromGatewayId, params.uid));
  const data = snapshot.exists ? snapshot.data() : undefined;
  const epoch = data?.epoch;
  return {
    exists: snapshot.exists,
    data,
    epoch: typeof epoch === "number" && epoch >= 0 ? epoch : 0,
  };
}

function assertTargetAcceptsCutover(
  targetRoot: Record<string, unknown> | undefined,
  gatewayId: string,
): void {
  if (targetRoot?.desiredStatus === "retired" || targetRoot?.retirementClaim != null) {
    throw new Error(`gateway ${gatewayId} has a current retirement claim`);
  }
}

interface CustomerMigrationV2FenceValidationInput {
  txn: FleetStateTxn;
  db: FleetStateFirestore;
  params: CutoverCommitParams;
  targetRoot: Record<string, unknown> | undefined;
  prior: PriorAssignment;
  nowMs: number;
}

async function assertCustomerMigrationV2FenceCurrent(
  input: CustomerMigrationV2FenceValidationInput,
): Promise<boolean> {
  const { txn, db, params, targetRoot, prior, nowMs } = input;
  const fence = params.customerMigrationV2Fence!;
  assertCustomerMigrationV2ParametersExact(params, fence);
  const [operationSnap, targetAssignmentSnap, sourceRootSnap, userSnap] = await Promise.all([
    txn.get(db.collection(GLM_OPERATIONS_COLLECTION).doc(fence.operationId)),
    txn.get(assignmentRef(db, params.toGatewayId, params.uid)),
    txn.get(db.collection(GATEWAYS_COLLECTION).doc(fence.sourceGatewayId)),
    txn.get(db.collection("users").doc(params.uid)),
  ]);
  const operation = operationSnap.exists ? operationSnap.data() : undefined;
  assertCustomerMigrationV2ProofsExact({
    fence,
    operation,
    targetRoot,
    sourceRoot: sourceRootSnap.exists ? sourceRootSnap.data() : undefined,
  });
  const targetAssignment = targetAssignmentSnap.exists ? targetAssignmentSnap.data() : undefined;
  if (customerMigrationAlreadyCommitted(prior, targetAssignment, fence)) return true;
  assertBuilderActivationCutoverAuthorized({
    operation,
    user: userSnap.exists ? userSnap.data() : undefined,
    targetRoot,
    fence,
    nowMs,
  });
  assertCustomerMigrationSourceAssignmentExact(prior, fence);
  return false;
}

function assertBuilderActivationCutoverAuthorized(input: {
  operation: Record<string, unknown> | undefined;
  user: Record<string, unknown> | undefined;
  targetRoot: Record<string, unknown> | undefined;
  fence: NonNullable<CutoverCommitParams["customerMigrationV2Fence"]>;
  nowMs: number;
}): void {
  const operationInput = recordOrEmpty(input.operation?.input);
  const allocation = recordOrEmpty(input.targetRoot?.allocation);
  if (operationInput.source !== "builder-activation-lease" ||
      allocation.kind !== "disposable-builder") return;
  const user = input.user;
  const provisioning = recordOrEmpty(user?.provisioning);
  const openclaw = recordOrEmpty(provisioning.openclaw);
  const lease = recordOrEmpty(openclaw.activationLease);
  const authorized = [
    accountAllowsInteractiveAccess(user),
    resolveBuilderTier(user ?? {}, new Date(input.nowMs)) !== null,
    lease.status === "activating",
    lease.targetGatewayId === input.fence.targetGatewayId,
    typeof lease.leaseId === "string" && lease.leaseId.length > 0,
    Number.isSafeInteger(lease.generation) && (lease.generation as number) > 0,
    allocation.kind === "disposable-builder",
    allocation.claimedByUid === input.fence.uid,
    allocation.leaseId === lease.leaseId,
    allocation.generation === lease.generation,
  ].every(Boolean);
  if (!authorized) {
    throw new Error("Builder activation authorization changed before cutover");
  }
}

function assertCustomerMigrationV2ParametersExact(
  params: CutoverCommitParams,
  fence: NonNullable<CutoverCommitParams["customerMigrationV2Fence"]>,
): void {
  const parametersExact = [
    fence.uid === params.uid,
    fence.slug === params.slug,
    fence.sourceGatewayId === params.fromGatewayId,
    fence.targetGatewayId === params.toGatewayId,
    params.assignment !== null,
  ].every(Boolean);
  if (!parametersExact) {
    throw new Error("customer migration V2 cutover parameters changed after verification");
  }
}

function assertCustomerMigrationV2ProofsExact(input: {
  fence: NonNullable<CutoverCommitParams["customerMigrationV2Fence"]>;
  operation: Record<string, unknown> | undefined;
  targetRoot: Record<string, unknown> | undefined;
  sourceRoot: Record<string, unknown> | undefined;
}): void {
  const { fence, operation, targetRoot, sourceRoot } = input;
  if (!customerMigrationV2FenceIsExact(operation, fence)) {
    throw new Error("customer migration V2 is not durably cutover-ready");
  }
  if (!customerMigrationV2GatewayRootFenceMatches(targetRoot, fence.targetRootFence)) {
    throw new Error("customer migration V2 target root changed before cutover");
  }
  if (!customerMigrationV2GatewayRootFenceMatches(sourceRoot, fence.sourceRootFence)) {
    throw new Error("customer migration V2 source root changed before cutover");
  }
}

function customerMigrationAlreadyCommitted(
  prior: PriorAssignment,
  targetAssignment: Record<string, unknown> | undefined,
  fence: NonNullable<CutoverCommitParams["customerMigrationV2Fence"]>,
): boolean {
  return !prior.exists &&
    targetAssignment?.gatewayId === fence.targetGatewayId &&
    targetAssignment.updatedByOperationId === fence.operationId &&
    targetAssignment.state === "serving";
}

function assertCustomerMigrationSourceAssignmentExact(
  prior: PriorAssignment,
  fence: NonNullable<CutoverCommitParams["customerMigrationV2Fence"]>,
): void {
  const sourceAssignmentExact = [
    prior.epoch === fence.sourceEpoch,
    prior.data?.uid === fence.uid,
    prior.data?.slug === fence.slug,
    prior.data?.gatewayId === fence.sourceGatewayId,
    prior.data?.state === "quiescing",
    prior.data?.updatedByOperationId === fence.operationId,
  ].every(Boolean);
  if (!sourceAssignmentExact) {
    throw new Error("customer migration V2 source assignment changed before cutover");
  }
}

function updateUserMirror(
  txn: FleetStateTxn,
  deps: FleetStateDeps,
  params: CutoverCommitParams,
  targetRoot: Record<string, unknown> | undefined,
  activationSourcePatch: Record<string, unknown>,
): void {
  if (!params.flipMirror) {
    clearWorkspaceMigrationMarker(txn, deps, params.uid);
    return;
  }
  const controlState = resolveUserGatewayControlState(targetRoot, params.uid);
  txn.update(deps.db.collection("users").doc(params.uid), {
    ...activationSourcePatch,
    "provisioning.openclaw.gatewayId": params.toGatewayId,
    "provisioning.openclaw.gatewayAssignedAt": deps.serverTimestamp(),
    "provisioning.openclaw.gatewayProfile": controlState.gatewayProfile,
    "provisioning.openclaw.controlUiEnabled": controlState.controlUiEnabled,
    [WORKSPACE_MIGRATION_MARKER_PATH]: deps.deleteField(),
  });
}

function updateAssignment(
  txn: FleetStateTxn,
  db: FleetStateFirestore,
  params: CutoverCommitParams,
  priorEpoch: number,
  nowMs: number,
): void {
  if (!params.assignment) return;
  txn.set(assignmentRef(db, params.toGatewayId, params.uid), {
    uid: params.uid,
    slug: params.slug,
    gatewayId: params.toGatewayId,
    source: params.assignment.source,
    state: "serving" satisfies AssignmentState,
    epoch: priorEpoch + 1,
    createdAt: nowMs,
    updatedAt: nowMs,
    updatedByOperationId: params.assignment.updatedByOperationId,
  });
  if (params.fromGatewayId !== params.toGatewayId) {
    txn.delete(assignmentRef(db, params.fromGatewayId, params.uid));
  }
}

export interface UnavailableGatewayRecoveryParams {
  operationId: string;
  kind: "recover-shared-customer";
  uid: string;
  slug: string;
  fromGatewayId: string;
  toGatewayId: string;
  expectedSourceEpoch: number;
  sharedGatewayIds: readonly string[];
  targetHeartbeatMaxAgeMs: number;
  validateTarget?: (context: UnavailableGatewayRecoveryTargetValidationContext) => Promise<void>;
}

export interface UnavailableGatewayRecoveryTargetValidationContext {
  txn: FleetStateTxn;
  targetGatewayId: string;
  targetRoot: Record<string, unknown>;
  targetRuntime: Record<string, unknown>;
}

type ProjectedGatewayRoot = NonNullable<
  ReturnType<typeof projectGatewayDesiredRootForGateway>
>;

function millisFromUnknown(value: unknown): number | null {
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

function recoveryOperationMatches(
  operation: Record<string, unknown> | undefined,
  params: UnavailableGatewayRecoveryParams,
): boolean {
  const input = recordOrEmpty(operation?.input);
  const operationMatches = [
    operation?.kind === MIGRATE_CUSTOMER_OPERATION_KIND,
    operation?.status === "succeeded",
    operation?.origin === "automatic",
    operation?.createdBy === "glm-controller-placement-policy",
    operation?.gatewayId === params.toGatewayId,
    operation?.inputUid === params.uid,
    input.uid === params.uid,
    input.slug === params.slug,
    input.recoveryKind === params.kind,
    input.fromGatewayId === params.fromGatewayId,
    input.toGatewayId === params.toGatewayId,
    input.sourceEpoch === params.expectedSourceEpoch,
  ].every(Boolean);
  return operationMatches;
}

function recoveryAlreadyCommitted(input: {
  params: UnavailableGatewayRecoveryParams;
  operation: Record<string, unknown> | undefined;
  user: Record<string, unknown> | undefined;
  targetRootData: Record<string, unknown> | undefined;
  sourceAssignmentExists: boolean;
  targetAssignment: Record<string, unknown> | undefined;
}): boolean {
  const openclaw = recordOrEmpty(recordOrEmpty(input.user?.provisioning).openclaw);
  const targetRoot = projectGatewayDesiredRootForGateway(
    input.targetRootData,
    input.params.toGatewayId,
  );
  const controlState = resolveUserGatewayControlState(
    targetRoot
      ? { ...targetRoot, builderAccess: targetRoot.builderAccess ?? undefined }
      : undefined,
    input.params.uid,
  );
  const targetAssignmentExact = [
    input.targetAssignment?.uid === input.params.uid,
    input.targetAssignment?.slug === input.params.slug,
    input.targetAssignment?.gatewayId === input.params.toGatewayId,
    input.targetAssignment?.source === "repair",
    input.targetAssignment?.state === "serving",
    input.targetAssignment?.epoch === input.params.expectedSourceEpoch + 1,
    input.targetAssignment?.updatedByOperationId === input.params.operationId,
  ].every(Boolean);
  const operationAt = millisFromUnknown(input.operation?.completedAt);
  const operationTimingExact = [
    operationAt !== null,
    input.operation?.createdAt === operationAt,
    input.operation?.startedAt === operationAt,
    input.targetAssignment?.updatedAt === operationAt,
  ].every(Boolean);
  return [
    recoveryOperationMatches(input.operation, input.params),
    !input.sourceAssignmentExists,
    openclaw.gatewayId === input.params.toGatewayId,
    millisFromUnknown(openclaw.gatewayAssignedAt) === operationAt,
    openclaw.gatewayProfile === controlState.gatewayProfile,
    openclaw.controlUiEnabled === controlState.controlUiEnabled,
    targetAssignmentExact,
    operationTimingExact,
    openclaw.runtimeReset === undefined,
  ].every(Boolean);
}

function recoveryTargetRootReady(
  root: ProjectedGatewayRoot | null,
  params: UnavailableGatewayRecoveryParams,
): root is ProjectedGatewayRoot {
  if (root === null) return false;
  return [
    params.sharedGatewayIds.includes(params.toGatewayId),
    root.gatewayClass === "shared",
    root.desiredStatus === "running",
    root.liveRelease !== null,
    root.desiredRelease === root.liveRelease,
  ].every(Boolean);
}

function recoveryTargetRuntimeReady(
  runtime: GatewayRuntimeDoc | null,
  root: ProjectedGatewayRoot,
  params: UnavailableGatewayRecoveryParams,
  nowMs: number,
): boolean {
  if (runtime === null) return false;
  const heartbeatAt = millisFromUnknown(runtime.heartbeat.lastHeartbeatAt);
  const heartbeatFresh = heartbeatAt === null
    ? false
    : nowMs - heartbeatAt <= params.targetHeartbeatMaxAgeMs;
  return [
    runtime.gatewayId === params.toGatewayId,
    runtime.release === root.liveRelease,
    runtime.lifecycle === "serving",
    runtime.heartbeat.status === "ready",
    heartbeatFresh,
    hasFreshReadyKubernetesObservation(runtime, nowMs, params.targetHeartbeatMaxAgeMs),
  ].every(Boolean);
}

function assertRecoveryTargetReady(input: {
  params: UnavailableGatewayRecoveryParams;
  targetRootData: Record<string, unknown> | undefined;
  targetRuntimeData: Record<string, unknown> | undefined;
  nowMs: number;
}): void {
  const { params, targetRootData, targetRuntimeData, nowMs } = input;
  const root = projectGatewayDesiredRootForGateway(targetRootData, params.toGatewayId);
  const runtime = isGatewayRuntimeDoc(targetRuntimeData) ? targetRuntimeData : null;
  if (
    !recoveryTargetRootReady(root, params) ||
    !recoveryTargetRuntimeReady(runtime, root, params, nowMs)
  ) {
    throw new Error(`recovery target runtime is not freshly ready: ${params.toGatewayId}`);
  }
}

function assertRecoverySourceIdentity(
  root: ProjectedGatewayRoot | null,
  openclaw: Record<string, unknown>,
  sourceAssignment: Record<string, unknown> | undefined,
  params: UnavailableGatewayRecoveryParams,
): asserts root is ProjectedGatewayRoot {
  if (!root || !sourceAssignment) {
    throw new Error("unavailable gateway recovery source changed before cutover");
  }
  const exact = [
    openclaw.gatewayId === params.fromGatewayId,
    sourceAssignment.uid === params.uid,
    sourceAssignment.slug === params.slug,
    sourceAssignment.gatewayId === params.fromGatewayId,
    sourceAssignment.state === "serving",
    sourceAssignment.epoch === params.expectedSourceEpoch,
  ].every(Boolean);
  if (!exact) throw new Error("unavailable gateway recovery source changed before cutover");
}

function assertSharedRecoverySource(
  root: ProjectedGatewayRoot,
  params: UnavailableGatewayRecoveryParams,
): void {
  const invalid = [
    root.gatewayClass !== "shared",
    root.desiredStatus !== "running",
    !params.sharedGatewayIds.includes(params.fromGatewayId),
  ].some(Boolean);
  if (invalid) throw new Error("shared gateway recovery source is not an active pool member");
}

function assertRecoverySource(input: {
  params: UnavailableGatewayRecoveryParams;
  sourceRootData: Record<string, unknown> | undefined;
  user: Record<string, unknown> | undefined;
  sourceAssignment: Record<string, unknown> | undefined;
}): void {
  const { params, sourceRootData, user, sourceAssignment } = input;
  const root = projectGatewayDesiredRootForGateway(sourceRootData, params.fromGatewayId);
  const openclaw = recordOrEmpty(recordOrEmpty(user?.provisioning).openclaw);
  assertRecoverySourceIdentity(root, openclaw, sourceAssignment, params);

  assertSharedRecoverySource(root, params);
}

function clearRecoveredSourceMount(input: {
  txn: FleetStateTxn;
  sourceRuntimeRef: FleetStateDocRef;
  sourceRuntimeSnapshot: {
    exists: boolean;
    data: () => Record<string, unknown> | undefined;
  };
  slug: string;
}): void {
  const runtimeData = input.sourceRuntimeSnapshot.exists
    ? input.sourceRuntimeSnapshot.data()
    : undefined;
  const runtime = isGatewayRuntimeDoc(runtimeData) ? runtimeData : null;
  if (!runtime?.heartbeat.mountedCustomers.includes(input.slug)) return;
  input.txn.update(input.sourceRuntimeRef, {
    heartbeat: {
      ...runtime.heartbeat,
      mountedCustomers: runtime.heartbeat.mountedCustomers.filter(
        (mountedCustomer) => mountedCustomer !== input.slug,
      ),
    },
  });
}

export async function commitUnavailableGatewayRecoveryAtomic(
  deps: FleetStateDeps,
  params: UnavailableGatewayRecoveryParams,
): Promise<{ operationId: string }> {
  if (params.kind !== "recover-shared-customer") {
    throw new Error("Builder recovery requires its retained home; metadata-only recovery is forbidden");
  }
  if (
    !params.operationId ||
    !Number.isSafeInteger(params.expectedSourceEpoch) ||
    params.expectedSourceEpoch < 0 ||
    params.fromGatewayId === params.toGatewayId
  ) {
    throw new Error("unavailable gateway recovery parameters are invalid");
  }
  const operationRef = deps.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .doc(params.operationId);
  const sourceAssignmentRef = assignmentRef(deps.db, params.fromGatewayId, params.uid);
  const targetAssignmentRef = assignmentRef(deps.db, params.toGatewayId, params.uid);
  const sourceRuntimeRef = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(params.fromGatewayId);
  const targetRuntimeRef = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(params.toGatewayId);
  const userRef = deps.db.collection("users").doc(params.uid);
  const nowMs = deps.now ? deps.now().getTime() : Date.now();

  await deps.db.runTransaction(async (txn) => {
    const [
      operationSnapshot,
      userSnapshot,
      sourceRootSnapshot,
      targetRootSnapshot,
      sourceRuntimeSnapshot,
      targetRuntimeSnapshot,
      sourceAssignmentSnapshot,
      targetAssignmentSnapshot,
    ] = await Promise.all([
      txn.get(operationRef),
      txn.get(userRef),
      txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.fromGatewayId)),
      txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.toGatewayId)),
      txn.get(sourceRuntimeRef),
      txn.get(targetRuntimeRef),
      txn.get(sourceAssignmentRef),
      txn.get(targetAssignmentRef),
    ]);
    const operation = operationSnapshot.exists ? operationSnapshot.data() : undefined;
    const user = userSnapshot.exists ? userSnapshot.data() : undefined;
    assertRestoreUnfenced(user);
    const targetAssignment = targetAssignmentSnapshot.exists
      ? targetAssignmentSnapshot.data()
      : undefined;
    if (recoveryAlreadyCommitted({
      params,
      operation,
      user,
      targetRootData: targetRootSnapshot.exists ? targetRootSnapshot.data() : undefined,
      sourceAssignmentExists: sourceAssignmentSnapshot.exists,
      targetAssignment,
    })) {
      return;
    }
    if (operationSnapshot.exists) {
      throw new Error(`recovery operation ${params.operationId} conflicts with current authority`);
    }
    assertRecoveryTargetReady({
      params,
      targetRootData: targetRootSnapshot.exists ? targetRootSnapshot.data() : undefined,
      targetRuntimeData: targetRuntimeSnapshot.exists ? targetRuntimeSnapshot.data() : undefined,
      nowMs,
    });
    if (!params.validateTarget) {
      throw new Error("unavailable gateway recovery requires an atomic target admission fence");
    }
    await params.validateTarget({
      txn,
      targetGatewayId: params.toGatewayId,
      targetRoot: targetRootSnapshot.data()!,
      targetRuntime: targetRuntimeSnapshot.data()!,
    });
    assertRecoverySource({
      params,
      sourceRootData: sourceRootSnapshot.exists ? sourceRootSnapshot.data() : undefined,
      user,
      sourceAssignment: sourceAssignmentSnapshot.exists
        ? sourceAssignmentSnapshot.data()
        : undefined,
    });
    const targetRoot = targetRootSnapshot.data();
    const controlState = resolveUserGatewayControlState(targetRoot, params.uid);
    clearRecoveredSourceMount({
      txn,
      sourceRuntimeRef,
      sourceRuntimeSnapshot,
      slug: params.slug,
    });
    txn.update(userRef, {
      "provisioning.openclaw.gatewayId": params.toGatewayId,
      "provisioning.openclaw.gatewayAssignedAt": nowMs,
      "provisioning.openclaw.gatewayProfile": controlState.gatewayProfile,
      "provisioning.openclaw.controlUiEnabled": controlState.controlUiEnabled,
      [WORKSPACE_MIGRATION_MARKER_PATH]: deps.deleteField(),
    });
    txn.set(targetAssignmentRef, {
      uid: params.uid,
      slug: params.slug,
      gatewayId: params.toGatewayId,
      source: "repair",
      state: "serving" satisfies AssignmentState,
      epoch: params.expectedSourceEpoch + 1,
      updatedAt: nowMs,
      updatedByOperationId: params.operationId,
    });
    txn.delete(sourceAssignmentRef);
    txn.set(operationRef, {
      kind: MIGRATE_CUSTOMER_OPERATION_KIND,
      status: "succeeded",
      origin: "automatic",
      createdBy: "glm-controller-placement-policy",
      createdAt: nowMs,
      startedAt: nowMs,
      completedAt: nowMs,
      input: {
        uid: params.uid,
        slug: params.slug,
        recoveryKind: params.kind,
        fromGatewayId: params.fromGatewayId,
        toGatewayId: params.toGatewayId,
        sourceEpoch: params.expectedSourceEpoch,
      },
      steps: [],
      gatewayId: params.toGatewayId,
      inputUid: params.uid,
    });
  });
  return { operationId: params.operationId };
}

export interface RecoveredDisposableRuntimeResetParams {
  operationId: string;
  previousRecoveryOperationId: string;
  uid: string;
  slug: string;
  targetGatewayId: string;
  expectedAssignmentEpoch: number;
  sharedGatewayIds: readonly string[];
  targetHeartbeatMaxAgeMs: number;
}

function priorDisposableRecovery(input: {
  operation: Record<string, unknown> | undefined;
  params: RecoveredDisposableRuntimeResetParams;
}): {
  sourceGatewayId: string;
  leaseId: string;
  leaseGeneration: number;
} | null {
  const { operation, params } = input;
  const priorInput = recordOrEmpty(operation?.input);
  const lease = recordOrEmpty(priorInput.disposableLease);
  const sourceGatewayId = typeof priorInput.fromGatewayId === "string"
    ? priorInput.fromGatewayId
    : "";
  const leaseId = typeof lease.leaseId === "string" ? lease.leaseId : "";
  const leaseGeneration = lease.generation;
  const exact = [
    operation?.kind === MIGRATE_CUSTOMER_OPERATION_KIND,
    operation?.status === "succeeded",
    operation?.origin === "automatic",
    operation?.createdBy === "glm-controller-placement-policy",
    operation?.gatewayId === params.targetGatewayId,
    operation?.inputUid === params.uid,
    priorInput.uid === params.uid,
    priorInput.slug === params.slug,
    priorInput.recoveryKind === "recover-disposable-customer",
    priorInput.toGatewayId === params.targetGatewayId,
    priorInput.sourceEpoch === params.expectedAssignmentEpoch - 1,
    sourceGatewayId.length > 0,
    leaseId.length > 0,
    Number.isSafeInteger(leaseGeneration),
    (leaseGeneration as number) >= 0,
  ].every(Boolean);
  return exact
    ? { sourceGatewayId, leaseId, leaseGeneration: leaseGeneration as number }
    : null;
}

function recoveredRuntimeResetMarker(input: {
  params: RecoveredDisposableRuntimeResetParams;
  prior: NonNullable<ReturnType<typeof priorDisposableRecovery>>;
  requestedAt: number;
}): Record<string, unknown> {
  return {
    status: "pending",
    uid: input.params.uid,
    slug: input.params.slug,
    operationId: input.params.operationId,
    sourceGatewayId: input.prior.sourceGatewayId,
    targetGatewayId: input.params.targetGatewayId,
    generation: input.params.expectedAssignmentEpoch + 1,
    disposableLeaseId: input.prior.leaseId,
    disposableLeaseGeneration: input.prior.leaseGeneration,
    requestedAt: input.requestedAt,
  };
}

function storedResetMatches(
  value: unknown,
  expected: Record<string, unknown>,
): boolean {
  const actual = recordOrEmpty(value);
  if (actual.status !== "pending" && actual.status !== "acknowledged") return false;
  return Object.entries(expected)
    .filter(([key]) => key !== "status")
    .every(([key, expectedValue]) => actual[key] === expectedValue);
}

function recoveredRuntimeResetReplayIsExact(input: {
  params: RecoveredDisposableRuntimeResetParams;
  operation: Record<string, unknown> | undefined;
  assignment: Record<string, unknown> | undefined;
  runtimeReset: unknown;
  marker: Record<string, unknown>;
}): boolean {
  const operationInput = recordOrEmpty(input.operation?.input);
  return [
    input.operation?.kind === MIGRATE_CUSTOMER_OPERATION_KIND,
    input.operation?.status === "succeeded",
    operationInput.recoveryKind === "recover-disposable-customer-runtime-reset",
    operationInput.previousRecoveryOperationId === input.params.previousRecoveryOperationId,
    input.assignment?.epoch === input.params.expectedAssignmentEpoch + 1,
    input.assignment?.updatedByOperationId === input.params.operationId,
    storedResetMatches(input.runtimeReset, input.marker),
  ].every(Boolean);
}

function recoveredRuntimeResetTargetIsReady(input: {
  params: RecoveredDisposableRuntimeResetParams;
  targetRoot: ProjectedGatewayRoot | null;
  targetRuntime: GatewayRuntimeDoc | null;
  nowMs: number;
}): boolean {
  const heartbeatAt = millisFromUnknown(input.targetRuntime?.heartbeat.lastHeartbeatAt);
  return [
    input.targetRoot?.gatewayClass === "shared",
    input.targetRoot?.desiredStatus === "running",
    input.targetRoot?.liveRelease !== null,
    input.targetRoot?.desiredRelease === input.targetRoot?.liveRelease,
    input.targetRuntime?.gatewayId === input.params.targetGatewayId,
    input.targetRuntime?.release === input.targetRoot?.liveRelease,
    input.targetRuntime?.lifecycle === "serving",
    heartbeatAt !== null,
    heartbeatAt !== null && input.nowMs - heartbeatAt <= input.params.targetHeartbeatMaxAgeMs,
    !input.targetRuntime?.heartbeat.mountedCustomers.includes(input.params.slug),
  ].every(Boolean);
}

function recoveredRuntimeResetCustomerStateIsExact(input: {
  params: RecoveredDisposableRuntimeResetParams;
  openclaw: Record<string, unknown>;
  assignment: Record<string, unknown> | undefined;
}): boolean {
  return [
    input.openclaw.gatewayId === input.params.targetGatewayId,
    input.openclaw.runtimeReset === undefined,
    input.assignment?.uid === input.params.uid,
    input.assignment?.slug === input.params.slug,
    input.assignment?.gatewayId === input.params.targetGatewayId,
    input.assignment?.source === "repair",
    input.assignment?.state === "serving",
    input.assignment?.epoch === input.params.expectedAssignmentEpoch,
    input.assignment?.updatedByOperationId === input.params.previousRecoveryOperationId,
  ].every(Boolean);
}

export async function commitRecoveredDisposableRuntimeResetAtomic(
  deps: FleetStateDeps,
  params: RecoveredDisposableRuntimeResetParams,
): Promise<{ operationId: string }> {
  if (
    !params.operationId ||
    !params.previousRecoveryOperationId ||
    !params.sharedGatewayIds.includes(params.targetGatewayId) ||
    !Number.isSafeInteger(params.expectedAssignmentEpoch) ||
    params.expectedAssignmentEpoch < 1
  ) {
    throw new Error("recovered disposable runtime reset parameters are invalid");
  }
  const nowMs = deps.now ? deps.now().getTime() : Date.now();
  const userRef = deps.db.collection("users").doc(params.uid);
  const targetRootRef = deps.db.collection(GATEWAYS_COLLECTION).doc(params.targetGatewayId);
  const targetRuntimeRef = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(params.targetGatewayId);
  const assignment = assignmentRef(deps.db, params.targetGatewayId, params.uid);
  const previousOperation = deps.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .doc(params.previousRecoveryOperationId);
  const operation = deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(params.operationId);

  await deps.db.runTransaction(async (txn) => {
    const [
      userSnapshot,
      targetRootSnapshot,
      targetRuntimeSnapshot,
      assignmentSnapshot,
      previousOperationSnapshot,
      operationSnapshot,
    ] = await Promise.all([
      txn.get(userRef),
      txn.get(targetRootRef),
      txn.get(targetRuntimeRef),
      txn.get(assignment),
      txn.get(previousOperation),
      txn.get(operation),
    ]);
    const user = userSnapshot.data();
    assertRestoreUnfenced(user);
    const openclaw = recordOrEmpty(recordOrEmpty(user?.provisioning).openclaw);
    const targetRoot = projectGatewayDesiredRootForGateway(
      targetRootSnapshot.data(),
      params.targetGatewayId,
    );
    const targetRuntimeData = targetRuntimeSnapshot.data();
    const targetRuntime = isGatewayRuntimeDoc(targetRuntimeData) ? targetRuntimeData : null;
    const prior = priorDisposableRecovery({
      operation: previousOperationSnapshot.data(),
      params,
    });
    if (!prior) throw new Error("previous disposable recovery fence changed");
    const marker = recoveredRuntimeResetMarker({ params, prior, requestedAt: nowMs });
    const assignmentData = assignmentSnapshot.data();

    if (operationSnapshot.exists) {
      const operationData = operationSnapshot.data();
      if (recoveredRuntimeResetReplayIsExact({
        params,
        operation: operationData,
        assignment: assignmentData,
        runtimeReset: openclaw.runtimeReset,
        marker,
      })) return;
      throw new Error(`recovered runtime reset ${params.operationId} conflicts with current state`);
    }

    const targetExact = recoveredRuntimeResetTargetIsReady({
      params,
      targetRoot,
      targetRuntime,
      nowMs,
    }) && recoveredRuntimeResetCustomerStateIsExact({
      params,
      openclaw,
      assignment: assignmentData,
    });
    if (!targetExact) throw new Error("recovered disposable runtime reset fence changed");

    txn.update(userRef, { "provisioning.openclaw.runtimeReset": marker });
    txn.set(assignment, {
      ...assignmentData,
      epoch: params.expectedAssignmentEpoch + 1,
      updatedAt: nowMs,
      updatedByOperationId: params.operationId,
    });
    txn.set(operation, {
      kind: MIGRATE_CUSTOMER_OPERATION_KIND,
      status: "succeeded",
      origin: "automatic",
      createdBy: "glm-controller-placement-policy",
      createdAt: nowMs,
      startedAt: nowMs,
      completedAt: nowMs,
      input: {
        uid: params.uid,
        slug: params.slug,
        recoveryKind: "recover-disposable-customer-runtime-reset",
        previousRecoveryOperationId: params.previousRecoveryOperationId,
        targetGatewayId: params.targetGatewayId,
        sourceEpoch: params.expectedAssignmentEpoch,
        disposableLease: {
          leaseId: prior.leaseId,
          generation: prior.leaseGeneration,
        },
      },
      steps: [],
      gatewayId: params.targetGatewayId,
      inputUid: params.uid,
    });
  });
  return { operationId: params.operationId };
}

export interface MarkAssignmentStateParams {
  gatewayId: string;
  uid: string;
  state: AssignmentState;
  slug?: string;
  epoch?: number;
  updatedByOperationId?: string;
  createIfMissing?: boolean;
  expected?: {
    state: AssignmentState;
    updatedByOperationId: string | null;
    updatedAt?: number;
  };
  automatic?: boolean;
  clearSharedSurgeForwardRecovery?: { operationId: string; targetPodUid: string; receivingPodUid: string };
}

interface SharedSurgeForwardRecoveryParams {
  gatewayId: string; uid: string; slug: string; epoch: number; operationId: string;
  targetPodUid: string; expectedUpdatedAt: number;
}

export async function markSharedSurgeForwardRecovery(deps: FleetStateDeps, params: SharedSurgeForwardRecoveryParams): Promise<void> {
  await writeSharedSurgeForwardRecovery(deps, { ...params, receivingPodUid: params.targetPodUid });
}

export async function rebindSharedSurgeForwardRecovery(deps: FleetStateDeps, params: SharedSurgeForwardRecoveryParams & {
  expectedReceivingPodUid: string; receivingPodUid: string;
}): Promise<void> {
  await writeSharedSurgeForwardRecovery(deps, params);
}

async function writeSharedSurgeForwardRecovery(deps: FleetStateDeps, params: SharedSurgeForwardRecoveryParams & {
  receivingPodUid: string; expectedReceivingPodUid?: string;
}): Promise<void> {
  if (![params.gatewayId, params.uid, params.slug, params.operationId, params.targetPodUid, params.receivingPodUid,
    params.expectedReceivingPodUid ?? params.targetPodUid].every(value =>
    typeof value === "string" && value.length > 0 && !value.includes("/")) ||
    !Number.isSafeInteger(params.epoch) || params.epoch < 0 ||
    !Number.isSafeInteger(params.expectedUpdatedAt) || params.expectedUpdatedAt <= 0) {
    throw new Error("Shared surge forward recovery identity is invalid");
  }
  await deps.db.runTransaction(async txn => {
    const ref = assignmentRef(deps.db, params.gatewayId, params.uid);
    const [snapshot, root] = await Promise.all([
      txn.get(ref), txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.gatewayId)),
    ]);
    const assignment = snapshot.data();
    const marker = { operationId: params.operationId, targetPodUid: params.targetPodUid, receivingPodUid: params.receivingPodUid };
    const prior = params.expectedReceivingPodUid === undefined ? marker : { ...marker, receivingPodUid: params.expectedReceivingPodUid };
    const markerMatches = isDeepStrictEqual(assignment?.sharedSurgeForwardRecovery, prior) ||
      params.expectedReceivingPodUid === undefined && assignment?.sharedSurgeForwardRecovery === undefined;
    const exact = [snapshot.exists, root.data()?.gatewayClass === "shared",
      assignment?.uid === params.uid, assignment?.slug === params.slug, assignment?.gatewayId === params.gatewayId,
      assignment?.epoch === params.epoch, assignment?.state === "quiescing",
      assignment?.updatedByOperationId === params.operationId, assignment?.updatedAt === params.expectedUpdatedAt,
      markerMatches,
    ].every(Boolean);
    if (!exact) throw new Error("Shared surge forward recovery authority changed");
    txn.update(ref, { sharedSurgeForwardRecovery: marker });
  });
}

// Flip ONLY the roster state on an existing assignment — epoch stays put. The
// gated quiesce writes "quiescing" here BEFORE the source pod is quiesced
// (blocking source serving ahead of the target ever serving — no double-serve
// window); a pre-cutover rollback writes "serving" to restore the source. No-op
// when the customer has no assignment doc (legacy migration): there is no
// roster entry for the edge to consult, so nothing to gate.
export async function markAssignmentState(
  deps: FleetStateDeps,
  params: MarkAssignmentStateParams,
): Promise<void> {
  await deps.db.runTransaction(async (txn) => {
    const restoreOwner = await txn.get(deps.db.collection("users").doc(params.uid));
    assertRestoreUnfenced(restoreOwner.data());
    const ref = assignmentRef(deps.db, params.gatewayId, params.uid);
    const snap = await txn.get(ref);
    if (!snap.exists) {
      if (params.expected?.updatedAt !== undefined) throw new Error("source assignment changed before roster state update");
      if (!params.createIfMissing) return;
      createMissingAssignment(txn, ref, deps, params);
      return;
    }
    const assignment = snap.data();
    assertAssignmentStateUpdateMatches(assignment, params);
    assertSharedSurgeForwardStateUpdate(assignment, params);
    const updatesClock = params.updatedByOperationId || params.expected?.updatedAt !== undefined;
    const updatedAt = nextAssignmentStateClock(deps, updatesClock ? assignment?.updatedAt : undefined);
    txn.update(ref, {
      state: params.state,
      ...(updatesClock ? { updatedAt } : {}),
      ...(params.updatedByOperationId ? { updatedByOperationId: params.updatedByOperationId } : {}),
      ...(params.clearSharedSurgeForwardRecovery ? { sharedSurgeForwardRecovery: deps.deleteField() } : {}),
    });
    writeWorkspaceMigrationMarkerForState(txn, deps, params, updatedAt);
  });
}

function assertSharedSurgeForwardStateUpdate(assignment: Record<string, unknown> | undefined, params: MarkAssignmentStateParams): void {
  const marker = assignment?.sharedSurgeForwardRecovery;
  const clear = params.clearSharedSurgeForwardRecovery;
  if (clear !== undefined) {
    const exact = [params.state === "serving", isDeepStrictEqual(marker, clear),
      params.updatedByOperationId === clear.operationId, params.expected?.updatedByOperationId === clear.operationId,
      params.expected?.state === "quiescing", params.expected?.updatedAt !== undefined,
      params.slug !== undefined, params.epoch !== undefined].every(Boolean);
    if (!exact) throw new Error("Shared surge forward recovery completion authority changed");
  } else if (marker !== undefined && (params.state === "serving" ||
    params.updatedByOperationId !== undefined && params.updatedByOperationId !== assignment?.updatedByOperationId)) {
    throw new Error("Shared surge forward recovery cannot reopen its source or change owner");
  }
}

function nextAssignmentStateClock(deps: FleetStateDeps, previous: unknown = 0): number {
  if (typeof previous !== "number" || !Number.isSafeInteger(previous) || previous < 0) {
    throw new Error("source assignment clock is invalid");
  }
  const updatedAt = Math.max(deps.now ? deps.now().getTime() : Date.now(), previous + 1);
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw new Error("source assignment clock is invalid");
  return updatedAt;
}

function writeWorkspaceMigrationMarkerForState(
  txn: FleetStateTxn,
  deps: FleetStateDeps,
  params: MarkAssignmentStateParams,
  updatedAt: number,
): void {
  if (params.state === "quiescing") {
    txn.update(deps.db.collection("users").doc(params.uid), {
      [WORKSPACE_MIGRATION_MARKER_PATH]: workspaceMigrationMarker(
        params.updatedByOperationId,
        updatedAt,
      ),
    });
    return;
  }
  if (params.state === "serving") clearWorkspaceMigrationMarker(txn, deps, params.uid);
}

function createMissingAssignment(
  txn: FleetStateTxn,
  ref: FleetStateDocRef,
  deps: FleetStateDeps,
  params: MarkAssignmentStateParams,
): void {
  const exactBinding = [
    params.state === "quiescing",
    params.slug,
    typeof params.epoch === "number",
    params.updatedByOperationId,
  ].every(Boolean);
  if (!exactBinding) {
    throw new Error("unassigned source quiesce requires an exact operation binding");
  }
  const updatedAt = nextAssignmentStateClock(deps);
  txn.set(ref, {
    uid: params.uid,
    slug: params.slug,
    gatewayId: params.gatewayId,
    source: MIGRATE_CUSTOMER_OPERATION_KIND,
    state: params.state,
    epoch: params.epoch,
    updatedAt,
    updatedByOperationId: params.updatedByOperationId,
  });
  writeWorkspaceMigrationMarkerForState(txn, deps, params, updatedAt);
}

function assertAssignmentStateUpdateMatches(
  assignment: Record<string, unknown> | undefined,
  params: MarkAssignmentStateParams,
): void {
  const current = assignment ?? {};
  const currentOwner = typeof current.updatedByOperationId === "string"
    ? current.updatedByOperationId
    : null;
  const exact = [
    params.slug === undefined || current.slug === params.slug,
    params.epoch === undefined || current.epoch === params.epoch,
    current.gatewayId === undefined || current.gatewayId === params.gatewayId,
    current.uid === undefined || current.uid === params.uid,
    !params.createIfMissing || current.updatedByOperationId === params.updatedByOperationId,
    params.expected === undefined || (
      current.state === params.expected.state &&
      currentOwner === params.expected.updatedByOperationId &&
      assignmentClockMatches(current.updatedAt, params.expected.updatedAt)
    ),
  ].every(Boolean);
  if (!exact) throw new Error("source assignment changed before roster state update");
}

function assignmentClockMatches(current: unknown, expected: number | undefined): boolean {
  return expected === undefined || Number.isSafeInteger(expected) && expected > 0 && current === expected;
}

function assignmentRef(
  db: FleetStateFirestore,
  gatewayId: string,
  uid: string,
): FleetStateDocRef {
  const gatewayDoc = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
  if (!gatewayDoc.collection) {
    throw new Error("FleetStateFirestore doc ref does not support subcollections");
  }
  return gatewayDoc.collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(uid);
}
