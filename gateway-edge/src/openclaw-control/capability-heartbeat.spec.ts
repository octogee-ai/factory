import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
  startOpenClawDashboardCapabilityHeartbeat,
} from "./capability-heartbeat.js";

describe("OpenClaw Dashboard capability heartbeat", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function createCapabilityFixture() {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-capability-"));
    cleanups.push(() => fs.rmSync(openclawDir, { recursive: true, force: true }));
    const capabilityPath = path.join(openclawDir, "dashboard_bridge.capability.json");
    const env = {
      OPENCLAW_DASHBOARD_BRIDGE_ENABLED: "true",
      OPENCLAW_DIR: openclawDir,
      GATEWAY_REVISION_ID: "walter-r7",
    };
    return { openclawDir, capabilityPath, env };
  }

  function startCapability(env: NodeJS.ProcessEnv, now: () => number = () => 1_000) {
    const heartbeat = startOpenClawDashboardCapabilityHeartbeat({
      env,
      instanceId: "edge-instance-1",
      now,
      intervalMs: 60_000,
      logError: vi.fn(),
    });
    if (!heartbeat) throw new Error("Expected the capability heartbeat to start");
    cleanups.push(heartbeat.stop);
    return heartbeat;
  }

  function writeRuntimeIdentity(openclawDir: string) {
    fs.writeFileSync(path.join(openclawDir, "system_config.status.json"), JSON.stringify({
      state: "clean",
      openclawVersion: "main",
      openclawForkSha: "current",
    }));
  }

  it("publishes a private revision and runtime-bound proof", () => {
    const { openclawDir, capabilityPath, env } = createCapabilityFixture();
    writeRuntimeIdentity(openclawDir);
    startCapability(env);
    const initial = fs.openSync(capabilityPath, "r");
    try {
      expect(fs.fstatSync(initial).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(initial, "utf8"))).toEqual({
        protocol: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
        version: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
        revisionId: "walter-r7",
        openclawVersion: "main",
        openclawForkSha: "current",
        instanceId: "edge-instance-1",
        observedAt: "1970-01-01T00:00:01.000Z",
      });
    } finally {
      fs.closeSync(initial);
    }
  });

  it("refreshes the proof and removes it on stop", () => {
    const { openclawDir, capabilityPath, env } = createCapabilityFixture();
    writeRuntimeIdentity(openclawDir);
    let now = 1_000;
    const heartbeat = startCapability(env, () => now);
    now = 2_000;
    heartbeat.publish();
    expect(JSON.parse(fs.readFileSync(capabilityPath, "utf8"))).toMatchObject({
      observedAt: "1970-01-01T00:00:02.000Z",
    });
    heartbeat.stop();
    expect(fs.existsSync(capabilityPath)).toBe(false);
  });

  it("leaves a successor's proof intact on stop", () => {
    const { openclawDir, capabilityPath, env } = createCapabilityFixture();
    writeRuntimeIdentity(openclawDir);
    const heartbeat = startCapability(env);
    const successor = path.join(openclawDir, "successor.json");
    fs.writeFileSync(successor, JSON.stringify({ instanceId: "newer-edge" }), { flag: "wx" });
    fs.renameSync(successor, capabilityPath);
    heartbeat.stop();
    expect(fs.existsSync(capabilityPath)).toBe(true);
  });

  it("fails closed without crash-looping while runtime identity is unavailable", () => {
    const { openclawDir, capabilityPath, env } = createCapabilityFixture();
    fs.writeFileSync(capabilityPath, JSON.stringify({ instanceId: "dead-edge" }));
    const logError = vi.fn();
    const heartbeat = startOpenClawDashboardCapabilityHeartbeat({
      env,
      intervalMs: 60_000,
      logError,
    });
    if (heartbeat) cleanups.push(heartbeat.stop);
    expect(fs.existsSync(capabilityPath)).toBe(false);
    expect(logError).toHaveBeenCalledTimes(1);

    fs.writeFileSync(path.join(openclawDir, "system_config.status.json"), JSON.stringify({
      state: "clean",
      openclawVersion: "0.0.0",
      openclawForkSha: "different",
    }));
    heartbeat?.publish();
    expect(JSON.parse(fs.readFileSync(capabilityPath, "utf8"))).toMatchObject({
      openclawVersion: "0.0.0",
      openclawForkSha: "different",
    });
    heartbeat?.stop();
  });

  it("stays disabled without the feature flag", () => {
    expect(startOpenClawDashboardCapabilityHeartbeat({ env: {}, logError: vi.fn() })).toBeNull();
  });
});
