import type {
  BuilderRecord,
  GatewayAssignment,
  PlatformStateRepositories,
  PlatformStateStore,
  Stored,
} from "@octogee/core/platform-state";

interface RecoveryIdentity { ownerUid: string; gatewayId: string; instanceId: string; operationId: string }

export async function assertOwnerOperationUnfenced(
  state: Pick<PlatformStateRepositories, "builders">,
  operationId: string,
  input: Record<string, unknown>,
): Promise<void> {
  if (!input || typeof input !== "object") return;
  const uid = input.uid ?? input.ownerUid;
  if (typeof uid !== "string" || !uid || uid.includes("/")) return;
  const fence = (await state.builders.records.get(uid))?.fences.computerRecovery;
  if (fence !== undefined && fence.operationId !== operationId) throw new Error("Builder computer recovery is in progress");
}

function assertFence(owner: Stored<BuilderRecord> | null, identity: RecoveryIdentity): { gatewayId: string; epoch: number } {
  const fence = owner?.fences.computerRecovery;
  if (!owner || !fence) throw new Error("computer recovery owner fence changed");
  const lease = owner.activationLease;
  const parked = owner.home.computer;
  const valid = [
    fence.operationId === identity.operationId, fence.gatewayId === identity.gatewayId, fence.instanceId === identity.instanceId,
    typeof fence.sharedGatewayId === "string", !!fence.sharedGatewayId, !String(fence.sharedGatewayId).includes("/"),
    Number.isSafeInteger(fence.assignmentEpoch), fence.assignmentEpoch! >= 0,
    owner.gateway?.gatewayId === fence.sharedGatewayId,
    lease === null || ["failed", "parked"].includes(lease.status),
    parked === undefined || (parked.gatewayId === identity.gatewayId && parked.instanceId === identity.instanceId),
  ];
  if (!valid.every(Boolean)) {
    throw new Error("computer recovery owner fence changed");
  }
  return { gatewayId: fence.sharedGatewayId!, epoch: fence.assignmentEpoch! };
}

function assertAssignment(assignment: Stored<GatewayAssignment> | null, identity: RecoveryIdentity, shared: { gatewayId: string; epoch: number }): void {
  if (assignment?.uid !== identity.ownerUid || assignment.gatewayId !== shared.gatewayId || assignment.state !== "serving" || assignment.epoch !== shared.epoch) throw new Error("computer recovery Shared assignment changed");
}

async function assertSharedAssignment(state: PlatformStateRepositories, owner: Stored<BuilderRecord> | null, identity: RecoveryIdentity): Promise<void> {
  const shared = assertFence(owner, identity);
  const [root, assignment] = await Promise.all([
    state.gateways.roots.get(shared.gatewayId),
    state.gateways.assignments.get(shared.gatewayId, identity.ownerUid),
  ]);
  if (root?.gatewayClass !== "shared") throw new Error("computer recovery Shared assignment changed");
  assertAssignment(assignment, identity, shared);
}

export async function assertComputerRecoveryFence(store: PlatformStateStore, identity: RecoveryIdentity): Promise<void> {
  await assertSharedAssignment(store, await store.builders.records.get(identity.ownerUid), identity);
}

export async function finishComputerRecovery(store: PlatformStateStore, identity: RecoveryIdentity): Promise<void> {
  await store.transaction({ label: "computer-recovery.finish" }, async tx => {
    const owner = await tx.builders.records.get(identity.ownerUid);
    await assertSharedAssignment(tx, owner, identity);
    const parked = owner!.home.computer;
    if (parked && (parked.gatewayId !== identity.gatewayId || parked.instanceId !== identity.instanceId)) {
      throw new Error("computer recovery parked identity changed");
    }
    await tx.builders.records.setFence(identity.ownerUid, "computerRecovery", { clear: true }, owner!.fences.computerRecovery);
    if (parked) await tx.builders.records.patch(identity.ownerUid, { home: { computer: { clear: true } } });
  });
}
