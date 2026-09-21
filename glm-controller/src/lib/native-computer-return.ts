import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";
import { awaitHomeCheckpoint, readHomeCheckpointCompletedAt, readVmHome } from "./home-checkpoint.js";
import type { GatewayVmClient } from "./compute-vm.js";

export interface NativeComputerReturnInput {
  fromGatewayId: string;
  toGatewayId: string;
  uid: string;
  slug: string;
  operationId: string;
}

export interface NativeComputerReturn {
  checkpointRequested: boolean;
  checkpoint: () => Promise<void>;
  release: () => Promise<void>;
  isSourceFencedOff: () => Promise<boolean>;
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
    const [snap, user, root] = await Promise.all([
      tx.get(source), tx.get(deps.db.collection("users").doc(input.uid)),
      tx.get(deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId)),
    ]);
    const data = snap.data();
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

async function releaseCheckpoint(deps: NativeReturnDeps, input: NativeComputerReturnInput): Promise<void> {
  const source = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId);
  await deps.db.runTransaction(async (tx) => {
    const [snap, root] = await Promise.all([
      tx.get(source), tx.get(deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId)),
    ]);
    if (returnRequest(snap.data(), input.operationId) === null) return;
    assertOwner(root.data(), input);
    tx.update(source, {
      "vmHome.returnOperationId": FieldValue.delete(),
      "vmHome.checkpointRequestedAt": FieldValue.delete(),
      "vmHome.parkRequestedAt": FieldValue.delete(),
    });
  });
}

async function isSourceFencedOff(deps: NativeReturnDeps, input: NativeComputerReturnInput): Promise<boolean> {
  const [source, root] = await Promise.all([
    deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.fromGatewayId).get(),
    deps.db.collection(GATEWAYS_COLLECTION).doc(input.fromGatewayId).get(),
  ]);
  const desired = root.data();
  assertOwner(desired, input);
  if (desired?.desiredStatus !== "paused" && desired?.desiredStatus !== "retired") return false;
  const vm = source.data()?.vm;
  if (!vm?.instanceName || !vm.zone) return false;
  const current = await deps.vm.describe(vm.instanceName, vm.zone);
  return current === null || current.status === "TERMINATED" || current.status === "STOPPED";
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
  return {
    checkpointRequested: returnRequest(source.data(), input.operationId) !== null,
    checkpoint: async () => {
      const requestedAt = await claimCheckpoint(deps, input);
      const result = await awaitHomeCheckpoint({
        ...deps,
        readHomeCheckpointCompletedAt: (gatewayId) => readHomeCheckpointCompletedAt(deps.db, gatewayId),
      }, { gatewayId: input.fromGatewayId, requestedAt });
      if (result.outcome !== "completed") throw new Error(`native computer checkpoint ${result.outcome}; source retained`);
    },
    release: () => releaseCheckpoint(deps, input),
    isSourceFencedOff: () => isSourceFencedOff(deps, input),
  };
}
