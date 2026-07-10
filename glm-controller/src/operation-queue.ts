// Op kinds with a serial invariant: at most one RUNNING op sharing the same
// scope key (conflictScopeKey below) at a time. A conflicting pending op is
// queued (left pending, never failed) until the running one clears — see
// docs/handbook/22-gateway-rollouts-cowboy.md.
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
}

export interface SerialConflict {
  conflictingOpId: string;
  waitingOn: string;
}

// The scope an op's exclusivity is measured within: "rollout" is a single
// global plane (one blue/green roll across the whole fleet); "migrate-customer"
// is exclusive per migration target (mirrors the fleet-migration-runner's
// one-slot-per-target transfer capacity) — two migrations to DIFFERENT targets
// never conflict. Returns null when the op carries no usable scope key (e.g. a
// migrate-customer input missing toGatewayId) — such an op never conflicts;
// its own validation failure is what stops it, not the queue.
function conflictScopeKey(op: OperationRef): string | null {
  if (op.kind === "rollout") return "rollout:global";
  if (op.kind === "migrate-customer") {
    const toGatewayId = typeof op.input?.toGatewayId === "string" ? op.input.toGatewayId : undefined;
    return toGatewayId ? `migrate-customer:${toGatewayId}` : null;
  }
  return null;
}

export function findSerialConflict(
  candidate: OperationRef,
  runningOpsSameKind: ReadonlyArray<OperationRef>,
): SerialConflict | null {
  const candidateScope = conflictScopeKey(candidate);
  if (candidateScope === null) return null;
  const conflict = runningOpsSameKind.find(
    (running) => running.id !== candidate.id && conflictScopeKey(running) === candidateScope,
  );
  if (!conflict) return null;
  return { conflictingOpId: conflict.id, waitingOn: describeWaitingOn(conflict) };
}

function describeWaitingOn(op: OperationRef): string {
  if (op.kind === "rollout") {
    const gatewayId = typeof op.input?.gatewayId === "string" ? op.input.gatewayId : undefined;
    const imageTag = typeof op.input?.imageTag === "string" ? op.input.imageTag : undefined;
    if (gatewayId) {
      return imageTag ? `roll ${gatewayId} → ${imageTag}` : `roll ${gatewayId}`;
    }
  }
  if (op.kind === "migrate-customer") {
    const toGatewayId = typeof op.input?.toGatewayId === "string" ? op.input.toGatewayId : undefined;
    const fromGatewayId = typeof op.input?.fromGatewayId === "string" ? op.input.fromGatewayId : undefined;
    if (toGatewayId) {
      return fromGatewayId ? `migration ${fromGatewayId} → ${toGatewayId}` : `migration → ${toGatewayId}`;
    }
  }
  return `another ${op.kind} operation`;
}

export interface PendingOperationRef extends OperationRef {
  createdAt: number;
}

export interface OperationClaimCandidate {
  id: string;
  kind: string;
  status: string;
  createdAt: number;
  nextAttemptAt?: number | null;
  input?: Record<string, unknown>;
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
  const candidateScope = conflictScopeKey(candidate);
  if (candidateScope === null) return null;
  const older = pendingOpsSameKind
    .filter(
      (pending) =>
        pending.id !== candidate.id &&
        conflictScopeKey(pending) === candidateScope &&
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
