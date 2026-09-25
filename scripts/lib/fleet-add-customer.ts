export function addCustomerAssignmentRefusal(input: {
  targetGatewayId: string;
  currentGatewayId: string | null;
  assignmentGatewayIds: readonly string[];
}): string | null {
  const elsewhere = input.assignmentGatewayIds.filter((gatewayId) => gatewayId !== input.targetGatewayId);
  if (elsewhere.length > 0) {
    return `Builder has a serving assignment on ${elsewhere.join(", ")}; add-customer only rewrites the user doc and would strand it. Move the Builder with migrate-customer.`;
  }
  if (input.currentGatewayId && input.currentGatewayId !== input.targetGatewayId && !input.assignmentGatewayIds.includes(input.targetGatewayId)) {
    return `Builder is placed on ${input.currentGatewayId}; add-customer only rewrites the user doc and would strand it. Move the Builder with migrate-customer.`;
  }
  return null;
}
