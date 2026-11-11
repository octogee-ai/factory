import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { GatewayProfile } from "../../shared/types/glm.js";

export function addUserAssignmentRefusal(input: {
  targetGatewayId: string;
  currentGatewayId: string | null;
  assignmentGatewayIds: readonly string[];
}): string | null {
  const elsewhere = input.assignmentGatewayIds.filter((gatewayId) => gatewayId !== input.targetGatewayId);
  if (elsewhere.length > 0) {
    return `user has a serving assignment on ${elsewhere.join(", ")}; add-customer only places a user onto one gateway and would strand it. Move the user with migrate-customer.`;
  }
  if (input.currentGatewayId && input.currentGatewayId !== input.targetGatewayId && !input.assignmentGatewayIds.includes(input.targetGatewayId)) {
    return `user is placed on ${input.currentGatewayId}; add-customer only places a user onto one gateway and would strand it. Move the user with migrate-customer.`;
  }
  return null;
}

export type AddUserPlacementOutcome = "placed" | "repaired" | "unchanged";

export interface AddUserPlacementInput {
  uid: string;
  gatewayId: string;
  gatewayProfile: GatewayProfile;
  now: number;
}

export async function commitAddUserPlacement(
  store: PlatformStateStore,
  input: AddUserPlacementInput,
): Promise<AddUserPlacementOutcome> {
  return store.transaction({ label: "fleet.add-customer" }, async (tx) => {
    const [user, root, assignments] = await Promise.all([
      tx.users.records.get(input.uid),
      tx.gateways.roots.get(input.gatewayId),
      tx.gateways.assignments.listForUid(input.uid),
    ]);
    if (user === null) throw new Error(`User ${input.uid} does not exist`);
    if (user.slug === null) throw new Error(`User ${input.uid} has no slug to assign`);
    if (root === null) throw new Error(`Gateway '${input.gatewayId}' has no durable root; refusing to write a placement without its assignment`);
    if (root.desiredStatus !== "running") throw new Error(`Gateway '${input.gatewayId}' is ${root.desiredStatus}, not running`);
    const currentGatewayId = user.gateway?.gatewayId ?? null;
    const refusal = addUserAssignmentRefusal({
      targetGatewayId: input.gatewayId,
      currentGatewayId,
      assignmentGatewayIds: assignments.map((assignment) => assignment.gatewayId),
    });
    if (refusal) throw new Error(refusal);
    const assigned = assignments.some((assignment) => assignment.gatewayId === input.gatewayId);
    if (assigned && currentGatewayId === input.gatewayId && user.gateway?.gatewayProfile === input.gatewayProfile) {
      return "unchanged";
    }
    await tx.users.records.setGatewayMirror(
      input.uid,
      { gatewayId: input.gatewayId, gatewayProfile: input.gatewayProfile, controlUiEnabled: false },
      { gatewayId: currentGatewayId },
    );
    if (assigned) return "repaired";
    await tx.gateways.assignments.create({
      uid: input.uid,
      slug: user.slug,
      gatewayId: input.gatewayId,
      source: "repair",
      state: "serving",
      epoch: 0,
      createdAt: input.now,
      updatedAt: input.now,
      updatedByOperationId: null,
    });
    return "placed";
  });
}
