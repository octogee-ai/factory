import { describe, expect, it } from "vitest";

import {
  isGatewayMutableConfigForGateway,
  isGatewayMutableConfig,
  projectGatewayMutableConfigForGateway,
  type GatewayMutableConfig,
} from "./gateway-mutable-config.js";

function validConfig(
  overrides: Partial<GatewayMutableConfig> = {},
): GatewayMutableConfig {
  return {
    configSchemaVersion: 1,
    profile: "operator",
    gatewayClass: "operator",
    imageProfile: "operator",
    sizingTier: "l",
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: { shellsEnabled: true },
    ownerUid: "uid-owner",
    builderSlug: "owner",
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    allocation: null,
    ...overrides,
  };
}

describe("gateway mutable config", () => {
  it("accepts the complete durable root authority shape", () => {
    expect(isGatewayMutableConfig(validConfig({
      operatorAccess: { shellsEnabled: true, controlUiEnabled: true },
    }))).toBe(true);
  });

  it("rejects a non-boolean Control UI capability", () => {
    expect(isGatewayMutableConfig({
      ...validConfig(),
      operatorAccess: { shellsEnabled: true, controlUiEnabled: "yes" },
    })).toBe(false);
  });

  it("rejects a credential-bearing or malformed root config", () => {
    expect(isGatewayMutableConfig({ ...validConfig(), byosub: {} })).toBe(false);
    expect(isGatewayMutableConfig(validConfig({ ownerUid: null }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({ builderSlug: null }))).toBe(false);
    expect(
      isGatewayMutableConfig(
        validConfig({ preemption: { warmTargetGatewayId: "" } }),
      ),
    ).toBe(false);
  });

  it("projects only an empty retired co-owner mirror out of a desired-root read", () => {
    const transitional = { ...validConfig(), coOwnerUids: [] };

    expect(isGatewayMutableConfigForGateway(transitional, "owner")).toBe(false);
    expect(projectGatewayMutableConfigForGateway(transitional, "owner")).toEqual(validConfig());
    expect(
      projectGatewayMutableConfigForGateway(
        { ...validConfig(), coOwnerUids: ["uid-former-helper"] },
        "owner",
      ),
    ).toBeNull();
  });

  it("keeps shared gateways ownerless while requiring the complete dedicated owner pair", () => {
    expect(isGatewayMutableConfig(validConfig({
      profile: null,
      gatewayClass: "shared",
      imageProfile: "standard",
      ownerUid: null,
      builderSlug: null,
    }))).toBe(true);
    expect(isGatewayMutableConfig(validConfig({ ownerUid: "uid-owner", builderSlug: null }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({ ownerUid: null, builderSlug: "owner" }))).toBe(false);
  });

  it("requires owned trial allocations to carry a matching claim identity", () => {
    expect(isGatewayMutableConfig(validConfig({
      allocation: {
        kind: "trial",
        state: "claimed",
        configHash: "0123456789abcdef",
        claimedAt: { seconds: 1, nanoseconds: 0 },
        claimedByUid: "uid-owner",
      },
    }))).toBe(true);
    expect(isGatewayMutableConfig(validConfig({
      allocation: {
        kind: "trial",
        state: "claimed",
        configHash: "0123456789abcdef",
        claimedAt: 1,
        claimedByUid: "uid-other",
      },
    }))).toBe(false);
  });

  it("allows only the addressed gateway's generated service account", () => {
    expect(
      isGatewayMutableConfigForGateway(
        validConfig({ serviceAccountName: "octogee-gw-bender" }),
        "bender",
      ),
    ).toBe(true);
    expect(
      isGatewayMutableConfigForGateway(
        validConfig({ serviceAccountName: "octogee-gw-other" }),
        "bender",
      ),
    ).toBe(false);
  });

  it("rejects default and platform service accounts while preserving custom tenant KSAs", () => {
    for (const serviceAccountName of [
      "default",
      "octogee-api",
      "octogee-gateway",
      "octogee-cron",
      "glm-controller",
      "llm-broker",
    ]) {
      expect(
        isGatewayMutableConfigForGateway(validConfig({ serviceAccountName }), "bender"),
      ).toBe(false);
    }
    expect(
      isGatewayMutableConfigForGateway(
        validConfig({ serviceAccountName: "custom-tenant-ksa" }),
        "bender",
      ),
    ).toBe(true);
  });
});
