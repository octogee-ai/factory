import type { GatewayMutableConfig } from "@octogee/core/gateway-live-release";
import { describe, expect, it, vi } from "vitest";

import { prepareGatewayRuntimeConfig } from "../gateway-runtime-config.js";

function operatorConfig(overrides: Partial<GatewayMutableConfig> = {}): GatewayMutableConfig {
  return {
    configSchemaVersion: 1,
    profile: "operator",
    gatewayClass: "operator",
    imageProfile: "operator",
    sizingTier: null,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: "octogee-gw-bender",
    serviceAccount: { create: true },
    operatorAccess: { shellsEnabled: true },
    ownerUid: "uid-operator",
    coOwnerUids: [],
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("prepareGatewayRuntimeConfig", () => {
  it("injects live API-server CIDRs into operator shell configuration", async () => {
    const resolveApiServerEgressCidrs = vi.fn(async () => [
      "10.128.0.2/32",
      "34.118.224.1/32",
    ]);

    await expect(
      prepareGatewayRuntimeConfig(
        operatorConfig(),
        "bender",
        resolveApiServerEgressCidrs,
      ),
    ).resolves.toMatchObject({
      operatorAccess: {
        shellsEnabled: true,
        kubeApiServerEgressCidrs: ["10.128.0.2/32", "34.118.224.1/32"],
      },
    });
    expect(resolveApiServerEgressCidrs).toHaveBeenCalledOnce();
  });

  it("preserves the last known CIDRs when live resolution returns empty", async () => {
    const config = operatorConfig({
      operatorAccess: {
        shellsEnabled: true,
        kubeApiServerEgressCidrs: ["10.128.0.2/32"],
      },
    });

    await expect(
      prepareGatewayRuntimeConfig(config, "bender", async () => []),
    ).resolves.toBe(config);
  });

  it("fails preparation when neither live nor last-known CIDRs are available", async () => {
    await expect(
      prepareGatewayRuntimeConfig(operatorConfig(), "bender", async () => []),
    ).rejects.toThrow("operator gateway bender has no API-server egress CIDRs");
  });

  it("does not resolve API-server CIDRs for gateways without operator shells", async () => {
    const resolveApiServerEgressCidrs = vi.fn(async () => ["10.128.0.2/32"]);
    const config = operatorConfig({ operatorAccess: { shellsEnabled: false } });

    await expect(
      prepareGatewayRuntimeConfig(config, "bender", resolveApiServerEgressCidrs),
    ).resolves.toBe(config);
    expect(resolveApiServerEgressCidrs).not.toHaveBeenCalled();
  });
});
