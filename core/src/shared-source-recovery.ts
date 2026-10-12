import { isDeepStrictEqual } from "node:util";
import type { DocumentData, Firestore, Transaction } from "firebase-admin/firestore";

export interface SourceRecoveryAssignment { uid: string; slug: string; agentId: string; assignmentEpoch: number; assignment: DocumentData }
export interface SourceRecoveryExport { operationId: string; input: DocumentData; startedAt: number; completedAt: number; error: string; steps: DocumentData[] }
export interface SharedSourceRecoveryAuthority { root: DocumentData; assignments: SourceRecoveryAssignment[]; failedExports: SourceRecoveryExport[] }
export class SharedSourceRecoveryConflict extends Error {}
const conflict = (message: string): never => { throw new SharedSourceRecoveryConflict(message); };

function rootIdentity(root: DocumentData): DocumentData {
  return Object.fromEntries(["gatewayId", "gatewayClass", "ownerUid", "builderSlug", "desiredStatus", "desiredRelease", "liveRelease", "latestRelease"]
    .map(key => [key, root[key]]));
}
function validRoot(root: DocumentData, gatewayId: string): boolean {
  return [root.gatewayId === gatewayId, root.gatewayClass === "shared", root.ownerUid === null, root.builderSlug === null,
    root.allocation == null, root.retirementClaim == null, ["running", "draining"].includes(root.desiredStatus),
    Number.isSafeInteger(root.liveRelease), root.liveRelease > 0, root.liveRelease === root.desiredRelease].every(Boolean);
}
function assignmentIdentity(uid: string, assignment: DocumentData, gatewayId: string): SourceRecoveryAssignment {
  const slug = assignment.slug;
  if (![assignment.uid === uid, assignment.gatewayId === gatewayId, assignment.state === "serving",
    typeof slug === "string", /^[a-z0-9][a-z0-9-]*$/.test(slug), Number.isSafeInteger(assignment.epoch), assignment.epoch >= 0].every(Boolean)) {
    conflict("source recovery assignment is unavailable");
  }
  return { uid, slug, agentId: `octogee-${slug}-coach`, assignmentEpoch: assignment.epoch, assignment };
}
function userMatches(user: DocumentData, identity: SourceRecoveryAssignment, gatewayId: string): boolean {
  const state = user.provisioning?.openclaw ?? {};
  return [user.username === identity.slug, state.gatewayId === gatewayId, state.status === "complete",
    state.migration === undefined, state.restoreFence === undefined, state.sourceTransferFence === undefined,
    state.nativeSharedContextRestore === undefined, state.runtimeRestartFence === undefined].every(Boolean);
}
function schema24ExportError(error: unknown, gatewayId: string, agentId: string): boolean {
  const prefix = `/push-rsync-state/${gatewayId}: 500 `;
  if (typeof error !== "string" || !error.startsWith(prefix)) return false;
  let body: DocumentData;
  try { body = JSON.parse(error.slice(prefix.length)); } catch { return false; }
  const file = `/home/node/.openclaw/agents/${agentId}/agent/openclaw-agent.sqlite`;
  return body?.error === "push-rsync-state failed" && body.message ===
    `OpenClaw snapshot of ${agentId} failed: SQLite database cannot be snapshotted safely: ${file}. OpenClaw agent database ${file} uses schema version 24; run openclaw doctor --fix before compacting it.`;
}
function failedExportMatches(row: DocumentData, identity: SourceRecoveryAssignment, gatewayId: string): boolean {
  const steps = Array.isArray(row.steps) ? row.steps : [];
  return [row.kind === "migrate-customer", row.status === "failed", row.cancellationRequestedAt === undefined,
    Number.isSafeInteger(row.startedAt), row.startedAt > 0, Number.isSafeInteger(row.completedAt), row.completedAt >= row.startedAt,
    row.input?.uid === identity.uid, row.input?.fromGatewayId === gatewayId,
    typeof row.input?.toGatewayId === "string", row.input?.toGatewayId !== gatewayId,
    row.cutoverCommittedAt === undefined, row.restoreAttempt === undefined,
    schema24ExportError(row.error, gatewayId, identity.agentId),
    steps.some(step => step.name === "pre-sync-state" && step.status === "failed" && step.error === row.error),
    steps.some(step => step.name === "rollback:unmount-target" && step.status === "done"),
    !steps.some(step => step.name === "quiesce-source" || step.name === "final-sync-state")].every(Boolean);
}
function operationTouchesSource(row: DocumentData, gatewayId: string): boolean {
  return [row.input?.gatewayId, row.input?.fromGatewayId, row.input?.toGatewayId].includes(gatewayId);
}
export async function readSharedSourceRecoveryAuthority(db: Firestore, tx: Transaction, gatewayId: string, ownOperationId?: string): Promise<SharedSourceRecoveryAuthority> {
  const [rootSnap, roster, active, failed] = await Promise.all([
    tx.get(db.doc(`gateways/${gatewayId}`)), tx.get(db.collection(`gateways/${gatewayId}/assignments`)),
    tx.get(db.collection("glmOperations").where("status", "in", ["pending", "running"])),
    tx.get(db.collection("glmOperations").where("status", "==", "failed")),
  ]);
  const root = rootSnap.data() ?? {};
  if (!validRoot(root, gatewayId) || (!ownOperationId && root.runtimeRestartFence !== undefined)) conflict("source recovery gateway authority is unavailable");
  const assignments = roster.docs.map(row => assignmentIdentity(row.id, row.data(), gatewayId)).sort((a, b) => a.uid.localeCompare(b.uid));
  if (!assignments.length || new Set(assignments.map(row => row.slug)).size !== assignments.length) conflict("source recovery roster is unavailable");
  const sourceUids = new Set(assignments.map(row => row.uid));
  if (active.docs.some(row => row.id !== ownOperationId && (operationTouchesSource(row.data(), gatewayId) || sourceUids.has(row.data().input?.uid)))) {
    conflict("another source operation is active");
  }
  const users = await Promise.all(assignments.map(row => tx.get(db.doc(`users/${row.uid}`))));
  if (users.some((user, index) => !userMatches(user.data() ?? {}, assignments[index]!, gatewayId))) conflict("source recovery customer authority changed");
  const failedExports = assignments.map(identity => {
    const matched = failed.docs.filter(row => failedExportMatches(row.data(), identity, gatewayId))
      .sort((a, b) => b.data().completedAt - a.data().completedAt)[0];
    if (!matched) return conflict(`source recovery lacks a rolled-back schema24 export for ${identity.slug}`);
    const row = matched.data();
    return { operationId: matched.id, input: row.input, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: row.steps };
  });
  return { root: rootIdentity(root), assignments, failedExports };
}
export function assertSharedSourceRecoveryUnchanged(current: SharedSourceRecoveryAuthority, captured: SharedSourceRecoveryAuthority): void {
  if (!isDeepStrictEqual(current, { root: captured.root, assignments: captured.assignments, failedExports: captured.failedExports })) {
    conflict("source recovery custody changed");
  }
}
