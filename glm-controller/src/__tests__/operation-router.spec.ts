import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationKind, OperationStep } from "@octogee/shared/types/glm";
import {
  routeOperation,
  type OperationContext,
  type OperationHandler,
} from "../operation-router";

const ctx: OperationContext = {
  reportStep: async () => undefined,
};

function mkOp(overrides: Partial<Operation>): Operation {
  return {
    id: "op-1",
    kind: "add-gateway",
    status: "pending",
    createdBy: "agent:test",
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    input: {},
    steps: [],
    ...overrides,
  };
}

describe("routeOperation", () => {
  it("dispatches to the handler matching op.kind", async () => {
    const calls: OperationKind[] = [];
    const handlers: Record<OperationKind, OperationHandler> = {
      "add-gateway": async () => {
        calls.push("add-gateway");
        return { steps: [], success: true };
      },
      "migrate-customer": async () => {
        calls.push("migrate-customer");
        return { steps: [], success: true };
      },
      "retire-gateway": async () => {
        calls.push("retire-gateway");
        return { steps: [], success: true };
      },
      rollout: async () => {
        calls.push("rollout");
        return { steps: [], success: true };
      },
    };
    await routeOperation(mkOp({ kind: "migrate-customer" }), handlers, ctx);
    expect(calls).toEqual(["migrate-customer"]);
  });

  it("returns the handler's success + steps verbatim", async () => {
    const steps: OperationStep[] = [
      { name: "step-a", status: "done" },
      { name: "step-b", status: "done" },
    ];
    const handlers: Record<OperationKind, OperationHandler> = {
      "add-gateway": async () => ({ steps, success: true }),
      "migrate-customer": async () => ({ steps: [], success: true }),
      "retire-gateway": async () => ({ steps: [], success: true }),
      rollout: async () => ({ steps: [], success: true }),
    };
    const result = await routeOperation(mkOp({ kind: "add-gateway" }), handlers, ctx);
    expect(result.success).toBe(true);
    expect(result.steps).toBe(steps);
  });

  it("propagates handler failure as success=false with the error message", async () => {
    const handlers: Record<OperationKind, OperationHandler> = {
      "add-gateway": async () => {
        throw new Error("helm install timed out");
      },
      "migrate-customer": async () => ({ steps: [], success: true }),
      "retire-gateway": async () => ({ steps: [], success: true }),
      rollout: async () => ({ steps: [], success: true }),
    };
    const result = await routeOperation(mkOp({ kind: "add-gateway" }), handlers, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/helm install timed out/);
  });

  it("rejects unknown kinds with an explicit error (defensive — strict typing should prevent at the boundary)", async () => {
    const handlers: Record<OperationKind, OperationHandler> = {
      "add-gateway": async () => ({ steps: [], success: true }),
      "migrate-customer": async () => ({ steps: [], success: true }),
      "retire-gateway": async () => ({ steps: [], success: true }),
      rollout: async () => ({ steps: [], success: true }),
    };
    const op = mkOp({ kind: "bogus" as OperationKind });
    const result = await routeOperation(op, handlers, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown operation kind/i);
  });

  it("forwards the context (with reportStep) to the matched handler", async () => {
    const reportStep = vi.fn(async (_step: OperationStep) => undefined);
    const liveCtx: OperationContext = { reportStep };
    const handlers: Record<OperationKind, OperationHandler> = {
      "add-gateway": async () => ({ steps: [], success: true }),
      "migrate-customer": async (_op, c) => {
        await c.reportStep({ name: "in-progress", status: "running" });
        return { steps: [], success: true };
      },
      "retire-gateway": async () => ({ steps: [], success: true }),
      rollout: async () => ({ steps: [], success: true }),
    };
    await routeOperation(mkOp({ kind: "migrate-customer" }), handlers, liveCtx);
    expect(reportStep).toHaveBeenCalledWith({ name: "in-progress", status: "running" });
  });
});
