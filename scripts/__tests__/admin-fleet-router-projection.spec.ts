import { describe, it, expect } from "vitest";
import {
  projectGatewaySummary,
  resolveFleetNamespace,
} from "../lib/admin-fleet-router.js";

function gatewayDoc(id: string, data: Record<string, unknown> = {}) {
  return {
    id,
    data: () => ({ gatewayId: id, status: "ready", mountedCustomers: [], ...data }),
  };
}

describe("projectGatewaySummary — instanceName", () => {
  const now = 1_750_000_000_000;

  it("surfaces instanceName from the glm desired-state doc (drives the metrics pod selector)", () => {
    const summary = projectGatewaySummary(
      gatewayDoc("gw-bender"),
      [],
      { instanceName: "bender", profile: "operator" },
      now,
    );
    expect(summary.gatewayId).toBe("gw-bender");
    expect(summary.instanceName).toBe("bender");
  });

  it("is null when there is no matching glm doc (orphan status doc)", () => {
    const summary = projectGatewaySummary(gatewayDoc("gw-orphan"), [], undefined, now);
    expect(summary.instanceName).toBeNull();
  });

  it("is null when the glm doc omits instanceName", () => {
    const summary = projectGatewaySummary(gatewayDoc("gw-x"), [], { profile: "standard" }, now);
    expect(summary.instanceName).toBeNull();
  });
});

describe("resolveFleetNamespace", () => {
  it("returns K8S_NAMESPACE when set (the env the fleet lives in)", () => {
    expect(resolveFleetNamespace({ K8S_NAMESPACE: "octogee-test" })).toBe("octogee-test");
    expect(resolveFleetNamespace({ K8S_NAMESPACE: "octogee" })).toBe("octogee");
  });

  it("defaults to the prod namespace when unset or empty", () => {
    expect(resolveFleetNamespace({})).toBe("octogee");
    expect(resolveFleetNamespace({ K8S_NAMESPACE: "" })).toBe("octogee");
  });
});
