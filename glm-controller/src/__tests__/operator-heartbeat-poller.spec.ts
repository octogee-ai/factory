import { describe, expect, it, vi } from "vitest";
import {
  departedFromAssigned,
  intersectMounted,
  parseHealthResponse,
  pollOperatorHeartbeatsOnce,
  type EvictionInFlight,
  type EvictionStreaks,
  type OperatorHeartbeatPollerDeps,
} from "../operator-heartbeat-poller.js";

describe("parseHealthResponse", () => {
  it("parses a well-formed /health body", () => {
    expect(parseHealthResponse({ status: "ready", customers: ["a", "b"] })).toEqual({
      status: "ready",
      customers: ["a", "b"],
    });
  });

  it("filters non-string entries out of customers", () => {
    expect(
      parseHealthResponse({ status: "ready", customers: ["a", 1, null, "b"] }),
    ).toEqual({ status: "ready", customers: ["a", "b"] });
  });

  it("returns null for malformed bodies (skipped like unreachable, never fabricated)", () => {
    expect(parseHealthResponse(null)).toBeNull();
    expect(parseHealthResponse("ready")).toBeNull();
    expect(parseHealthResponse({ customers: ["a"] })).toBeNull(); // missing status
    expect(parseHealthResponse({ status: "", customers: ["a"] })).toBeNull(); // empty status
    expect(parseHealthResponse({ status: 1, customers: ["a"] })).toBeNull(); // non-string status
    expect(parseHealthResponse({ status: "ready" })).toBeNull(); // missing customers
    expect(parseHealthResponse({ status: "ready", customers: "a" })).toBeNull(); // non-array
  });

  it("carries startedAt when /health reports a number, ignores a non-number", () => {
    expect(
      parseHealthResponse({ status: "ready", customers: [], startedAt: 1700 }),
    ).toEqual({ status: "ready", customers: [], startedAt: 1700 });
    expect(
      parseHealthResponse({ status: "ready", customers: [], startedAt: "x" }),
    ).toEqual({ status: "ready", customers: [] });
  });

  it("carries migratingIn (string entries only); omits it when absent or non-array", () => {
    expect(
      parseHealthResponse({ status: "ready", customers: ["a"], migratingIn: ["a", 1, "b"] }),
    ).toEqual({ status: "ready", customers: ["a"], migratingIn: ["a", "b"] });
    expect(parseHealthResponse({ status: "ready", customers: ["a"] })).toEqual({
      status: "ready",
      customers: ["a"],
    });
    expect(
      parseHealthResponse({ status: "ready", customers: ["a"], migratingIn: "a" }),
    ).toEqual({ status: "ready", customers: ["a"] });
  });
});

describe("intersectMounted", () => {
  it("keeps only locally-present customers that are also assigned, sorted", () => {
    expect(intersectMounted(["c", "a", "ghost"], ["a", "c", "notpresent"])).toEqual([
      "a",
      "c",
    ]);
  });

  it("drops a locally-present customer that is no longer assigned (the stale-mount case)", () => {
    expect(intersectMounted(["eggman"], [])).toEqual([]);
  });

  it("drops an assigned customer the pod has not actually mounted yet", () => {
    expect(intersectMounted([], ["pending"])).toEqual([]);
  });
});

function makeDeps(
  over: Partial<OperatorHeartbeatPollerDeps> = {},
): OperatorHeartbeatPollerDeps {
  return {
    listGatewayIds: vi.fn(async () => ["bender"]),
    fetchHealth: vi.fn(async () => ({
      status: "ready",
      customers: ["ceckert", "ghost"],
    })),
    readAssignedSlugs: vi.fn(async () => ["ceckert"]),
    writeHeartbeat: vi.fn(async () => {}),
    log: vi.fn(),
    ...over,
  };
}

describe("pollOperatorHeartbeatsOnce", () => {
  it("writes assigned∩present as mountedCustomers, carrying the health status", async () => {
    const deps = makeDeps();
    await pollOperatorHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).toHaveBeenCalledWith("bender", {
      status: "ready",
      mountedCustomers: ["ceckert"],
    });
  });

  it("persists startedAt from /health so the shell reaper can detect a roll", async () => {
    const deps = makeDeps({
      fetchHealth: vi.fn(async () => ({
        status: "ready",
        customers: ["ceckert"],
        startedAt: 1700000,
      })),
    });
    await pollOperatorHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).toHaveBeenCalledWith("bender", {
      status: "ready",
      mountedCustomers: ["ceckert"],
      startedAt: 1700000,
    });
  });

  it("skips a gateway it cannot reach (does NOT clobber the doc to empty)", async () => {
    const deps = makeDeps({ fetchHealth: vi.fn(async () => null) });
    await pollOperatorHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).not.toHaveBeenCalled();
  });

  it("isolates per-gateway failures so one bad gateway does not block the rest", async () => {
    const deps = makeDeps({
      listGatewayIds: vi.fn(async () => ["bad", "good"]),
      fetchHealth: vi.fn(async (id: string) => {
        if (id === "bad") throw new Error("connection refused");
        return { status: "ready", customers: ["x"] };
      }),
      readAssignedSlugs: vi.fn(async () => ["x"]),
    });
    await pollOperatorHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).toHaveBeenCalledTimes(1);
    expect(deps.writeHeartbeat).toHaveBeenCalledWith(
      "good",
      expect.objectContaining({ mountedCustomers: ["x"] }),
    );
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("bad"));
  });

  it("logs and returns without writing when listing gateways fails", async () => {
    const deps = makeDeps({
      listGatewayIds: vi.fn(async () => {
        throw new Error("firestore unavailable");
      }),
    });
    await pollOperatorHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("gateways"));
  });
});

describe("departedFromAssigned", () => {
  it("returns locally-present customers that are no longer assigned, sorted", () => {
    expect(departedFromAssigned(["ghost", "ceckert"], ["ceckert"])).toEqual(["ghost"]);
  });

  it("is empty when everything present is still assigned", () => {
    expect(departedFromAssigned(["ceckert"], ["ceckert", "other"])).toEqual([]);
  });
});

describe("pollOperatorHeartbeatsOnce — Cowboy-driven local eviction", () => {
  function evictDeps(over: Partial<OperatorHeartbeatPollerDeps> = {}) {
    // makeDeps reports ghost present but not assigned → ghost is the departed one.
    return makeDeps({ evictSlug: vi.fn(async () => {}), evictAfterStreak: 2, ...over });
  }

  it("evicts a departed local customer only after the streak threshold", async () => {
    const deps = evictDeps();
    const streaks: EvictionStreaks = new Map();
    await pollOperatorHeartbeatsOnce(deps, streaks); // ghost departed, streak 1
    expect(deps.evictSlug).not.toHaveBeenCalled();
    await pollOperatorHeartbeatsOnce(deps, streaks); // streak 2 → evict
    expect(deps.evictSlug).toHaveBeenCalledTimes(1);
    expect(deps.evictSlug).toHaveBeenCalledWith("bender", "ghost");
  });

  it("never evicts a customer that is still assigned, no matter how many ticks", async () => {
    const deps = evictDeps({ readAssignedSlugs: vi.fn(async () => ["ceckert", "ghost"]) });
    const streaks: EvictionStreaks = new Map();
    await pollOperatorHeartbeatsOnce(deps, streaks);
    await pollOperatorHeartbeatsOnce(deps, streaks);
    await pollOperatorHeartbeatsOnce(deps, streaks);
    expect(deps.evictSlug).not.toHaveBeenCalled();
  });

  it("resets the streak when a departed customer is re-assigned before the threshold", async () => {
    let assigned = ["ceckert"];
    const deps = evictDeps({ readAssignedSlugs: vi.fn(async () => assigned) });
    const streaks: EvictionStreaks = new Map();
    await pollOperatorHeartbeatsOnce(deps, streaks); // ghost departed, streak 1
    assigned = ["ceckert", "ghost"]; // re-assigned
    await pollOperatorHeartbeatsOnce(deps, streaks); // ghost assigned → streak reset
    assigned = ["ceckert"]; // departs again
    await pollOperatorHeartbeatsOnce(deps, streaks); // streak back to 1, not 2 → no evict
    expect(deps.evictSlug).not.toHaveBeenCalled();
  });

  it("never evicts a slug /health flags migrating-in, even when departed past the threshold", async () => {
    // ghost is present + unassigned (departed) but mid-migration-import: coach-wired on the
    // target before cutover moves its assignment. Cowboy must not drain the fresh import.
    const deps = evictDeps({
      evictAfterStreak: 1,
      fetchHealth: vi.fn(async () => ({
        status: "ready",
        customers: ["ceckert", "ghost"],
        migratingIn: ["ghost"],
      })),
    });
    const streaks: EvictionStreaks = new Map();
    await pollOperatorHeartbeatsOnce(deps, streaks);
    await pollOperatorHeartbeatsOnce(deps, streaks);
    await pollOperatorHeartbeatsOnce(deps, streaks);
    expect(deps.evictSlug).not.toHaveBeenCalled();
    // ...and it's still correctly absent from mountedCustomers (unassigned pre-cutover).
    expect(deps.writeHeartbeat).toHaveBeenLastCalledWith(
      "bender",
      expect.objectContaining({ mountedCustomers: ["ceckert"] }),
    );
  });

  it("does nothing (but still reports) when no evictSlug is configured", async () => {
    const deps = makeDeps({ evictAfterStreak: 1 }); // no evictSlug
    const streaks: EvictionStreaks = new Map();
    await pollOperatorHeartbeatsOnce(deps, streaks);
    await pollOperatorHeartbeatsOnce(deps, streaks);
    expect(deps.writeHeartbeat).toHaveBeenCalled();
  });

  it("logs and continues the poll when an eviction call fails", async () => {
    const deps = evictDeps({
      evictAfterStreak: 1,
      evictSlug: vi.fn(async () => {
        throw new Error("unmount 500");
      }),
    });
    const streaks: EvictionStreaks = new Map();
    await pollOperatorHeartbeatsOnce(deps, streaks);
    expect(deps.evictSlug).toHaveBeenCalledWith("bender", "ghost");
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("evict"));
    expect(deps.writeHeartbeat).toHaveBeenCalled();
  });

  it("does not double-issue eviction while a prior /unmount is still in flight", async () => {
    let markStarted!: () => void;
    let releaseEviction!: () => void;
    const evictionStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const evictionRelease = new Promise<void>((resolve) => {
      releaseEviction = resolve;
    });
    const deps = evictDeps({
      evictAfterStreak: 1,
      evictSlug: vi.fn(async () => {
        markStarted();
        await evictionRelease;
      }),
    });
    const streaks: EvictionStreaks = new Map();
    const inFlight: EvictionInFlight = new Set();

    const firstPoll = pollOperatorHeartbeatsOnce(deps, streaks, inFlight);
    await evictionStarted;
    await pollOperatorHeartbeatsOnce(deps, streaks, inFlight);

    expect(deps.evictSlug).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("already in flight"));

    releaseEviction();
    await firstPoll;
  });
});
