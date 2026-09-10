import { describe, expect, it } from "vitest";
import { CRASH_LOOP_EVICTION_BUDGET, claimCrashLoopEviction, crashLoopEvictionDecision } from "../surge-crashloop-eviction.js";

const pod = { uid: "t", name: "gateway-new", podIP: "10.0.0.2", ready: false, terminating: false, crashLooping: true };

describe("crashLoopEvictionDecision", () => {
  it("spends the budget one eviction at a time for the same image, then refuses", () => {
    expect(crashLoopEvictionDecision(undefined, "new-sha")).toEqual({ allowed: true, count: 1 });
    expect(crashLoopEvictionDecision({ imageTag: "new-sha", count: 2 }, "new-sha")).toEqual({ allowed: true, count: 3 });
    expect(crashLoopEvictionDecision({ imageTag: "new-sha", count: CRASH_LOOP_EVICTION_BUDGET }, "new-sha")).toEqual({ allowed: false, count: 3 });
  });

  it("starts a fresh budget for a different image and ignores a malformed record", () => {
    expect(crashLoopEvictionDecision({ imageTag: "old-sha", count: 3 }, "new-sha")).toEqual({ allowed: true, count: 1 });
    expect(crashLoopEvictionDecision({ imageTag: "new-sha", count: "3" }, "new-sha")).toEqual({ allowed: true, count: 1 });
    expect(crashLoopEvictionDecision("garbage", "new-sha")).toEqual({ allowed: true, count: 1 });
  });
});

describe("claimCrashLoopEviction", () => {
  function fakeDb(seed: Record<string, unknown> | undefined) {
    let stored = seed;
    const ref = { path: "glmGateways/gw" };
    const db = {
      collection: () => ({ doc: () => ref }),
      runTransaction: async <T>(body: (transaction: unknown) => Promise<T>) => body({
        get: async () => ({ exists: stored !== undefined, data: () => stored }),
        set: (_ref: unknown, patch: Record<string, unknown>) => { stored = { ...(stored ?? {}), ...patch }; },
      }),
    };
    return { db: db as never, read: () => stored };
  }

  it("records each allowed eviction on the runtime doc and leaves the doc alone once the budget is spent", async () => {
    const { db, read } = fakeDb({ docKind: "runtime", surgeCrashLoopEvictions: { imageTag: "new-sha", count: 2, lastAt: 1, lastPod: "p" } });
    await expect(claimCrashLoopEviction(db, { gatewayId: "gw", imageTag: "new-sha", pod, now: 50 })).resolves.toEqual({ allowed: true, count: 3, budget: 3 });
    expect(read()).toEqual({ docKind: "runtime", surgeCrashLoopEvictions: { imageTag: "new-sha", count: 3, lastAt: 50, lastPod: "gateway-new" } });

    await expect(claimCrashLoopEviction(db, { gatewayId: "gw", imageTag: "new-sha", pod, now: 60 })).resolves.toEqual({ allowed: false, count: 3, budget: 3 });
    expect(read()).toMatchObject({ surgeCrashLoopEvictions: { count: 3, lastAt: 50 } });
  });
});
