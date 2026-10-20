import { describe, it, expect } from "vitest";
import {
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  GATEWAY_UNREACHABLE_AFTER_MS,
} from "@octogee/shared/types/fleet-controller";
import { OPENCLAW_CONTROL_RUNTIME_FRESH_MS } from "@octogee/core/openclaw-control-runtime-ready";
import {
  HEARTBEAT_REFRESH_MS,
  heartbeatMergeIsRedundant,
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

  it("writes the configured Builder report, including an explicit null, only when the poll carried one", () => {
    expect(revisionHeartbeatMerge(
      { status: "ready", mountedCustomers: [], configuredBuilder: { state: "standby" } }, 1000,
    ).heartbeat.configuredBuilder).toEqual({ state: "standby" });
    expect(revisionHeartbeatMerge(
      { status: "ready", mountedCustomers: [], configuredBuilder: null }, 1000,
    ).heartbeat).toHaveProperty("configuredBuilder", null);
    expect(revisionHeartbeatMerge({ status: "ready", mountedCustomers: [] }, 1000).heartbeat)
      .not.toHaveProperty("configuredBuilder");
  });

  it("leaves the separately published config marker untouched", () => {
    const timestamp = { toMillis: () => 1000 };
    const controlProtocol = { protocol: "durable-openclaw-config" as const, version: 2 as const };
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

  it("persists the OpenClaw runtime version from trusted pod health", () => {
    expect(
      revisionHeartbeatMerge(
        {
          status: "ready",
          mountedCustomers: [],
          openclawVersion: "2026.7.1",
        },
        5,
      ).heartbeat,
    ).toMatchObject({ openclawVersion: "2026.7.1" });
  });
});

describe("heartbeatMergeIsRedundant — a converged poll writes nothing", () => {
  const NOW = 1_000_000;
  const SERVER_TIMESTAMP = { _methodName: "serverTimestamp" };
  const INTERNAL_URL = "http://octogee-gateway-bender.octogee.svc.cluster.local:18789";
  const REPORTED = {
    status: "ready",
    mountedCustomers: ["ceckert"],
    startedAt: 42,
    version: "abc1234",
    openclawVersion: "2026.7.1",
  };

  function candidate(): Record<string, unknown> {
    const merge = revisionHeartbeatMerge(REPORTED, SERVER_TIMESTAMP);
    merge.heartbeat.internalUrl = INTERNAL_URL;
    return merge.heartbeat;
  }

  function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...REPORTED,
      internalUrl: INTERNAL_URL,
      lastHeartbeatAt: NOW - GATEWAY_HEARTBEAT_INTERVAL_MS,
      ...overrides,
    };
  }

  it("skips the write when every merged field already matches a fresh stored heartbeat", () => {
    expect(heartbeatMergeIsRedundant(stored(), candidate(), NOW)).toBe(true);
  });

  it("reads a Firestore Timestamp lastHeartbeatAt for the freshness gate", () => {
    expect(heartbeatMergeIsRedundant(
      stored({ lastHeartbeatAt: { toMillis: () => NOW - GATEWAY_HEARTBEAT_INTERVAL_MS } }),
      candidate(),
      NOW,
    )).toBe(true);
  });

  it.each([
    ["status", { status: "degraded" }],
    ["mountedCustomers", { mountedCustomers: ["ceckert", "bender"] }],
    ["startedAt", { startedAt: 41 }],
    ["version", { version: "0000000" }],
    ["openclawVersion", { openclawVersion: "2026.7.0" }],
    ["internalUrl", { internalUrl: "http://elsewhere:18789" }],
  ])("writes when the poll reports a new %s", (_field, drift) => {
    expect(heartbeatMergeIsRedundant(stored(drift), candidate(), NOW)).toBe(false);
  });

  it("writes once the stored heartbeat reaches the refresh deadline", () => {
    expect(heartbeatMergeIsRedundant(
      stored({ lastHeartbeatAt: NOW - HEARTBEAT_REFRESH_MS }),
      candidate(),
      NOW,
    )).toBe(false);
  });

  it("writes when the stored heartbeat is absent or carries no lastHeartbeatAt", () => {
    expect(heartbeatMergeIsRedundant(undefined, candidate(), NOW)).toBe(false);
    expect(heartbeatMergeIsRedundant({ status: "ready" }, candidate(), NOW)).toBe(false);
  });

  it("writes when the stored stamp is ahead of the poller clock", () => {
    expect(heartbeatMergeIsRedundant(
      stored({ lastHeartbeatAt: NOW + 1 }),
      candidate(),
      NOW,
    )).toBe(false);
  });

  it("ignores stored fields the poller's merge never writes", () => {
    expect(heartbeatMergeIsRedundant(
      stored({ lastError: { message: "boom", at: 5 } }),
      candidate(),
      NOW,
    )).toBe(true);
  });

  it("never rewrites over the broker-authored configStatus it does not own", () => {
    expect(heartbeatMergeIsRedundant(
      stored({
        configStatus: {
          runtimeReady: true,
          openclawVersion: "2026.7.1",
          observedAt: NOW - GATEWAY_HEARTBEAT_INTERVAL_MS,
        },
      }),
      candidate(),
      NOW,
    )).toBe(true);
  });

  it("keeps a full poll interval of headroom under the fleet staleness bound", () => {
    expect(HEARTBEAT_REFRESH_MS + GATEWAY_HEARTBEAT_INTERVAL_MS)
      .toBeLessThan(GATEWAY_UNREACHABLE_AFTER_MS);
  });

  it("refreshes before the OpenClaw dashboard readiness proof can expire", () => {
    expect(HEARTBEAT_REFRESH_MS + GATEWAY_HEARTBEAT_INTERVAL_MS)
      .toBeLessThanOrEqual(OPENCLAW_CONTROL_RUNTIME_FRESH_MS);
  });
});

describe("readHeartbeatLiveness", () => {
  it("reads lastHeartbeatAt and version from runtime telemetry", () => {
    expect(readHeartbeatLiveness({ heartbeat: { lastHeartbeatAt: 1234, version: "abc" } }))
      .toEqual({ lastHeartbeatAt: 1234, version: "abc" });
  });

  it("coerces a Firestore Timestamp heartbeat value", () => {
    expect(readHeartbeatLiveness({ heartbeat: { lastHeartbeatAt: { toMillis: () => 9999 } } }))
      .toEqual({ lastHeartbeatAt: 9999, version: null });
  });

  it("returns null without runtime heartbeat telemetry", () => {
    expect(readHeartbeatLiveness(undefined)).toBeNull();
    expect(readHeartbeatLiveness({ heartbeat: {} })).toBeNull();
  });
});

describe("readMountedCustomers", () => {
  it("reads the mounted set from runtime telemetry", () => {
    expect(readMountedCustomers({ heartbeat: { mountedCustomers: ["x", "y"] } }))
      .toEqual(["x", "y"]);
  });

  it("returns an empty set without runtime mounted customers", () => {
    expect(readMountedCustomers(undefined)).toEqual([]);
  });
});
