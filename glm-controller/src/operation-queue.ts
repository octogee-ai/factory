import { serialFleetOperationsConflict } from "@octogee/core/fleet-operation-lock";

// Op kinds with a serial invariant: overlapping migration/release resources
// cannot run together, and rollout operations remain globally serial.
export const SERIALLY_EXCLUSIVE_OPERATION_KINDS: ReadonlySet<string> = new Set([
  "rollout",
  "migrate-customer",
]);

export function isSeriallyExclusiveKind(kind: string): boolean {
  return SERIALLY_EXCLUSIVE_OPERATION_KINDS.has(kind);
}

export interface OperationRef {
  id: string;
  kind: string;
  input?: Record<string, unknown>;
  customerMigrationV2?: {
    sourceGatewayId?: string;
    sourceRevisionId?: string;
    targetGatewayId?: string;
    targetRevisionId?: string;
  };
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

export function findSerialConflict(
  candidate: OperationRef,
  runningOpsSameKind: ReadonlyArray<OperationRef>,
): SerialConflict | null {
  const conflict = runningOpsSameKind.find(
    (running) => running.id !== candidate.id && serialFleetOperationsConflict(candidate, running),
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
};

function describeWaitingOn(op: OperationRef): string {
  return WAITING_ON_DESCRIPTIONS[op.kind]?.(op.input) ?? `another ${op.kind} operation`;
}

export interface PendingOperationRef extends OperationRef {
  createdAt: number;
  nextAttemptAt?: number | null;
}

export interface OperationClaimCandidate {
  id: string;
  kind: string;
  status: string;
  createdAt: number;
  nextAttemptAt?: number | null;
  input?: Record<string, unknown>;
  customerMigrationV2?: OperationRef["customerMigrationV2"];
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

function isOlderThanCandidate(
  other: { createdAt: number; id: string },
  candidate: { createdAt: number; id: string },
): boolean {
  if (other.createdAt !== candidate.createdAt) return other.createdAt < candidate.createdAt;
  return other.id < candidate.id;
}

// An OLDER same-scope pending op is a conflict too: the onSnapshot fast path
// claims a NEWLY created doc immediately, and without this check it would jump
// ahead of an op already queued for the same scope (whose blocker finished
// without any event waking it) — starving the queue head. Together with the
// drain's createdAt-asc scan this makes claiming jointly FIFO per scope.
function findOlderPendingSameScope(
  candidate: OperationRef & { createdAt: number },
  pendingOpsSameKind: ReadonlyArray<PendingOperationRef>,
): SerialConflict | null {
  const older = pendingOpsSameKind
    .filter(
      (pending) =>
        pending.id !== candidate.id &&
        serialFleetOperationsConflict(candidate, pending) &&
        isOlderThanCandidate(pending, candidate),
    )
    .sort((a, b) => (isOlderThanCandidate(a, b) ? -1 : 1))[0];
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
  const olderPending = findOlderPendingSameScope(op, pendingOpsSameKind);
  if (olderPending) return { outcome: "queue", waitingOn: olderPending.waitingOn };
  return { outcome: "claim" };
}
