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
    expect(run).toHaveBeenCalledWith("openclaw", ["doctor", "--fix", "--non-interactive"]);
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

  it("starts normally when the platform release does not have the sentinel route", async () => {
    const log = vi.fn();
    const run = vi.fn(async () => undefined);
    const watcher = createOpenClawBootWatcher({
      client: {
        claimOpenClawBoot: vi.fn(async () => {
          throw new Error("fleet-broker POST /internal/fleet/openclaw-boot/claim → 404");
        }),
        completeOpenClawBoot: vi.fn(async () => undefined),
      },
      releaseKey: "release@sha256:abc",
      log,
      run,
    });

    await watcher.beforeStart();

    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("starting normally"));
  });

  it("does not hide a rejected sentinel claim", async () => {
    const failure = new Error("fleet-broker POST /internal/fleet/openclaw-boot/claim → 403");
    const watcher = createOpenClawBootWatcher({
      client: {
        claimOpenClawBoot: vi.fn(async () => { throw failure; }),
        completeOpenClawBoot: vi.fn(async () => undefined),
      },
      releaseKey: "release@sha256:abc",
      log: () => undefined,
    });

    await expect(watcher.beforeStart()).rejects.toBe(failure);
  });

  it("finishes normally when the platform release does not have the completion route", async () => {
    const log = vi.fn();
    const watcher = createOpenClawBootWatcher({
      client: {
        claimOpenClawBoot: vi.fn(async () => ({ action: "start" as const })),
        completeOpenClawBoot: vi.fn(async () => {
          throw new Error("fleet-broker POST /internal/fleet/openclaw-boot/healthy → 404");
        }),
      },
      releaseKey: "release@sha256:abc",
      log,
    });

    await watcher.healthy();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("completion unavailable"));
  });

  it("does not hide a rejected sentinel completion", async () => {
    const failure = new Error("fleet-broker POST /internal/fleet/openclaw-boot/healthy → 403");
    const watcher = createOpenClawBootWatcher({
      client: {
        claimOpenClawBoot: vi.fn(async () => ({ action: "start" as const })),
        completeOpenClawBoot: vi.fn(async () => { throw failure; }),
      },
      releaseKey: "release@sha256:abc",
      log: () => undefined,
    });

    await expect(watcher.healthy()).rejects.toBe(failure);
  });
});
