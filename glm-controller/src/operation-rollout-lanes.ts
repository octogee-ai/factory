import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { RolloutLane } from "@octogee/core/fleet-operation-lock";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION, isValidGatewayId } from "@octogee/shared/types/glm";
import type { OperationRef } from "./operation-queue.js";

export async function readOperationRolloutLanes(
  db: Firestore,
  transaction: Transaction,
  operations: readonly OperationRef[],
): Promise<ReadonlyMap<string, RolloutLane>> {
  const gatewayIds = new Set(operations.flatMap((operation) => {
    const gatewayId = operation.input?.gatewayId;
    return operation.kind === "rollout" && isValidGatewayId(gatewayId) ? [gatewayId] : [];
  }));
  const lanes = new Map<string, RolloutLane>();
  await Promise.all([...gatewayIds].map(async (gatewayId) => {
    const [rootSnapshot, runtimeSnapshot] = await Promise.all([
      transaction.get(db.collection(GATEWAYS_COLLECTION).doc(gatewayId)),
      transaction.get(db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId)),
    ]);
    const root = rootSnapshot.data();
    const runtime = runtimeSnapshot.data();
    if (root?.gatewayId !== gatewayId) return;
    if (root.gatewayClass !== "shared" && root.gatewayClass !== "builder") return;
    if (runtime?.runtime === "cluster") lanes.set(gatewayId, "cluster");
    if (root.gatewayClass === "builder" && runtime?.runtime === "gce-vm") {
      lanes.set(gatewayId, "builder-vm");
    }
  }));
  return lanes;
}

export function withOperationRolloutLane<T extends OperationRef>(
  operation: T,
  lanes: ReadonlyMap<string, RolloutLane>,
): T {
  const gatewayId = operation.input?.gatewayId;
  return {
    ...operation,
    rolloutLane: operation.kind === "rollout" && typeof gatewayId === "string"
      ? lanes.get(gatewayId) : undefined,
  };
}
