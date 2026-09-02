import { describe, expect, it, vi } from "vitest";

import { createOpenClawBootWatcher } from "../lib/openclaw-boot-watcher.js";

describe("OpenClaw boot watcher", () => {
  it("records an ordinary first start without running Doctor", async () => {
    const run = vi.fn(async () => undefined);
    const client = {
      claimOpenClawBoot: vi.fn(async () => ({ action: "start" as const })),
      completeOpenClawBoot: vi.fn(async () => undefined),
    };
    const watcher = createOpenClawBootWatcher({
      client,
      releaseKey: "release@sha256:abc",
      log: () => undefined,
      run,
    });

    await watcher.beforeStart();

    expect(client.claimOpenClawBoot).toHaveBeenCalledWith({ releaseKey: "release@sha256:abc" });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the claimed Doctor repair exactly once with the requested command", async () => {
    const run = vi.fn(async () => undefined);
    const client = {
      claimOpenClawBoot: vi.fn(async () => ({ action: "doctor" as const })),
      completeOpenClawBoot: vi.fn(async () => undefined),
    };
    const watcher = createOpenClawBootWatcher({
      client,
      releaseKey: "release@sha256:abc",
      log: () => undefined,
      run,
    });

    await watcher.beforeStart();

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("openclaw", ["doctor", "--fix"]);
  });

  it("propagates a failed one-shot Doctor attempt", async () => {
    const failure = new Error("doctor failed");
    const watcher = createOpenClawBootWatcher({
      client: {
        claimOpenClawBoot: vi.fn(async () => ({ action: "doctor" as const })),
        completeOpenClawBoot: vi.fn(async () => undefined),
      },
      releaseKey: "release@sha256:abc",
      log: () => undefined,
      run: vi.fn(async () => { throw failure; }),
    });

    await expect(watcher.beforeStart()).rejects.toBe(failure);
  });

  it("clears the sentinel after health", async () => {
    const completeOpenClawBoot = vi.fn(async () => undefined);
    const watcher = createOpenClawBootWatcher({
      client: {
        claimOpenClawBoot: vi.fn(async () => ({ action: "start" as const })),
        completeOpenClawBoot,
      },
      releaseKey: "release@sha256:abc",
      log: () => undefined,
    });

    await watcher.healthy();

    expect(completeOpenClawBoot).toHaveBeenCalledWith({ releaseKey: "release@sha256:abc" });
  });
});
