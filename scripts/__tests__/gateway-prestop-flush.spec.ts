import { describe, expect, it, vi } from "vitest";

import { runGatewayPreStopFlush } from "../lib/gateway-prestop-flush.js";

describe("runGatewayPreStopFlush", () => {
  it("runs workspace, blob, and system_config flushes in order", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    let now = 100;

    const result = await runGatewayPreStopFlush({
      gatewayId: "builder-a",
      gatewayClass: "builder",
      syncWorkspaces: vi.fn(async () => { calls.push("workspaces"); }),
      syncBlobs: vi.fn(async () => { calls.push("blobs"); }),
      syncSystemConfig: vi.fn(async () => { calls.push("system_config"); }),
      log: (msg) => logs.push(msg),
      now: () => {
        now += 10;
        return now;
      },
    });

    expect(calls).toEqual(["workspaces", "blobs", "system_config"]);
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.status)).toEqual(["done", "done", "done"]);
    expect(logs.join("\n")).toMatch(/starting gateway=builder-a class=builder/);
    expect(logs.join("\n")).toMatch(/complete ok=true/);
  });

  it("logs a failed step and still attempts later flushes", async () => {
    const calls: string[] = [];
    const logs: string[] = [];

    const result = await runGatewayPreStopFlush({
      gatewayId: "default",
      gatewayClass: "shared",
      syncWorkspaces: vi.fn(async () => {
        calls.push("workspaces");
        throw new Error("git unavailable");
      }),
      syncBlobs: vi.fn(async () => { calls.push("blobs"); }),
      log: (msg) => logs.push(msg),
      now: () => 1000,
    });

    expect(calls).toEqual(["workspaces", "blobs"]);
    expect(result.ok).toBe(false);
    expect(result.steps).toMatchObject([
      { name: "workspace-git", status: "failed", error: "git unavailable" },
      { name: "blob-sync", status: "done" },
      { name: "system-config", status: "skipped" },
    ]);
    expect(logs.join("\n")).toMatch(/workspace-git failed/);
    expect(logs.join("\n")).toMatch(/complete ok=false/);
  });
});
