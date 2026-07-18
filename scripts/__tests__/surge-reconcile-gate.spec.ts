import { describe, expect, it, vi } from "vitest";
import {
  observeReadySibling,
  startAfterSurgeReadiness,
  startSurgeReadinessSelfRelease,
} from "../lib/surge-reconcile-gate.js";

describe("surge reconcile gate", () => {
  it("does not start customer reconcile until the pod handoff marker is released", async () => {
    let released = false;
    let retry: (() => void) | null = null;
    const stopInner = vi.fn();
    const start = vi.fn(() => stopInner);
    const stop = startAfterSurgeReadiness({
      released: async () => released,
      start,
      schedule: (callback) => {
        retry = callback;
        return vi.fn();
      },
      log: vi.fn(),
    });
    await vi.waitFor(() => expect(retry).not.toBeNull());
    expect(start).not.toHaveBeenCalled();

    released = true;
    retry?.();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

    stop();
    expect(stopInner).toHaveBeenCalledOnce();
  });

  it("identifies Ready siblings by pod UID and treats a missing endpoint as absence", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ podUid: "source-uid" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ podUid: "target-uid" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready" })))
      .mockRejectedValueOnce(new Error("connection refused"));

    await expect(observeReadySibling({
      healthUrl: "http://gateway/health",
      ownPodUid: "target-uid",
      fetchImpl,
    })).resolves.toEqual({ kind: "sibling", podUid: "source-uid" });
    await expect(observeReadySibling({
      healthUrl: "http://gateway/health",
      ownPodUid: "target-uid",
      fetchImpl,
    })).resolves.toEqual({ kind: "self" });
    await expect(observeReadySibling({
      healthUrl: "http://gateway/health",
      ownPodUid: "target-uid",
      fetchImpl,
    })).resolves.toEqual({ kind: "sibling", podUid: null });
    await expect(observeReadySibling({
      healthUrl: "http://gateway/health",
      ownPodUid: "target-uid",
      fetchImpl,
    })).resolves.toMatchObject({ kind: "none", reason: "connection refused" });
  });

  it("does not interpret an unhealthy or malformed Ready endpoint as sibling absence", async () => {
    await expect(observeReadySibling({
      healthUrl: "http://gateway/health",
      ownPodUid: "target-uid",
      fetchImpl: vi.fn(async () => new Response("unavailable", { status: 503 })),
    })).rejects.toThrow("503");

    await expect(observeReadySibling({
      healthUrl: "http://gateway/health",
      ownPodUid: "target-uid",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ podUid: 42 }))),
    })).rejects.toThrow("invalid podUid");
  });

  it("self-releases after three observations when no Ready sibling has ever existed", async () => {
    const scheduled: Array<() => void> = [];
    const release = vi.fn(async () => undefined);
    const stop = startSurgeReadinessSelfRelease({
      released: async () => false,
      observe: async () => ({ kind: "none", reason: "connection refused" }),
      release,
      schedule: (callback) => {
        scheduled.push(callback);
        return vi.fn();
      },
      now: () => 0,
      log: vi.fn(),
    });

    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    scheduled.shift()?.();
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    scheduled.shift()?.();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());

    stop();
  });

  it("restarts the fast absence count after an inconclusive probe", async () => {
    const scheduled: Array<() => void> = [];
    const observations = [
      { kind: "none", reason: "connection refused" } as const,
      { kind: "none", reason: "connection refused" } as const,
      new Error("invalid health body"),
      { kind: "none", reason: "connection refused" } as const,
      { kind: "none", reason: "connection refused" } as const,
      { kind: "none", reason: "connection refused" } as const,
    ];
    const release = vi.fn(async () => undefined);
    const stop = startSurgeReadinessSelfRelease({
      released: async () => false,
      observe: async () => {
        const observation = observations.shift();
        if (observation instanceof Error) throw observation;
        if (!observation) throw new Error("missing test observation");
        return observation;
      },
      release,
      schedule: (callback) => {
        scheduled.push(callback);
        return vi.fn();
      },
      now: () => 0,
      log: vi.fn(),
    });

    for (let index = 0; index < 4; index += 1) {
      await vi.waitFor(() => expect(scheduled).toHaveLength(1));
      scheduled.shift()?.();
    }
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    expect(release).not.toHaveBeenCalled();

    scheduled.shift()?.();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());

    stop();
  });

  it("waits 60 seconds after a previously seen Ready sibling disappears", async () => {
    let now = 0;
    let observation: "sibling" | "none" = "sibling";
    let scheduled: (() => void) | null = null;
    const release = vi.fn(async () => undefined);
    const runScheduled = () => {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    };
    const stop = startSurgeReadinessSelfRelease({
      released: async () => false,
      observe: async () => observation === "sibling"
        ? { kind: "sibling", podUid: "source-uid" }
        : { kind: "none", reason: "connection refused" },
      release,
      schedule: (callback) => {
        scheduled = callback;
        return vi.fn();
      },
      now: () => now,
      log: vi.fn(),
    });

    await vi.waitFor(() => expect(scheduled).not.toBeNull());
    observation = "none";
    runScheduled();
    await vi.waitFor(() => expect(scheduled).not.toBeNull());
    now = 59_999;
    runScheduled();
    await vi.waitFor(() => expect(scheduled).not.toBeNull());
    expect(release).not.toHaveBeenCalled();

    now = 60_000;
    runScheduled();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());

    stop();
  });

  it("resets the source-loss debounce when the Ready sibling reappears", async () => {
    let now = 0;
    const observations = ["sibling", "none", "sibling", "none", "none"] as const;
    let index = 0;
    let scheduled: (() => void) | null = null;
    const release = vi.fn(async () => undefined);
    const runScheduled = () => {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    };
    const stop = startSurgeReadinessSelfRelease({
      released: async () => false,
      observe: async () => observations[index++] === "sibling"
        ? { kind: "sibling", podUid: "source-uid" }
        : { kind: "none", reason: "connection refused" },
      release,
      schedule: (callback) => {
        scheduled = callback;
        return vi.fn();
      },
      now: () => now,
      log: vi.fn(),
    });

    for (const nextNow of [0, 30_000, 31_000, 90_999]) {
      await vi.waitFor(() => expect(scheduled).not.toBeNull());
      now = nextNow;
      runScheduled();
    }
    await vi.waitFor(() => expect(scheduled).not.toBeNull());
    expect(release).not.toHaveBeenCalled();

    now = 91_000;
    runScheduled();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());

    stop();
  });
});
