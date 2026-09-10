import { describe, expect, it } from "vitest";

import {
  authoritativeSharedGatewayLoad,
  compareSharedGatewayIds,
  deriveSharedGatewayPoolConfig,
  isAcceptingSharedGateway,
  isSharedPoolSlotId,
  nextSharedPoolSlotId,
  parseSharedGatewayAutoscalingConfig,
  parseSharedGatewayPoolConfig,
  parseSharedPoolReplicaBounds,
  planSharedGatewayRebalance,
  selectSharedGateway,
  sharedPoolSlotOrdinal,
} from "./shared-gateway-pool.js";

const config = {
  defaultGatewayId: "shared-0",
  sharedGatewayIds: ["shared-0", "shared-1"],
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

function root(
  gatewayId: string,
  overrides: Partial<{ gatewayClass: unknown; desiredStatus: unknown; managedBy: unknown }> = {},
) {
  return { gatewayId, gatewayClass: "shared", desiredStatus: "running", ...overrides };
}

describe("shared pool slot ids", () => {
  it("recognises unnamed ordinal slots and their ordinals", () => {
    expect(isSharedPoolSlotId("shared-0")).toBe(true);
    expect(isSharedPoolSlotId("shared-12")).toBe(true);
    expect(sharedPoolSlotOrdinal("shared-12")).toBe(12);
    for (const id of ["shared-a", "shared-01", "shared-", "shared", "builder-0", 7, null]) {
      expect(isSharedPoolSlotId(id)).toBe(false);
    }
    expect(sharedPoolSlotOrdinal("shared-a")).toBeNull();
  });

  it("orders slots numerically, with any other id after them", () => {
    expect(["shared-b", "shared-10", "shared-2", "shared-a", "shared-0"].sort(compareSharedGatewayIds))
      .toEqual(["shared-0", "shared-2", "shared-10", "shared-a", "shared-b"]);
  });

  it("mints the lowest unused ordinal", () => {
    expect(nextSharedPoolSlotId([])).toBe("shared-0");
    expect(nextSharedPoolSlotId(["shared-0", "shared-1"])).toBe("shared-2");
    expect(nextSharedPoolSlotId(["shared-0", "shared-2", "shared-a"])).toBe("shared-1");
  });
});

describe("deriveSharedGatewayPoolConfig", () => {
  it("derives the pool from Cowboy-managed shared roots only", () => {
    expect(deriveSharedGatewayPoolConfig([
      root("shared-1"),
      root("shared-0", { desiredStatus: "paused" }),
      root("shared-a", { desiredStatus: "draining" }),
      root("bender", { gatewayClass: "builder" }),
      root("shared-2", { managedBy: "operator" }),
      root("shared-3", { desiredStatus: "retired" }),
      root("NOT VALID"),
    ])).toEqual({
      defaultGatewayId: "shared-1",
      sharedGatewayIds: ["shared-1", "shared-0", "shared-a"],
    });
  });

  it("anchors on the first running member in slot order, else the first member", () => {
    expect(deriveSharedGatewayPoolConfig([
      root("shared-2"),
      root("shared-0", { desiredStatus: "paused" }),
    ])?.defaultGatewayId).toBe("shared-2");
    expect(deriveSharedGatewayPoolConfig([
      root("shared-1", { desiredStatus: "paused" }),
      root("shared-0", { desiredStatus: "paused" }),
    ])?.defaultGatewayId).toBe("shared-0");
  });

  it("is null for an empty pool and carries the autoscaling knobs when given", () => {
    expect(deriveSharedGatewayPoolConfig([root("bender", { gatewayClass: "builder" })])).toBeNull();
    expect(deriveSharedGatewayPoolConfig(
      [root("shared-0")],
      { enabled: false, buildersPerGateway: 3 },
    )).toEqual({
      defaultGatewayId: "shared-0",
      sharedGatewayIds: ["shared-0"],
      sharedGatewayAutoscaling: { enabled: false, buildersPerGateway: 3 },
    });
  });
});

describe("parseSharedGatewayPoolConfig", () => {
  it("requires a valid unique pool with the anchor first", () => {
    expect(parseSharedGatewayPoolConfig(config)).toEqual(config);
    expect(parseSharedGatewayPoolConfig({ defaultGatewayId: "shared-0" })).toBeNull();
    expect(parseSharedGatewayPoolConfig({
      defaultGatewayId: "shared-0",
      sharedGatewayIds: ["shared-1", "shared-0"],
    })).toBeNull();
    expect(parseSharedGatewayPoolConfig({
      defaultGatewayId: "shared-0",
      sharedGatewayIds: ["shared-0", "shared-0"],
    })).toBeNull();
    expect(parseSharedGatewayPoolConfig({
      defaultGatewayId: "shared-0",
      sharedGatewayIds: ["shared-0", "NOT VALID"],
    })).toBeNull();
  });
});

describe("scaling configuration", () => {
  it("parses the operator autoscaling knobs with defaults", () => {
    expect(parseSharedGatewayAutoscalingConfig(undefined)).toEqual({
      enabled: true,
      buildersPerGateway: 4,
    });
    expect(parseSharedGatewayAutoscalingConfig({ enabled: false, buildersPerGateway: 2 })).toEqual({
      enabled: false,
      buildersPerGateway: 2,
    });
    expect(parseSharedGatewayAutoscalingConfig({ buildersPerGateway: 1 })).toBeNull();
    expect(parseSharedGatewayAutoscalingConfig({ enabled: "yes" })).toBeNull();
    expect(parseSharedGatewayAutoscalingConfig({ minHotMembers: 2 })).toEqual({
      enabled: true,
      buildersPerGateway: 4,
    });
  });

  it("parses the environment replica bounds", () => {
    expect(parseSharedPoolReplicaBounds({ minReplicas: "0", maxReplicas: "8" })).toEqual({
      minReplicas: 0,
      maxReplicas: 8,
    });
    expect(parseSharedPoolReplicaBounds({ minReplicas: 2, maxReplicas: 2 })).toEqual({
      minReplicas: 2,
      maxReplicas: 2,
    });
    for (const bounds of [
      { minReplicas: "3", maxReplicas: "2" },
      { minReplicas: "-1", maxReplicas: "2" },
      { minReplicas: "0", maxReplicas: "0" },
      { minReplicas: "1.5", maxReplicas: "2" },
      { minReplicas: undefined, maxReplicas: "2" },
    ]) {
      expect(parseSharedPoolReplicaBounds(bounds)).toBeNull();
    }
  });
});

describe("shared gateway selection", () => {
  it("chooses the least authoritative load", () => {
    expect(authoritativeSharedGatewayLoad(candidate("shared-0", {
      assignmentCount: 2,
      incomingMigrationCount: 1,
    }))).toBe(3);
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      candidates: [candidate("shared-0", { assignmentCount: 4 }), candidate("shared-1", { assignmentCount: 2 })],
    })).toMatchObject({ kind: "selected", gatewayId: "shared-1", load: 2 });
  });

  it("uses a stable uid hash to distribute equal loads", () => {
    const candidates = [candidate("shared-0"), candidate("shared-1")];
    const picks = new Set(
      Array.from({ length: 32 }, (_, index) => selectSharedGateway({
        uid: `uid-${index}`,
        config,
        candidates,
      })).map((selection) => selection.kind === "selected" ? selection.gatewayId : null),
    );
    expect(picks).toEqual(new Set(["shared-0", "shared-1"]));
    expect(selectSharedGateway({ uid: "uid-7", config, candidates })).toEqual(
      selectSharedGateway({ uid: "uid-7", config, candidates }),
    );
  });

  it("keeps a healthy current member until its load is more than one above the minimum", () => {
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      currentGatewayId: "shared-0",
      candidates: [candidate("shared-0", { assignmentCount: 3 }), candidate("shared-1", { assignmentCount: 2 })],
    })).toMatchObject({ gatewayId: "shared-0", retainedCurrent: true });
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      currentGatewayId: "shared-0",
      candidates: [candidate("shared-0", { assignmentCount: 4 }), candidate("shared-1", { assignmentCount: 2 })],
    })).toMatchObject({ gatewayId: "shared-1", retainedCurrent: false });
  });

  it("excludes invalid destinations and blocks visibly when none accept", () => {
    for (const overrides of [
      { ready: false },
      { heartbeatFresh: false },
      { managedBy: "operator" },
      { gatewayClass: "builder" },
      { gatewayId: "isolated" },
    ]) {
      expect(isAcceptingSharedGateway(config, candidate("shared-0", overrides))).toBe(false);
    }
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      candidates: [candidate("shared-0", { ready: false })],
    })).toEqual({ kind: "blocked", reason: "no-accepting-shared-gateway" });
  });

  it("uses queued migrations as projected load without rejecting their target", () => {
    expect(selectSharedGateway({
      uid: "uid-alice",
      config,
      candidates: [
        candidate("shared-0", { assignmentCount: 1, incomingMigrationCount: 2 }),
        candidate("shared-1", { assignmentCount: 2 }),
      ],
    })).toMatchObject({ kind: "selected", gatewayId: "shared-1", load: 2 });
  });

  it("plans one recovery rebalance only when the healthy pool differs by two", () => {
    expect(planSharedGatewayRebalance({
      config,
      candidates: [candidate("shared-0", { assignmentCount: 4 }), candidate("shared-1", { assignmentCount: 2 })],
    })).toEqual({ fromGatewayId: "shared-0", toGatewayId: "shared-1" });
    expect(planSharedGatewayRebalance({
      config,
      candidates: [candidate("shared-0", { assignmentCount: 3 }), candidate("shared-1", { assignmentCount: 2 })],
    })).toBeNull();
  });
});
