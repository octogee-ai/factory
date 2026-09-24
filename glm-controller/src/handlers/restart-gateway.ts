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

const RESTART_STEP = "openclaw-restart";

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
      name: RESTART_STEP,
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
      if (openClawProcessDown(message)) {
        await reportStep(ctx, {
          name: RESTART_STEP,
          status: "skipped",
          startedAt,
          completedAt: deps.now(),
          error: message,
        });
        deps.log(
          `[restart-gateway] ${gatewayId} OpenClaw process is not running; the gateway container exits on OpenClaw death and Kubernetes restarts it, which satisfies restart intent`,
        );
        return { steps: [], success: true };
      }
      if (restartTargetUnavailable(message)) {
        await reportStep(ctx, {
          name: RESTART_STEP,
          status: "skipped",
          startedAt,
          completedAt: deps.now(),
          error: message,
        });
        deps.log(
          `[restart-gateway] ${gatewayId} pod is no longer execable; Kubernetes replacement satisfies restart intent`,
        );
        return { steps: [], success: true };
      }
      await reportStep(ctx, {
        name: RESTART_STEP,
        status: "failed",
        startedAt,
        completedAt: deps.now(),
        error: message,
      });
      return { steps: [], success: false, error: message };
    }

    await reportStep(ctx, {
      name: RESTART_STEP,
      status: "done",
      startedAt,
      completedAt: deps.now(),
    });

    return { steps: [], success: true };
  };
}

function openClawProcessDown(message: string): boolean {
  return /gateway not reachable at ws:\/\/127\.0\.0\.1:18789/iu.test(message);
}

function restartTargetUnavailable(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("cannot exec into a container in a completed pod") ||
    /pods?\s+"[^"]+"\s+not found/u.test(normalized) ||
    normalized.includes("pod does not exist")
  );
}

async function reportStep(
  ctx: OperationContext,
  step: OperationStep & { status: StepStatus },
): Promise<void> {
  await ctx.reportStep(step);
}
