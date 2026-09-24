import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
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
    resolveLiveRevisionId: vi.fn(async (gatewayId: string) => `${gatewayId}-r7`),
    now: () => 1000,
    log: vi.fn(),
    ...overrides,
  };
}

describe("createRestartGatewayHandler", () => {
  it("calls kubeOps.restartOpenClawInPlace with the deployment derived from the serving revision", async () => {
    const deps = mkDeps();
    const handler = createRestartGatewayHandler(deps);
    const { ctx } = mkCtx();

    const result = await handler(mkOp(), ctx);

    expect(deps.kubeOps.restartOpenClawInPlace).toHaveBeenCalledTimes(1);
    expect(deps.kubeOps.restartOpenClawInPlace).toHaveBeenCalledWith({
      namespace: "octogee-test",
      name: "octogee-gateway-bender-r7",
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

  it("fails closed when the durable root has no serving revision", async () => {
    const deps = mkDeps({ resolveLiveRevisionId: vi.fn(async () => null) });

    const result = await createRestartGatewayHandler(deps)(mkOp(), mkCtx().ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/serving revision/i);
    expect(deps.kubeOps.restartOpenClawInPlace).not.toHaveBeenCalled();
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

  it("treats a restart against an already failed pod as idempotently satisfied", async () => {
    const deps = mkDeps({
      kubeOps: {
        scaleDeployment: vi.fn(async () => undefined),
        restartOpenClawInPlace: vi.fn(async () => {
          throw new Error(
            "cannot exec into a container in a completed pod; current phase is Failed",
          );
        }),
        readDeployedReplicas: vi.fn(async () => 1),
        deletePersistentVolumeClaim: vi.fn(async () => undefined),
      },
    });
    const { ctx, reported } = mkCtx();

    const result = await createRestartGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(reported.map((step) => `${step.name}:${step.status}`)).toEqual([
      "openclaw-restart:running",
      "openclaw-restart:skipped",
    ]);
  });

  it("treats a dead OpenClaw process as satisfied by the container's own restart instead of retrying into the fresh boot", async () => {
    const log = vi.fn();
    const deps = mkDeps({
      log,
      kubeOps: {
        scaleDeployment: vi.fn(async () => undefined),
        restartOpenClawInPlace: vi.fn(async () => {
          throw new Error(
            "openclaw gateway restart (in-place) deploy/octogee-gateway-shared-0 ns=octogee-test failed (code=1): Gateway not reachable at ws://127.0.0.1:18789 (ECONNREFUSED)",
          );
        }),
        readDeployedReplicas: vi.fn(async () => 1),
        deletePersistentVolumeClaim: vi.fn(async () => undefined),
      },
    });
    const { ctx, reported } = mkCtx();

    const result = await createRestartGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(reported.map((step) => `${step.name}:${step.status}`)).toEqual([
      "openclaw-restart:running",
      "openclaw-restart:skipped",
    ]);
    expect(reported[1]?.error).toMatch(/ECONNREFUSED/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/bender OpenClaw process is not running/));
  });

  it("treats a restart against a disappeared pod as idempotently satisfied", async () => {
    const deps = mkDeps({
      kubeOps: {
        scaleDeployment: vi.fn(async () => undefined),
        restartOpenClawInPlace: vi.fn(async () => {
          throw new Error('Error from server (NotFound): pods "octogee-gateway-bender-abc" not found');
        }),
        readDeployedReplicas: vi.fn(async () => 1),
        deletePersistentVolumeClaim: vi.fn(async () => undefined),
      },
    });

    const result = await createRestartGatewayHandler(deps)(mkOp(), mkCtx().ctx);

    expect(result.success).toBe(true);
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
