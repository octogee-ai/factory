import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
  startOpenClawDashboardCapabilityHeartbeat,
} from "./capability-heartbeat.js";

describe("OpenClaw Dashboard capability heartbeat", () => {
  it("atomically publishes a revision and runtime-bound proof and removes only its own proof", () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-capability-"));
    fs.writeFileSync(path.join(openclawDir, "system_config.status.json"), JSON.stringify({
      state: "clean",
      openclawVersion: "2026.7.1",
      openclawForkSha: "8969b0a3",
    }));
    let now = 1_000;
    const heartbeat = startOpenClawDashboardCapabilityHeartbeat({
      env: {
        OPENCLAW_DASHBOARD_BRIDGE_ENABLED: "true",
        OPENCLAW_DIR: openclawDir,
        GATEWAY_REVISION_ID: "bender-r7",
      },
      instanceId: "edge-instance-1",
      now: () => now,
      intervalMs: 60_000,
      logError: vi.fn(),
    });
    const capabilityPath = path.join(openclawDir, "dashboard_bridge.capability.json");
    expect(JSON.parse(fs.readFileSync(capabilityPath, "utf8"))).toEqual({
      protocol: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
      version: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
      revisionId: "bender-r7",
      openclawVersion: "2026.7.1",
      openclawForkSha: "8969b0a3",
      instanceId: "edge-instance-1",
      observedAt: "1970-01-01T00:00:01.000Z",
    });
    expect(fs.statSync(capabilityPath).mode & 0o777).toBe(0o600);
    now = 2_000;
    heartbeat?.publish();
    expect(JSON.parse(fs.readFileSync(capabilityPath, "utf8"))).toMatchObject({
      observedAt: "1970-01-01T00:00:02.000Z",
    });
    fs.writeFileSync(capabilityPath, JSON.stringify({ instanceId: "newer-edge" }));
    heartbeat?.stop();
    expect(fs.existsSync(capabilityPath)).toBe(true);
  });

  it("fails closed without crash-looping while runtime identity is unavailable or drifting", () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-capability-"));
    const capabilityPath = path.join(openclawDir, "dashboard_bridge.capability.json");
    fs.writeFileSync(capabilityPath, JSON.stringify({ instanceId: "dead-edge" }));
    const logError = vi.fn();
    const heartbeat = startOpenClawDashboardCapabilityHeartbeat({
      env: {
        OPENCLAW_DASHBOARD_BRIDGE_ENABLED: "true",
        OPENCLAW_DIR: openclawDir,
        GATEWAY_REVISION_ID: "bender-r7",
      },
      intervalMs: 60_000,
      logError,
    });
    expect(fs.existsSync(capabilityPath)).toBe(false);
    expect(logError).toHaveBeenCalledTimes(1);

    fs.writeFileSync(path.join(openclawDir, "system_config.status.json"), JSON.stringify({
      state: "clean",
      openclawVersion: "2026.7.2",
      openclawForkSha: "8969b0a3",
    }));
    expect(() => heartbeat?.publish()).toThrow(/runtime identity/i);
    expect(fs.existsSync(capabilityPath)).toBe(false);

    fs.writeFileSync(path.join(openclawDir, "system_config.status.json"), JSON.stringify({
      state: "clean",
      openclawVersion: "2026.7.1",
      openclawForkSha: "8969b0a3",
    }));
    heartbeat?.publish();
    expect(JSON.parse(fs.readFileSync(capabilityPath, "utf8"))).toMatchObject({
      openclawVersion: "2026.7.1",
      openclawForkSha: "8969b0a3",
    });
    heartbeat?.stop();
  });

  it("stays disabled without the feature flag", () => {
    expect(startOpenClawDashboardCapabilityHeartbeat({ env: {}, logError: vi.fn() })).toBeNull();
  });
});
