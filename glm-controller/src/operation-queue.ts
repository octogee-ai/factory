import { serialFleetOperationsConflict, type RolloutLane } from "@octogee/core/fleet-operation-lock";

const ACCOUNT_SUSPENSION_KIND = "suspend-customer";

export const SERIALLY_EXCLUSIVE_OPERATION_KINDS: ReadonlySet<string> = new Set([
  "rollout",
  "migrate-customer",
  ACCOUNT_SUSPENSION_KIND,
]);

export function isSeriallyExclusiveKind(kind: string): boolean {
  return SERIALLY_EXCLUSIVE_OPERATION_KINDS.has(kind);
}

export interface OperationRef {
  id: string;
  kind: string;
  rolloutLane?: RolloutLane;
  input?: Record<string, unknown>;
  customerMigrationV2?: {
    sourceGatewayId?: string;
    sourceRevisionId?: string;
    targetGatewayId?: string;
    targetRevisionId?: string;
  };
  cutoverCommittedAt?: number;
}

export interface SerialConflict {
  conflictingOpId: string;
  waitingOn: string;
}

export function findRunningRolloutParentOperationId(
  gatewayId: string,
  runningOperations: ReadonlyArray<OperationRef>,
): string | null {
  const matches = runningOperations.filter((operation) =>
    operation.kind === "rollout" &&
    (operation.input?.gatewayId === gatewayId || operation.input?.fromGatewayId === gatewayId)
  );
  if (matches.length > 1) {
    throw new Error(`multiple running rollout operations target gateway ${gatewayId}`);
  }
  return matches[0]?.id ?? null;
}

function operationsConflict(candidate: OperationRef, other: OperationRef): boolean {
  if (candidate.kind === ACCOUNT_SUSPENSION_KIND || other.kind === ACCOUNT_SUSPENSION_KIND) {
    return candidate.kind === other.kind;
  }
  return serialFleetOperationsConflict(candidate, other);
}

export function findSerialConflict(
  candidate: OperationRef,
  runningOpsSameKind: ReadonlyArray<OperationRef>,
): SerialConflict | null {
  const conflict = runningOpsSameKind.find(
    (running) => running.id !== candidate.id && operationsConflict(candidate, running),
  );
  if (!conflict) return null;
  return { conflictingOpId: conflict.id, waitingOn: describeWaitingOn(conflict) };
}

function inputString(input: OperationRef["input"], key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}

function rolloutWaitingOn(input: OperationRef["input"]): string | null {
  const gatewayId = inputString(input, "gatewayId");
  if (!gatewayId) return null;
  const imageTag = inputString(input, "imageTag");
  return imageTag ? `roll ${gatewayId} → ${imageTag}` : `roll ${gatewayId}`;
}

function migrationWaitingOn(input: OperationRef["input"]): string | null {
  const toGatewayId = inputString(input, "toGatewayId");
  if (!toGatewayId) return null;
  const fromGatewayId = inputString(input, "fromGatewayId");
  return fromGatewayId ? `migration ${fromGatewayId} → ${toGatewayId}` : `migration → ${toGatewayId}`;
}

const WAITING_ON_DESCRIPTIONS: Readonly<Record<string, (input: OperationRef["input"]) => string | null>> = {
  rollout: rolloutWaitingOn,
  "migrate-customer": migrationWaitingOn,
  [ACCOUNT_SUSPENSION_KIND]: () => "another account suspension",
};

function describeWaitingOn(op: OperationRef): string {
  return WAITING_ON_DESCRIPTIONS[op.kind]?.(op.input) ?? `another ${op.kind} operation`;
}

export interface PendingOperationRef extends OperationRef {
  createdAt: number;
  queuedAt?: number;
  nextAttemptAt?: number | null;
}

export interface OperationClaimCandidate {
  rolloutLane?: RolloutLane;
  id: string;
  kind: string;
  status: string;
  createdAt: number;
  queuedAt?: number;
  nextAttemptAt?: number | null;
  input?: Record<string, unknown>;
  customerMigrationV2?: OperationRef["customerMigrationV2"];
  cutoverCommittedAt?: number;
}

export interface OperationClaimDecisionInput {
  op: OperationClaimCandidate;
  now: number;
  runningOpsSameKind: ReadonlyArray<OperationRef>;
  pendingOpsSameKind: ReadonlyArray<PendingOperationRef>;
}

export type OperationClaimDecision =
  | { outcome: "skip" }
  | { outcome: "claim" }
  | { outcome: "queue"; waitingOn: string };

export function compareOperationQueueOrder(
  a: { createdAt: number; queuedAt?: number; id: string },
  b: { createdAt: number; queuedAt?: number; id: string },
): number {
  const timeDifference = (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt);
  if (timeDifference !== 0) return timeDifference;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function isBackingOffReleasedOperation(pending: PendingOperationRef, now: number): boolean {
  return (pending.kind === ACCOUNT_SUSPENSION_KIND ||
    pending.kind === "migrate-customer" && pending.queuedAt !== undefined) &&
    typeof pending.nextAttemptAt === "number" &&
    pending.nextAttemptAt > now;
}

function findOlderPendingSameScope(
  candidate: PendingOperationRef,
  pendingOpsSameKind: ReadonlyArray<PendingOperationRef>,
  now: number,
): SerialConflict | null {
  const older = pendingOpsSameKind
    .filter(
      (pending) =>
        pending.id !== candidate.id &&
        !isBackingOffReleasedOperation(pending, now) &&
        operationsConflict(candidate, pending) &&
        compareOperationQueueOrder(pending, candidate) < 0,
    )
    .sort(compareOperationQueueOrder)[0];
  if (!older) return null;
  return { conflictingOpId: older.id, waitingOn: describeWaitingOn(older) };
}

// Pure decision core for the operation worker's claim transaction: given a
// pending op, the OTHER currently-running ops of its kind, and the other
// pending ops of its kind (all read inside the same Firestore transaction the
// caller wraps this in), decide whether to claim it now, leave it queued, or
// skip it (already claimed elsewhere, or its retry backoff hasn't elapsed).
// Never returns a terminal-failure outcome — a serial-invariant conflict is
// not a validation failure, it is a scheduling fact.
export function decideOperationClaim(
  input: OperationClaimDecisionInput,
): OperationClaimDecision {
  const { op, now, runningOpsSameKind, pendingOpsSameKind } = input;
  if (op.status !== "pending") return { outcome: "skip" };
  if (typeof op.nextAttemptAt === "number" && op.nextAttemptAt > now) {
    return { outcome: "skip" };
  }
  const runningConflict = findSerialConflict(op, runningOpsSameKind);
  if (runningConflict) return { outcome: "queue", waitingOn: runningConflict.waitingOn };
  const olderPending = findOlderPendingSameScope(op, pendingOpsSameKind, now);
  if (olderPending) return { outcome: "queue", waitingOn: olderPending.waitingOn };
  return { outcome: "claim" };
}
