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
    let now = 1_000;
    const heartbeat = startOpenClawDashboardCapabilityHeartbeat({
      env: {
        OPENCLAW_DASHBOARD_BRIDGE_ENABLED: "true",
        OPENCLAW_DIR: openclawDir,
        GATEWAY_REVISION_ID: "bender-r7",
        OPENCLAW_VERSION: "2026.7.1",
        OPENCLAW_FORK_SHA: "5e38a689",
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
      openclawForkSha: "5e38a689",
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

  it("fails closed on runtime pin drift and stays disabled without the feature flag", () => {
    expect(() => startOpenClawDashboardCapabilityHeartbeat({
      env: {
        OPENCLAW_DASHBOARD_BRIDGE_ENABLED: "true",
        OPENCLAW_DIR: "/tmp/openclaw",
        GATEWAY_REVISION_ID: "bender-r7",
        OPENCLAW_VERSION: "2026.7.2",
        OPENCLAW_FORK_SHA: "5e38a689",
      },
      logError: vi.fn(),
    })).toThrow(/runtime identity/i);
    expect(startOpenClawDashboardCapabilityHeartbeat({ env: {}, logError: vi.fn() })).toBeNull();
  });
});
