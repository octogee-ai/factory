import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "../../../shared/types/glm";
import { createAddGatewayHandler } from "../handlers/add-gateway";
import type { AddGatewayDeps } from "../handlers/add-gateway";
import type { OperationContext } from "../operation-router";

function mkOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-1",
    kind: "add-gateway",
    status: "pending",
    createdBy: "admin@octogee.com",
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    input: { gatewayId: "gw-test-canary", instanceName: "canary", imageTag: "abc1234" },
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
  deployments: Set<string>;
  heartbeats: Map<string, number>;
}

function makeDeps(
  state: FakeState,
  overrides: Partial<AddGatewayDeps> = {},
): AddGatewayDeps {
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
    kubeOps: {
      readDeployedReplicas: vi.fn(async ({ name }: { namespace: string; name: string }) => {
        return state.deployments.has(name) ? 1 : null;
      }),
    },
    readGatewayHeartbeat: vi.fn(async (gatewayId: string) => {
      const ts = state.heartbeats.get(gatewayId);
      return ts == null ? null : { lastHeartbeatAt: ts };
    }),
    syncFleetIngress: vi.fn(async () => {}),
    helmRenderTimeoutMs: 60_000,
    deploymentCreatedTimeoutMs: 240_000,
    heartbeatTimeoutMs: 240_000,
    pollIntervalMs: 1_000,
    now: () => virtualClock,
    wait: vi.fn(async (ms: number) => {
      virtualClock += ms;
    }),
    log: vi.fn(),
    ...overrides,
  };
}

describe("createAddGatewayHandler — happy path", () => {
  it("succeeds when helm renders the instance and the gateway heartbeats within budget", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      deployments: new Set(["octogee-gateway-canary"]),
      heartbeats: new Map([["gw-test-canary", 1]]),
    };
    const deps = makeDeps(state);
    const handler = createAddGatewayHandler(deps);
    const ctx = makeCtx();

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(true);
    expect(ctx.reported.map((s) => `${s.name}:${s.status}`)).toEqual([
      "helm-render:running",
      "helm-render:done",
      "deployment-created:running",
      "deployment-created:done",
      "gateway-heartbeat:running",
      "gateway-heartbeat:done",
      "fleet-ingress:running",
      "fleet-ingress:done",
    ]);
  });

  it("calls syncFleetIngress exactly once after the heartbeat step succeeds", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      deployments: new Set(["octogee-gateway-canary"]),
      heartbeats: new Map([["gw-test-canary", 1]]),
    };
    const sync = vi.fn(async () => {});
    const deps = makeDeps(state, { syncFleetIngress: sync });
    const handler = createAddGatewayHandler(deps);
    const result = await handler(mkOp({}), makeCtx());
    expect(result.success).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("waits through pre-render polls and succeeds once helm picks up the new instance", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      deployments: new Set(["octogee-gateway-canary"]),
      heartbeats: new Map([["gw-test-canary", 1]]),
    };
    let polls = 0;
    const deps = makeDeps(state, {
      wait: vi.fn(async (_ms: number) => {
        polls++;
        if (polls === 3) {
          state.helmInstances.add("canary");
        }
      }),
    });
    const handler = createAddGatewayHandler(deps);
    const ctx = makeCtx();
    const result = await handler(mkOp({}), ctx);
    expect(result.success).toBe(true);
  });

  it("does not spend heartbeat budget before Kubernetes creates the deployment", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      deployments: new Set(),
      heartbeats: new Map(),
    };
    let virtualClock = 0;
    const deps = makeDeps(state, {
      deploymentCreatedTimeoutMs: 300_000,
      heartbeatTimeoutMs: 20_000,
      wait: vi.fn(async (ms: number) => {
        virtualClock += ms;
        if (virtualClock >= 240_000) {
          state.deployments.add("octogee-gateway-canary");
        }
        if (virtualClock >= 250_000) {
          state.heartbeats.set("gw-test-canary", virtualClock);
        }
      }),
      now: () => virtualClock,
    });

    const result = await createAddGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(true);
    expect(deps.kubeOps.readDeployedReplicas).toHaveBeenCalled();
  });
});

describe("createAddGatewayHandler — failures", () => {
  it("fails with helm-render timeout when the instance never appears in the helm map", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      deployments: new Set(["octogee-gateway-canary"]),
      heartbeats: new Map([["gw-test-canary", 1]]),
    };
    const deps = makeDeps(state, {
      helmRenderTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    const handler = createAddGatewayHandler(deps);
    const ctx = makeCtx();
    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/helm[-\s]render.*timeout|did not.*render/i);
    const failedStep = ctx.reported.find((s) => s.status === "failed");
    expect(failedStep?.name).toBe("helm-render");
  });

  it("fails with deployment-created timeout when Helm has not created the deployment", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      deployments: new Set(),
      heartbeats: new Map([["gw-test-canary", 1]]),
    };
    const deps = makeDeps(state, {
      deploymentCreatedTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    const ctx = makeCtx();
    const result = await createAddGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/deployment.*not created/i);
    const failedStep = ctx.reported.find((s) => s.status === "failed");
    expect(failedStep?.name).toBe("deployment-created");
  });

  it("fails with heartbeat timeout when helm renders but the pod never heartbeats", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      deployments: new Set(["octogee-gateway-canary"]),
      heartbeats: new Map(),
    };
    const deps = makeDeps(state, {
      heartbeatTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    const handler = createAddGatewayHandler(deps);
    const ctx = makeCtx();
    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/heartbeat.*timeout|never.*heartbeat/i);
    const failedStep = ctx.reported.find((s) => s.status === "failed");
    expect(failedStep?.name).toBe("gateway-heartbeat");
  });

  it("returns failure with explicit error when op.input is missing gatewayId", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      deployments: new Set(),
      heartbeats: new Map(),
    };
    const deps = makeDeps(state);
    const handler = createAddGatewayHandler(deps);
    const ctx = makeCtx();
    const result = await handler(mkOp({ input: { instanceName: "canary", imageTag: "abc" } }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/gatewayId/i);
  });

  it("returns failure with explicit error when op.input is missing instanceName", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      deployments: new Set(),
      heartbeats: new Map(),
    };
    const deps = makeDeps(state);
    const handler = createAddGatewayHandler(deps);
    const ctx = makeCtx();
    const result = await handler(mkOp({ input: { gatewayId: "gw-test-canary", imageTag: "abc" } }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/instanceName/i);
  });

  it("fails the operation when fleet-ingress sync throws — surfaces the error and reports a failed step", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      deployments: new Set(["octogee-gateway-canary"]),
      heartbeats: new Map([["gw-test-canary", 1]]),
    };
    const deps = makeDeps(state, {
      syncFleetIngress: vi.fn(async () => {
        throw new Error("kubectl apply denied");
      }),
    });
    const handler = createAddGatewayHandler(deps);
    const ctx = makeCtx();
    const result = await handler(mkOp({}), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/kubectl apply denied/);
    const failedStep = ctx.reported.find((s) => s.status === "failed");
    expect(failedStep?.name).toBe("fleet-ingress");
  });
});
