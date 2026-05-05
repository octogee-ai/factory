import type { Operation, OperationStep, StepStatus } from "../../../shared/types/glm.js";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { HelmRunner } from "../helm-runner.js";

export interface GatewayHeartbeat {
  lastHeartbeatAt: number;
}

export interface AddGatewayDeps {
  helm: Pick<HelmRunner, "readDeployedInstances">;
  /** Reads the heartbeat doc the gateway pod publishes once it boots; null if no doc yet. */
  readGatewayHeartbeat: (gatewayId: string) => Promise<GatewayHeartbeat | null>;
  /**
   * Reconciles the fleet-control Ingress paths with the current
   * desired-state set in glmGateways. Called after helm-render +
   * heartbeat succeed so external callers (Cloud Tasks) can hit the
   * new gateway's RPC paths immediately, without waiting for the next
   * reconciler tick.
   */
  syncFleetIngress: () => Promise<void>;
  /** Max time to wait for helm to render the new instance into its values map. */
  helmRenderTimeoutMs: number;
  /** Max time to wait for the gateway pod's first heartbeat after helm renders. */
  heartbeatTimeoutMs: number;
  /** Poll cadence for both phases. */
  pollIntervalMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

interface AddGatewayInput {
  gatewayId?: unknown;
  instanceName?: unknown;
}

interface PollResult {
  ok: boolean;
  errorMsg?: string;
}

const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";

export function createAddGatewayHandler(deps: AddGatewayDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as AddGatewayInput;
    const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
    const instanceName = typeof input.instanceName === "string" ? input.instanceName : undefined;

    if (!gatewayId) return { steps: [], success: false, error: "missing gatewayId in op.input" };
    if (!instanceName) return { steps: [], success: false, error: "missing instanceName in op.input" };

    const renderResult = await pollUntil({
      stepName: "helm-render",
      timeoutMs: deps.helmRenderTimeoutMs,
      ctx,
      deps,
      check: async () => {
        const map = await deps.helm.readDeployedInstances({ namespace: NAMESPACE });
        return Object.prototype.hasOwnProperty.call(map, instanceName);
      },
      timeoutMessage: `helm did not render instance "${instanceName}" within ${deps.helmRenderTimeoutMs}ms`,
    });
    if (!renderResult.ok) {
      return { steps: [], success: false, error: renderResult.errorMsg };
    }

    const heartbeatResult = await pollUntil({
      stepName: "gateway-heartbeat",
      timeoutMs: deps.heartbeatTimeoutMs,
      ctx,
      deps,
      check: async () => {
        const hb = await deps.readGatewayHeartbeat(gatewayId);
        return hb != null;
      },
      timeoutMessage: `gateway "${gatewayId}" never published a heartbeat within ${deps.heartbeatTimeoutMs}ms`,
    });
    if (!heartbeatResult.ok) {
      return { steps: [], success: false, error: heartbeatResult.errorMsg };
    }

    const ingressStartedAt = deps.now();
    await reportStep(ctx, { name: "fleet-ingress", status: "running", startedAt: ingressStartedAt });
    try {
      await deps.syncFleetIngress();
      await reportStep(ctx, {
        name: "fleet-ingress",
        status: "done",
        startedAt: ingressStartedAt,
        completedAt: deps.now(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reportStep(ctx, {
        name: "fleet-ingress",
        status: "failed",
        startedAt: ingressStartedAt,
        completedAt: deps.now(),
        error: msg,
      });
      return { steps: [], success: false, error: msg };
    }

    return { steps: [], success: true };
  };
}

async function pollUntil(args: {
  stepName: string;
  timeoutMs: number;
  ctx: OperationContext;
  deps: AddGatewayDeps;
  check: () => Promise<boolean>;
  timeoutMessage: string;
}): Promise<PollResult> {
  const { stepName, timeoutMs, ctx, deps, check, timeoutMessage } = args;
  const startedAt = deps.now();
  await reportStep(ctx, { name: stepName, status: "running", startedAt });

  const deadline = startedAt + timeoutMs;
  while (true) {
    if (await check()) {
      await reportStep(ctx, {
        name: stepName,
        status: "done",
        startedAt,
        completedAt: deps.now(),
      });
      return { ok: true };
    }
    if (deps.now() >= deadline) {
      await reportStep(ctx, {
        name: stepName,
        status: "failed",
        startedAt,
        completedAt: deps.now(),
        error: timeoutMessage,
      });
      return { ok: false, errorMsg: timeoutMessage };
    }
    await deps.wait(deps.pollIntervalMs);
  }
}

async function reportStep(
  ctx: OperationContext,
  step: OperationStep & { status: StepStatus },
): Promise<void> {
  await ctx.reportStep(step);
}
