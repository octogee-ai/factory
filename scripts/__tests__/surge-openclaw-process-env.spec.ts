import { describe, expect, it } from "vitest";

import { openClawProcessEnv } from "../entrypoints/surge-openclaw-supervisor.js";

describe("surge OpenClaw supervisor process environment", () => {
  it("keeps the pod token for the shared operator identity", () => {
    const env = openClawProcessEnv({
      OPENCLAW_GATEWAY_TOKEN: "pod-token",
      OCTOGEE_POD_RELAY_TOKEN: "pod-token",
      OPENCLAW_CONTROL_IDENTITY: "shared-operator",
    });

    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("pod-token");
    expect(env.OCTOGEE_POD_RELAY_TOKEN).toBe("pod-token");
  });

  it("withholds the pod token from a per-user OpenClaw process while keeping the relay credential", () => {
    const source = {
      OPENCLAW_GATEWAY_TOKEN: "pod-token",
      OCTOGEE_POD_RELAY_TOKEN: "pod-token",
      OPENCLAW_CONTROL_IDENTITY: "per-user",
      GATEWAY_ID: "bender",
    };

    const env = openClawProcessEnv(source);

    expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
    expect(env.OCTOGEE_POD_RELAY_TOKEN).toBe("pod-token");
    expect(env.GATEWAY_ID).toBe("bender");
    expect(source.OPENCLAW_GATEWAY_TOKEN).toBe("pod-token");
  });
});
