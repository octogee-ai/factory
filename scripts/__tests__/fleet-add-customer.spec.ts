import { describe, expect, it } from "vitest";
import { addCustomerAssignmentRefusal } from "../lib/fleet-add-customer.js";

describe("fleet add-customer assignment guard", () => {
  it("allows placing a Builder that has no assignment", () => {
    expect(addCustomerAssignmentRefusal({ targetGatewayId: "shared-b", currentGatewayId: null, assignmentGatewayIds: [] })).toBeNull();
  });

  it("allows repairing a Builder whose assignment is already on the target", () => {
    expect(addCustomerAssignmentRefusal({ targetGatewayId: "shared-b", currentGatewayId: "shared-a", assignmentGatewayIds: ["shared-b"] })).toBeNull();
  });

  it("refuses to move a Builder whose assignment lives on another gateway", () => {
    expect(addCustomerAssignmentRefusal({ targetGatewayId: "shared-b", currentGatewayId: "shared-b", assignmentGatewayIds: ["shared-a"] }))
      .toMatch(/assignment on shared-a.*migrate-customer/);
  });

  it("refuses to move a Builder served from another gateway without an assignment record", () => {
    expect(addCustomerAssignmentRefusal({ targetGatewayId: "shared-b", currentGatewayId: "shared-a", assignmentGatewayIds: [] }))
      .toMatch(/placed on shared-a.*migrate-customer/);
  });
});
