import { describe, expect, it } from "vitest";

import * as fleetController from "./fleet-controller.js";
import {
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE,
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
} from "./fleet-controller.js";

describe("fleet controller contract", () => {
  it("exports one exact observed Dashboard bridge capability contract", () => {
    expect(OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL).toBe("openclaw-dashboard-bridge");
    expect(OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE).toBe(
      "dashboard_bridge.capability.json",
    );
    expect(OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS).toBe(15_000);
  });

  it("retires the protocol-v2 config-control surface (GATEWAY-SIMPLE-ROLL-SPEC)", () => {
    const exported = Object.keys(fleetController);
    expect(exported.filter((name) => /CONFIG_CONTROL|systemConfigMigrationMode/u.test(name)))
      .toEqual([]);
    expect(exported).not.toContain("hasDurableOpenClawConfigControlProtocol");
    expect(exported).not.toContain("SYSTEM_CONFIG_CONTROL_CAPABILITY_FILE");
  });
});
