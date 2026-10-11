import type { DocumentReference, DocumentSnapshot, Firestore, QueryDocumentSnapshot, Transaction } from "firebase-admin/firestore";
import { claimGatewayRetirementAtomic } from "@octogee/core/gateway-retirement-claim";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GLM_OPERATIONS_COLLECTION,
} from "@octogee/shared/types/glm";
import { schedulerHandoffAwaitingRelease } from "../../scheduler-handoff-release.js";
import { DISPOSABLE_GATEWAY_RECOVERY_RECEIPTS_COLLECTION } from "../../placement-policy-reconciler.js";

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
  assertRetirementClaimOwnership(input, doc.id, root);
  const operationId = retirementOperationId(input.deletionId, doc.id);
  if (root.desiredStatus === "retired") {
    return finishCompletedGatewayRetirement(input, doc);
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
    claimGuard: async ({ root: claimedRoot }) => {
      const claimed = claimedRoot as unknown as Record<string, unknown>;
      assertRetirementClaimOwnership(input, doc.id, claimed);
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
): Promise<boolean> {
  const expectedClaim = retirementClaim(doc.id, doc.data());
  const operationRef = input.db.collection(GLM_OPERATIONS_COLLECTION).doc(expectedClaim.operationId);
  const recoveryRefs = [GLM_OPERATIONS_COLLECTION, DISPOSABLE_GATEWAY_RECOVERY_RECEIPTS_COLLECTION]
    .map((collection) => input.db.collection(collection).doc(`builder-recover-${doc.id}`));
  const canFinish = async (transaction: Transaction): Promise<DocumentReference[] | null> => {
    const rootSnap = await transaction.get(doc.ref);
    const root = rootSnap.data();
    if (!root) return null;
    assertRetirementClaimOwnership(input, doc.id, root);
    const claim = retirementClaim(doc.id, root);
    if (root.desiredStatus !== "retired" || claim.operationId !== expectedClaim.operationId || claim.version !== expectedClaim.version) {
      throw new Error(`owned gateway ${doc.id} retirement claim changed during customer deletion`);
    }
    const operationSnap = await transaction.get(operationRef);
    if (!retirementOperationAllowsCleanup(input, doc.id, claim.version, operationSnap)) return null;
    const [runtime, assignments, users, ...handoffs] = await Promise.all([
      transaction.get(input.db.collection("glmGateways").doc(doc.id)),
      transaction.get(doc.ref.collection("assignments")),
      transaction.get(input.db.collection("users").where("provisioning.openclaw.gatewayId", "==", doc.id)),
      ...["builder-activate", "builder-return"].map((prefix) =>
        transaction.get(input.db.collection(GLM_OPERATIONS_COLLECTION).doc(`${prefix}-${doc.id}`))),
    ]);
    if (runtime.exists || !assignments.empty || !users.empty ||
      handoffs.some((snapshot) => schedulerHandoffAwaitingRelease({ ...snapshot.data(), id: snapshot.id }))) return null;
    const recoverySnapshots = await Promise.all(recoveryRefs.map((ref) => transaction.get(ref)));
    const cleanupRefs = [doc.ref, operationRef];
    for (const [index, snapshot] of recoverySnapshots.entries()) {
      if (!snapshot.exists) continue;
      assertRecoveryOwnership(input, doc.id, root, snapshot.data()!);
      cleanupRefs.push(recoveryRefs[index]!);
    }
    return cleanupRefs;
  };
  const cleanupRefs = await input.db.runTransaction(canFinish);
  if (!cleanupRefs) return true;
  const childCollections = await Promise.all(cleanupRefs.map((ref) => ref.listCollections()));
  for (const collection of childCollections.flat()) {
    if (collection.path === `${doc.ref.path}/assignments`) continue;
    await input.db.recursiveDelete(collection);
  }
  return input.db.runTransaction(async (transaction) => {
    const currentRefs = await canFinish(transaction);
    if (!currentRefs || currentRefs.length !== cleanupRefs.length ||
      currentRefs.some((ref, index) => ref.path !== cleanupRefs[index]?.path)) return true;
    for (const ref of currentRefs) transaction.delete(ref);
    return false;
  });
}

function retirementOperationAllowsCleanup(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
  version: number,
  operationSnap: DocumentSnapshot,
): boolean {
  const operation = operationSnap.data();
  if (!operationSnap.exists) return false;
  if (operation?.kind !== "retire-gateway" || operation.gatewayId !== gatewayId ||
    operation.input?.gatewayId !== gatewayId || operation.input.retirementClaimVersion !== version ||
    (operation.input.uid != null && operation.input.uid !== input.uid)) {
    throw new Error(`owned gateway ${gatewayId} retirement operation does not match its owner and claim`);
  }
  if (operation.status === "failed") {
    throw new Error(`owned gateway ${gatewayId} retirement failed: ${String(operation.error ?? "unknown")}`);
  }
  if (operation.status !== "succeeded") return false;
  if (operation.input.retainData === true || operation.input.retainServiceAccount === true) {
    throw new Error(`owned gateway ${gatewayId} retirement retained resources; customer cleanup cannot complete`);
  }
  return true;
}

function assertRecoveryOwnership(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
  root: Record<string, unknown>,
  recovery: Record<string, unknown>,
): void {
  const allocation = root.allocation as Record<string, unknown> | undefined;
  const recoveryInput = recovery.input as Record<string, unknown> | undefined;
  if (recoveryIdentityMismatch(input, gatewayId, recovery, recoveryInput) ||
    recoveryBuilderMismatch(input, root, recoveryInput as Record<string, unknown>, allocation) ||
    recoveryLeaseMismatch(recoveryInput as Record<string, unknown>, allocation as Record<string, unknown>)) {
    throw new Error(`owned gateway ${gatewayId} recovery artifact does not match its owner and allocation`);
  }
}

function recoveryIdentityMismatch(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
  recovery: Record<string, unknown>,
  recoveryInput: Record<string, unknown> | undefined,
): boolean {
  return recovery.kind !== "recover-unreachable-disposable" ||
    recoveryInput?.uid !== input.uid || recoveryInput.gatewayId !== gatewayId ||
    (recovery.gatewayId != null && recovery.gatewayId !== gatewayId) ||
    (recovery.inputUid != null && recovery.inputUid !== input.uid);
}

function recoveryBuilderMismatch(
  input: OwnedGatewayRetirementInput,
  root: Record<string, unknown>,
  recoveryInput: Record<string, unknown>,
  allocation: Record<string, unknown> | undefined,
): boolean {
  return typeof root.builderSlug !== "string" || !root.builderSlug || recoveryInput.builderSlug !== root.builderSlug ||
    allocation?.kind !== "disposable-builder" || allocation.claimedByUid !== input.uid;
}

function recoveryLeaseMismatch(
  recoveryInput: Record<string, unknown>,
  allocation: Record<string, unknown>,
): boolean {
  return typeof allocation.leaseId !== "string" || !allocation.leaseId ||
    !Number.isSafeInteger(allocation.generation) || (allocation.generation as number) <= 0 ||
    recoveryInput.leaseId !== allocation.leaseId || recoveryInput.generation !== allocation.generation;
}

function retirementClaim(gatewayId: string, root: Record<string, unknown>): { operationId: string; version: number } {
  const claim = root.retirementClaim as Record<string, unknown> | undefined;
  if (!claim || typeof claim.operationId !== "string" || !claim.operationId || claim.operationId.includes("/") ||
    !Number.isInteger(claim.version) || (claim.version as number) <= 0 ||
    claim.version !== root.retirementVersion || claim.phase !== "claimed") {
    throw new Error(`owned gateway ${gatewayId} has invalid retirement claim`);
  }
  return { operationId: claim.operationId, version: claim.version as number };
}

function assertRetirementClaimOwnership(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
  claimed: Record<string, unknown>,
): void {
  if (claimed.ownerUid !== input.uid || claimed.gatewayClass !== "builder") {
    throw new Error(`gateway ${gatewayId} ownership changed during customer deletion`);
  }
}

