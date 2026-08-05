import { describe, expect, it, vi } from "vitest";

import { runGatewayPreStopFlush } from "../lib/gateway-prestop-flush.js";

describe("runGatewayPreStopFlush", () => {
  it("lets the predecessor complete its final pushes before releasing its stale key", async () => {
    const calls: string[] = [];
    const result = await runGatewayPreStopFlush({
      gatewayId: "eggman-devdays",
      gatewayClass: "builder",
      quiesceSessions: vi.fn(async () => { calls.push("quiesce"); }),
      syncWorkspaces: vi.fn(async () => { calls.push("workspaces"); }),
      syncBlobs: vi.fn(async () => { calls.push("blobs"); }),
      syncSystemConfig: vi.fn(async () => { calls.push("system_config-push"); }),
      releaseGiteaKey: vi.fn(async () => { calls.push("release-key"); }),
      log: () => {},
    });

    expect(calls).toEqual(["quiesce", "workspaces", "blobs", "system_config-push", "release-key"]);
    expect(result.ok).toBe(true);
    expect(result.steps.at(-1)).toMatchObject({ name: "gitea-key-release", status: "done" });
  });

  it("fences stale-key cleanup when the predecessor final push fails", async () => {
    const releaseGiteaKey = vi.fn(async () => {});
    const result = await runGatewayPreStopFlush({
      gatewayId: "eggman-devdays",
      gatewayClass: "builder",
      syncWorkspaces: vi.fn(async () => {}),
      syncSystemConfig: vi.fn(async () => { throw new Error("push failed"); }),
      releaseGiteaKey,
      log: () => {},
    });

    expect(releaseGiteaKey).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ name: "gitea-key-release", status: "skipped" });
  });

  it("runs workspace, blob, and system_config flushes in order", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    let now = 100;

    const result = await runGatewayPreStopFlush({
      gatewayId: "builder-a",
      gatewayClass: "builder",
      syncWorkspaces: vi.fn(async () => { calls.push("workspaces"); }),
      syncBlobs: vi.fn(async () => { calls.push("blobs"); }),
      syncSystemConfig: vi.fn(async () => {
        calls.push("system_config");
        return { acceptedCommit: "a".repeat(40) };
      }),
      log: (msg) => logs.push(msg),
      now: () => {
        now += 10;
        return now;
      },
    });

    expect(calls).toEqual(["workspaces", "blobs", "system_config"]);
    expect(result.ok).toBe(true);
    expect(result.systemConfigCommit).toBe("a".repeat(40));
    expect(result.steps.map((step) => step.status)).toEqual([
      "skipped",
      "done",
      "done",
      "done",
      "skipped",
    ]);
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
      { name: "session-quiesce", status: "skipped" },
      { name: "workspace-git", status: "failed", error: "git unavailable" },
      { name: "blob-sync", status: "done" },
      { name: "system-config", status: "skipped" },
      { name: "gitea-key-release", status: "skipped" },
    ]);
    expect(logs.join("\n")).toMatch(/workspace-git failed/);
    expect(logs.join("\n")).toMatch(/complete ok=false/);
  });

  it("continues strict durable saves when best-effort session quiescence fails", async () => {
    const calls: string[] = [];
    const releaseGiteaKey = vi.fn(async () => {});
    const result = await runGatewayPreStopFlush({
      gatewayId: "builder-a",
      gatewayClass: "builder",
      quiesceSessions: vi.fn(async () => {
        calls.push("quiesce");
        throw new Error("2 sessions still running");
      }),
      syncWorkspaces: vi.fn(async () => { calls.push("workspaces"); }),
      syncBlobs: vi.fn(async () => { calls.push("blobs"); }),
      syncSystemConfig: vi.fn(async () => { calls.push("system-config"); }),
      releaseGiteaKey,
      log: () => {},
    });

    expect(calls).toEqual(["quiesce", "workspaces", "blobs", "system-config"]);
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      name: "session-quiesce",
      status: "failed",
      error: "2 sessions still running",
    });
    expect(releaseGiteaKey).not.toHaveBeenCalled();
    expect(result.steps.at(-1)).toMatchObject({ name: "gitea-key-release", status: "skipped" });
  });
});
