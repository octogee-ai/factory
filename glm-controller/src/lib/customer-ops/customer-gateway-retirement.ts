import type { Firestore } from "firebase-admin/firestore";
import { claimGatewayRetirementAtomic } from "@octogee/core/gateway-retirement-claim";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";

export type OwnedGatewayRetirementOutcome =
  | "not-owned"
  | "retirement-pending"
  | "retired";

export interface OwnedGatewayRetirementInput {
  db: Firestore;
  uid: string;
  deletionId: string;
  now: number;
  claimRetirement?: typeof claimGatewayRetirementAtomic;
}

function retirementOperationId(deletionId: string, gatewayId: string): string {
  return `delete-retire-${deletionId}-${gatewayId}`;
}

export async function ensureOwnedDedicatedGatewaysRetired(
  input: OwnedGatewayRetirementInput,
): Promise<OwnedGatewayRetirementOutcome> {
  const claimRetirement = input.claimRetirement ?? claimGatewayRetirementAtomic;
  const snapshot = await input.db
    .collection(GATEWAYS_COLLECTION)
    .where("ownerUid", "==", input.uid)
    .get();
  const owned = snapshot.docs
    .filter((doc) => doc.data().gatewayClass !== "shared")
    .sort((a, b) => a.id.localeCompare(b.id));
  if (owned.length === 0) return "not-owned";

  let pending = false;
  for (const doc of owned) {
    const root = doc.data() as Record<string, unknown>;
    if (root.gatewayClass !== "builder" && root.gatewayClass !== "operator") {
      throw new Error(`owned gateway ${doc.id} has invalid class: ${String(root.gatewayClass)}`);
    }
    const operationId = retirementOperationId(input.deletionId, doc.id);
    const operationRef = input.db.collection(GLM_OPERATIONS_COLLECTION).doc(operationId);
    if (root.desiredStatus === "retired") {
      const operationSnap = await operationRef.get();
      const operation = operationSnap.data() as Record<string, unknown> | undefined;
      if (operation?.status === "failed") {
        throw new Error(
          `dedicated gateway ${doc.id} retirement failed: ${String(operation.error ?? "unknown")}`,
        );
      }
      if (operation?.status !== "succeeded") {
        pending = true;
        continue;
      }
      await input.db.recursiveDelete(doc.ref);
      await input.db.recursiveDelete(operationRef);
      continue;
    }
    if (root.desiredStatus !== "running" && root.desiredStatus !== "paused") {
      throw new Error(
        `owned gateway ${doc.id} has invalid desired status: ${String(root.desiredStatus)}`,
      );
    }
    await claimRetirement({
      db: input.db,
      gatewayId: doc.id,
      operationId,
      operation: {
        kind: "retire-gateway",
        status: "pending",
        createdBy: "customer-deletion-lifecycle",
        createdAt: input.now,
        startedAt: null,
        completedAt: null,
        input: { gatewayId: doc.id },
        steps: [],
        gatewayId: doc.id,
      },
      now: input.now,
      updatedBy: "customer-deletion-lifecycle",
      claimGuard: ({ root: claimedRoot }) => {
        const claimed = claimedRoot as unknown as Record<string, unknown>;
        if (claimed.ownerUid !== input.uid || claimed.gatewayClass === "shared") {
          throw new Error(`gateway ${doc.id} ownership changed during customer deletion`);
        }
      },
    });
    pending = true;
  }
  return pending ? "retirement-pending" : "retired";
}
