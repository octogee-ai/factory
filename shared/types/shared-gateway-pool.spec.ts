import { describe, expect, it } from "vitest";

import {
  authoritativeSharedGatewayLoad,
  isAcceptingSharedGateway,
  parseSharedGatewayPoolConfig,
  planSharedGatewayRebalance,
  selectSharedGateway,
} from "./shared-gateway-pool.js";

const config = {
  defaultGatewayId: "shared-a",
  sharedGatewayIds: ["shared-a", "shared-b"],
} as const;

function candidate(
  gatewayId: string,
  overrides: Partial<Parameters<typeof isAcceptingSharedGateway>[1]> = {},
) {
  return {
    gatewayId,
    gatewayClass: "shared",
    desiredStatus: "running",
    managedBy: "cowboy",
    ready: true,
    serving: true,
    heartbeatFresh: true,
    liveReleaseReady: true,
    rosterComplete: true,
    incomingMigrationCount: 0,
    assignmentCount: 0,
    ...overrides,
  };
}

describe("parseSharedGatewayPoolConfig", () => {
  it("requires a valid unique pool with the primary first", () => {
    expect(parseSharedGatewayPoolConfig(config)).toEqual(config);
    expect(parseSharedGatewayPoolConfig({ defaultGatewayId: "shared-a" })).toBeNull();
    expect(parseSharedGatewayPoolConfig({
      defaultGatewayId: "shared-a",
      sharedGatewayIds: ["shared-b", "shared-a"],
    })).toBeNull();
    expect(parseSharedGatewayPoolConfig({
      defaultGatewayId: "shared-a",
      sharedGatewayIds: ["shared-a", "shared-a"],
    })).toBeNull();
    expect(parseSharedGatewayPoolConfig({
      defaultGatewayId: "shared-a",
      sharedGatewayIds: ["shared-a", "NOT VALID"],
    })).toBeNull();
  });
});

describe("shared gateway selection", () => {
  it("chooses the least authoritative load", () => {
    expect(authoritativeSharedGatewayLoad(candidate("shared-a", {
      assignmentCount: 2,
      incomingMigrationCount: 1,
    }))).toBe(3);
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      candidates: [candidate("shared-a", { assignmentCount: 4 }), candidate("shared-b", { assignmentCount: 2 })],
    })).toMatchObject({ kind: "selected", gatewayId: "shared-b", load: 2 });
  });

  it("uses a stable uid hash to distribute equal loads", () => {
    const candidates = [candidate("shared-a"), candidate("shared-b")];
    const picks = new Set(
      Array.from({ length: 32 }, (_, index) => selectSharedGateway({
        uid: `uid-${index}`,
        config,
        candidates,
      })).map((selection) => selection.kind === "selected" ? selection.gatewayId : null),
    );
    expect(picks).toEqual(new Set(["shared-a", "shared-b"]));
    expect(selectSharedGateway({ uid: "uid-7", config, candidates })).toEqual(
      selectSharedGateway({ uid: "uid-7", config, candidates }),
    );
  });

  it("keeps a healthy current member until its load is more than one above the minimum", () => {
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      currentGatewayId: "shared-a",
      candidates: [candidate("shared-a", { assignmentCount: 3 }), candidate("shared-b", { assignmentCount: 2 })],
    })).toMatchObject({ gatewayId: "shared-a", retainedCurrent: true });
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      currentGatewayId: "shared-a",
      candidates: [candidate("shared-a", { assignmentCount: 4 }), candidate("shared-b", { assignmentCount: 2 })],
    })).toMatchObject({ gatewayId: "shared-b", retainedCurrent: false });
  });

  it("excludes invalid destinations and blocks visibly when none accept", () => {
    for (const overrides of [
      { ready: false },
      { heartbeatFresh: false },
      { managedBy: "operator" },
      { gatewayClass: "builder" },
      { gatewayId: "isolated" },
    ]) {
      expect(isAcceptingSharedGateway(config, candidate("shared-a", overrides))).toBe(false);
    }
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      candidates: [candidate("shared-a", { ready: false })],
    })).toEqual({ kind: "blocked", reason: "no-accepting-shared-gateway" });
  });

  it("uses queued migrations as projected load without rejecting their target", () => {
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      candidates: [
        candidate("shared-a", { assignmentCount: 1, incomingMigrationCount: 2 }),
        candidate("shared-b", { assignmentCount: 2 }),
      ],
    })).toMatchObject({ kind: "selected", gatewayId: "shared-b", load: 2 });
  });

  it("plans one recovery rebalance only when the healthy pool differs by two", () => {
    expect(planSharedGatewayRebalance({
      config,
      candidates: [candidate("shared-a", { assignmentCount: 4 }), candidate("shared-b", { assignmentCount: 2 })],
    })).toEqual({ fromGatewayId: "shared-a", toGatewayId: "shared-b" });
    expect(planSharedGatewayRebalance({
      config,
      candidates: [candidate("shared-a", { assignmentCount: 3 }), candidate("shared-b", { assignmentCount: 2 })],
    })).toBeNull();
  });
});
