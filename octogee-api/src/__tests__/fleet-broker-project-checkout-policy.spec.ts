import { describe, expect, it } from "vitest";

import { projectCheckoutScopeForGatewayRoot } from "../routes/fleet-broker.js";

function gatewayRoot(
  gatewayClass: "shared" | "builder",
  allocation: Record<string, unknown> | null = null,
): Record<string, unknown> {
  const owned = gatewayClass !== "shared";
  return {
    gatewayId: "default",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: gatewayClass === "builder" ? "builder" : "standard",
    gatewayClass,
    imageProfile: gatewayClass === "builder" ? "builder" : "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: owned ? "uid-alice" : null,
    builderSlug: owned ? "alice" : null,
    modelBrokerLimits: null,
    preemption: null,
    allocation,
  };
}

describe("projectCheckoutScopeForGatewayRoot", () => {
  it("restores project checkouts on shared gateways", () => {
    expect(projectCheckoutScopeForGatewayRoot(
      gatewayRoot("shared"),
      "default",
      "uid-alice",
      "alice",
    )).toBe("workspace-and-projects");
  });

  it("keeps non-disposable builder gateways workspace-only", () => {
    expect(projectCheckoutScopeForGatewayRoot(
      gatewayRoot("builder"),
      "default",
      "uid-alice",
      "alice",
    )).toBe("workspace-only");
  });

  it("allows project checkouts only for an exact disposable Builder allocation", () => {
    expect(projectCheckoutScopeForGatewayRoot(
      gatewayRoot("builder"),
      "default",
      "uid-alice",
      "alice",
    )).toBe("workspace-only");
    expect(projectCheckoutScopeForGatewayRoot(
      gatewayRoot("builder", {
        kind: "disposable-builder",
        schemaVersion: 1,
        leaseId: "lease-alice",
        generation: 1,
        claimedByUid: "uid-alice",
      }),
      "default",
      "uid-alice",
      "alice",
    )).toBe("workspace-and-projects");
  });

  it("fails closed when the assigned user does not own the isolated gateway", () => {
    expect(projectCheckoutScopeForGatewayRoot(
      gatewayRoot("builder"),
      "default",
      "uid-bob",
      "bob",
    )).toBe("workspace-only");
  });
});
