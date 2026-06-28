import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
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
    input: { gatewayId: "canary", imageTag: "abc1234" },
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
  helmImageTags?: Map<string, string>;
  availableReplicas: Map<string, number>;
  heartbeats: Map<string, number | { lastHeartbeatAt: number; version?: string | null }>;
  platformReady: Set<string>;
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
            image: { repository: "repo", tag: state.helmImageTags?.get(name) ?? "abc1234" },
            gatewayId: name,
          };
        }
        return m;
      }),
    },
    kubeOps: {
      readAvailableReplicas: vi.fn(async ({ name }: { namespace: string; name: string }) => {
        return state.availableReplicas.get(name) ?? null;
      }),
    },
    readGatewayHeartbeat: vi.fn(async (gatewayId: string) => {
      const ts = state.heartbeats.get(gatewayId);
      return typeof ts === "number" ? { lastHeartbeatAt: ts, version: "abc1234" } : ts ?? null;
    }),
    publishGatewayReady: vi.fn(async ({ gatewayId }: { gatewayId: string }) => {
      state.platformReady.add(gatewayId);
    }),
    syncFleetIngress: vi.fn(async () => {}),
    helmRenderTimeoutMs: 60_000,
    deploymentReadyTimeoutMs: 240_000,
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
      availableReplicas: new Map([["octogee-gateway-canary", 1]]),
      heartbeats: new Map([["canary", 1]]),
      platformReady: new Set(),
    };
    const deps = makeDeps(state);
    const handler = createAddGatewayHandler(deps);
    const ctx = makeCtx();

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(true);
    expect(ctx.reported.map((s) => `${s.name}:${s.status}`)).toEqual([
      "helm-render:running",
      "helm-render:done",
      "deployment-ready:running",
      "deployment-ready:done",
      "gateway-heartbeat:running",
      "gateway-heartbeat:done",
      "fleet-ingress:running",
      "fleet-ingress:done",
    ]);
  });

  it("calls syncFleetIngress exactly once after the heartbeat step succeeds", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      availableReplicas: new Map([["octogee-gateway-canary", 1]]),
      heartbeats: new Map([["canary", 1]]),
      platformReady: new Set(),
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
      availableReplicas: new Map([["octogee-gateway-canary", 1]]),
      heartbeats: new Map([["canary", 1]]),
      platformReady: new Set(),
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

  it("waits for the requested image tag when reusing an existing sibling release", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      helmImageTags: new Map([["canary", "old"]]),
      availableReplicas: new Map([["octogee-gateway-canary", 1]]),
      heartbeats: new Map([["canary", { lastHeartbeatAt: 1, version: "new" }]]),
      platformReady: new Set(),
    };
    let polls = 0;
    const deps = makeDeps(state, {
      wait: vi.fn(async () => {
        polls++;
        if (polls === 2) {
          state.helmImageTags?.set("canary", "new");
        }
      }),
    });

    const result = await createAddGatewayHandler(deps)(
      mkOp({ input: { gatewayId: "canary", imageTag: "new" } }),
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(deps.helm.readDeployedInstances).toHaveBeenCalledTimes(3);
  });

  it("does not spend heartbeat budget before Kubernetes reports the deployment available", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      availableReplicas: new Map(),
      heartbeats: new Map(),
      platformReady: new Set(),
    };
    let virtualClock = 0;
    const deps = makeDeps(state, {
      deploymentReadyTimeoutMs: 300_000,
      heartbeatTimeoutMs: 20_000,
      wait: vi.fn(async (ms: number) => {
        virtualClock += ms;
        if (virtualClock >= 240_000) {
          state.availableReplicas.set("octogee-gateway-canary", 1);
        }
        if (virtualClock >= 250_000) {
          state.heartbeats.set("canary", virtualClock);
        }
      }),
      now: () => virtualClock,
    });

    const result = await createAddGatewayHandler(deps)(mkOp(), makeCtx());

    expect(result.success).toBe(true);
    expect(deps.kubeOps.readAvailableReplicas).toHaveBeenCalled();
  });

  it("publishes the platform-owned ready record instead of waiting for self-heartbeat on operator gateways", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      availableReplicas: new Map([["octogee-gateway-canary", 1]]),
      heartbeats: new Map(),
      platformReady: new Set(),
    };
    const deps = makeDeps(state);
    const ctx = makeCtx();

    const result = await createAddGatewayHandler(deps)(
      mkOp({ input: { gatewayId: "canary", imageTag: "abc1234", profile: "operator" } }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(state.platformReady.has("canary")).toBe(true);
    expect(deps.readGatewayHeartbeat).not.toHaveBeenCalled();
    expect(ctx.reported.map((s) => `${s.name}:${s.status}`)).toEqual([
      "helm-render:running",
      "helm-render:done",
      "deployment-ready:running",
      "deployment-ready:done",
      "platform-ready-record:running",
      "platform-ready-record:done",
      "fleet-ingress:running",
      "fleet-ingress:done",
    ]);
  });

  it("waits for self-heartbeat on builder-class gateways", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      availableReplicas: new Map([["octogee-gateway-canary", 1]]),
      heartbeats: new Map([["canary", 1]]),
      platformReady: new Set(),
    };
    const deps = makeDeps(state);
    const ctx = makeCtx();

    const result = await createAddGatewayHandler(deps)(
      mkOp({ input: { gatewayId: "canary", imageTag: "abc1234", gatewayClass: "builder" } }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(state.platformReady.has("canary")).toBe(false);
    expect(deps.readGatewayHeartbeat).toHaveBeenCalledWith("canary");
    expect(ctx.reported.map((s) => `${s.name}:${s.status}`)).toEqual([
      "helm-render:running",
      "helm-render:done",
      "deployment-ready:running",
      "deployment-ready:done",
      "gateway-heartbeat:running",
      "gateway-heartbeat:done",
      "fleet-ingress:running",
      "fleet-ingress:done",
    ]);
  });

  it("waits for a heartbeat from the requested image instead of accepting a stale sibling heartbeat", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      helmImageTags: new Map([["canary", "new"]]),
      availableReplicas: new Map([["octogee-gateway-canary", 1]]),
      heartbeats: new Map([["canary", { lastHeartbeatAt: 1, version: "old" }]]),
      platformReady: new Set(),
    };
    let polls = 0;
    const deps = makeDeps(state, {
      wait: vi.fn(async () => {
        polls++;
        if (polls === 2) {
          state.heartbeats.set("canary", { lastHeartbeatAt: 2, version: "new" });
        }
      }),
    });

    const result = await createAddGatewayHandler(deps)(
      mkOp({ input: { gatewayId: "canary", imageTag: "new" } }),
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(deps.readGatewayHeartbeat).toHaveBeenCalledTimes(3);
  });
});

describe("createAddGatewayHandler — failures", () => {
  it("fails with helm-render timeout when the instance never appears in the helm map", async () => {
    const state: FakeState = {
      helmInstances: new Set(),
      availableReplicas: new Map([["octogee-gateway-canary", 1]]),
      heartbeats: new Map([["canary", 1]]),
      platformReady: new Set(),
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

  it("fails with deployment-ready timeout when Helm has not made the deployment available", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      availableReplicas: new Map(),
      heartbeats: new Map([["canary", 1]]),
      platformReady: new Set(),
    };
    const deps = makeDeps(state, {
      deploymentReadyTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    const ctx = makeCtx();
    const result = await createAddGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/deployment.*available/i);
    const failedStep = ctx.reported.find((s) => s.status === "failed");
    expect(failedStep?.name).toBe("deployment-ready");
  });

  it("fails with heartbeat timeout when helm renders but the pod never heartbeats", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      availableReplicas: new Map([["octogee-gateway-canary", 1]]),
      heartbeats: new Map(),
      platformReady: new Set(),
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
      availableReplicas: new Map(),
      heartbeats: new Map(),
      platformReady: new Set(),
    };
    const deps = makeDeps(state);
    const handler = createAddGatewayHandler(deps);
    const ctx = makeCtx();
    const result = await handler(mkOp({ input: { imageTag: "abc" } }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/gatewayId/i);
  });

  it("fails the operation when fleet-ingress sync throws — surfaces the error and reports a failed step", async () => {
    const state: FakeState = {
      helmInstances: new Set(["canary"]),
      availableReplicas: new Map([["octogee-gateway-canary", 1]]),
      heartbeats: new Map([["canary", 1]]),
      platformReady: new Set(),
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
