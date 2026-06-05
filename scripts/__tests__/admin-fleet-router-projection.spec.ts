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

describe("projectGatewaySummary — gatewayId", () => {
  const now = 1_750_000_000_000;

  it("surfaces the bare gatewayId from the status doc", () => {
    const summary = projectGatewaySummary(
      gatewayDoc("bender"),
      [],
      { profile: "operator" },
      now,
    );
    expect(summary.gatewayId).toBe("bender");
  });

  it("falls back to the doc id when the status doc omits gatewayId", () => {
    const summary = projectGatewaySummary(
      { id: "default", data: () => ({ status: "ready", mountedCustomers: [] }) },
      [],
      undefined,
      now,
    );
    expect(summary.gatewayId).toBe("default");
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
