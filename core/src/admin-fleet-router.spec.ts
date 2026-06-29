import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEDICATED_GATEWAY_IDLE_DEFAULT_MS,
  parseDedicatedGatewayIdlePatch,
  projectDedicatedGatewayIdleSettings,
  projectGatewayReservation,
} from "./admin-fleet-router.js";

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

describe("dedicated gateway idle settings", () => {
  it("uses the 30 minute default when no runtime override exists", () => {
    expect(projectDedicatedGatewayIdleSettings({}, undefined, 60_000)).toEqual({
      configuredMs: null,
      defaultMs: DEDICATED_GATEWAY_IDLE_DEFAULT_MS,
      effectiveMs: DEDICATED_GATEWAY_IDLE_DEFAULT_MS,
      sweepMs: 60_000,
      disabled: false,
    });
  });

  it("projects 0ms as the operator-controlled never setting", () => {
    expect(projectDedicatedGatewayIdleSettings({ dedicatedGatewayIdleMs: 0 }, 86_400_000, 60_000))
      .toMatchObject({
        configuredMs: 0,
        defaultMs: 86_400_000,
        effectiveMs: 0,
        disabled: true,
      });
  });

  it("accepts non-negative integer patches and rejects invalid values", () => {
    expect(parseDedicatedGatewayIdlePatch({ dedicatedGatewayIdleMs: 0 })).toEqual({ ok: 0 });
    expect(parseDedicatedGatewayIdlePatch({ dedicatedGatewayIdleMs: 1_800_000 })).toEqual({
      ok: 1_800_000,
    });
    expect(parseDedicatedGatewayIdlePatch({ dedicatedGatewayIdleMs: null })).toEqual({
      ok: null,
    });
    expect(parseDedicatedGatewayIdlePatch({ dedicatedGatewayIdleMs: -1 })).toMatchObject({
      error: { status: 400 },
    });
    expect(parseDedicatedGatewayIdlePatch({ dedicatedGatewayIdleMs: 1.5 })).toMatchObject({
      error: { status: 400 },
    });
  });
});
