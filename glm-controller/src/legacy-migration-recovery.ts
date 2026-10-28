import { isBuilderActivateOperationIdFor } from "@octogee/core/builder-activation-lease";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { customerRuntimeMutationFenced, GATEWAY_ASSIGNMENTS_SUBCOLLECTION } from "@octogee/shared/types/gateway-releases";
import { GLM_OPERATIONS_COLLECTION, readSchedulerMigrationIdentity, type Operation, type SchedulerHandoffState } from "@octogee/shared/types/glm";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { readWorkspaceMigrationMarker } from "@octogee/shared/types/workspace-migration";
import { builderActivationRecoveryTargetMatches } from "@octogee/core/fleet-state";
import { classifyOperationFailure, retryBackoffMs } from "./operation-retry.js";

function handoffAttemptEvidence(operation: Partial<Operation>) {
  const handoff = operation.schedulerHandoff;
  const identity = readSchedulerMigrationIdentity(operation.id, handoff?.migrationId);
  if (!identity) return undefined;
  if (handoff?.sourceRecovery) {
    return handoff.sourceRecovery.migrationId === handoff.migrationId ? handoff.sourceRecovery : undefined;
  }
  const { attempt, claimStartedAt } = identity;
  const claimMatches = (startedAt: number | null | undefined) => claimStartedAt === startedAt;
  const prior = operation.attemptHistory?.slice().reverse().find((entry) => entry.attempt === attempt && claimMatches(entry.startedAt));
  const currentAttempt = operation.status === "running" ? (operation.attempts ?? 0) + 1 : operation.attempts;
  return prior ?? (currentAttempt === attempt && claimMatches(operation.startedAt) ? { steps: operation.steps } : undefined);
}

const SOURCE_HOLDING_STEP_STATUSES: ReadonlySet<string> = new Set(["running", "done", "failed"]);

export function attemptNeverHeldSource(operation: Partial<Operation>): boolean {
  const steps = handoffAttemptEvidence(operation)?.steps;
  return steps !== undefined && steps.length > 0 &&
    !steps.some((step) => step.name === "quiesce-source" && SOURCE_HOLDING_STEP_STATUSES.has(step.status));
}

export function attemptMayHoldSourceIngress(operation: Partial<Operation>): boolean {
  const steps = handoffAttemptEvidence(operation)?.steps ?? [];
  return steps.some((step) =>
    step.name === "wait-for-active-work" && (step.status === "running" || step.status === "done"));
}

function failedActivationHeldSource(operation: Partial<Operation>): boolean {
  return operation.input?.recoverSourceOnly === true ||
    handoffAttemptEvidence(operation)?.steps?.some((step) => step.name === "quiesce-source") !== false;
}

export function builderActivationSourceRecoveryPending(operation: Partial<Operation>): boolean {
  const input = operation.input;
  return operation.kind === "migrate-customer" && input?.source === "builder-activation-lease" &&
    isBuilderActivateOperationIdFor(operation.id, input.toGatewayId) &&
    typeof input.fromGatewayId === "string" && input.fromGatewayId.startsWith("shared-") &&
    operation.schedulerHandoff?.stageAfterCutover === true && operation.customerMigrationV2 === undefined &&
    operation.cutoverCommittedAt === undefined && operation.rolledBack !== true &&
    (operation.status === "pending" || operation.status === "running" ||
      operation.status === "failed" && failedActivationHeldSource(operation));
}

function failedPreSyncCleanup(operation: Operation): boolean {
  const steps = handoffAttemptEvidence(operation)?.steps;
  return steps?.length === 3 &&
    steps[0]?.name === "keys-sync-state" && steps[0].status === "done" &&
    steps[1]?.name === "pre-sync-state" && steps[1].status === "failed" &&
    steps[2]?.name === "rollback:unmount-target" && steps[2].status === "failed";
}

function incompleteNativeCleanup(error: unknown): boolean {
  return typeof error === "string" &&
    /agent database files are still held open:|native cleanup incomplete: purgeFailed=(?:true failed=\[|false failed=\[[^\]])|deletion cleanup is still pending/.test(error);
}

function legacyHeldTargetCleanupPending(operation: Operation): boolean {
  return incompleteNativeCleanup(handoffAttemptEvidence(operation)?.steps?.[1]?.error) && failedPreSyncCleanup(operation);
}

function rollbackRecoveryPending(operation: Operation): boolean {
  const steps = handoffAttemptEvidence(operation)?.steps;
  const failures = steps?.filter((step) => step.name.startsWith("rollback:") && step.status === "failed") ?? [];
  return failures.length > 0 && (failures.some((step) => incompleteNativeCleanup(step.error) || classifyOperationFailure(step.error) === "transient") ||
    steps!.some((step) => !step.name.startsWith("rollback:") && step.status === "failed" && classifyOperationFailure(step.error) === "transient"));
}

export function sourceRecoveryForwardRetryable(operation: Partial<Operation>): boolean {
  const steps = handoffAttemptEvidence(operation)?.steps;
  return steps !== undefined && steps.filter((step) => !step.name.startsWith("rollback:") && step.status === "failed")
    .every((step) => incompleteNativeCleanup(step.error) || classifyOperationFailure(step.error) === "transient");
}

export function legacyAttemptNeverQuiesced(operation: Operation): boolean {
  if (operation.customerMigrationV2 !== undefined ||
      !([operation.input.fromGatewayId, operation.input.toGatewayId].every((id) => typeof id === "string" && id.startsWith("shared-")) ||
        builderActivationSourceRecoveryPending(operation))) return false;
  if (failedPreSyncCleanup(operation)) return true;
  const steps = handoffAttemptEvidence(operation)?.steps;
  return steps?.length === 1 && steps[0]?.name === "keys-sync-state" && steps[0].status === "failed";
}

function recoverableLegacyScope(operation: Operation & { cancellationRequestedAt?: number }): boolean {
  const input = operation.input;
  const handoff = operation.schedulerHandoff;
  if (!handoff || typeof input.fromGatewayId !== "string" || typeof input.toGatewayId !== "string") return false;
  const identity = readSchedulerMigrationIdentity(operation.id, handoff.migrationId);
  return [
    operation.kind === "migrate-customer", operation.customerMigrationV2 === undefined, handoff.forwardRecovery === undefined,
    operation.cutoverCommittedAt === undefined, operation.cancellationRequestedAt === undefined,
    operation.sourceTransferExecution === undefined, input.sourceTransferMode === undefined,
    Array.isArray(operation.steps),
    typeof input.uid === "string", input.fromGatewayId.startsWith("shared-"), input.fromGatewayId !== input.toGatewayId,
    handoff.uid === input.uid, handoff.fromGatewayId === input.fromGatewayId, handoff.toGatewayId === input.toGatewayId,
    input.toGatewayId.startsWith("shared-") && handoff.stageAfterCutover !== true || builderActivationSourceRecoveryPending(operation),
    identity !== null,
  ].every(Boolean);
}

function ownsLegacySource(operation: Operation, user: FirebaseFirestore.DocumentData | undefined, assignment: FirebaseFirestore.DocumentData | undefined, targetExists: boolean): boolean {
  const openclaw = user?.provisioning?.openclaw;
  if (!assignment || !openclaw) return false;
  return [
    !customerRuntimeMutationFenced(user), !targetExists, openclaw.gatewayId === operation.input.fromGatewayId,
    readWorkspaceMigrationMarker(openclaw)?.operationId === operation.id ||
      openclaw.migration === undefined && assignment.state === "serving" && assignment.updatedByOperationId === operation.id,
    assignment.uid === operation.input.uid, assignment.gatewayId === operation.input.fromGatewayId,
    Number.isSafeInteger(assignment.epoch), assignment.epoch >= 0,
    assignment.state === "serving" || assignment.state === "quiescing" && assignment.updatedByOperationId === operation.id,
  ].every(Boolean);
}

function recoveryAttemptHistory(operation: Operation, now: number): { attempt: number; history: NonNullable<Operation["attemptHistory"]> } {
  const attempt = operation.status === "running"
    ? (operation.attempts ?? 0) + 1
    : Math.max(operation.attempts ?? 0, readSchedulerMigrationIdentity(operation.id, operation.schedulerHandoff!.migrationId)!.attempt);
  const currentAttempt = operation.status === "running" ? (operation.attempts ?? 0) + 1 : operation.attempts;
  const recorded = currentAttempt === attempt && !operation.attemptHistory?.some((entry) => entry.attempt === attempt) ? [{
    attempt, startedAt: operation.startedAt ?? now, completedAt: now,
    error: operation.error ?? "controller restarted mid-op; native source recovery required",
    classification: "transient" as const, steps: operation.steps,
  }] : [];
  return { attempt, history: [...operation.attemptHistory ?? [], ...recorded].slice(-20) };
}

function recoveryIntent(operation: Operation, sourceEpoch: number): NonNullable<SchedulerHandoffState["sourceRecovery"]> | null {
  const handoff = operation.schedulerHandoff!;
  const prior = handoff.sourceRecovery;
  if (prior) return prior.migrationId === handoff.migrationId && prior.sourceEpoch === sourceEpoch && Array.isArray(prior.steps) ? prior : null;
  const steps = handoffAttemptEvidence(operation)?.steps;
  if (!steps) return null;
  return { migrationId: handoff.migrationId, sourceEpoch, steps };
}

function recoveryRearmPatch(operation: Operation, intent: NonNullable<SchedulerHandoffState["sourceRecovery"]>, now: number) {
  const { attempt, history } = recoveryAttemptHistory(operation, now);
  return {
    status: "pending", startedAt: null, completedAt: null, steps: [],
    "input.recoverSourceOnly": true, schedulerHandoffReleased: false,
    schedulerHandoff: { ...operation.schedulerHandoff, sourceRecovery: intent },
    attempts: Math.max(operation.attempts ?? 0, attempt), attemptHistory: history,
    error: FieldValue.delete(), expireAt: FieldValue.delete(), lastProgressAt: FieldValue.delete(),
    nextAttemptAt: operation.schedulerHandoff!.sourceRecovery ? now + retryBackoffMs(attempt) : FieldValue.delete(),
    waitingOn: FieldValue.delete(), rolledBack: FieldValue.delete(),
  };
}

function failedRecoveryAdmitted(operation: Operation): boolean {
  if (operation.status !== "failed") return false;
  if (operation.input.recoverSourceOnly === true) {
    return operation.rolledBack !== true && operation.schedulerHandoffReleased !== true && handoffAttemptEvidence(operation)?.steps !== undefined;
  }
  if (builderActivationSourceRecoveryPending(operation)) return true;
  return typeof operation.error === "string" && (legacyHeldTargetCleanupPending(operation) || rollbackRecoveryPending(operation) ||
    /^reaped: (?:controller restarted mid-op|op exceeded \d+m running budget)/.test(operation.error) ||
    /gateway starting; retry shortly|rsync import port \d+ is already serving migrationId=/.test(operation.error));
}

export async function rearmOwnedLegacyMigration(input: {
  db: Firestore;
  ref: FirebaseFirestore.DocumentReference;
  now: number;
  admitted: (operation: Operation) => boolean;
}): Promise<boolean> {
  return input.db.runTransaction(async (txn) => {
    const snapshot = await txn.get(input.ref);
    const operation = { ...snapshot.data(), id: input.ref.id } as Operation;
    if (!snapshot.exists || operation.kind !== "migrate-customer" || !operation.input ||
        !input.admitted(operation) || !recoverableLegacyScope(operation)) return false;
    if (operation.input.recoverSourceOnly === true && operation.schedulerHandoffReleased === true) return false;
    const { uid, fromGatewayId, toGatewayId } = operation.input as { uid: string; fromGatewayId: string; toGatewayId: string };
    const [user, source, target] = await Promise.all([
      txn.get(input.db.collection("users").doc(uid)),
      txn.get(input.db.collection(GATEWAYS_COLLECTION).doc(fromGatewayId).collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(uid)),
      txn.get(input.db.collection(GATEWAYS_COLLECTION).doc(toGatewayId).collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(uid)),
    ]);
    if (!ownsLegacySource(operation, user.data(), source.data(), target.exists)) return false;
    const intent = recoveryIntent(operation, source.data()!.epoch);
    if (!intent) return false;
    if (builderActivationSourceRecoveryPending(operation)) {
      const root = await txn.get(input.db.collection(GATEWAYS_COLLECTION).doc(toGatewayId));
      if (!builderActivationRecoveryTargetMatches({ operationId: operation.id, input: operation.input,
        openclaw: user.data()!.provisioning.openclaw, sourceEpoch: intent.sourceEpoch, targetRoot: root.data() })) return false;
    }
    txn.update(input.ref, recoveryRearmPatch(operation, intent, input.now));
    return true;
  });
}

export async function recoverFailedLegacyMigrations(deps: { db: Firestore; log: (message: string) => void; now: () => number }): Promise<void> {
  const snapshot = await deps.db.collection(GLM_OPERATIONS_COLLECTION).where("status", "==", "failed").get();
  for (const doc of snapshot.docs) {
    try {
      const rearmed = await rearmOwnedLegacyMigration({ db: deps.db, ref: doc.ref, now: deps.now(), admitted: failedRecoveryAdmitted });
      if (rearmed) deps.log(`[migration-recovery] queued native source recovery for ${doc.id}; assignment and marker remain held`);
    } catch (error) {
      deps.log(`[migration-recovery] ${doc.id} recovery admission failed: ${String(error)}`);
    }
  }
}
