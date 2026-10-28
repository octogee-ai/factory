import { isDeepStrictEqual } from "node:util";
import { legacyForwardRecoveryMatches } from "@octogee/core/fleet-state";
import { nativeReturnSourceIdentity, nativeReturnSourceState, type NativeReturnSourceState } from "./native-return-source-fence.js";
import { FieldValue, type DocumentData, type Firestore } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";
import { awaitHomeCheckpoint, readHomeCheckpointCompletedAt, readVmHome } from "./home-checkpoint.js";
import type { GatewayVmClient } from "./compute-vm.js";
import { nativeSchedulerRetirementForReturn } from "./native-scheduler-retirement.js";

export interface NativeComputerReturnInput {
  fromGatewayId: string;
  toGatewayId: string;
  uid: string;
  slug: string;
  operationId: string;
  claimedStartedAt: number | null;
}

export type NativeSourcePark = { mode: "suspend" } | { mode: "stop"; reason: string };

export interface NativeReturnPark {
  parked: "suspended" | "stopped";
  stopReason?: string;
}

export interface NativeComputerReturn {
  checkpointRequested: boolean;
  requestCheckpoint: () => Promise<void>;
  awaitCheckpoint: () => Promise<void>;
  release: () => Promise<void>;
  releaseWriterHold: () => Promise<void>;
  sourceComputerStatus: () => Promise<string | null>;
  park: (park: NativeSourcePark) => Promise<NativeReturnPark>;
  acknowledgeCompletedSchedulerHandoff: () => Promise<void>;
}

function persistSchedulerRetirement(
  tx: import("firebase-admin/firestore").Transaction,
  userRef: import("firebase-admin/firestore").DocumentReference,
  retirement: ReturnType<typeof nativeSchedulerRetirementForReturn>,
): void {
  if (retirement) tx.update(userRef, { "provisioning.pendingNativeSchedulerRetirement": retirement });
}

type NativeReturnDb = Pick<Firestore, "collection" | "runTransaction">;
type NativeReturnDeps = {
  db: NativeReturnDb;
  vm: Pick<GatewayVmClient, "describe" | "stop">;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

function assertOwner(data: Record<string, unknown> | undefined, input: NativeComputerReturnInput): void {
  if (data?.gatewayClass !== "builder" ||
      data.ownerUid !== input.uid || data.builderSlug !== input.slug) {
    throw new Error(`native computer return ${input.fromGatewayId}: source ownership changed`);
  }
}

function returnRequest(data: Record<string, unknown> | undefined, operationId: string): number | null {
  const home = readVmHome(data);
  const returnOperationId = (data?.vmHome as { returnOperationId?: unknown } | undefined)?.returnOperationId;
  if (returnOperationId !== operationId) return null;
  if (typeof home?.checkpointRequestedAt !== "number") throw new Error("native return checkpoint request is missing");
  return home.checkpointRequestedAt;
}

async function claimCheckpoint(deps: NativeReturnDeps, input: NativeComputerReturnInput): Promise<number> {
  const source = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId);
  return deps.db.runTransaction(async (tx) => {
    const [snap, user, root, operation] = await Promise.all([
      tx.get(source), tx.get(deps.db.collection("users").doc(input.uid)),
      tx.get(deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId)),
      tx.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(input.operationId)),
    ]);
    const data = snap.data();
    if (!precutoverOperationMatches(operation.data(), input) ||
        operation.data()?.cancellationRequestedAt !== undefined && !forwardRecoveryMatches(operation.data(), input)) {
      throw new Error("native return checkpoint claim authority changed");
    }
    assertOwner(root.data(), input);
    if (data?.runtime !== "gce-vm" || !data.vm) throw new Error("native computer runtime changed");
    if (user.data()?.provisioning?.openclaw?.gatewayId !== input.fromGatewayId) {
      throw new Error("native computer return assignment changed before checkpoint");
    }
    const existing = returnRequest(data, input.operationId);
    if (existing !== null) return existing;
    if (readVmHome(data)?.checkpointRequestedAt != null) throw new Error("native computer has another checkpoint request");
    const requestedAt = deps.now();
    tx.update(source, {
      "vmHome.returnOperationId": input.operationId,
      "vmHome.checkpointRequestedAt": requestedAt,
      "vmHome.parkRequestedAt": requestedAt,
    });
    return requestedAt;
  });
}

const RELEASED_RETURN_HOLD = {
  "vmHome.returnOperationId": FieldValue.delete(),
  "vmHome.checkpointRequestedAt": FieldValue.delete(),
  "vmHome.parkRequestedAt": FieldValue.delete(),
};

async function releaseUncommittedCheckpoint(deps: NativeReturnDeps, input: NativeComputerReturnInput, requestedAt: number | null): Promise<void> {
  const source = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId);
  await deps.db.runTransaction(async (tx) => {
    const [snap, root, operation, user] = await Promise.all([
      tx.get(source), tx.get(deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId)),
      tx.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(input.operationId)),
      tx.get(deps.db.collection("users").doc(input.uid)),
    ]);
    assertOwner(root.data(), input);
    if (operation.data()?.schedulerHandoff?.forwardRecovery !== undefined) {
      throw new Error("native return crossed the final transfer boundary and must roll forward");
    }
    if (!precutoverOperationMatches(operation.data(), input) || user.data()?.provisioning?.openclaw?.gatewayId !== input.fromGatewayId) {
      throw new Error("native return checkpoint release authority changed");
    }
    const held = returnRequest(snap.data(), input.operationId);
    if (held === null) return;
    if (held !== requestedAt) throw new Error("native return checkpoint release authority changed");
    tx.update(source, RELEASED_RETURN_HOLD);
  });
}

export async function releaseNativeReturnSourceRecoveryHold(deps: NativeReturnDeps, input: NativeComputerReturnInput): Promise<void> {
  const source = await deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId).get();
  if (source.data()?.runtime !== "gce-vm") throw new Error("native return source recovery runtime changed");
  const home = source.data()?.vmHome;
  if ((home?.returnOperationId !== undefined || home?.checkpointRequestedAt !== undefined) && home?.returnOperationId !== input.operationId) {
    throw new Error("native return source recovery retains a foreign checkpoint hold");
  }
  await releaseUncommittedCheckpoint(deps, input, returnRequest(source.data(), input.operationId));
}

async function releaseCommittedWriterHold(deps: NativeReturnDeps, input: NativeComputerReturnInput, requestedAt: number | null): Promise<void> {
  const source = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId);
  await deps.db.runTransaction(async (tx) => {
    const [snap, root, operation, user, target, assignment] = await Promise.all([
      tx.get(source), tx.get(deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId)),
      tx.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(input.operationId)),
      tx.get(deps.db.collection("users").doc(input.uid)),
      tx.get(deps.db.collection(GATEWAYS_COLLECTION).doc(input.toGatewayId)),
      tx.get(deps.db.collection(`${GATEWAYS_COLLECTION}/${input.toGatewayId}/assignments`).doc(input.uid)),
    ]);
    if (returnRequest(snap.data(), input.operationId) === null) return;
    assertOwner(root.data(), input);
    const exact = returnRequest(snap.data(), input.operationId) === requestedAt && committedOperationMatches(operation.data(), input) &&
      user.data()?.provisioning?.openclaw?.gatewayId === input.toGatewayId && target.data()?.gatewayClass === "shared" &&
      sharedAssignmentMatches(assignment.data(), input) && sourceCheckpointMatches(snap.data(), input) && root.data()?.desiredStatus === "running";
    if (!exact) throw new Error("native return writer hold release authority changed");
    tx.update(source, RELEASED_RETURN_HOLD);
  });
}

function forwardRecoveryMatches(op: DocumentData | undefined, input: NativeComputerReturnInput): boolean {
  return op?.schedulerHandoff?.slug === input.slug && legacyForwardRecoveryMatches(input.operationId, {
    uid: input.uid, fromGatewayId: input.fromGatewayId, toGatewayId: input.toGatewayId,
  }, op.schedulerHandoff);
}

function currentOperationMatches(op: DocumentData | undefined, input: NativeComputerReturnInput): boolean {
  return op?.kind === "migrate-customer" && op.status === "running" &&
    typeof input.claimedStartedAt === "number" && op.startedAt === input.claimedStartedAt &&
    op.input?.uid === input.uid && op.input.fromGatewayId === input.fromGatewayId && op.input.toGatewayId === input.toGatewayId;
}

function precutoverOperationMatches(op: DocumentData | undefined, input: NativeComputerReturnInput): boolean {
  return currentOperationMatches(op, input) && op?.cutoverCommittedAt === undefined;
}

function committedOperationMatches(op: DocumentData | undefined, input: NativeComputerReturnInput): boolean {
  return currentOperationMatches(op, input) && typeof op?.cutoverCommittedAt === "number" && op.cutoverCommittedAt > 0;
}

function sharedAssignmentMatches(assignment: DocumentData | undefined, input: NativeComputerReturnInput): boolean {
  return assignment?.uid === input.uid && assignment.gatewayId === input.toGatewayId &&
    assignment.slug === input.slug && assignment.state === "serving";
}

function returnHoldMatches(runtime: DocumentData | undefined, input: NativeComputerReturnInput): boolean {
  const home = readVmHome(runtime);
  const returnOperationId = (runtime?.vmHome as { returnOperationId?: unknown } | undefined)?.returnOperationId;
  const requestedAt = returnRequest(runtime, input.operationId);
  return (returnOperationId === undefined || returnOperationId === input.operationId) &&
    (requestedAt === null || home?.checkpointAcknowledgedAt === requestedAt && (home?.lastCheckpoint?.completedAt ?? 0) >= requestedAt);
}

function sourceCheckpointMatches(runtime: DocumentData | undefined, input: NativeComputerReturnInput): boolean {
  const checkpoint = readVmHome(runtime)?.lastCheckpoint;
  if (runtime?.runtime !== "gce-vm" || typeof runtime.vm?.instanceId !== "string" ||
      checkpoint?.instanceId !== runtime.vm.instanceId || typeof checkpoint?.completedAt !== "number") return false;
  return returnHoldMatches(runtime, input);
}

type SourceIdentity = NonNullable<ReturnType<typeof nativeReturnSourceIdentity>>;
type PauseIntent = { requestStop: string | null } | { parkedAs: SourceIdentity; clearStop: boolean };

type StopRequest = { operationId: string; reason: string; claimedAt?: number };

function readStopRequest(source: DocumentData | undefined): StopRequest | null {
  const request = source?.vmStopOnPark as Partial<StopRequest> | undefined;
  if (request === undefined) return null;
  if (typeof request?.operationId !== "string" || typeof request.reason !== "string" ||
      (request.claimedAt !== undefined && typeof request.claimedAt !== "number")) throw new Error("vmStopOnPark request is malformed");
  return request as StopRequest;
}

async function pauseCommittedSource(deps: NativeReturnDeps, input: NativeComputerReturnInput, intent: PauseIntent): Promise<StopRequest | null> {
  return deps.db.runTransaction(async (tx) => {
    const rootRef = deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId);
    const userRef = deps.db.collection("users").doc(input.uid);
    const sourceRef = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId);
    const [user, root, source, operation, target, assignment] = await Promise.all([
      tx.get(userRef), tx.get(rootRef), tx.get(sourceRef),
      tx.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(input.operationId)),
      tx.get(deps.db.collection(GATEWAYS_COLLECTION).doc(input.toGatewayId)),
      tx.get(deps.db.collection(`${GATEWAYS_COLLECTION}/${input.toGatewayId}/assignments`).doc(input.uid)),
    ]);
    const desired = root.data();
    assertOwner(desired, input);
    const records = { user: user.data(), desired, source: source.data(), operation: operation.data(), target: target.data(), assignment: assignment.data() };
    if (!pauseAuthorityMatches(input, records, intent)) throw new Error("native return source pause authority changed");
    const retirement = nativeSchedulerRetirementForReturn(input, records.user, records.source, records.operation);
    persistSchedulerRetirement(tx, userRef, retirement);
    if (desired?.desiredStatus !== "paused") {
      tx.update(rootRef, { desiredStatus: "paused", updatedAt: deps.now(), updatedBy: input.operationId });
    }
    const token = readStopRequest(records.source);
    const claimed = token?.claimedAt !== undefined ? token : null;
    const stopOnPark = stopOnParkUpdate(input, intent, claimed);
    if (stopOnPark) tx.update(sourceRef, { vmStopOnPark: stopOnPark });
    return claimed;
  });
}

function pauseAuthorityMatches(input: NativeComputerReturnInput, records: Record<"user" | "desired" | "source" | "operation" | "target" | "assignment", DocumentData | undefined>,
  intent: PauseIntent): boolean {
  const { user, desired, source, operation, target, assignment } = records;
  return user?.provisioning?.openclaw?.gatewayId === input.toGatewayId && target?.gatewayClass === "shared" &&
    sharedAssignmentMatches(assignment, input) && committedOperationMatches(operation, input) &&
    sourceCheckpointMatches(source, input) && ["running", "paused"].includes(desired?.desiredStatus) &&
    (!("parkedAs" in intent) || isDeepStrictEqual(intent.parkedAs, nativeReturnSourceIdentity(source, desired)));
}

function stopOnParkUpdate(input: NativeComputerReturnInput, intent: PauseIntent, claimed: StopRequest | null): Record<string, string> | FieldValue | null {
  if ("requestStop" in intent) {
    if (claimed) return null;
    return intent.requestStop === null ? FieldValue.delete() : { operationId: input.operationId, reason: intent.requestStop };
  }
  return intent.clearStop ? FieldValue.delete() : null;
}

async function acknowledgeCompletedSchedulerHandoff(deps: NativeReturnDeps, input: NativeComputerReturnInput): Promise<void> {
  await deps.db.runTransaction(async tx => {
    const userRef = deps.db.collection("users").doc(input.uid);
    const [user, source, root, operation, target, assignment] = await Promise.all([
      tx.get(userRef), tx.get(deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId)),
      tx.get(deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId)),
      tx.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(input.operationId)),
      tx.get(deps.db.collection(GATEWAYS_COLLECTION).doc(input.toGatewayId)),
      tx.get(deps.db.collection(`${GATEWAYS_COLLECTION}/${input.toGatewayId}/assignments`).doc(input.uid)),
    ]);
    const op = operation.data();
    assertOwner(root.data(), input);
    if (!committedOperationMatches(op, input) || user.data()?.provisioning?.openclaw?.gatewayId !== input.toGatewayId ||
        target.data()?.gatewayClass !== "shared" || !sharedAssignmentMatches(assignment.data(), input) ||
        root.data()?.desiredStatus !== "paused" || !sourceCheckpointMatches(source.data(), input) ||
        returnRequest(source.data(), input.operationId) !== null) {
      throw new Error("native scheduler handoff completion authority changed");
    }
    const pending = nativeSchedulerRetirementForReturn(input, user.data(), source.data(), op);
    if (pending) tx.update(userRef, { "provisioning.pendingNativeSchedulerRetirement": {
      ...pending, completedAt: deps.now(), cutoverCommittedAt: op!.cutoverCommittedAt,
    } });
  });
}

async function parkCommittedSource(deps: NativeReturnDeps, input: NativeComputerReturnInput, park: NativeSourcePark): Promise<NativeReturnPark> {
  const stopReason = await pauseForPark(deps, input, park);
  const deadline = deps.now() + (deps.timeoutMs ?? 300_000);
  let observed = await parkedSourceState(deps, input);
  let stoppedSuspended = false;
  while (observed.state === "running" || (stopReason !== null && observed.state === "suspended")) {
    if (deps.now() >= deadline) throw new Error(`native return source ${stopReason === null ? "park" : "stop"} timed out`);
    if (observed.state === "suspended" && observed.identity && !stoppedSuspended) {
      await stopSuspendedSource(deps, input, observed.identity);
      stoppedSuspended = true;
    }
    await deps.wait(Math.min(5_000, deadline - deps.now()));
    observed = await parkedSourceState(deps, input);
  }
  await pauseCommittedSource(deps, input, { parkedAs: observed.identity!, clearStop: stopReason !== null });
  return stopReason === null ? { parked: observed.state === "suspended" ? "suspended" : "stopped" } : { parked: "stopped", stopReason };
}

async function pauseForPark(deps: NativeReturnDeps, input: NativeComputerReturnInput, park: NativeSourcePark): Promise<string | null> {
  const requested = park.mode === "stop" ? park.reason : null;
  const inFlight = await pauseCommittedSource(deps, input, { requestStop: requested });
  return requested ?? (inFlight ? `a claimed stop of ${inFlight.operationId} is in flight: ${inFlight.reason}` : null);
}

async function stopSuspendedSource(deps: NativeReturnDeps, input: NativeComputerReturnInput, identity: SourceIdentity): Promise<void> {
  if (await claimSuspendedSourceStop(deps, input)) await deps.vm.stop(identity.instanceName, identity.zone);
}

async function claimSuspendedSourceStop(deps: NativeReturnDeps, input: NativeComputerReturnInput): Promise<boolean> {
  const sourceRef = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId);
  return deps.db.runTransaction(async (tx) => {
    const [source, operation] = await Promise.all([
      tx.get(sourceRef), tx.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(input.operationId)),
    ]);
    if (!committedOperationMatches(operation.data(), input)) throw new Error("native return source stop authority changed");
    const token = readStopRequest(source.data());
    if (token?.operationId !== input.operationId) return false;
    if (token.claimedAt === undefined) tx.update(sourceRef, { "vmStopOnPark.claimedAt": deps.now() });
    return true;
  });
}

async function parkedSourceState(deps: NativeReturnDeps, input: NativeComputerReturnInput): Promise<{ state: NativeReturnSourceState; identity: SourceIdentity | null }> {
  const [source, root] = await Promise.all([
    deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId).get(),
    deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId).get(),
  ]);
  const desired = root.data();
  assertOwner(desired, input);
  const identity = nativeReturnSourceIdentity(source.data(), desired);
  return { state: identity ? await nativeReturnSourceState(deps.vm, identity) : "running", identity };
}

async function sourceComputerStatus(deps: NativeReturnDeps, input: NativeComputerReturnInput): Promise<string | null> {
  const vm = (await deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId).get()).data()?.vm;
  if (![vm?.instanceName, vm?.zone, vm?.instanceId].every(v => typeof v === "string" && v.length > 0)) {
    throw new Error(`native return source ${input.fromGatewayId} has no recorded computer`);
  }
  const current = await deps.vm.describe(vm.instanceName, vm.zone);
  if (current === null) return null;
  if (current.instanceId !== vm.instanceId) throw new Error(`native return source computer ${vm.instanceName} was replaced`);
  return current.status;
}

export async function prepareNativeComputerReturn(
  deps: NativeReturnDeps,
  input: NativeComputerReturnInput,
): Promise<NativeComputerReturn | null> {
  const [source, target, root] = await Promise.all([
    deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId).get(),
    deps.db.collection(GATEWAYS_COLLECTION).doc(input.toGatewayId).get(),
    deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId).get(),
  ]);
  if (source.data()?.runtime !== "gce-vm") return null;
  if (!target.exists) throw new Error(`native computer return target is unavailable: ${input.toGatewayId}`);
  if (target.data()?.gatewayClass !== "shared") return null;
  assertOwner(root.data(), input);
  let requestedAt = returnRequest(source.data(), input.operationId);
  return {
    checkpointRequested: returnRequest(source.data(), input.operationId) !== null,
    requestCheckpoint: async () => {
      requestedAt = await claimCheckpoint(deps, input);
    },
    awaitCheckpoint: async () => {
      if (requestedAt === null) return;
      const result = await awaitHomeCheckpoint({
        ...deps,
        readHomeCheckpointCompletedAt: (gatewayId) => readHomeCheckpointCompletedAt(deps.db, gatewayId),
      }, { gatewayId: input.fromGatewayId, requestedAt });
      if (result.outcome !== "completed") throw new Error(`native computer checkpoint ${result.outcome}; source retained`);
    },
    release: () => releaseUncommittedCheckpoint(deps, input, requestedAt),
    releaseWriterHold: () => releaseCommittedWriterHold(deps, input, requestedAt),
    sourceComputerStatus: () => sourceComputerStatus(deps, input),
    park: (park) => parkCommittedSource(deps, input, park),
    acknowledgeCompletedSchedulerHandoff: () => acknowledgeCompletedSchedulerHandoff(deps, input),
  };
}
