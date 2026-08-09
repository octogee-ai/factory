import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { claimGatewayRetirementAtomic } from "@octogee/core/gateway-retirement-claim";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GLM_OPERATIONS_COLLECTION,
  isOperatorManaged,
  resolveOperationOrigin,
} from "@octogee/shared/types/glm";

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

export async function ensureOwnedGatewaysRetired(
  input: OwnedGatewayRetirementInput,
): Promise<OwnedGatewayRetirementOutcome> {
  const claimRetirement = input.claimRetirement ?? claimGatewayRetirementAtomic;
  const snapshot = await input.db
    .collection(GATEWAYS_COLLECTION)
    .where("ownerUid", "==", input.uid)
    .get();
  const owned = snapshot.docs
    .filter((doc) => {
      const root = doc.data() as Record<string, unknown>;
      return root.gatewayClass === "builder";
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (owned.length === 0) return "not-owned";

  let pending = false;
  for (const doc of owned) {
    pending = (await reconcileOwnedGatewayRetirement(input, doc, claimRetirement)) || pending;
  }
  return pending ? "retirement-pending" : "retired";
}

async function reconcileOwnedGatewayRetirement(
  input: OwnedGatewayRetirementInput,
  doc: QueryDocumentSnapshot,
  claimRetirement: typeof claimGatewayRetirementAtomic,
): Promise<boolean> {
  const root = doc.data() as Record<string, unknown>;
  if (root.gatewayClass !== "builder") {
    throw new Error(`owned gateway ${doc.id} has invalid class: ${String(root.gatewayClass)}`);
  }
  const operationId = retirementOperationId(input.deletionId, doc.id);
  const operationRef = input.db.collection(GLM_OPERATIONS_COLLECTION).doc(operationId);
  if (root.desiredStatus === "retired") {
    return finishCompletedGatewayRetirement(input, doc, operationRef);
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
    operation: automaticRetirementOperation(input, doc.id),
    now: input.now,
    updatedBy: "customer-deletion-lifecycle",
    claimGuard: async ({ root: claimedRoot, transaction }) => {
      const claimed = claimedRoot as unknown as Record<string, unknown>;
      await assertAutomaticRetirementClaimAllowed(input, doc.id, claimed, transaction);
    },
  });
  return true;
}

function automaticRetirementOperation(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
): Parameters<typeof claimGatewayRetirementAtomic>[0]["operation"] {
  return {
    kind: "retire-gateway",
    status: "pending",
    origin: "automatic",
    createdBy: "customer-deletion-lifecycle",
    createdAt: input.now,
    startedAt: null,
    completedAt: null,
    input: { gatewayId },
    steps: [],
    gatewayId,
  };
}

async function finishCompletedGatewayRetirement(
  input: OwnedGatewayRetirementInput,
  doc: QueryDocumentSnapshot,
  operationRef: FirebaseFirestore.DocumentReference,
): Promise<boolean> {
  const operationSnap = await operationRef.get();
  const operation = operationSnap.data() as Record<string, unknown> | undefined;
  if (operation?.status === "failed") {
    throw new Error(
      `owned gateway ${doc.id} retirement failed: ${String(operation.error ?? "unknown")}`,
    );
  }
  if (operation?.status !== "succeeded") return true;
  if (resolveOperationOrigin(operation.origin) === "automatic") {
    await assertAutomaticRetirementCleanupAllowed(input, doc.id);
  }
  await input.db.recursiveDelete(doc.ref);
  await input.db.recursiveDelete(operationRef);
  return false;
}

async function assertAutomaticRetirementClaimAllowed(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
  claimed: Record<string, unknown>,
  transaction: FirebaseFirestore.Transaction,
): Promise<void> {
  if (isOperatorManaged(claimed.managedBy)) {
    throw new Error(`gateway ${gatewayId} is operator-managed`);
  }
  const user = await transaction.get(input.db.collection("users").doc(input.uid));
  const openclaw = user.data()?.provisioning?.openclaw;
  if (
    openclaw &&
    typeof openclaw === "object" &&
    !Array.isArray(openclaw) &&
    isOperatorManaged((openclaw as Record<string, unknown>).managedBy)
  ) {
    throw new Error(`customer ${input.uid} is operator-managed`);
  }
  if (claimed.ownerUid !== input.uid || claimed.gatewayClass === "shared") {
    throw new Error(`gateway ${gatewayId} ownership changed during customer deletion`);
  }
}

async function assertAutomaticRetirementCleanupAllowed(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
): Promise<void> {
  const [rootSnap, userSnap] = await Promise.all([
    input.db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get(),
    input.db.collection("users").doc(input.uid).get(),
  ]);
  const root = rootSnap.exists ? rootSnap.data() : undefined;
  if (isOperatorManaged(root?.managedBy)) {
    throw new Error(`owned gateway ${gatewayId} is operator-managed`);
  }
  const openclaw = userSnap.data()?.provisioning?.openclaw;
  if (
    openclaw &&
    typeof openclaw === "object" &&
    !Array.isArray(openclaw) &&
    isOperatorManaged((openclaw as Record<string, unknown>).managedBy)
  ) {
    throw new Error(`customer ${input.uid} is operator-managed`);
  }
}
