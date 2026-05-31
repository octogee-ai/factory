import type { Operation, OperationStep, StepStatus } from "../../../shared/types/glm.js";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { HelmRunner } from "../helm-runner.js";
import type { KubeOps } from "../lib/kube-ops.js";

export interface GatewayHeartbeat {
  lastHeartbeatAt: number;
}

export interface AddGatewayDeps {
  helm: Pick<HelmRunner, "readDeployedInstances">;

  kubeOps: Pick<KubeOps, "readAvailableReplicas">;

  readGatewayHeartbeat: (gatewayId: string) => Promise<GatewayHeartbeat | null>;

  publishGatewayReady: (input: {
    gatewayId: string;
    instanceName: string;
    imageTag?: string;
  }) => Promise<void>;

  syncFleetIngress: () => Promise<void>;

  helmRenderTimeoutMs: number;

  deploymentReadyTimeoutMs: number;

  heartbeatTimeoutMs: number;

  pollIntervalMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

interface AddGatewayInput {
  gatewayId?: unknown;
  instanceName?: unknown;
  imageTag?: unknown;
  profile?: unknown;
}

interface PollResult {
  ok: boolean;
  errorMsg?: string;
}

const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";

function deploymentNameForInstance(instanceName: string): string {
  return `octogee-gateway-${instanceName}`;
}

export function createAddGatewayHandler(deps: AddGatewayDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as AddGatewayInput;
    const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
    const instanceName = typeof input.instanceName === "string" ? input.instanceName : undefined;
    const imageTag = typeof input.imageTag === "string" ? input.imageTag : undefined;
    const profile = input.profile === "operator" ? "operator" : "standard";

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

    const deploymentName = deploymentNameForInstance(instanceName);
    const deploymentReadyResult = await pollUntil({
      stepName: "deployment-ready",
      timeoutMs: deps.deploymentReadyTimeoutMs,
      ctx,
      deps,
      check: async () => {
        const replicas = await deps.kubeOps.readAvailableReplicas({
          namespace: NAMESPACE,
          name: deploymentName,
        });
        return replicas != null && replicas > 0;
      },
      timeoutMessage: `deployment "${deploymentName}" did not become available within ${deps.deploymentReadyTimeoutMs}ms`,
    });
    if (!deploymentReadyResult.ok) {
      return { steps: [], success: false, error: deploymentReadyResult.errorMsg };
    }

    if (profile === "operator") {
      const readyStartedAt = deps.now();
      await reportStep(ctx, {
        name: "platform-ready-record",
        status: "running",
        startedAt: readyStartedAt,
      });
      try {
        await deps.publishGatewayReady({ gatewayId, instanceName, imageTag });
        await reportStep(ctx, {
          name: "platform-ready-record",
          status: "done",
          startedAt: readyStartedAt,
          completedAt: deps.now(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await reportStep(ctx, {
          name: "platform-ready-record",
          status: "failed",
          startedAt: readyStartedAt,
          completedAt: deps.now(),
          error: msg,
        });
        return { steps: [], success: false, error: msg };
      }
    } else {
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
