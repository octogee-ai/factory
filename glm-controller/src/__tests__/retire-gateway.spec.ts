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
  /**
   * Test seam for the P2 quiesce step: gatewayIds whose heartbeat doc
   * "comes back" after the cleanup delete (simulating a pod's last
   * heartbeat write landing post-delete). The handler is expected to
   * detect this on its re-check and delete again.
   */
  heartbeatPresentAfterDelete?: Set<string>;
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
    readGatewayHeartbeatExists: vi.fn(async (gatewayId: string) => {
      return state.heartbeatPresentAfterDelete?.has(gatewayId) ?? false;
    }),
    archiveAuthTokenSecret: vi.fn(async (gatewayId: string) => {
      state.archivedSecret.add(gatewayId);
    }),
    syncFleetIngress: vi.fn(async () => {}),
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
      "heartbeat-quiesce:running",
      "heartbeat-quiesce:done",
      "fleet-ingress:running",
      "fleet-ingress:done",
    ]);
  });

  it("calls syncFleetIngress exactly once after cleanup succeeds", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      live: new Map([["gw-test-canary", { mounted: [], inFlightJobId: null }]]),
      glmInstanceNames: new Map([["gw-test-canary", "canary"]]),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
    };
    const sync = vi.fn(async () => {});
    const deps = makeDeps(state, { syncFleetIngress: sync });
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("fails the operation when fleet-ingress sync throws — reports a failed step but cleanup is already done", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      live: new Map([["gw-test-canary", { mounted: [], inFlightJobId: null }]]),
      glmInstanceNames: new Map([["gw-test-canary", "canary"]]),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
    };
    const deps = makeDeps(state, {
      syncFleetIngress: vi.fn(async () => {
        throw new Error("kubectl apply denied");
      }),
    });
    const ctx = makeCtx();
    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/kubectl apply denied/);
    // Cleanup must have already succeeded — failure here doesn't roll back the deletes
    expect(state.deletedGlm.has("gw-test-canary")).toBe(true);
    expect(state.deletedHeartbeat.has("gw-test-canary")).toBe(true);
    const failedStep = ctx.reported.find((s) => s.status === "failed");
    expect(failedStep?.name).toBe("fleet-ingress");
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

describe("createRetireGatewayHandler — P2 heartbeat-quiesce", () => {
  it("re-deletes the heartbeat doc when a pod's late write resurrected it after cleanup", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      live: new Map([["gw-test-canary", { mounted: [], inFlightJobId: null }]]),
      glmInstanceNames: new Map([["gw-test-canary", "canary"]]),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
      // Pod sent a final heartbeat in its SIGTERM handler that landed
      // AFTER the cleanup delete — Firestore re-created the doc. The
      // handler should re-delete on the post-cleanup verification pass.
      heartbeatPresentAfterDelete: new Set(["gw-test-canary"]),
    };
    const deps = makeDeps(state);
    const ctx = makeCtx();
    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);
    expect(result.success).toBe(true);
    // Two delete calls: cleanup's initial + heartbeat-quiesce's re-delete.
    expect(deps.deleteGatewayHeartbeat).toHaveBeenCalledTimes(2);
    const quiesceFinal = ctx.reported
      .filter((s) => s.name === "heartbeat-quiesce")
      .at(-1);
    expect(quiesceFinal?.status).toBe("done");
  });

  it("skips the re-delete when heartbeat stays gone after cleanup (happy path, no zombie)", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      live: new Map([["gw-test-canary", { mounted: [], inFlightJobId: null }]]),
      glmInstanceNames: new Map([["gw-test-canary", "canary"]]),
      deletedGlm: new Set(),
      deletedHeartbeat: new Set(),
      archivedSecret: new Set(),
      // No resurrection — readGatewayHeartbeatExists returns false on re-check.
    };
    const deps = makeDeps(state);
    const ctx = makeCtx();
    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);
    expect(result.success).toBe(true);
    expect(deps.deleteGatewayHeartbeat).toHaveBeenCalledTimes(1);
    const quiesceFinal = ctx.reported
      .filter((s) => s.name === "heartbeat-quiesce")
      .at(-1);
    expect(quiesceFinal?.status).toBe("done");
  });
});
