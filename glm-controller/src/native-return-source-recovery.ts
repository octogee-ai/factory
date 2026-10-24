import { isDeepStrictEqual } from "node:util";
import { FieldValue, type DocumentData, type Firestore, type Transaction } from "firebase-admin/firestore";
import { builderReturnOperationId } from "@octogee/core/builder-activation-lease";
import { customerRuntimeMutationFenced } from "@octogee/shared/types/gateway-releases";
import { readSchedulerMigrationIdentity, type Operation } from "@octogee/shared/types/glm";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { AgentStoreHandoffAuthority, PrepareMigrationAgentStores } from "./migration-agent-stores.js";
import type { OperationContext, OperationResult } from "./operation-router.js";
import type { NativeComputerReturnInput } from "./lib/native-computer-return.js";

export interface NativeReturnRecoveryIntent {
  leaseId: string;
  generation: number;
  sourceEpoch: number;
  failedAt: number;
  schedulerMigrationId: string;
  sourceVm: { instanceName: string; instanceId: string; zone: string };
  targetRetirement: { operationId: string; version: number; createdAt: number; completedAt: number };
  completedAt?: number;
}
export interface NativeReturnRecoveryRequest { uid: string; operationId: string; requestedAt: number; requestedBy: string }
export class NativeReturnRecoveryConflict extends Error {}
interface RecoveryDeps {
  db: Firestore;
  now(): number;
  log(message: string): void;
  verifyRetiredTarget(gatewayId: string, assertCurrent: () => Promise<void>): Promise<boolean>;
  releaseSourceHold(input: NativeComputerReturnInput): Promise<void>;
  prepareSourceStores: PrepareMigrationAgentStores;
  sourceClient(gatewayId: string, authority: AgentStoreHandoffAuthority): Promise<MigrationClient>;
}
function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) throw new NativeReturnRecoveryConflict(message);
}
function identity(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value); }
function returnLeaseMatches(user: DocumentData, operation: DocumentData, operationId: string): boolean {
  const input = operation.input, openclaw = user.provisioning?.openclaw, lease = openclaw?.activationLease;
  if (!Number.isSafeInteger(lease?.generation) || lease.generation < 1) return false;
  return [openclaw.gatewayId === input.fromGatewayId, user.username === input.builderSlug, openclaw.slug === input.builderSlug,
    lease.status === "returning", lease.targetGatewayId === input.fromGatewayId, lease.returnOperationId === operationId,
    identity(lease.leaseId), operationId === builderReturnOperationId(input.fromGatewayId, lease.generation)].every(Boolean);
}
function ownedSourceMatches(source: DocumentData, input: DocumentData, uid: string, lease: DocumentData): boolean {
  const allocation = source.allocation;
  return [source.gatewayId === input.fromGatewayId, source.gatewayClass === "builder",
    source.ownerUid === uid, source.builderSlug === input.builderSlug, source.desiredStatus === "running",
    source.liveRelease > 0, source.liveRelease === source.desiredRelease, source.latestRelease === source.desiredRelease,
    source.runtimeRestartFence === undefined, source.retirementClaim == null,
    allocation?.kind === "disposable-builder", allocation?.claimedByUid === uid,
    allocation?.leaseId === lease.leaseId, allocation?.generation === lease.generation].every(Boolean);
}
function sourceLeaseMatches(user: DocumentData, source: DocumentData, operation: DocumentData, operationId: string, uid: string): boolean {
  if (!returnLeaseMatches(user, operation, operationId)) return false;
  const openclaw = user.provisioning.openclaw;
  return ownedSourceMatches(source, operation.input, uid, openclaw.activationLease) &&
    openclaw.nativeSharedContextRestore === undefined && !customerRuntimeMutationFenced(user) &&
    (!user.accountLifecycle?.status || user.accountLifecycle.status === "active") &&
    (openclaw.migration === undefined || openclaw.migration?.operationId === operationId);
}
function retirementRootMatches(root: DocumentData | undefined, gatewayId: string, version: number): boolean {
  if (root === undefined) return true;
  const claim = root.retirementClaim;
  return [root.gatewayClass === "shared", root.ownerUid == null, root.desiredStatus === "retired", root.retirementVersion === version,
    claim?.operationId === `shared-pool-retire-${gatewayId}`, claim?.version === version, claim?.phase === "claimed"].every(Boolean);
}
function retirementMatches(root: DocumentData | undefined, operation: DocumentData, gatewayId: string, failedAt: number): boolean {
  const input = operation.input ?? {}, version = input.retirementClaimVersion;
  return [retirementRootMatches(root, gatewayId, version), operation.kind === "retire-gateway", operation.status === "succeeded", operation.gatewayId === gatewayId,
    input.gatewayId === gatewayId, input.source === "shared-pool-scaler", input.retainData !== true, input.retainServiceAccount !== true,
    Number.isSafeInteger(version), version > 0, Number.isSafeInteger(operation.createdAt), Number.isSafeInteger(operation.completedAt),
    operation.createdAt >= failedAt, operation.completedAt >= operation.createdAt,
    ["helm-uninstall", "revoke-agent-store-credentials"].every(name => operation.steps?.some((step: DocumentData) => step.name === name && step.status === "done"))].every(Boolean);
}
function terminalFailureReceipt(operation: DocumentData): boolean {
  return operation.status === "failed" && operation.rolledBack === false && Number.isSafeInteger(operation.startedAt) && operation.startedAt > 0 &&
    Number.isSafeInteger(operation.completedAt) && operation.completedAt >= operation.startedAt;
}
function recoveryPhase(operation: DocumentData, claimedStartedAt?: number) {
  const input = operation.input;
  const prior = input.nativeReturnSourceRecovery as NativeReturnRecoveryIntent | undefined;
  requireState(prior === undefined || prior !== null && typeof prior === "object", "native return recovery intent is malformed");
  requireState(input.recoverSourceOnly === undefined || input.recoverSourceOnly === true && prior !== undefined, "native return recovery mode is malformed");
  const failedAt = prior?.failedAt ?? operation.completedAt;
  requireState(Number.isSafeInteger(failedAt) && failedAt > 0, "native return recovery failure receipt is unavailable");
  requireState(claimedStartedAt === undefined ? terminalFailureReceipt(operation) :
    operation.status === "running" && operation.startedAt === claimedStartedAt && input.recoverSourceOnly === true, "native return recovery claim changed");
  return { prior, failedAt };
}
function assignmentMatches(assignment: DocumentData, input: DocumentData, operationId: string): boolean {
  return [assignment.uid === input.uid, assignment.gatewayId === input.fromGatewayId, assignment.slug === input.builderSlug,
    Number.isSafeInteger(assignment.epoch), assignment.epoch > 0,
    assignment.state === "serving" || assignment.state === "quiescing" && assignment.updatedByOperationId === operationId].every(Boolean);
}
function sourceVmMatches(runtime: DocumentData, sourceId: string, operationId: string): boolean {
  const vm = runtime.vm ?? {}, home = runtime.vmHome ?? {};
  return [runtime.gatewayId === sourceId, runtime.runtime === "gce-vm", identity(vm.instanceName), identity(vm.instanceId), identity(vm.zone),
    home.returnOperationId === undefined || home.returnOperationId === operationId,
    home.checkpointRequestedAt === undefined || home.returnOperationId === operationId].every(Boolean);
}
function handoffMatches(operation: DocumentData): boolean {
  const input = operation.input, handoff = operation.schedulerHandoff;
  return [handoff.uid === input.uid, handoff.slug === input.builderSlug, handoff.fromGatewayId === input.fromGatewayId,
    handoff.toGatewayId === input.toGatewayId, handoff.stageAfterCutover !== true].every(Boolean);
}
function assertCapturedIntent(prior: NativeReturnRecoveryIntent | undefined, intent: NativeReturnRecoveryIntent, claimedStartedAt?: number): void {
  if (prior) {
    const { completedAt, ...captured } = prior;
    requireState(completedAt === undefined || Number.isSafeInteger(completedAt), "native return recovery completion is malformed");
    requireState(isDeepStrictEqual(captured, intent), "native return recovery captured authority changed");
  }
  if (claimedStartedAt !== undefined) requireState(prior !== undefined, "native return recovery intent is unavailable");
}
function assertInitialFailureScheduler(operation: DocumentData, operationId: string, prior: NativeReturnRecoveryIntent | undefined): void {
  if (prior) return;
  const scheduler = readSchedulerMigrationIdentity(operationId, operation.schedulerHandoff?.migrationId);
  requireState(scheduler !== null && scheduler.attempt === operation.attempts && scheduler.claimStartedAt === operation.startedAt,
    "native return recovery scheduler failure claim changed");
}
async function readAuthority(deps: RecoveryDeps, tx: Transaction, uid: string, operationId: string, claimedStartedAt?: number) {
  const opRef = deps.db.doc(`glmOperations/${operationId}`);
  const operation = (await tx.get(opRef)).data() ?? {}, input = operation.input ?? {};
  requireState(operation.kind === "migrate-customer" && identity(input.fromGatewayId) && identity(input.toGatewayId) && identity(input.builderSlug), "native return recovery operation scope is unavailable");
  requireState([operation.origin === "automatic", operation.createdBy === "glm-controller-placement-policy", operation.inputUid === uid,
    input.uid === uid, input.source === "builder-activation-lease", operation.gatewayId === input.toGatewayId,
    operation.cutoverCommittedAt === undefined, operation.cancellationRequestedAt === undefined, operation.customerMigrationV2 === undefined,
    operation.sourceTransferExecution === undefined, operation.restoreAttempt === undefined, operation.schedulerHandoffLost === undefined, input.sourceTransferMode === undefined,
    readSchedulerMigrationIdentity(operationId, operation.schedulerHandoff?.migrationId) !== null].every(Boolean), "native return recovery operation custody changed");
  const { prior, failedAt } = recoveryPhase(operation, claimedStartedAt);
  assertInitialFailureScheduler(operation, operationId, prior);
  const sourceId = input.fromGatewayId, targetId = input.toGatewayId;
  const userRef = deps.db.doc(`users/${uid}`), assignmentRef = deps.db.doc(`gateways/${sourceId}/assignments/${uid}`);
  const retirementId = `shared-pool-retire-${targetId}`;
  const [userSnap, sourceSnap, runtimeSnap, assignmentSnap, targetAssignment, targetSnap, retirementSnap, active] = await Promise.all([
    tx.get(userRef), tx.get(deps.db.doc(`gateways/${sourceId}`)), tx.get(deps.db.doc(`glmGateways/${sourceId}`)), tx.get(assignmentRef),
    tx.get(deps.db.doc(`gateways/${targetId}/assignments/${uid}`)), tx.get(deps.db.doc(`gateways/${targetId}`)),
    tx.get(deps.db.doc(`glmOperations/${retirementId}`)), tx.get(deps.db.collection("glmOperations").where("status", "in", ["pending", "running"])),
  ]);
  const user = userSnap.data() ?? {}, source = sourceSnap.data() ?? {}, assignment = assignmentSnap.data() ?? {}, runtime = runtimeSnap.data() ?? {};
  requireState(sourceLeaseMatches(user, source, operation, operationId, uid), "native return recovery source lease changed");
  requireState(assignmentMatches(assignment, input, operationId) && !targetAssignment.exists && sourceVmMatches(runtime, sourceId, operationId) && handoffMatches(operation),
    "native return recovery assignment or scheduler custody changed");
  requireState(!active.docs.some(doc => doc.id !== operationId && competingOperation(doc.data(), uid, sourceId, targetId)), "native return recovery has competing work");
  const retirement = retirementSnap.data() ?? {};
  requireState(retirementMatches(targetSnap.data(), retirement, targetId, failedAt), "native return target retirement is incomplete");
  const lease = user.provisioning.openclaw.activationLease;
  const intent: NativeReturnRecoveryIntent = { leaseId: lease.leaseId, generation: lease.generation, sourceEpoch: assignment.epoch, failedAt,
    schedulerMigrationId: operation.schedulerHandoff.migrationId,
    sourceVm: { instanceName: runtime.vm.instanceName, instanceId: runtime.vm.instanceId, zone: runtime.vm.zone },
    targetRetirement: { operationId: retirementId, version: retirement.input.retirementClaimVersion, createdAt: retirement.createdAt, completedAt: retirement.completedAt } };
  assertCapturedIntent(prior, intent, claimedStartedAt);
  return { operation, input, intent, opRef, userRef, assignmentRef, uid, sourceId, targetId, slug: input.builderSlug as string };
}
function competingOperation(operation: DocumentData, uid: string, sourceId: string, targetId: string): boolean {
  const input = operation.input ?? {};
  return input.uid === uid || [input.gatewayId, input.fromGatewayId, input.toGatewayId, input.sourceGatewayId, input.targetGatewayId].some(id => id === sourceId || id === targetId);
}
export function createNativeReturnSourceRecoveryOwner(deps: RecoveryDeps) {
  const read = (uid: string, operationId: string, claim?: number) => deps.db.runTransaction(tx => readAuthority(deps, tx, uid, operationId, claim), { readOnly: true });
  const request = async (input: NativeReturnRecoveryRequest): Promise<boolean> => {
    try {
      requireState(identity(input.uid) && identity(input.operationId) && Number.isSafeInteger(input.requestedAt) && input.requestedAt > 0, "native return recovery request identity is invalid");
      const captured = await read(input.uid, input.operationId);
      const assertCurrent = async () => { const current = await read(input.uid, input.operationId); requireState(isDeepStrictEqual(current.intent, captured.intent), "native return recovery request changed"); };
      if (!await deps.verifyRetiredTarget(captured.targetId, assertCurrent)) {
        deps.log(`[native-return-recovery] refused ${input.operationId}: retired target physical or PostgreSQL proof is incomplete`);
        return false;
      }
      await deps.db.runTransaction(async tx => {
        const current = await readAuthority(deps, tx, input.uid, input.operationId);
        requireState(isDeepStrictEqual(current.intent, captured.intent), "native return recovery request changed");
        tx.update(current.opRef, { status: "pending", startedAt: null, completedAt: null, steps: [],
          "input.recoverSourceOnly": true, "input.nativeReturnSourceRecovery": captured.intent,
          sourceRecoveryRequestedAt: input.requestedAt, sourceRecoveryRequestedBy: input.requestedBy,
          error: FieldValue.delete(), expireAt: FieldValue.delete(), nextAttemptAt: input.requestedAt });
      });
      return true;
    } catch (error) {
      if (!(error instanceof NativeReturnRecoveryConflict)) throw error;
      deps.log(`[native-return-recovery] refused ${input.operationId}: ${error.message}`); return false;
    }
  };
  const recover = async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    try {
      requireState(typeof op.input.uid === "string" && typeof op.startedAt === "number" && ctx.assertActiveClaim, "native return recovery requires an active claim");
      const uid = op.input.uid, claim = op.startedAt, assertClaim = ctx.assertActiveClaim;
      const assertCurrent = async () => { await assertClaim(); return read(uid, op.id, claim); };
      const captured = await assertCurrent();
      const assertSourceCurrent = async () => { await assertCurrent(); };
      const assertRetired = async () => { await assertCurrent(); requireState(await deps.verifyRetiredTarget(captured.targetId, async () => { await assertCurrent(); }), "native return target runtime or PostgreSQL login remains live"); await assertCurrent(); };
      await assertRetired();
      if (captured.input.nativeReturnSourceRecovery.completedAt !== undefined) return completedResult({ ...captured.intent, completedAt: captured.input.nativeReturnSourceRecovery.completedAt });
      const step = async (name: string, work: () => Promise<unknown>) => {
        await assertRetired(); await ctx.reportStep({ name, status: "running", startedAt: deps.now() });
        await assertRetired(); await work(); await assertRetired(); await ctx.reportStep({ name, status: "done", completedAt: deps.now() });
      };
      const nativeInput = { fromGatewayId: captured.sourceId, toGatewayId: captured.targetId, uid, slug: captured.slug, operationId: op.id, claimedStartedAt: claim };
      await step("recover-native-source-hold", () => deps.releaseSourceHold(nativeInput));
      await step("recover-native-source-ownership", () => deps.prepareSourceStores(captured.sourceId, captured.slug, { expectedBuilderUid: uid, assertCurrent: assertSourceCurrent }));
      const client = await deps.sourceClient(captured.sourceId, { expectedBuilderUid: uid, assertCurrent: assertSourceCurrent });
      await step("recover-native-source-scheduler", () => client.scheduler({ gatewayId: captured.sourceId, migrationId: captured.intent.schedulerMigrationId, slug: captured.slug, phase: "resume" }));
      await step("recover-native-source-ingress", () => client.resume({ gatewayId: captured.sourceId, migrationId: `mig-${op.id}`, slug: captured.slug }));
      await assertRetired();
      const completedAt = await deps.db.runTransaction(async tx => {
        const current = await readAuthority(deps, tx, uid, op.id, claim);
        if (current.input.nativeReturnSourceRecovery.completedAt !== undefined) return current.input.nativeReturnSourceRecovery.completedAt as number;
        const at = deps.now();
        const receipt = { ...captured.intent, completedAt: at, uid, slug: captured.slug, operationId: op.id,
          sourceGatewayId: captured.sourceId, targetGatewayId: captured.targetId, claimStartedAt: claim };
        const priorReceipts = Array.isArray(current.operation.nativeReturnSourceRecoveryReceipts) ? current.operation.nativeReturnSourceRecoveryReceipts : [];
        tx.update(current.assignmentRef, { state: "serving", updatedByOperationId: op.id, updatedAt: at });
        tx.update(current.userRef, { "provisioning.openclaw.migration": FieldValue.delete() });
        tx.update(current.opRef, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: at,
          "input.nativeReturnSourceRecovery.completedAt": at, nativeReturnSourceRecoveryReceipts: [...priorReceipts, receipt].slice(-20) });
        return at;
      });
      return completedResult({ ...captured.intent, completedAt });
    } catch (error) {
      return { steps: [], success: false, rolledBack: false, error: `native return source recovery pending: status 503: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  return { request, recover };
}
function completedResult(intent: NativeReturnRecoveryIntent): OperationResult {
  return { steps: [], success: false, rolledBack: true, error: "native return source recovery completed", output: { nativeReturnSourceRecovery: intent } };
}
