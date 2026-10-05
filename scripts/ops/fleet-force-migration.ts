import type { Firestore, Transaction } from "firebase-admin/firestore";
import { isDeepStrictEqual } from "node:util";
import { slugFromAssignedUser } from "@octogee/core/assigned-roster";
import { assertGatewayRuntimeMutationUnfenced } from "@octogee/core/gateway-retirement-claim";
import { findActiveGatewayMigration, type FleetOperationLockRef } from "@octogee/core/fleet-operation-lock";
import { customerRuntimeMutationFenced } from "../../shared/types/gateway-releases.js";

export interface ForceMigrationTarget {
  operationId: string;
  uid: string;
  slug: string;
  fromGatewayId: string;
  toGatewayId: string;
}

export interface ForceMigrationPlan extends ForceMigrationTarget {
  sourceEpoch: number;
  sourceRelease: number;
  targetRelease: number;
  attempts: number;
  lastProgressAt: number;
}

export interface OwnedMigrationRestart {
  fence: Record<string, unknown>;
  request: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertForceMigrationSource(source: Record<string, unknown>, target: ForceMigrationTarget): void {
  if (source.gatewayClass !== "builder") {
    throw new Error("forced migration recovery requires a dedicated Builder gateway; Shared sources cannot be restarted");
  }
  if (source.ownerUid !== target.uid || source.builderSlug !== target.slug) {
    throw new Error("forced migration Builder source ownership changed");
  }
  if (source.runtime !== undefined && source.runtime !== "cluster") {
    throw new Error("forced migration currently supports Kubernetes Builder gateways only; GCE VM transport is not available");
  }
}

export async function readForceMigrationSource(db: Firestore, target: ForceMigrationTarget): Promise<void> {
  const source = (await db.collection("gateways").doc(target.fromGatewayId).get()).data();
  assertForceMigrationSource(record(source), target);
}

function drainBlocked(op: Record<string, unknown>): boolean {
  const history = Array.isArray(op.attemptHistory) ? op.attemptHistory : [];
  const last = record(history.at(-1));
  const waiting = op.waitingOn === "builder-idle";
  const steps = waiting ? op.steps : last.steps;
  if (!Array.isArray(steps) || (!waiting && last.attempt !== op.attempts)) return false;
  const rows = steps.map(record);
  const drain = (step: Record<string, unknown>) => step.name === "quiesce-source" || step.name === "wait-for-active-work";
  if (!rows.some((step) => drain(step) && step.status === (waiting ? "skipped" : "failed"))) return false;
  if (rows.some((step) => step.status === "running" || step.status === "failed" && !drain(step))) return false;
  if (rows.some((step) => ["flush-source", "final-sync-state", "verify-target", "cutover-firestore", "unmount-source"].includes(String(step.name)))) return false;
  return waiting || !rows.some((step) => step.name === "pre-sync-state" && step.status === "done") ||
    rows.some((step) => step.name === "rollback:unmount-target" && step.status === "done");
}

async function assertSourceCustomersUnfenced(db: Firestore, txn: Transaction, gatewayId: string): Promise<void> {
  const [sources, targets, customers] = await Promise.all([
    txn.get(db.collection("users").where("provisioning.openclaw.sourceTransferFence.sourceGatewayId", "==", gatewayId)),
    txn.get(db.collection("users").where("provisioning.openclaw.sourceTransferFence.targetGatewayId", "==", gatewayId)),
    txn.get(db.collection("users").where("provisioning.openclaw.gatewayId", "==", gatewayId)),
  ]);
  if (sources.size > 0 || targets.size > 0 || customers.docs.some((doc) => customerRuntimeMutationFenced(doc.data()))) {
    throw new Error("force migration source customers retain custody fences");
  }
}

async function assertNoCompetingCustody(db: Firestore, txn: Transaction, target: ForceMigrationTarget, owned?: OwnedMigrationRestart): Promise<void> {
  const running = await txn.get(db.collection("glmOperations").where("status", "==", "running"));
  const operations = running.docs.map((doc) => ({ ...doc.data(), id: doc.id } as FleetOperationLockRef));
  if ([target.fromGatewayId, target.toGatewayId].some((id) => findActiveGatewayMigration(id, operations)) ||
    operations.some((op) => op.kind === "migrate-customer" && record(op.input).uid === target.uid)) {
    throw new Error("force migration is blocked by another running migration");
  }
  if (owned) await assertSourceCustomersUnfenced(db, txn, target.fromGatewayId);
  else await assertGatewayRuntimeMutationUnfenced(db, txn, target.fromGatewayId);
  await assertGatewayRuntimeMutationUnfenced(db, txn, target.toGatewayId);
}

function assertPendingDrain(op: Record<string, unknown>, target: ForceMigrationTarget, owned?: OwnedMigrationRestart): void {
  const input = record(op.input);
  if (op.kind !== "migrate-customer" || op.status !== "pending" || op.startedAt !== null || op.completedAt !== null ||
    input.uid !== target.uid || input.fromGatewayId !== target.fromGatewayId || input.toGatewayId !== target.toGatewayId) {
    throw new Error("force migration requires the exact pending unclaimed operation");
  }
  if (!owned && op.forceDrainRequest !== undefined) throw new Error("force migration was already requested for this operation");
  if (!drainBlocked(op)) throw new Error("force migration requires a settled attempt blocked by source drain");
}

function assertNoAcceptedCustody(op: Record<string, unknown>): void {
  const v2 = record(op.customerMigrationV2);
  if (["cutoverCommittedAt", "restoreAttempt", "sourceTransferExecution", "cancellationRequestedAt"].some((key) => op[key] !== undefined) ||
    op.customerMigrationV2 !== undefined && !["initialized", "keysSynced", "preSynced"].includes(String(v2.phase))) {
    throw new Error("force migration cannot replace accepted custody or cutover");
  }
}

function assertSourceAssignment(customer: Record<string, unknown>, assignment: Record<string, unknown>,
  targetAssignment: unknown, target: ForceMigrationTarget): void {
  const openclaw = record(record(customer.provisioning).openclaw);
  const migration = record(openclaw.migration);
  if (slugFromAssignedUser(customer) !== target.slug || openclaw.gatewayId !== target.fromGatewayId ||
    migration.operationId !== target.operationId || migration.phase !== "waiting" ||
    assignment.uid !== target.uid || assignment.slug !== target.slug || assignment.gatewayId !== target.fromGatewayId ||
    assignment.state !== "serving" || assignment.updatedByOperationId !== target.operationId ||
    !Number.isSafeInteger(assignment.epoch) || Number(assignment.epoch) < 1 || targetAssignment !== undefined) {
    throw new Error("force migration source assignment or migration owner changed");
  }
}

function assertConvergedRoots(customer: Record<string, unknown>, source: Record<string, unknown>, destination: Record<string, unknown>, owned?: OwnedMigrationRestart): void {
  if (customerRuntimeMutationFenced(customer) || (!owned && source.runtimeRestartFence !== undefined) ||
    destination.runtimeRestartFence !== undefined || [source, destination].some((root) => root.retirementClaim != null)) {
    throw new Error("force migration is blocked by a live custody fence");
  }
  if (!["running", "draining"].includes(String(source.desiredStatus)) || destination.desiredStatus !== "running" ||
    [source, destination].some((root) => !Number.isSafeInteger(root.desiredRelease) || Number(root.desiredRelease) < 1 || root.desiredRelease !== root.liveRelease)) {
    throw new Error("force migration requires converged source and target releases");
  }
}

function assertOwnedRestart(owned: OwnedMigrationRestart, op: Record<string, unknown>, source: Record<string, unknown>,
  target: ForceMigrationTarget, sourceEpoch: unknown): void {
  const { fence, request } = owned;
  const matches = [
    isDeepStrictEqual(op.forceDrainRequest, request), isDeepStrictEqual(source.runtimeRestartFence, fence),
    typeof request.auditId === "string" && request.auditId.length > 0, request.auditId === fence.auditId,
    fence.gatewayId === target.fromGatewayId, request.uid === target.uid,
    request.sourceGatewayId === target.fromGatewayId, request.targetGatewayId === target.toGatewayId,
    request.sourceEpoch === sourceEpoch,
  ].every(Boolean);
  if (!matches) throw new Error("force migration restart authority changed");
}

export async function readForceMigrationPlanInTransaction(db: Firestore, txn: Transaction, target: ForceMigrationTarget, owned?: OwnedMigrationRestart): Promise<ForceMigrationPlan> {
  for (const value of Object.values(target)) {
    if (!value || value.includes("/")) throw new Error("force migration requires exact non-empty identifiers");
  }
  if (target.fromGatewayId === target.toGatewayId) throw new Error("force migration requires different gateways");
  const get = async (collection: string, id: string) => (await txn.get(db.collection(collection).doc(id))).data();
  const [operation, user, sourceAssignment, targetAssignment, sourceRoot, targetRoot] = await Promise.all([
    get("glmOperations", target.operationId), get("users", target.uid),
    get(`gateways/${target.fromGatewayId}/assignments`, target.uid),
    get(`gateways/${target.toGatewayId}/assignments`, target.uid),
    get("gateways", target.fromGatewayId), get("gateways", target.toGatewayId),
  ]);
  const op = record(operation);
  const customer = record(user);
  const assignment = record(sourceAssignment);
  const source = record(sourceRoot);
  const destination = record(targetRoot);
  assertForceMigrationSource(source, target);
  if (owned) assertOwnedRestart(owned, op, source, target, assignment.epoch);
  assertPendingDrain(op, target, owned);
  assertNoAcceptedCustody(op);
  assertSourceAssignment(customer, assignment, targetAssignment, target);
  assertConvergedRoots(customer, source, destination, owned);
  if (!Number.isSafeInteger(op.attempts ?? 0) || Number(op.attempts ?? 0) < 0 || typeof op.lastProgressAt !== "number" || !Number.isFinite(op.lastProgressAt)) {
    throw new Error("force migration has invalid attempt identity");
  }
  await assertNoCompetingCustody(db, txn, target, owned);
  return { ...target, sourceEpoch: Number(assignment.epoch), sourceRelease: Number(source.liveRelease),
    targetRelease: Number(destination.liveRelease), attempts: Number(op.attempts ?? 0), lastProgressAt: op.lastProgressAt };
}

export function readForceMigrationPlan(db: Firestore, target: ForceMigrationTarget, owned?: OwnedMigrationRestart): Promise<ForceMigrationPlan> {
  return db.runTransaction((txn) => readForceMigrationPlanInTransaction(db, txn, target, owned));
}
