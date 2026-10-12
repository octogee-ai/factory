import { describe, expect, it, vi } from "vitest";

import { createOpenClawBootWatcher } from "../lib/openclaw-boot-watcher.js";

describe("OpenClaw boot watcher", () => {
  it("records an ordinary first start without running Doctor", async () => {
    const run = vi.fn(async () => undefined);
    const client = {
      claimOpenClawBoot: vi.fn(async () => ({ action: "start" as const })),
      completeOpenClawDoctor: vi.fn(async () => undefined),
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
      completeOpenClawDoctor: vi.fn(async () => undefined),
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
        completeOpenClawDoctor: vi.fn(async () => undefined),
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
        completeOpenClawDoctor: vi.fn(async () => undefined),
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
        completeOpenClawDoctor: vi.fn(async () => undefined),
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
        completeOpenClawDoctor: vi.fn(async () => undefined),
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
        completeOpenClawDoctor: vi.fn(async () => undefined),
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
        completeOpenClawDoctor: vi.fn(async () => undefined),
      completeOpenClawBoot: vi.fn(async () => { throw failure; }),
      },
      releaseKey: "release@sha256:abc",
      log: () => undefined,
    });

    await expect(watcher.healthy()).rejects.toBe(failure);
  });
});


describe("operator-requested source Doctor", () => {
  const sourceDoctor = { requestId: "source-repair", agentIds: ["octogee-alice-coach"] };
  function fixture() {
    const order: string[] = [];
    const client = {
      claimOpenClawBoot: vi.fn().mockResolvedValue({ action: "doctor", sourceDoctor }),
      completeOpenClawBoot: vi.fn(),
      completeOpenClawDoctor: vi.fn(async () => { order.push("ack"); }),
    };
    const run = vi.fn(async () => { order.push("doctor"); });
    const verifySourceDoctor = vi.fn(async () => { order.push("preflight"); });
    return { client, run, verifySourceDoctor, order };
  }
  it("acknowledges the requested repair only after canonical Doctor and every native store preflight", async () => {
    const f = fixture();
    await createOpenClawBootWatcher({ ...f, releaseKey: "observed-image-build", log: () => {} }).beforeStart();
    expect(f.order).toEqual(["doctor", "preflight", "ack"]);
    expect(f.verifySourceDoctor).toHaveBeenCalledWith(sourceDoctor.agentIds);
    expect(f.client.completeOpenClawDoctor).toHaveBeenCalledWith({ releaseKey: "observed-image-build", requestId: sourceDoctor.requestId, verifiedAgentIds: sourceDoctor.agentIds });
  });
  it("keeps the source repair unacknowledged when native postflight still refuses a requested store", async () => {
    const f = fixture(); f.verifySourceDoctor.mockRejectedValue(new Error("agent store still incompatible"));
    await expect(createOpenClawBootWatcher({ ...f, releaseKey: "observed-image-build", log: () => {} }).beforeStart()).rejects.toThrow("agent store still incompatible");
    expect(f.client.completeOpenClawDoctor).not.toHaveBeenCalled();
  });
  it("waits for the controller's installed image proof before spending the requested Doctor", async () => {
    const f = fixture();
    f.client.claimOpenClawBoot.mockResolvedValueOnce({ action: "wait", sourceDoctor });
    const wait = vi.fn(async () => { f.order.push("wait"); });
    await createOpenClawBootWatcher({ ...f, wait, releaseKey: "observed-image-build", log: () => {} }).beforeStart();
    expect(f.order).toEqual(["wait", "doctor", "preflight", "ack"]);
  });
  it("does not acknowledge or preflight a failed canonical Doctor", async () => {
    const f = fixture(); f.run.mockRejectedValue(new Error("Doctor failed"));
    await expect(createOpenClawBootWatcher({ ...f, releaseKey: "observed-image-build", log: () => {} }).beforeStart()).rejects.toThrow("Doctor failed");
    expect(f.verifySourceDoctor).not.toHaveBeenCalled();
    expect(f.client.completeOpenClawDoctor).not.toHaveBeenCalled();
  });
  it("fails fenced after the bounded installed image proof wait instead of starting a writer", async () => {
    const f = fixture(); f.client.claimOpenClawBoot.mockResolvedValue({ action: "wait", sourceDoctor });
    let now = 0;
    await expect(createOpenClawBootWatcher({ ...f, now: () => now, wait: async (ms) => { now += ms; }, releaseKey: "observed-image-build", log: () => {} }).beforeStart()).rejects.toThrow("image proof wait timed out");
    expect(f.run).not.toHaveBeenCalled(); expect(f.client.completeOpenClawDoctor).not.toHaveBeenCalled();
  });

  it("does not fall back to ordinary startup if the broker route disappears after an explicit request", async () => {
    const f = fixture(); f.client.claimOpenClawBoot.mockResolvedValueOnce({ action: "wait", sourceDoctor }).mockRejectedValue(new Error("fleet-broker POST /internal/fleet/openclaw-boot/claim → 404"));
    await expect(createOpenClawBootWatcher({ ...f, wait: async () => {}, releaseKey: "observed-image-build", log: () => {} }).beforeStart()).rejects.toThrow("source Doctor claim failed");
    expect(f.run).not.toHaveBeenCalled(); expect(f.client.completeOpenClawDoctor).not.toHaveBeenCalled();
  });

});
