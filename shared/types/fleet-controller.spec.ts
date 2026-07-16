import { describe, expect, it } from "vitest";

import {
  CONFIG_FREEZE_CHECKPOINT_PUSH_PENDING_CODE,
  CONFIG_FREEZE_CONFLICT_ERROR,
  CONFIG_FREEZE_OWNER_CONFLICT_CODE,
  CONFIG_FREEZE_SCOPE_CONFLICT_CODE,
  CONFIG_FREEZE_UNAVAILABLE_ERROR,
  CONFIG_FREEZE_WRITER_LOCK_BUSY_CODE,
  DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL,
  DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION,
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE,
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
  SYSTEM_CONFIG_CONTROL_CAPABILITY_FILE,
  SYSTEM_CONFIG_CONTROL_CAPABILITY_TTL_MS,
} from "./fleet-controller.js";

describe("durable OpenClaw config control protocol", () => {
  it("exports one exact capability contract for rollout and Dashboard gates", () => {
    expect(DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL).toBe("durable-openclaw-config");
    expect(DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION).toBe(1);
  });

  it("exports stable freeze conflict and retry codes for signed control responses", () => {
    expect(CONFIG_FREEZE_CONFLICT_ERROR).toBe("config freeze conflict");
    expect(CONFIG_FREEZE_UNAVAILABLE_ERROR).toBe("config freeze unavailable");
    expect(CONFIG_FREEZE_OWNER_CONFLICT_CODE).toBe("freeze-owner-conflict");
    expect(CONFIG_FREEZE_SCOPE_CONFLICT_CODE).toBe("freeze-scope-conflict");
    expect(CONFIG_FREEZE_WRITER_LOCK_BUSY_CODE).toBe("writer-lock-busy");
    expect(CONFIG_FREEZE_CHECKPOINT_PUSH_PENDING_CODE).toBe("checkpoint-push-pending");
  });

  it("exports one exact observed Dashboard bridge capability contract", () => {
    expect(OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL).toBe("openclaw-dashboard-bridge");
    expect(OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE).toBe(
      "dashboard_bridge.capability.json",
    );
    expect(OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS).toBe(15_000);
    expect(SYSTEM_CONFIG_CONTROL_CAPABILITY_FILE).toBe("system_config.control-capability.json");
    expect(SYSTEM_CONFIG_CONTROL_CAPABILITY_TTL_MS).toBe(15_000);
  });
});
