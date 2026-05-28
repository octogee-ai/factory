import type { Operation, OperationStep, StepStatus } from "../../../shared/types/glm.js";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { KubeOps } from "../lib/kube-ops.js";

export interface RestartGatewayDeps {
  kubeOps: KubeOps;
  namespace: string;
  now: () => number;
  log: (msg: string) => void;
}

interface RestartGatewayInput {
  gatewayId?: unknown;
  instanceName?: unknown;
}

function deploymentNameForInstance(instanceName: string): string {
  return `octogee-gateway-${instanceName}`;
}

export function createRestartGatewayHandler(
  deps: RestartGatewayDeps,
): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as RestartGatewayInput;
    const gatewayId =
      typeof input.gatewayId === "string" ? input.gatewayId : undefined;
    const instanceName =
      typeof input.instanceName === "string" ? input.instanceName : undefined;

    if (!gatewayId) {
      return { steps: [], success: false, error: "missing gatewayId in op.input" };
    }
    if (!instanceName) {
      return {
        steps: [],
        success: false,
        error: "missing instanceName in op.input",
      };
    }

    const startedAt = deps.now();
    await reportStep(ctx, {
      name: "openclaw-restart",
      status: "running",
      startedAt,
    });

    try {
      await deps.kubeOps.restartOpenClawInPlace({
        namespace: deps.namespace,
        name: deploymentNameForInstance(instanceName),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await reportStep(ctx, {
        name: "openclaw-restart",
        status: "failed",
        startedAt,
        completedAt: deps.now(),
        error: message,
      });
      return { steps: [], success: false, error: message };
    }

    await reportStep(ctx, {
      name: "openclaw-restart",
      status: "done",
      startedAt,
      completedAt: deps.now(),
    });

    return { steps: [], success: true };
  };
}

async function reportStep(
  ctx: OperationContext,
  step: OperationStep & { status: StepStatus },
): Promise<void> {
  await ctx.reportStep(step);
}
