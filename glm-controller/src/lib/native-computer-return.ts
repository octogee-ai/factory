import { isDeepStrictEqual } from "node:util";
import { nativeReturnSourceIdentity, nativeReturnSourceStopped } from "./native-return-source-fence.js";
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

export interface NativeComputerReturn {
  checkpointRequested: boolean;
  checkpoint: () => Promise<void>;
  release: () => Promise<void>;
  acknowledgeCompletedSchedulerHandoff: () => Promise<void>;
  isSourceFencedOff: () => Promise<boolean>;
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
  vm: Pick<GatewayVmClient, "describe">;
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
    if (!precutoverOperationMatches(operation.data(), input) || operation.data()?.cancellationRequestedAt !== undefined) {
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

async function releaseCheckpoint(deps: NativeReturnDeps, input: NativeComputerReturnInput, requestedAt: number | null, fence: ReturnType<typeof nativeReturnSourceIdentity>): Promise<void> {
  const source = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId);
  await deps.db.runTransaction(async (tx) => {
    const [snap, root, operation, user] = await Promise.all([
      tx.get(source), tx.get(deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId)),
      tx.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(input.operationId)),
      tx.get(deps.db.collection("users").doc(input.uid)),
    ]);
    if (returnRequest(snap.data(), input.operationId) === null) return;
    assertOwner(root.data(), input);
    if (returnRequest(snap.data(), input.operationId) !== requestedAt ||
        !releaseAuthorityMatches(input, fence, { operation: operation.data(), user: user.data(), source: snap.data(), root: root.data() })) {
      throw new Error("native return checkpoint release authority changed");
    }
    tx.update(source, {
      "vmHome.returnOperationId": FieldValue.delete(),
      "vmHome.checkpointRequestedAt": FieldValue.delete(),
      "vmHome.parkRequestedAt": FieldValue.delete(),
    });
  });
}

function currentOperationMatches(op: DocumentData | undefined, input: NativeComputerReturnInput): boolean {
  return op?.kind === "migrate-customer" && op.status === "running" &&
    typeof input.claimedStartedAt === "number" && op.startedAt === input.claimedStartedAt &&
    op.input?.uid === input.uid && op.input.fromGatewayId === input.fromGatewayId && op.input.toGatewayId === input.toGatewayId;
}

function precutoverOperationMatches(op: DocumentData | undefined, input: NativeComputerReturnInput): boolean {
  return currentOperationMatches(op, input) && op?.cutoverCommittedAt === undefined;
}

function releaseAuthorityMatches(input: NativeComputerReturnInput, fence: ReturnType<typeof nativeReturnSourceIdentity>,
  records: { operation?: DocumentData; user?: DocumentData; source?: DocumentData; root?: DocumentData }): boolean {
  const { operation, user, source, root } = records;
  const current = user?.provisioning?.openclaw?.gatewayId;
  if (!fence) return precutoverOperationMatches(operation, input) && current === input.fromGatewayId;
  return committedOperationMatches(operation, input) && current === input.toGatewayId &&
    isDeepStrictEqual(fence, nativeReturnSourceIdentity(source, root));
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

async function pauseCommittedSource(deps: NativeReturnDeps, input: NativeComputerReturnInput): Promise<boolean> {
  return deps.db.runTransaction(async (tx) => {
    const rootRef = deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId);
    const userRef = deps.db.collection("users").doc(input.uid);
    const [user, root, source, operation, target, assignment] = await Promise.all([
      tx.get(userRef), tx.get(rootRef),
      tx.get(deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId)),
      tx.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(input.operationId)),
      tx.get(deps.db.collection(GATEWAYS_COLLECTION).doc(input.toGatewayId)),
      tx.get(deps.db.collection(`${GATEWAYS_COLLECTION}/${input.toGatewayId}/assignments`).doc(input.uid)),
    ]);
    const current = user.data()?.provisioning?.openclaw?.gatewayId;
    if (current === input.fromGatewayId) return false;
    const desired = root.data();
    assertOwner(desired, input);
    const exact = current === input.toGatewayId && target.data()?.gatewayClass === "shared" &&
      sharedAssignmentMatches(assignment.data(), input) && committedOperationMatches(operation.data(), input) &&
      sourceCheckpointMatches(source.data(), input) &&
      ["running", "paused"].includes(desired?.desiredStatus);
    if (!exact) throw new Error("native return source pause authority changed");
    const retirement = nativeSchedulerRetirementForReturn(input, user.data(), source.data(), operation.data());
    persistSchedulerRetirement(tx, userRef, retirement);
    if (desired?.desiredStatus !== "paused") {
      tx.update(rootRef, { desiredStatus: "paused", updatedAt: deps.now(), updatedBy: input.operationId });
    }
    return true;
  });
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

async function releaseReturnCheckpoint(deps: NativeReturnDeps, input: NativeComputerReturnInput, requestedAt: number | null): Promise<void> {
  let fence: ReturnType<typeof nativeReturnSourceIdentity> = null;
  const committed = await pauseCommittedSource(deps, input);
  if (committed) {
    const deadline = deps.now() + (deps.timeoutMs ?? 300_000);
    fence = await stoppedSourceIdentity(deps, input);
    while (!fence) {
      if (deps.now() >= deadline) throw new Error("native return source stop timed out; final checkpoint remains held");
      await deps.wait(Math.min(5_000, deadline - deps.now()));
      fence = await stoppedSourceIdentity(deps, input);
    }
    if (!await pauseCommittedSource(deps, input)) throw new Error("native return source pause authority changed");
  }
  await releaseCheckpoint(deps, input, requestedAt, fence);
}

async function stoppedSourceIdentity(deps: NativeReturnDeps, input: NativeComputerReturnInput) {
  const [source, root] = await Promise.all([
    deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId).get(),
    deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId).get(),
  ]);
  const desired = root.data();
  assertOwner(desired, input);
  const identity = nativeReturnSourceIdentity(source.data(), desired);
  return identity && await nativeReturnSourceStopped(deps.vm, identity) ? identity : null;
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
  if (source.data()?.runtime !== "gce-vm" || target.data()?.gatewayClass !== "shared") return null;
  assertOwner(root.data(), input);
  let requestedAt = returnRequest(source.data(), input.operationId);
  return {
    checkpointRequested: returnRequest(source.data(), input.operationId) !== null,
    checkpoint: async () => {
      requestedAt = await claimCheckpoint(deps, input);
      const result = await awaitHomeCheckpoint({
        ...deps,
        readHomeCheckpointCompletedAt: (gatewayId) => readHomeCheckpointCompletedAt(deps.db, gatewayId),
      }, { gatewayId: input.fromGatewayId, requestedAt });
      if (result.outcome !== "completed") throw new Error(`native computer checkpoint ${result.outcome}; source retained`);
    },
    release: () => releaseReturnCheckpoint(deps, input, requestedAt),
    acknowledgeCompletedSchedulerHandoff: () => acknowledgeCompletedSchedulerHandoff(deps, input),
    isSourceFencedOff: async () => await stoppedSourceIdentity(deps, input) !== null,
  };
}
