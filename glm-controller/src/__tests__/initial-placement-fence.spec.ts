import { describe, expect, it } from "vitest";
import { initialTargetFenceFailures } from "../initial-placement.js";

const NOW = 1_800_000_000_000;

function fence(overrides: {
  gateway?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  heartbeat?: Record<string, unknown>;
  load?: Partial<{ assignmentCount: number; incomingMigrations: number; outgoingMigrations: number }>;
  siblingLoads?: number[];
  buildersPerGateway?: number | null;
} = {}) {
  return initialTargetFenceFailures({
    target: "shared-0",
    gateway: {
      gatewayId: "shared-0",
      gatewayClass: "shared",
      desiredStatus: "running",
      liveRelease: 7,
      desiredRelease: 7,
      ...overrides.gateway,
    } as never,
    runtime: {
      gatewayId: "shared-0",
      release: 7,
      lifecycle: "serving",
      kubernetes: { status: "ready", readyPods: 1, totalPods: 1, observedAt: NOW - 5_000 },
      heartbeat: { status: "ready", lastHeartbeatAt: NOW - 10_000, mountedCustomers: [], ...overrides.heartbeat },
      ...overrides.runtime,
    } as never,
    load: { assignmentCount: 2, incomingMigrations: 0, outgoingMigrations: 0, ...overrides.load },
    siblingLoads: overrides.siblingLoads ?? [],
    buildersPerGateway: overrides.buildersPerGateway === undefined ? 10 : overrides.buildersPerGateway,
    nowMs: NOW,
  });
}

describe("initialTargetFenceFailures", () => {
  it("accepts a converged, serving shared gateway with room", () => {
    expect(fence()).toEqual([]);
  });

  it.each([
    ["gateway-id-mismatch", { gateway: { gatewayId: "other" } }],
    ["gateway-class-not-shared", { gateway: { gatewayClass: "owned" } }],
    ["gateway-not-running", { gateway: { desiredStatus: "paused" } }],
    ["live-release-missing", { gateway: { liveRelease: null } }],
    ["release-not-converged", { gateway: { desiredRelease: 8 } }],
    ["runtime-gateway-mismatch", { runtime: { gatewayId: "other" } }],
    ["runtime-release-mismatch", { runtime: { release: 6 } }],
    ["runtime-not-serving", { runtime: { lifecycle: "booting" } }],
    ["heartbeat-not-ready", { heartbeat: { status: "degraded" } }],
    ["kubernetes-observation-stale", { runtime: { kubernetes: { status: "ready", readyPods: 1, totalPods: 1, observedAt: NOW - 10 * 60_000 } } }],
    ["heartbeat-missing", { heartbeat: { lastHeartbeatAt: null } }],
    ["heartbeat-stale", { heartbeat: { lastHeartbeatAt: NOW - 10 * 60_000 } }],
    ["target-at-capacity", { load: { assignmentCount: 10 } }],
    ["target-not-least-loaded", { siblingLoads: [1] }],
  ])("rejects the target for %s", (failure, overrides) => {
    expect(fence(overrides as never)).toContain(failure);
  });

  it("lets a Builder already assigned to the target through a full gateway", () => {
    expect(fence({ load: { assignmentCount: 10 }, buildersPerGateway: null })).toEqual([]);
  });

  it("reserves capacity for incoming migrations without refusing the target outright", () => {
    expect(fence({ load: { assignmentCount: 8, incomingMigrations: 1 } })).toEqual([]);
    expect(fence({ load: { assignmentCount: 9, incomingMigrations: 1 } })).toContain("target-at-capacity");
  });

  it("compares load with incoming added and outgoing removed, matching target selection", () => {
    expect(fence({ load: { assignmentCount: 3, incomingMigrations: 1 }, siblingLoads: [3] }))
      .toContain("target-not-least-loaded");
    expect(fence({ load: { assignmentCount: 5, outgoingMigrations: 3 }, siblingLoads: [3] })).toEqual([]);
    expect(fence({ load: { assignmentCount: 5, outgoingMigrations: 1 }, siblingLoads: [3] }))
      .toContain("target-not-least-loaded");
  });
});
