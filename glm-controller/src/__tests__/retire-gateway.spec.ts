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
    input: { gatewayId: "canary" },
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
  live: Map<string, { mounted: string[]; inFlightJobId: string | null }>;
  glmGatewayIds: Map<string, string>;
  deletedGlm: Set<string>;
  deletedHeartbeat: Set<string>;
  heartbeatPresentAfterDelete?: Set<string>;
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    helmInstances: new Set(),
    live: new Map([["canary", { mounted: [], inFlightJobId: null }]]),
    glmGatewayIds: new Map([["canary", "canary"]]),
    deletedGlm: new Set(),
    deletedHeartbeat: new Set(),
    ...overrides,
  };
}

function makeDeps(state: FakeState, overrides: Partial<RetireGatewayDeps> = {}): RetireGatewayDeps {
  let virtualClock = 0;
  return {
    helm: {
      readDeployedInstances: vi.fn(async () => {
        const m: Record<
          string,
          { enabled: boolean; image: { repository: string; tag: string }; gatewayId: string }
        > = {};
        for (const name of state.helmInstances) {
          m[name] = { enabled: true, image: { repository: "repo", tag: "abc" }, gatewayId: name };
        }
        return m;
      }),
    },
    readGatewayLiveState: vi.fn(async (gatewayId: string) => {
      const live = state.live.get(gatewayId);
      if (!live) return null;
      return { mountedCustomers: live.mounted, inFlightJobId: live.inFlightJobId };
    }),
    readGlmGatewayId: vi.fn(async (gatewayId: string) => state.glmGatewayIds.get(gatewayId) ?? null),
    deleteGlmGateway: vi.fn(async (gatewayId: string) => {
      state.deletedGlm.add(gatewayId);
    }),
    deleteGatewayHeartbeat: vi.fn(async (gatewayId: string) => {
      state.deletedHeartbeat.add(gatewayId);
    }),
    readGatewayHeartbeatExists: vi.fn(
      async (gatewayId: string) => state.heartbeatPresentAfterDelete?.has(gatewayId) ?? false,
    ),
    deleteGatewayPersistentVolumeClaim: vi.fn(async () => {}),
    deleteGatewayKubeSecret: vi.fn(async () => {}),
    deleteAuthTokenSecret: vi.fn(async () => {}),
    teardownGatewayServiceAccount: vi.fn(async () => {}),
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

describe("createRetireGatewayHandler — teardown completeness (happy path)", () => {
  it("uninstalls, then deletes PVC + K8s secret + SM secret + GSA by default, then records + ingress", async () => {
    const state = baseState();
    const deps = makeDeps(state);
    const ctx = makeCtx();

    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(deps.deleteGatewayPersistentVolumeClaim).toHaveBeenCalledWith("canary");
    expect(deps.deleteGatewayKubeSecret).toHaveBeenCalledWith("canary");
    expect(deps.deleteAuthTokenSecret).toHaveBeenCalledWith("canary");
    expect(deps.teardownGatewayServiceAccount).toHaveBeenCalledWith("canary");
    expect(state.deletedGlm.has("canary")).toBe(true);
    expect(state.deletedHeartbeat.has("canary")).toBe(true);
    expect(ctx.reported.map((s) => `${s.name}:${s.status}`)).toEqual([
      "helm-uninstall:running",
      "helm-uninstall:done",
      "delete-pvc:running",
      "delete-pvc:done",
      "delete-kube-secret:running",
      "delete-kube-secret:done",
      "delete-sm-secret:running",
      "delete-sm-secret:done",
      "teardown-gsa:running",
      "teardown-gsa:done",
      "cleanup:running",
      "cleanup:done",
      "heartbeat-quiesce:running",
      "heartbeat-quiesce:done",
      "fleet-ingress:running",
      "fleet-ingress:done",
    ]);
  });

  it("retainData=true preserves the PVC (skips delete-pvc) but still deletes both secrets", async () => {
    const state = baseState();
    const deps = makeDeps(state);
    const ctx = makeCtx();

    const result = await createRetireGatewayHandler(deps)(
      mkOp({ input: { gatewayId: "canary", retainData: true } }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(deps.deleteGatewayPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(deps.deleteGatewayKubeSecret).toHaveBeenCalledWith("canary");
    expect(deps.deleteAuthTokenSecret).toHaveBeenCalledWith("canary");
    expect(ctx.reported.some((s) => s.name === "delete-pvc")).toBe(false);
  });

  it("no-ops GSA teardown when no teardownGatewayServiceAccount dep is wired", async () => {
    const state = baseState();
    const deps = makeDeps(state, { teardownGatewayServiceAccount: undefined });
    const ctx = makeCtx();

    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(ctx.reported.some((s) => s.name === "teardown-gsa")).toBe(false);
  });

  it("calls syncFleetIngress exactly once after teardown + records succeed", async () => {
    const state = baseState();
    const sync = vi.fn(async () => {});
    const deps = makeDeps(state, { syncFleetIngress: sync });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe("createRetireGatewayHandler — independent best-effort teardown (D4)", () => {
  it("attempts every teardown step even when one throws, fails the op, preserves records for retry", async () => {
    const state = baseState();
    const deps = makeDeps(state, {
      deleteGatewayKubeSecret: vi.fn(async () => {
        throw new Error("kubectl secret denied");
      }),
    });
    const ctx = makeCtx();

    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/teardown incomplete/);
    expect(result.error).toMatch(/kubectl secret denied/);
    // Every other teardown step is still attempted — one failure does not abort the rest.
    expect(deps.deleteGatewayPersistentVolumeClaim).toHaveBeenCalled();
    expect(deps.deleteAuthTokenSecret).toHaveBeenCalled();
    expect(deps.teardownGatewayServiceAccount).toHaveBeenCalled();
    // Records preserved so the operation stays re-drivable.
    expect(state.deletedGlm.size).toBe(0);
    expect(state.deletedHeartbeat.size).toBe(0);
    const failed = ctx.reported.find((s) => s.status === "failed");
    expect(failed?.name).toBe("delete-kube-secret");
  });

  it("aggregates multiple teardown failures into one error", async () => {
    const state = baseState();
    const deps = makeDeps(state, {
      deleteGatewayPersistentVolumeClaim: vi.fn(async () => {
        throw new Error("pvc stuck");
      }),
      deleteAuthTokenSecret: vi.fn(async () => {
        throw new Error("sm denied");
      }),
    });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pvc stuck/);
    expect(result.error).toMatch(/sm denied/);
  });

  it("GSA teardown failure aggregate-gates the op — a stranded IAM principal is not silently OK", async () => {
    const state = baseState();
    const deps = makeDeps(state, {
      teardownGatewayServiceAccount: vi.fn(async () => {
        throw new Error("iam denied");
      }),
    });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/teardown incomplete/);
    expect(result.error).toMatch(/teardown-gsa: iam denied/);
    // Records preserved so the op is re-drivable once the GSA is cleared.
    expect(state.deletedGlm.size).toBe(0);
  });

  it("retainServiceAccount=true skips GSA teardown (terraform-managed GSA), op succeeds", async () => {
    const state = baseState();
    const teardownGsa = vi.fn(async () => {
      throw new Error("would fail if called");
    });
    const deps = makeDeps(state, { teardownGatewayServiceAccount: teardownGsa });

    const result = await createRetireGatewayHandler(deps)(
      mkOp({ input: { gatewayId: "canary", retainServiceAccount: true } }),
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(teardownGsa).not.toHaveBeenCalled();
    expect(state.deletedGlm.has("canary")).toBe(true);
  });

  it("fails the op when fleet-ingress sync throws — records already done, failed step reported", async () => {
    const state = baseState();
    const deps = makeDeps(state, {
      syncFleetIngress: vi.fn(async () => {
        throw new Error("kubectl apply denied");
      }),
    });
    const ctx = makeCtx();

    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/kubectl apply denied/);
    expect(state.deletedGlm.has("canary")).toBe(true);
    expect(state.deletedHeartbeat.has("canary")).toBe(true);
    const failedStep = ctx.reported.find((s) => s.status === "failed");
    expect(failedStep?.name).toBe("fleet-ingress");
  });

  it("waits through pre-uninstall polls until helm removes the instance", async () => {
    const state = baseState({ helmInstances: new Set(["canary"]) });
    let polls = 0;
    const deps = makeDeps(state, {
      wait: vi.fn(async (_ms: number) => {
        polls++;
        if (polls === 2) state.helmInstances.delete("canary");
      }),
    });

    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(true);
  });
});

describe("createRetireGatewayHandler — refusals + edge cases", () => {
  it("refuses when the gateway still has mounted customers (nothing torn down)", async () => {
    const state = baseState({
      helmInstances: new Set(["canary"]),
      live: new Map([["canary", { mounted: ["alice", "bob"], inFlightJobId: null }]]),
    });
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/still has 2 mounted/);
    expect(deps.deleteGatewayPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(deps.deleteAuthTokenSecret).not.toHaveBeenCalled();
    expect(state.deletedGlm.size).toBe(0);
  });

  it("refuses when an in-flight restore job is set on the heartbeat (mid-mount)", async () => {
    const state = baseState({
      helmInstances: new Set(["canary"]),
      live: new Map([["canary", { mounted: [], inFlightJobId: "job-restore-7" }]]),
    });
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/in-flight restore job job-restore-7/);
    expect(deps.deleteAuthTokenSecret).not.toHaveBeenCalled();
    expect(state.deletedGlm.size).toBe(0);
  });

  it("proceeds with retire when heartbeat doc is missing (stranded crash-loop case)", async () => {
    const state = baseState({ live: new Map() });
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(true);
    expect(state.deletedGlm.has("canary")).toBe(true);
    expect(state.deletedHeartbeat.has("canary")).toBe(true);
    expect(deps.deleteGatewayPersistentVolumeClaim).toHaveBeenCalledWith("canary");
  });

  it("refuses when glmGateways doc is missing (cannot determine gatewayId)", async () => {
    const state = baseState({ glmGatewayIds: new Map() });
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/glmGateways.*not found|gatewayId/);
  });

  it("refuses teardown when the resolved gatewayId mismatches the input id (no destructive work)", async () => {
    const state = baseState({ glmGatewayIds: new Map([["canary", "other"]]) });
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp(), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mismatched id/);
    expect(deps.deleteGatewayPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(deps.deleteAuthTokenSecret).not.toHaveBeenCalled();
    expect(state.deletedGlm.size).toBe(0);
  });

  it("rejects a structurally-invalid gatewayId before any teardown", async () => {
    const state = baseState();
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(
      mkOp({ input: { gatewayId: "Bad ID!" } }),
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid gatewayId/);
    expect(deps.deleteGatewayPersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it("returns failure when op.input is missing gatewayId", async () => {
    const state = baseState({ live: new Map(), glmGatewayIds: new Map() });
    const deps = makeDeps(state);
    const result = await createRetireGatewayHandler(deps)(mkOp({ input: {} }), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/gatewayId/);
  });
});

describe("createRetireGatewayHandler — failures", () => {
  it("times out helm-uninstall and reports the failure step when helm never removes the instance", async () => {
    const state = baseState({ helmInstances: new Set(["canary"]) });
    const deps = makeDeps(state, { helmUninstallTimeoutMs: 5_000, pollIntervalMs: 1_000 });
    const ctx = makeCtx();
    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/did not uninstall|timeout/i);
    const failed = ctx.reported.find((s) => s.status === "failed");
    expect(failed?.name).toBe("helm-uninstall");
    // No teardown attempted when the workload won't stop.
    expect(deps.deleteAuthTokenSecret).not.toHaveBeenCalled();
    expect(state.deletedGlm.size).toBe(0);
  });
});

describe("createRetireGatewayHandler — P2 heartbeat-quiesce", () => {
  it("re-deletes the heartbeat doc when a pod's late write resurrected it after cleanup", async () => {
    const state = baseState({ heartbeatPresentAfterDelete: new Set(["canary"]) });
    const deps = makeDeps(state);
    const ctx = makeCtx();
    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);
    expect(result.success).toBe(true);
    expect(deps.deleteGatewayHeartbeat).toHaveBeenCalledTimes(2);
    const quiesceFinal = ctx.reported.filter((s) => s.name === "heartbeat-quiesce").at(-1);
    expect(quiesceFinal?.status).toBe("done");
  });

  it("skips the re-delete when heartbeat stays gone after cleanup (happy path, no zombie)", async () => {
    const state = baseState();
    const deps = makeDeps(state);
    const ctx = makeCtx();
    const result = await createRetireGatewayHandler(deps)(mkOp(), ctx);
    expect(result.success).toBe(true);
    expect(deps.deleteGatewayHeartbeat).toHaveBeenCalledTimes(1);
    const quiesceFinal = ctx.reported.filter((s) => s.name === "heartbeat-quiesce").at(-1);
    expect(quiesceFinal?.status).toBe("done");
  });
});
