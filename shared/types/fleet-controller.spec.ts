import { describe, expect, it } from "vitest";

import {
  CONFIG_CONTROL_ACTIONS,
  CONFIG_CONTROL_CONFLICT_ERROR,
  CONFIG_CONTROL_GIT_UNAVAILABLE_CODE,
  CONFIG_CONTROL_REF_CONFLICT_CODE,
  CONFIG_CONTROL_UNAVAILABLE_ERROR,
  CONFIG_CONTROL_WRITER_LOCK_BUSY_CODE,
  DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL,
  DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION,
  hasDurableOpenClawConfigControlProtocol,
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE,
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
  SYSTEM_CONFIG_CONTROL_CAPABILITY_FILE,
  SYSTEM_CONFIG_CONTROL_CAPABILITY_TTL_MS,
  systemConfigMigrationMode,
} from "./fleet-controller.js";

describe("durable OpenClaw config control protocol", () => {
  it("exports one exact capability contract for rollout and Dashboard gates", () => {
    expect(DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL).toBe("durable-openclaw-config");
    expect(DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION).toBe(2);
    expect(CONFIG_CONTROL_ACTIONS).toEqual([
      "freeze-v2",
      "candidate-proof",
      "promote-candidate",
      "abort-v2",
      "finalize-v2",
    ]);
  });

  it("exports stable protocol-v2 conflict and retry codes", () => {
    expect(CONFIG_CONTROL_CONFLICT_ERROR).toBe("config control conflict");
    expect(CONFIG_CONTROL_UNAVAILABLE_ERROR).toBe("config control unavailable");
    expect(CONFIG_CONTROL_REF_CONFLICT_CODE).toBe("config-ref-conflict");
    expect(CONFIG_CONTROL_WRITER_LOCK_BUSY_CODE).toBe("config-writer-lock-busy");
    expect(CONFIG_CONTROL_GIT_UNAVAILABLE_CODE).toBe("config-git-unavailable");
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

describe("systemConfigMigrationMode", () => {
  it.each([
    ["shared", "shared", "none"],
    ["shared", "builder", "none"],
    ["shared", "operator", "none"],
    ["builder", "shared", "checkpoint-only"],
    ["operator", "shared", "checkpoint-only"],
    ["builder", "builder", "checkpoint-and-restore"],
    ["builder", "operator", "checkpoint-and-restore"],
    ["operator", "builder", "checkpoint-and-restore"],
    ["operator", "operator", "checkpoint-and-restore"],
  ] as const)("maps %s → %s to %s", (source, target, expected) => {
    expect(systemConfigMigrationMode(source, target)).toBe(expected);
  });
});

describe("hasDurableOpenClawConfigControlProtocol", () => {
  it("requires the exact nested protocol marker", () => {
    expect(hasDurableOpenClawConfigControlProtocol({
      controlProtocol: {
        protocol: DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL,
        version: DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION,
      },
    })).toBe(true);
    expect(hasDurableOpenClawConfigControlProtocol(undefined)).toBe(false);
    expect(hasDurableOpenClawConfigControlProtocol({
      controlProtocol: {
        protocol: DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL,
        version: DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION + 1,
      },
    })).toBe(false);
    expect(hasDurableOpenClawConfigControlProtocol({
      protocol: DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL,
      version: DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION,
    })).toBe(false);
  });
});
