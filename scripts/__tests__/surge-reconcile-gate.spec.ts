import { describe, expect, it, vi } from "vitest";
import {
  observeReadySibling,
  selfReleaseRetryDelayMs,
  startAfterSurgeReadiness,
  startSurgeReadinessSelfRelease,
  SURGE_READINESS_HOLD_DEADLINE_MS,
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

  it("self-releases 60s after a previously seen Ready sibling disappears unless a reservation holds it", async () => {
    let now = 0;
    let observation: "sibling" | "none" = "sibling";
    let holdReason: string | null = "reserved by migration mig-1 as target";
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
      holdReason: async () => holdReason,
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
    await vi.waitFor(() => expect(scheduled).not.toBeNull());
    expect(release).not.toHaveBeenCalled();

    holdReason = null;
    now = 61_000;
    runScheduled();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());

    stop();
  });

  it("backs off after a failed self-release instead of retrying every second", async () => {
    const delays: number[] = [];
    let scheduled: (() => void) | null = null;
    let attempts = 0;
    const release = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("attach failed");
    });
    const runScheduled = () => {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    };
    const stop = startSurgeReadinessSelfRelease({
      released: async () => false,
      observe: async () => ({ kind: "none", reason: "connection refused" }),
      release,
      schedule: (callback, delayMs) => {
        delays.push(delayMs);
        scheduled = callback;
        return vi.fn();
      },
      now: () => 0,
      log: vi.fn(),
    });

    for (let check = 0; check < 4; check += 1) {
      await vi.waitFor(() => expect(scheduled).not.toBeNull());
      runScheduled();
    }
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(3));
    expect(delays).toEqual([
      selfReleaseRetryDelayMs(0),
      selfReleaseRetryDelayMs(0),
      selfReleaseRetryDelayMs(1),
      selfReleaseRetryDelayMs(2),
    ]);
    expect(selfReleaseRetryDelayMs(1)).toBeGreaterThan(selfReleaseRetryDelayMs(0));
    expect(selfReleaseRetryDelayMs(10)).toBe(30_000);

    stop();
  });

  it("does not self-release at the hold cap while a Ready sibling remains observable", async () => {
    let now = 0;
    let scheduled: (() => void) | null = null;
    const release = vi.fn(async () => undefined);
    const log = vi.fn();
    const runScheduled = () => {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    };
    const stop = startSurgeReadinessSelfRelease({
      released: async () => false,
      observe: async () => ({ kind: "sibling", podUid: "source-uid" }),
      release,
      schedule: (callback) => {
        scheduled = callback;
        return vi.fn();
      },
      now: () => now,
      log,
    });

    for (const nextNow of [60_000, SURGE_READINESS_HOLD_DEADLINE_MS - 1]) {
      await vi.waitFor(() => expect(scheduled).not.toBeNull());
      now = nextNow;
      runScheduled();
    }
    await vi.waitFor(() => expect(scheduled).not.toBeNull());
    expect(release).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Ready sibling observed"));

    now = SURGE_READINESS_HOLD_DEADLINE_MS;
    runScheduled();
    await vi.waitFor(() => expect(scheduled).not.toBeNull());
    expect(release).not.toHaveBeenCalled();

    stop();
  });

  it("releases at the hold cap when the sibling probe never stops failing", async () => {
    let now = 0;
    let scheduled: (() => void) | null = null;
    const release = vi.fn(async () => undefined);
    const runScheduled = () => {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    };
    const stop = startSurgeReadinessSelfRelease({
      released: async () => false,
      observe: async () => {
        throw new Error("Ready sibling health returned HTTP 503");
      },
      release,
      schedule: (callback) => {
        scheduled = callback;
        return vi.fn();
      },
      now: () => now,
      log: vi.fn(),
    });

    await vi.waitFor(() => expect(scheduled).not.toBeNull());
    expect(release).not.toHaveBeenCalled();

    now = SURGE_READINESS_HOLD_DEADLINE_MS;
    runScheduled();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());

    stop();
  });

  it("restarts the absence window after a Ready sibling reappears and later disappears", async () => {
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

  it("names the reason a due self-release is held in the readiness hold log", async () => {
    let now = 0;
    let scheduled: (() => void) | null = null;
    const release = vi.fn(async () => undefined);
    const log = vi.fn();
    const runScheduled = () => {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    };
    const stop = startSurgeReadinessSelfRelease({
      released: async () => false,
      observe: async () => ({ kind: "none", reason: "connection refused" }),
      release,
      holdReason: async () => "no canonical assignment for chris on this gateway",
      schedule: (callback) => {
        scheduled = callback;
        return vi.fn();
      },
      now: () => now,
      log,
    });

    for (const nextNow of [1_000, 2_000, 3_000, 61_000]) {
      await vi.waitFor(() => expect(scheduled).not.toBeNull());
      now = nextNow;
      runScheduled();
    }
    await vi.waitFor(() => expect(scheduled).not.toBeNull());

    expect(release).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(([message]) => message ===
      "[surge-handoff] self-release held: no canonical assignment for chris on this gateway")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "[surge-handoff] still holding readiness after 61s — no Ready sibling: connection refused; " +
      "self-release held: no canonical assignment for chris on this gateway",
    );

    stop();
  });

  it("names the current hold reason on the check where a seen-sibling self-release first becomes due", async () => {
    let now = 0;
    let observation: "sibling" | "none" = "sibling";
    let holdReason = "reserved by migration mig-1 as target";
    let scheduled: (() => void) | null = null;
    const release = vi.fn(async () => undefined);
    const log = vi.fn();
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
      holdReason: async () => holdReason,
      schedule: (callback) => {
        scheduled = callback;
        return vi.fn();
      },
      now: () => now,
      log,
    });
    const progressLines = () => log.mock.calls
      .map(([message]) => message as string)
      .filter((message) => message.startsWith("[surge-handoff] still holding readiness"));

    await vi.waitFor(() => expect(scheduled).not.toBeNull());
    observation = "none";
    for (const nextNow of [1_000, 30_000, 61_000]) {
      now = nextNow;
      runScheduled();
      await vi.waitFor(() => expect(scheduled).not.toBeNull());
    }
    expect(progressLines()).toEqual([
      "[surge-handoff] still holding readiness after 61s — no Ready sibling: connection refused; " +
      "self-release held: reserved by migration mig-1 as target",
    ]);

    holdReason = "no canonical assignment for chris on this gateway";
    now = 121_000;
    runScheduled();
    await vi.waitFor(() => expect(scheduled).not.toBeNull());
    expect(progressLines().at(-1)).toBe(
      "[surge-handoff] still holding readiness after 121s — no Ready sibling: connection refused; " +
      "self-release held: no canonical assignment for chris on this gateway",
    );
    expect(release).not.toHaveBeenCalled();

    stop();
  });

  it("names the last self-release failure in the readiness hold log", async () => {
    let now = 0;
    let scheduled: (() => void) | null = null;
    const release = vi.fn(async () => {
      throw new Error("EBUSY: resource busy or locked, rmdir '/home/node/.openclaw/customers/chris/projects'");
    });
    const log = vi.fn();
    const runScheduled = () => {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    };
    const stop = startSurgeReadinessSelfRelease({
      released: async () => false,
      observe: async () => ({ kind: "none", reason: "connection refused" }),
      release,
      holdReason: async () => null,
      schedule: (callback) => {
        scheduled = callback;
        return vi.fn();
      },
      now: () => now,
      log,
    });

    for (const nextNow of [1_000, 2_000, 61_000]) {
      await vi.waitFor(() => expect(scheduled).not.toBeNull());
      now = nextNow;
      runScheduled();
    }
    await vi.waitFor(() => expect(scheduled).not.toBeNull());

    expect(release).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "[surge-handoff] still holding readiness after 61s — no Ready sibling: connection refused; " +
      "last self-release failed: EBUSY: resource busy or locked, rmdir '/home/node/.openclaw/customers/chris/projects'",
    );

    stop();
  });

  it("keeps holding with a backed-off, named reason while the hold-reason read keeps failing", async () => {
    let now = 0;
    const delays: number[] = [];
    let scheduled: (() => void) | null = null;
    const release = vi.fn(async () => undefined);
    const log = vi.fn();
    const runScheduled = () => {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    };
    const stop = startSurgeReadinessSelfRelease({
      released: async () => false,
      observe: async () => ({ kind: "none", reason: "connection refused" }),
      release,
      holdReason: async () => {
        throw new Error("assignment roster unavailable: HTTP 502");
      },
      schedule: (callback, delayMs) => {
        delays.push(delayMs);
        scheduled = callback;
        return vi.fn();
      },
      now: () => now,
      log,
    });

    for (let check = 1; check <= 12; check += 1) {
      await vi.waitFor(() => expect(scheduled).not.toBeNull());
      now = check * 10_000;
      runScheduled();
    }
    await vi.waitFor(() => expect(scheduled).not.toBeNull());

    expect(release).not.toHaveBeenCalled();
    expect(delays.at(-1)).toBeGreaterThan(selfReleaseRetryDelayMs(0));
    expect(log.mock.calls.filter(([message]) => message ===
      "[surge-handoff] self-release check failed: assignment roster unavailable: HTTP 502")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(
      /^\[surge-handoff\] still holding readiness after \d+s — no Ready sibling: connection refused; self-release check failed: assignment roster unavailable: HTTP 502$/u,
    ));

    stop();
  });
});
