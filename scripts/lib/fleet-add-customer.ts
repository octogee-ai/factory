import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { GatewayProfile } from "../../shared/types/glm.js";

export function addCustomerAssignmentRefusal(input: {
  targetGatewayId: string;
  currentGatewayId: string | null;
  assignmentGatewayIds: readonly string[];
}): string | null {
  const elsewhere = input.assignmentGatewayIds.filter((gatewayId) => gatewayId !== input.targetGatewayId);
  if (elsewhere.length > 0) {
    return `Builder has a serving assignment on ${elsewhere.join(", ")}; add-customer only places a Builder onto one gateway and would strand it. Move the Builder with migrate-customer.`;
  }
  if (input.currentGatewayId && input.currentGatewayId !== input.targetGatewayId && !input.assignmentGatewayIds.includes(input.targetGatewayId)) {
    return `Builder is placed on ${input.currentGatewayId}; add-customer only places a Builder onto one gateway and would strand it. Move the Builder with migrate-customer.`;
  }
  return null;
}

export type AddCustomerPlacementOutcome = "placed" | "repaired" | "unchanged";

export interface AddCustomerPlacementInput {
  uid: string;
  gatewayId: string;
  gatewayProfile: GatewayProfile;
  now: number;
}

export async function commitAddCustomerPlacement(
  store: PlatformStateStore,
  input: AddCustomerPlacementInput,
): Promise<AddCustomerPlacementOutcome> {
  return store.transaction({ label: "fleet.add-customer" }, async (tx) => {
    const [builder, root, assignments] = await Promise.all([
      tx.builders.records.get(input.uid),
      tx.gateways.roots.get(input.gatewayId),
      tx.gateways.assignments.listForUid(input.uid),
    ]);
    if (builder === null) throw new Error(`Builder ${input.uid} does not exist`);
    if (builder.slug === null) throw new Error(`Builder ${input.uid} has no slug to assign`);
    if (root === null) throw new Error(`Gateway '${input.gatewayId}' has no durable root; refusing to write a placement without its assignment`);
    if (root.desiredStatus !== "running") throw new Error(`Gateway '${input.gatewayId}' is ${root.desiredStatus}, not running`);
    const currentGatewayId = builder.gateway?.gatewayId ?? null;
    const refusal = addCustomerAssignmentRefusal({
      targetGatewayId: input.gatewayId,
      currentGatewayId,
      assignmentGatewayIds: assignments.map((assignment) => assignment.gatewayId),
    });
    if (refusal) throw new Error(refusal);
    const assigned = assignments.some((assignment) => assignment.gatewayId === input.gatewayId);
    if (assigned && currentGatewayId === input.gatewayId && builder.gateway?.gatewayProfile === input.gatewayProfile) {
      return "unchanged";
    }
    await tx.builders.records.setGatewayMirror(
      input.uid,
      { gatewayId: input.gatewayId, gatewayProfile: input.gatewayProfile, controlUiEnabled: false },
      { gatewayId: currentGatewayId },
    );
    if (assigned) return "repaired";
    await tx.gateways.assignments.create({
      uid: input.uid,
      slug: builder.slug,
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
