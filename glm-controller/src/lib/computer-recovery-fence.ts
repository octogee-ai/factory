import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";

interface RecoveryIdentity { ownerUid: string; gatewayId: string; instanceId: string; operationId: string }

export async function assertOwnerOperationUnfenced(db: Firestore, tx: Transaction, operationId: string, input: Record<string, unknown>): Promise<void> {
  if (!input || typeof input !== "object") return;
  const uid = input.uid ?? input.ownerUid;
  if (typeof uid !== "string" || !uid || uid.includes("/")) return;
  const fence = (await tx.get(db.collection("users").doc(uid))).data()?.provisioning?.computerRecovery;
  if (fence != null && fence.operationId !== operationId) throw new Error("Builder computer recovery is in progress");
}

function assertFence(data: FirebaseFirestore.DocumentData | undefined, identity: RecoveryIdentity): { gatewayId: string; epoch: number } {
  const provisioning = data?.provisioning;
  const fence = provisioning?.computerRecovery;
  const lease = provisioning?.openclaw?.activationLease;
  const parked = provisioning?.computer;
  if (!fence) throw new Error("computer recovery owner fence changed");
  const valid = [
    fence.operationId === identity.operationId, fence.gatewayId === identity.gatewayId, fence.instanceId === identity.instanceId,
    typeof fence.sharedGatewayId === "string", !!fence.sharedGatewayId, !String(fence.sharedGatewayId).includes("/"),
    Number.isSafeInteger(fence.assignmentEpoch), fence.assignmentEpoch >= 0,
    provisioning?.openclaw?.gatewayId === fence.sharedGatewayId,
    lease == null || ["failed", "parked"].includes(lease.status),
    parked == null || (parked.gatewayId === identity.gatewayId && parked.instanceId === identity.instanceId),
  ];
  if (!valid.every(Boolean)) {
    throw new Error("computer recovery owner fence changed");
  }
  return { gatewayId: fence.sharedGatewayId, epoch: fence.assignmentEpoch };
}

function assertAssignment(assignment: FirebaseFirestore.DocumentData | undefined, identity: RecoveryIdentity, shared: { gatewayId: string; epoch: number }): void {
  if (assignment?.uid !== identity.ownerUid || assignment.gatewayId !== shared.gatewayId || assignment.state !== "serving" || assignment.epoch !== shared.epoch) throw new Error("computer recovery Shared assignment changed");
}

export async function assertComputerRecoveryFence(db: Firestore, identity: RecoveryIdentity): Promise<void> {
  const shared = assertFence((await db.doc(`users/${identity.ownerUid}`).get()).data(), identity);
  const [root, assignment] = await Promise.all([db.doc(`gateways/${shared.gatewayId}`).get(), db.doc(`gateways/${shared.gatewayId}/assignments/${identity.ownerUid}`).get()]);
  if (root.data()?.gatewayClass !== "shared") throw new Error("computer recovery Shared assignment changed");
  assertAssignment(assignment.data(), identity, shared);
}

export async function finishComputerRecovery(db: Firestore, identity: RecoveryIdentity): Promise<void> {
  const ref = db.doc(`users/${identity.ownerUid}`);
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const data = snapshot.data();
    const shared = assertFence(data, identity);
    const [root, assignment] = await Promise.all([tx.get(db.doc(`gateways/${shared.gatewayId}`)), tx.get(db.doc(`gateways/${shared.gatewayId}/assignments/${identity.ownerUid}`))]);
    if (root.data()?.gatewayClass !== "shared") throw new Error("computer recovery Shared assignment changed");
    assertAssignment(assignment.data(), identity, shared);
    const parked = data?.provisioning?.computer;
    if (parked && (parked.gatewayId !== identity.gatewayId || parked.instanceId !== identity.instanceId)) {
      throw new Error("computer recovery parked identity changed");
    }
    tx.set(ref, { provisioning: { computerRecovery: FieldValue.delete(), ...(parked ? { computer: FieldValue.delete() } : {}) } }, { merge: true });
  });
}
