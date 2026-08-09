import type { GatewayMutableConfig } from "@octogee/core/gateway-live-release";
import { describe, expect, it, vi } from "vitest";

import { prepareGatewayRuntimeConfig } from "../gateway-runtime-config.js";

function builderConfig(overrides: Partial<GatewayMutableConfig> = {}): GatewayMutableConfig {
  return {
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "builder",
    imageProfile: "builder",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: "octogee-gw-bender",
    serviceAccount: { create: true },
    builderAccess: { shellsEnabled: true },
    ownerUid: "uid-builder",
    builderSlug: "builder",
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("prepareGatewayRuntimeConfig", () => {
  it("injects live API-server CIDRs into Builder shell configuration", async () => {
    const resolveApiServerEgressCidrs = vi.fn(async () => [
      "10.128.0.2/32",
      "34.118.224.1/32",
    ]);

    await expect(
      prepareGatewayRuntimeConfig(
        builderConfig(),
        "bender",
        resolveApiServerEgressCidrs,
      ),
    ).resolves.toMatchObject({
      builderAccess: {
        shellsEnabled: true,
        kubeApiServerEgressCidrs: ["10.128.0.2/32", "34.118.224.1/32"],
      },
    });
    expect(resolveApiServerEgressCidrs).toHaveBeenCalledOnce();
  });

  it("preserves the last known CIDRs when live resolution returns empty", async () => {
    const config = builderConfig({
      builderAccess: {
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
      prepareGatewayRuntimeConfig(builderConfig(), "bender", async () => []),
    ).rejects.toThrow("builder gateway bender has no API-server egress CIDRs");
  });

  it("does not resolve API-server CIDRs for gateways without Builder shells", async () => {
    const resolveApiServerEgressCidrs = vi.fn(async () => ["10.128.0.2/32"]);
    const config = builderConfig({ builderAccess: { shellsEnabled: false } });

    await expect(
      prepareGatewayRuntimeConfig(config, "bender", resolveApiServerEgressCidrs),
    ).resolves.toBe(config);
    expect(resolveApiServerEgressCidrs).not.toHaveBeenCalled();
  });
});
