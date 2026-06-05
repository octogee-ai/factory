import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "../../../shared/types/glm";
import { createRestartGatewayHandler } from "../handlers/restart-gateway";
import type { RestartGatewayDeps } from "../handlers/restart-gateway";
import type { OperationContext } from "../operation-router";

function mkOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-restart-1",
    kind: "restart-gateway",
    status: "pending",
    createdBy: "admin@octogee.com",
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    input: { gatewayId: "bender" },
    steps: [],
    ...overrides,
  };
}

function mkCtx() {
  const reported: OperationStep[] = [];
  const ctx: OperationContext = {
    reportStep: async (step) => {
      reported.push(step);
    },
  };
  return { ctx, reported };
}

function mkDeps(overrides: Partial<RestartGatewayDeps> = {}): RestartGatewayDeps {
  return {
    kubeOps: {
      scaleDeployment: vi.fn(async () => undefined),
      restartOpenClawInPlace: vi.fn(async () => undefined),
      readDeployedReplicas: vi.fn(async () => 1),
      deletePersistentVolumeClaim: vi.fn(async () => undefined),
    },
    namespace: "octogee-test",
    now: () => 1000,
    log: vi.fn(),
    ...overrides,
  };
}

describe("createRestartGatewayHandler", () => {
  it("calls kubeOps.restartOpenClawInPlace with the deployment derived from gatewayId", async () => {
    const deps = mkDeps();
    const handler = createRestartGatewayHandler(deps);
    const { ctx } = mkCtx();

    const result = await handler(mkOp(), ctx);

    expect(deps.kubeOps.restartOpenClawInPlace).toHaveBeenCalledTimes(1);
    expect(deps.kubeOps.restartOpenClawInPlace).toHaveBeenCalledWith({
      namespace: "octogee-test",
      name: "octogee-gateway-bender",
    });
    expect(result.success).toBe(true);
  });

  it("reports a single `openclaw-restart` step that transitions running → done", async () => {
    const deps = mkDeps();
    const handler = createRestartGatewayHandler(deps);
    const { ctx, reported } = mkCtx();

    await handler(mkOp(), ctx);

    expect(reported.map((s) => `${s.name}:${s.status}`)).toEqual([
      "openclaw-restart:running",
      "openclaw-restart:done",
    ]);
  });

  it("returns failure when gatewayId is missing from op.input (defensive — admin route always provides)", async () => {
    const deps = mkDeps();
    const handler = createRestartGatewayHandler(deps);
    const { ctx } = mkCtx();

    const result = await handler(
      mkOp({ input: {} }),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/gatewayId/);
  });

  it("reports the openclaw-restart step failed when kubeOps throws, surfacing the error message", async () => {
    const deps = mkDeps({
      kubeOps: {
        scaleDeployment: vi.fn(async () => undefined),
        restartOpenClawInPlace: vi.fn(async () => {
          throw new Error("kubectl: connection refused");
        }),
        readDeployedReplicas: vi.fn(async () => 1),
        deletePersistentVolumeClaim: vi.fn(async () => undefined),
      },
    });
    const handler = createRestartGatewayHandler(deps);
    const { ctx, reported } = mkCtx();

    const result = await handler(mkOp(), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/connection refused/);
    const failed = reported.find((s) => s.status === "failed");
    expect(failed?.name).toBe("openclaw-restart");
    expect(failed?.error).toMatch(/connection refused/);
  });

  it("does NOT touch desiredStatus or any Firestore docs (restart is a one-shot kubectl op)", async () => {
    const deps = mkDeps();
    const handler = createRestartGatewayHandler(deps);
    const { ctx } = mkCtx();

    await handler(mkOp(), ctx);

    expect(deps.kubeOps.scaleDeployment).not.toHaveBeenCalled();
    expect(deps.kubeOps.readDeployedReplicas).not.toHaveBeenCalled();
  });

  it("does NOT gate on mounted customers (restart is operator intent)", async () => {
    const deps = mkDeps();
    const handler = createRestartGatewayHandler(deps);
    const { ctx } = mkCtx();

    const result = await handler(
      mkOp({ input: { gatewayId: "bender", mountedCustomers: ["alice", "bob"] } }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(deps.kubeOps.restartOpenClawInPlace).toHaveBeenCalledTimes(1);
  });
});
