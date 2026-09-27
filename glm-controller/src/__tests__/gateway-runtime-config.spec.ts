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
    builderAccess: { controlUiEnabled: true },
    ownerUid: "uid-builder",
    builderSlug: "builder",
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("prepareGatewayRuntimeConfig", () => {
  it("injects live API-server CIDRs into enabled Builder control configuration", async () => {
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
        controlUiEnabled: true,
        kubeApiServerEgressCidrs: ["10.128.0.2/32", "34.118.224.1/32"],
      },
    });
    expect(resolveApiServerEgressCidrs).toHaveBeenCalledOnce();
  });

  it("preserves the last known CIDRs when live resolution returns empty", async () => {
    const config = builderConfig({
      builderAccess: {
        controlUiEnabled: true,
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

  it("injects API-server CIDRs when Builder Control UI is disabled", async () => {
    const resolveApiServerEgressCidrs = vi.fn(async () => ["10.128.0.2/32"]);
    const config = builderConfig({ builderAccess: { controlUiEnabled: false } });

    await expect(
      prepareGatewayRuntimeConfig(config, "bender", resolveApiServerEgressCidrs),
    ).resolves.toMatchObject({
      builderAccess: {
        controlUiEnabled: false,
        kubeApiServerEgressCidrs: ["10.128.0.2/32"],
      },
    });
    expect(resolveApiServerEgressCidrs).toHaveBeenCalledOnce();
  });
});
