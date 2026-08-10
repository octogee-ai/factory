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
    profile: "builder",
    gatewayClass: "builder",
    imageProfile: "builder",
    sizingTier: "l",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: { shellsEnabled: true },
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
      builderAccess: { shellsEnabled: true, controlUiEnabled: true },
    }))).toBe(true);
  });

  it("rejects the retired operator customer gateway class", () => {
    expect(isGatewayMutableConfig({
      ...validConfig(),
      gatewayClass: "operator",
    })).toBe(false);
  });

  it("rejects class and runtime profile mismatches", () => {
    expect(isGatewayMutableConfig(validConfig({
      gatewayClass: "builder",
      imageProfile: "standard",
    }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({
      profile: "standard",
      gatewayClass: "builder",
      imageProfile: "builder",
    }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({
      profile: "builder",
      gatewayClass: "shared",
      imageProfile: "standard",
      ownerUid: null,
      builderSlug: null,
    }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({
      profile: null,
      gatewayClass: "shared",
      imageProfile: "builder",
      ownerUid: null,
      builderSlug: null,
    }))).toBe(false);
  });

  it("accepts a durable root that carries no computeClass at all", () => {
    const config = validConfig();
    expect(Object.prototype.hasOwnProperty.call(config, "computeClass")).toBe(false);
    expect(isGatewayMutableConfigForGateway(config, "owner")).toBe(true);
  });

  it("treats a residual computeClass from the retired ComputeClass era as inert", () => {
    for (const residue of ["octogee-gateway-spot", "", 123, null]) {
      expect(
        isGatewayMutableConfigForGateway(
          { ...validConfig(), computeClass: residue },
          "owner",
        ),
      ).toBe(true);
    }
  });

  it("rejects a non-boolean Control UI capability", () => {
    expect(isGatewayMutableConfig({
      ...validConfig(),
      builderAccess: { shellsEnabled: true, controlUiEnabled: "yes" },
    })).toBe(false);
  });

  it("rejects network authority embedded in mutable Builder access", () => {
    expect(isGatewayMutableConfig({
      ...validConfig(),
      builderAccess: {
        shellsEnabled: true,
        platformMetadataEgress: true,
      },
    })).toBe(false);
  });

  it("rejects a credential-bearing or malformed root config", () => {
    expect(isGatewayMutableConfig({ ...validConfig(), byosub: {} })).toBe(false);
    expect(isGatewayMutableConfig(validConfig({ ownerUid: null }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({ builderSlug: null }))).toBe(false);
    expect(isGatewayMutableConfig({
      ...validConfig(),
      preemption: { warmTargetGatewayId: "owner-warm" },
    })).toBe(false);
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

  it("requires disposable allocations to carry the matching owner and lease generation", () => {
    expect(isGatewayMutableConfig(validConfig({
      allocation: {
        kind: "disposable-builder",
        schemaVersion: 1,
        leaseId: "lease-one",
        generation: 1,
        claimedByUid: "uid-owner",
      },
    }))).toBe(true);
    expect(isGatewayMutableConfig(validConfig({
      allocation: {
        kind: "disposable-builder",
        schemaVersion: 1,
        leaseId: "lease-one",
        generation: 1,
        claimedByUid: "uid-other",
      },
    }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({
      allocation: {
        kind: "disposable-builder",
        schemaVersion: 1,
        leaseId: "lease-one",
        generation: 0,
        claimedByUid: "uid-owner",
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
