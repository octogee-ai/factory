import { afterEach, describe, expect, it, vi } from "vitest";

import { projectGatewayReservation } from "./admin-fleet-router.js";

// The Fleet card's reservation/cost derives from this projection. It must match
// the helm posture (#1932: all classes ride Spot by default) — a prod operator
// gateway with no per-gateway override is on Spot, not on-demand.
describe("projectGatewayReservation — Spot is the default for every class", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("a PROD operator gateway with no scheduling override projects spot", () => {
    vi.stubEnv("K8S_NAMESPACE", "octogee");
    const r = projectGatewayReservation({ profile: "operator", gatewayClass: "operator" });
    expect(r.type).toBe("spot");
    expect(r.computeClass).toBe("octogee-gateway-spot");
  });

  it("an explicit on-demand scheduling override still wins", () => {
    vi.stubEnv("K8S_NAMESPACE", "octogee");
    const r = projectGatewayReservation({ profile: "operator", scheduling: "on-demand" });
    expect(r.type).toBe("on-demand");
  });

  it("TEST gateways resolve the env-specific spot class", () => {
    vi.stubEnv("K8S_NAMESPACE", "octogee-test");
    const r = projectGatewayReservation({ profile: "operator", gatewayClass: "operator" });
    expect(r.type).toBe("spot");
    expect(r.computeClass).toBe("octogee-gateway-test-spot");
  });
});
