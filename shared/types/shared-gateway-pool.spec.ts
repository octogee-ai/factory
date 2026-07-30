import { describe, expect, it } from "vitest";

import {
  authoritativeSharedGatewayLoad,
  isAcceptingSharedGateway,
  parseSharedGatewayPoolConfig,
  planSharedGatewayRebalance,
  selectSharedGateway,
} from "./shared-gateway-pool.js";

const config = {
  defaultGatewayId: "default",
  sharedGatewayIds: ["default", "default-b"],
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
    converging: false,
    incomingMigrationCount: 0,
    assignmentCount: 0,
    ...overrides,
  };
}

describe("parseSharedGatewayPoolConfig", () => {
  it("requires a valid unique pool with the primary first", () => {
    expect(parseSharedGatewayPoolConfig(config)).toEqual(config);
    expect(parseSharedGatewayPoolConfig({ defaultGatewayId: "default" })).toBeNull();
    expect(parseSharedGatewayPoolConfig({
      defaultGatewayId: "default",
      sharedGatewayIds: ["default-b", "default"],
    })).toBeNull();
    expect(parseSharedGatewayPoolConfig({
      defaultGatewayId: "default",
      sharedGatewayIds: ["default", "default"],
    })).toBeNull();
    expect(parseSharedGatewayPoolConfig({
      defaultGatewayId: "default",
      sharedGatewayIds: ["default", "NOT VALID"],
    })).toBeNull();
  });
});

describe("shared gateway selection", () => {
  it("chooses the least authoritative load", () => {
    expect(authoritativeSharedGatewayLoad(candidate("default", {
      assignmentCount: 2,
      incomingMigrationCount: 1,
    }))).toBe(3);
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      candidates: [candidate("default", { assignmentCount: 4 }), candidate("default-b", { assignmentCount: 2 })],
    })).toMatchObject({ kind: "selected", gatewayId: "default-b", load: 2 });
  });

  it("uses a stable uid hash to distribute equal loads", () => {
    const candidates = [candidate("default"), candidate("default-b")];
    const picks = new Set(
      Array.from({ length: 32 }, (_, index) => selectSharedGateway({
        uid: `uid-${index}`,
        config,
        candidates,
      })).map((selection) => selection.kind === "selected" ? selection.gatewayId : null),
    );
    expect(picks).toEqual(new Set(["default", "default-b"]));
    expect(selectSharedGateway({ uid: "uid-7", config, candidates })).toEqual(
      selectSharedGateway({ uid: "uid-7", config, candidates }),
    );
  });

  it("keeps a healthy current member until its load is more than one above the minimum", () => {
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      currentGatewayId: "default",
      candidates: [candidate("default", { assignmentCount: 3 }), candidate("default-b", { assignmentCount: 2 })],
    })).toMatchObject({ gatewayId: "default", retainedCurrent: true });
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      currentGatewayId: "default",
      candidates: [candidate("default", { assignmentCount: 4 }), candidate("default-b", { assignmentCount: 2 })],
    })).toMatchObject({ gatewayId: "default-b", retainedCurrent: false });
  });

  it("excludes invalid destinations and blocks visibly when none accept", () => {
    for (const overrides of [
      { ready: false },
      { heartbeatFresh: false },
      { managedBy: "operator" },
      { gatewayClass: "builder" },
      { converging: true },
      { incomingMigrationCount: 1 },
      { gatewayId: "isolated" },
    ]) {
      expect(isAcceptingSharedGateway(config, candidate("default", overrides))).toBe(false);
    }
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      candidates: [candidate("default", { ready: false })],
    })).toEqual({ kind: "blocked", reason: "no-accepting-shared-gateway" });
  });

  it("plans one recovery rebalance only when the healthy pool differs by two", () => {
    expect(planSharedGatewayRebalance({
      config,
      candidates: [candidate("default", { assignmentCount: 4 }), candidate("default-b", { assignmentCount: 2 })],
    })).toEqual({ fromGatewayId: "default", toGatewayId: "default-b" });
    expect(planSharedGatewayRebalance({
      config,
      candidates: [candidate("default", { assignmentCount: 3 }), candidate("default-b", { assignmentCount: 2 })],
    })).toBeNull();
  });
});
