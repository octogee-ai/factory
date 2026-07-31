import type { Operation, OperationStep, StepStatus } from "@octogee/shared/types/glm";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { KubeOps } from "../lib/kube-ops.js";

export interface RestartGatewayDeps {
  kubeOps: KubeOps;
  namespace: string;
  resolveLiveRevisionId: (gatewayId: string) => Promise<string | null>;
  now: () => number;
  log: (msg: string) => void;
}

interface RestartGatewayInput {
  gatewayId?: unknown;
}

function deploymentNameForGateway(gatewayId: string): string {
  return `octogee-gateway-${gatewayId}`;
}

export function createRestartGatewayHandler(
  deps: RestartGatewayDeps,
): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as RestartGatewayInput;
    const gatewayId =
      typeof input.gatewayId === "string" ? input.gatewayId : undefined;

    if (!gatewayId) {
      return { steps: [], success: false, error: "missing gatewayId in op.input" };
    }

    const revisionId = await deps.resolveLiveRevisionId(gatewayId);
    if (!revisionId) {
      return {
        steps: [],
        success: false,
        error: `gateway ${gatewayId} has no validated serving revision`,
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
        name: deploymentNameForGateway(revisionId),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (restartTargetUnavailable(message)) {
        await reportStep(ctx, {
          name: "openclaw-restart",
          status: "skipped",
          startedAt,
          completedAt: deps.now(),
          error: message,
        });
        return restartDeployment(deps, revisionId, ctx);
      }
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

function restartTargetUnavailable(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("cannot exec into a container in a completed pod") ||
    /pods?\s+"[^"]+"\s+not found/u.test(normalized) ||
    normalized.includes("pod does not exist")
  );
}

async function restartDeployment(
  deps: RestartGatewayDeps,
  revisionId: string,
  ctx: OperationContext,
): Promise<OperationResult> {
  const startedAt = deps.now();
  await reportStep(ctx, {
    name: "deployment-restart",
    status: "running",
    startedAt,
  });
  try {
    await deps.kubeOps.restartDeployment({
      namespace: deps.namespace,
      name: deploymentNameForGateway(revisionId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reportStep(ctx, {
      name: "deployment-restart",
      status: "failed",
      startedAt,
      completedAt: deps.now(),
      error: message,
    });
    return { steps: [], success: false, error: message };
  }
  await reportStep(ctx, {
    name: "deployment-restart",
    status: "done",
    startedAt,
    completedAt: deps.now(),
  });
  return { steps: [], success: true };
}

async function reportStep(
  ctx: OperationContext,
  step: OperationStep & { status: StepStatus },
): Promise<void> {
  await ctx.reportStep(step);
}
