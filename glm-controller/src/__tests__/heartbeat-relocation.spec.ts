import { describe, it, expect } from "vitest";
import {
  revisionHeartbeatMerge,
  readHeartbeatLiveness,
  readMountedCustomers,
  heartbeatTeardownAction,
} from "../heartbeat-relocation.js";

describe("heartbeatTeardownAction — retire must preserve a durable GatewayDoc", () => {
  it("CLEARS (never deletes) when gateways/{id} is a GatewayDoc (numeric latestRelease)", () => {
    expect(
      heartbeatTeardownAction({
        gatewayId: "default",
        latestRelease: 4,
        desiredRelease: 4,
        desiredStatus: "retired",
      }),
    ).toBe("clear");
  });

  it("DELETES a legacy heartbeat-only doc", () => {
    expect(
      heartbeatTeardownAction({ status: "ready", version: "abc", lastHeartbeatAt: 1, mountedCustomers: [] }),
    ).toBe("delete");
    expect(heartbeatTeardownAction(undefined)).toBe("delete");
  });
});

describe("revisionHeartbeatMerge — writer targets glmGateways/{id}.heartbeat", () => {
  it("nests live telemetry under the heartbeat sub-document", () => {
    const merge = revisionHeartbeatMerge(
      { status: "ready", mountedCustomers: ["a", "b"], startedAt: 42 },
      1000,
    );
    expect(merge).toEqual({
      heartbeat: {
        status: "ready",
        mountedCustomers: ["a", "b"],
        lastHeartbeatAt: 1000,
        startedAt: 42,
      },
    });
  });

  it("timestamps each accepted config marker without erasing a separately published marker", () => {
    const timestamp = { toMillis: () => 1000 };
    const controlProtocol = { protocol: "durable-openclaw-config" as const, version: 2 as const };
    expect(revisionHeartbeatMerge({
      status: "ready",
      mountedCustomers: [],
      configStatus: { controlProtocol },
    }, timestamp).heartbeat.configStatus).toEqual({
      controlProtocol,
      observedAt: timestamp,
    });
    const pollerMerge = revisionHeartbeatMerge({
      status: "ready",
      mountedCustomers: [],
    }, timestamp);
    expect(pollerMerge.heartbeat).not.toHaveProperty("configStatus");
    expect({
      configStatus: {
        controlProtocol,
        openclawVersion: "2026.7.1",
        observedAt: 900,
      },
      ...pollerMerge.heartbeat,
    }).toMatchObject({
      configStatus: {
        controlProtocol,
        openclawVersion: "2026.7.1",
        observedAt: 900,
      },
      lastHeartbeatAt: timestamp,
    });
  });

  it("omits startedAt when the poll did not report it", () => {
    const merge = revisionHeartbeatMerge({ status: "ready", mountedCustomers: [] }, 5);
    expect(merge.heartbeat).not.toHaveProperty("startedAt");
  });
});

describe("readHeartbeatLiveness — reader prefers glmGateways heartbeat, falls back to legacy", () => {
  it("reads lastHeartbeatAt + version from the heartbeat sub-document", () => {
    const out = readHeartbeatLiveness(
      { heartbeat: { lastHeartbeatAt: 1234, version: "abc" } },
      { lastHeartbeatAt: 1, version: "stale" },
    );
    expect(out).toEqual({ lastHeartbeatAt: 1234, version: "abc" });
  });

  it("falls back to the legacy flat doc when no heartbeat sub-document exists", () => {
    const out = readHeartbeatLiveness(undefined, { lastHeartbeatAt: 55, version: "leg" });
    expect(out).toEqual({ lastHeartbeatAt: 55, version: "leg" });
  });

  it("coerces a Firestore Timestamp (toMillis) heartbeat value", () => {
    const out = readHeartbeatLiveness(
      { heartbeat: { lastHeartbeatAt: { toMillis: () => 9999 } } },
      undefined,
    );
    expect(out?.lastHeartbeatAt).toBe(9999);
  });

  it("returns null when neither location carries a heartbeat", () => {
    expect(readHeartbeatLiveness(undefined, undefined)).toBeNull();
    expect(readHeartbeatLiveness({ heartbeat: {} }, undefined)).toBeNull();
  });
});

describe("readMountedCustomers — reader prefers glmGateways heartbeat, falls back to legacy", () => {
  it("reads the mounted set from the heartbeat sub-document", () => {
    expect(
      readMountedCustomers({ heartbeat: { mountedCustomers: ["x", "y"] } }, { mountedCustomers: ["z"] }),
    ).toEqual(["x", "y"]);
  });

  it("falls back to the legacy flat doc", () => {
    expect(readMountedCustomers(undefined, { mountedCustomers: ["z"] })).toEqual(["z"]);
  });

  it("returns [] when neither location has a mounted set", () => {
    expect(readMountedCustomers(undefined, undefined)).toEqual([]);
  });
});
