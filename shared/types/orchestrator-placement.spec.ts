import { describe, expect, it } from "vitest";
import {
  resolveOnboardingPlacementForUid,
  rewritePlacementGatewayPointers,
  type OnboardingOrchestratorConfig,
} from "./orchestrator-placement";

const config: OnboardingOrchestratorConfig = {
  defaultGatewayId: "default",
  overrides: { "uid-pinned": "canary" },
};

describe("onboarding gateway placement (post-cohorts)", () => {
  it("lands new users on the default gateway", () => {
    expect(resolveOnboardingPlacementForUid("u1", config)).toEqual({
      kind: "default",
      gatewayId: "default",
    });
  });

  it("honors a per-uid gateway override", () => {
    expect(resolveOnboardingPlacementForUid("uid-pinned", config)).toEqual({
      kind: "gateway-override",
      gatewayId: "canary",
    });
  });
});

describe("rewritePlacementGatewayPointers (blue/green pointer moves)", () => {
  it("rewrites the default and every override pointing at the source gateway", () => {
    const result = rewritePlacementGatewayPointers(
      { defaultGatewayId: "blue", overrides: { a: "blue", b: "canary" } },
      "blue",
      "green",
    );
    expect(result.config).toEqual({
      defaultGatewayId: "green",
      overrides: { a: "green", b: "canary" },
    });
    expect(result.changedPointers).toEqual(["defaultGatewayId", "overrides.a"]);
  });

  it("is a no-op (with proof) when nothing points at the source", () => {
    const result = rewritePlacementGatewayPointers(config, "elsewhere", "green");
    expect(result.changedPointers).toEqual([]);
    expect(result.config).toEqual(config);
  });

  it("does not manufacture an undefined overrides field", () => {
    const result = rewritePlacementGatewayPointers(
      { defaultGatewayId: "default-blue" },
      "default-blue",
      "default",
    );
    expect(result.config).toEqual({ defaultGatewayId: "default" });
    expect(Object.hasOwn(result.config, "overrides")).toBe(false);
  });
});
