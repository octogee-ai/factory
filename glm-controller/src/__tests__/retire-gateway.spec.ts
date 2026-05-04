import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "../../../shared/types/glm";
import { createRetireGatewayHandler } from "../handlers/retire-gateway";
import type { RetireGatewayDeps } from "../handlers/retire-gateway";
import type { OperationContext } from "../operation-router";

function mkOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-r-1",
    kind: "retire-gateway",
    status: "pending",
    createdBy: "admin@octogee.com",
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    input: { gatewayId: "gw-test-canary" },
    steps: [],
    ...overrides,
  };
}

function makeCtx(): OperationContext & { reported: OperationStep[] } {
  const reported: OperationStep[] = [];
  return {
    reportStep: vi.fn(async (s: OperationStep) => {
      reported.push(s);
    }),
    reported,
  };
}

interface FakeState {
  helmInstances: Set<string>;
  /** Per-gatewayId live state. `undefined` (Map.get returns undefined) = no heartbeat. */
  live: Map<string, { mounted: string[]; inFlightJobId: string | null }>;
  glmInstanceNames: Map<string, string>;
  deletedGlm: Set<string>;
  deletedHeartbeat: Set<string>;
  archivedSecret: Set<string>;
}

function makeDeps(state: FakeState, overrides: Partial<RetireGatewayDeps> = {}): RetireGatewayDeps {
  let virtualClock = 0;
  return {
    helm: {
      readDeployedInstances: vi.fn(async () => {
        const m: Record<string, { enabled: boolean; image: { repository: string; tag: string }; gatewayId: string }> = {};
        for (const name of state.helmInstances) {
          m[name] = {
            enabled: true,
            image: { repository: "repo", tag: "abc" },
            gatewayId: name === "canary" ? "gw-test-canary" : `gw-test-${name}`,
          };
        }
        return m;
      }),
    },
    readGatewayLiveState: vi.fn(async (gatewayId: string) => {
      const live = state.live.get(gatewayId);
      if (!live) return null;
      return { mountedCustomers: live.mounted, inFlightJobId: live.inFlightJobId };
    }),
    readGlmGatewayInstanceName: vi.fn(async (gatewayId: string) => {
      return state.glmInstanceNames.get(gatewayId) ?? null;
    }),
    deleteGlmGateway: vi.fn(async (gatewayId: string) => {
      state.deletedGlm.add(gatewayId);
    }),
    deleteGatewayHeartbeat: vi.fn(async (gatewayId: string) => {
      state.deletedHeartbeat.add(gatewayId);
    }),
    archiveAuthTokenSecret: vi.fn(async (gatewayId: string) => {
      state.archivedSecret.add(gatewayId);
    }),
    helmUninstallTimeoutMs: 60_000,
    pollIntervalMs: 1_000,
    now: () => virtualClock,
    wait: vi.fn(async (ms: number) => {
      virtualClock += ms;
    }),
    log: vi.fn(),
    ...overrides,
  };
}

describe("createRetireGatewayHandler — happy path", () => {
  it("waits for helm uninstall, then deletes glmGateways + heartbeat (and archives SM if provided)", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      live: new Map([["gw-test-canary", { mounted: [], inFlightJobId: null }]]),
      glmInstanceNames: new Map([["gw-test-canary", "canary"]]),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
    };
    const deps = makeDeps(state);
    const handler = createRetireGatewayHandler(deps);
    const ctx = makeCtx();

    const result = await handler(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(state.deletedGlm.has("gw-test-canary")).toBe(true);
    expect(state.deletedHeartbeat.has("gw-test-canary")).toBe(true);
    expect(state.archivedSecret.has("gw-test-canary")).toBe(true);
    expect(ctx.reported.map((s) => `${s.name}:${s.status}`)).toEqual([
      "helm-uninstall:running",
      "helm-uninstall:done",
      "cleanup:running",
      "cleanup:done",
    ]);
  });

  it("skips SM secret archive when no archiveAuthTokenSecret is provided", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      live: new Map([["gw-test-canary", { mounted: [], inFlightJobId: null }]]),
      glmInstanceNames: new Map([["gw-test-canary", "canary"]]),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
    };
    const deps = makeDeps(state, { archiveAuthTokenSecret: undefined });
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(true);
    expect(state.deletedGlm.has("gw-test-canary")).toBe(true);
    expect(state.archivedSecret.size).toBe(0);
  });

  it("waits through pre-uninstall polls until helm removes the instance", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      live: new Map([["gw-test-canary", { mounted: [], inFlightJobId: null }]]),
      glmInstanceNames: new Map([["gw-test-canary", "canary"]]),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
    };
    let polls = 0;
    const deps = makeDeps(state, {
      wait: vi.fn(async (_ms: number) => {
        polls++;
        if (polls === 2) state.helmInstances.delete("canary");
      }),
    });
    const handler = createRetireGatewayHandler(deps);
    const result = await handler(mkOp(), makeCtx());
    expect(result.success).toBe(true);
  });
});

describe("createRetireGatewayHandler — refusals + edge cases", () => {
  it("refuses when the gateway still has mounted customers", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      live: new Map([["gw-test-canary", { mounted: ["alice", "bob"], inFlightJobId: null }]]),
      glmInstanceNames: new Map([["gw-test-canary", "canary"]]),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
    };
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/still has 2 mounted/);
    expect(state.deletedGlm.size).toBe(0);
    expect(state.deletedHeartbeat.size).toBe(0);
    expect(state.archivedSecret.size).toBe(0);
  });

  it("refuses when an in-flight restore job is set on the heartbeat (mid-mount)", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      live: new Map([
        ["gw-test-canary", { mounted: [], inFlightJobId: "job-restore-7" }],
      ]),
      glmInstanceNames: new Map([["gw-test-canary", "canary"]]),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
    };
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/in-flight restore job job-restore-7/);
    expect(state.deletedGlm.size).toBe(0);
    expect(state.deletedHeartbeat.size).toBe(0);
    expect(state.archivedSecret.size).toBe(0);
  });

  it("proceeds with retire when heartbeat doc is missing (stranded crash-loop case)", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      live: new Map(),
      glmInstanceNames: new Map([["gw-test-canary", "canary"]]),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
    };
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(true);
    expect(state.deletedGlm.has("gw-test-canary")).toBe(true);
    expect(state.deletedHeartbeat.has("gw-test-canary")).toBe(true);
  });

  it("refuses when glmGateways doc is missing (cannot determine instanceName)", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      live: new Map([["gw-test-canary", { mounted: [], inFlightJobId: null }]]),
      glmInstanceNames: new Map(),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
    };
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/glmGateways.*not found|instanceName/);
  });

  it("returns failure when op.input is missing gatewayId", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      live: new Map(),
      glmInstanceNames: new Map(),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
    };
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp({ input: {} }), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/gatewayId/);
  });
});

describe("createRetireGatewayHandler — failures", () => {
  it("times out helm-uninstall and reports the failure step when helm never removes the instance", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      live: new Map([["gw-test-canary", { mounted: [], inFlightJobId: null }]]),
      glmInstanceNames: new Map([["gw-test-canary", "canary"]]),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
    };
    const deps = makeDeps(state, { helmUninstallTimeoutMs: 5_000, pollIntervalMs: 1_000 });
    const ctx = makeCtx();
    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/did not uninstall|timeout/i);
    const failed = ctx.reported.find((s) => s.status === "failed");
    expect(failed?.name).toBe("helm-uninstall");
    expect(state.deletedGlm.size).toBe(0);
  });
});
