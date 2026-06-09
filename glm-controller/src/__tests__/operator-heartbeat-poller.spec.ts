import { describe, expect, it, vi } from "vitest";
import {
  intersectMounted,
  parseHealthResponse,
  pollOperatorHeartbeatsOnce,
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
    listOperatorGatewayIds: vi.fn(async () => ["bender"]),
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

  it("skips a gateway it cannot reach (does NOT clobber the doc to empty)", async () => {
    const deps = makeDeps({ fetchHealth: vi.fn(async () => null) });
    await pollOperatorHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).not.toHaveBeenCalled();
  });

  it("isolates per-gateway failures so one bad gateway does not block the rest", async () => {
    const deps = makeDeps({
      listOperatorGatewayIds: vi.fn(async () => ["bad", "good"]),
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

  it("logs and returns without writing when listing operator gateways fails", async () => {
    const deps = makeDeps({
      listOperatorGatewayIds: vi.fn(async () => {
        throw new Error("firestore unavailable");
      }),
    });
    await pollOperatorHeartbeatsOnce(deps);
    expect(deps.writeHeartbeat).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("operator gateways"));
  });
});
