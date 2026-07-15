import { describe, expect, it } from "vitest";

import {
  DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL,
  DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION,
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE,
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
} from "./fleet-controller.js";

describe("durable OpenClaw config control protocol", () => {
  it("exports one exact capability contract for rollout and Dashboard gates", () => {
    expect(DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL).toBe("durable-openclaw-config");
    expect(DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION).toBe(1);
  });

  it("exports one exact observed Dashboard bridge capability contract", () => {
    expect(OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL).toBe("openclaw-dashboard-bridge");
    expect(OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE).toBe(
      "dashboard_bridge.capability.json",
    );
    expect(OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS).toBe(15_000);
  });
});
