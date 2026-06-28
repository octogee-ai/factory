import {
  isGatewayClass,
  isGatewayProfile,
  resolveGatewayClass,
  type GatewayClass,
  type Operation,
  type OperationStep,
  type StepStatus,
} from "@octogee/shared/types/glm";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { HelmRunner } from "../helm-runner.js";
import type { KubeOps } from "../lib/kube-ops.js";

export interface GatewayHeartbeat {
  lastHeartbeatAt: number;
  version?: string | null;
}

export interface AddGatewayDeps {
  helm: Pick<HelmRunner, "readDeployedInstances">;

  kubeOps: Pick<KubeOps, "readAvailableReplicas">;

  readGatewayHeartbeat: (gatewayId: string) => Promise<GatewayHeartbeat | null>;

  publishGatewayReady: (input: {
    gatewayId: string;
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
  imageTag?: unknown;
  profile?: unknown;
  gatewayClass?: unknown;
  imageProfile?: unknown;
}

type StepResult = { ok: true } | { ok: false; error: string };

interface AddGatewayPlan {
  gatewayId: string;
  imageTag?: string;
  gatewayClass: GatewayClass;
}

const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";
const PINNED_OC_MARKER = "-oc";

function deploymentNameForGateway(gatewayId: string): string {
  return `octogee-gateway-${gatewayId}`;
}

function heartbeatMatchesImageTag(version: string | null | undefined, imageTag: string | undefined): boolean {
  if (!imageTag) return true;
  if (!version) return false;
  if (version === imageTag) return true;
  const marker = imageTag.indexOf(PINNED_OC_MARKER);
  if (marker < 7 || marker > 40) return false;
  const buildSha = imageTag.slice(0, marker);
  return isLowerHex(buildSha) && version === buildSha;
}

function isLowerHex(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isLowerAF = code >= 97 && code <= 102;
    if (!isDigit && !isLowerAF) return false;
  }
  return true;
}

export function createAddGatewayHandler(deps: AddGatewayDeps): OperationHandler {
  return (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    return handleAddGateway(op, ctx, deps);
  };
}

async function handleAddGateway(
  op: Operation,
  ctx: OperationContext,
  deps: AddGatewayDeps,
): Promise<OperationResult> {
  const plan = parseAddGatewayPlan(op.input as AddGatewayInput);
  if (!plan) return failure("missing gatewayId in op.input");

  const renderResult = await waitForHelmRender(plan, ctx, deps);
  if (!renderResult.ok) return failure(renderResult.error);

  const deploymentResult = await waitForDeployment(plan.gatewayId, ctx, deps);
  if (!deploymentResult.ok) return failure(deploymentResult.error);

  const readyResult = await waitForReadySignal(plan, ctx, deps);
  if (!readyResult.ok) return failure(readyResult.error);

  const ingressResult = await syncFleetIngress(ctx, deps);
  if (!ingressResult.ok) return failure(ingressResult.error);

  return { steps: [], success: true };
}

function parseAddGatewayPlan(input: AddGatewayInput): AddGatewayPlan | null {
  const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
  const imageTag = typeof input.imageTag === "string" ? input.imageTag : undefined;

  if (!gatewayId) return null;

  return {
    gatewayId,
    imageTag,
    gatewayClass: resolveGatewayClass({
      gatewayClass: isGatewayClass(input.gatewayClass) ? input.gatewayClass : undefined,
      profile: isGatewayProfile(input.profile) ? input.profile : undefined,
      imageProfile: isGatewayProfile(input.imageProfile) ? input.imageProfile : undefined,
    }),
  };
}

async function waitForHelmRender(
  plan: AddGatewayPlan,
  ctx: OperationContext,
  deps: AddGatewayDeps,
): Promise<StepResult> {
  return pollUntil({
    stepName: "helm-render",
    timeoutMs: deps.helmRenderTimeoutMs,
    ctx,
    deps,
    check: async () => {
      const map = await deps.helm.readDeployedInstances({ namespace: NAMESPACE });
      const instance = map[plan.gatewayId];
      return instance != null && (!plan.imageTag || instance.image.tag === plan.imageTag);
    },
    timeoutMessage: plan.imageTag
      ? `helm did not render instance "${plan.gatewayId}" with imageTag=${plan.imageTag} within ${deps.helmRenderTimeoutMs}ms`
      : `helm did not render instance "${plan.gatewayId}" within ${deps.helmRenderTimeoutMs}ms`,
  });
}

async function waitForDeployment(
  gatewayId: string,
  ctx: OperationContext,
  deps: AddGatewayDeps,
): Promise<StepResult> {
  const deploymentName = deploymentNameForGateway(gatewayId);
  return pollUntil({
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
}

async function waitForReadySignal(
  plan: AddGatewayPlan,
  ctx: OperationContext,
  deps: AddGatewayDeps,
): Promise<StepResult> {
  if (plan.gatewayClass === "operator") {
    return publishPlatformReadyRecord(plan, ctx, deps);
  }

  return waitForGatewayHeartbeat(plan, ctx, deps);
}

async function publishPlatformReadyRecord(
  plan: AddGatewayPlan,
  ctx: OperationContext,
  deps: AddGatewayDeps,
): Promise<StepResult> {
  return runReportedStep({
    stepName: "platform-ready-record",
    ctx,
    deps,
    action: () => deps.publishGatewayReady({ gatewayId: plan.gatewayId, imageTag: plan.imageTag }),
  });
}

async function waitForGatewayHeartbeat(
  plan: AddGatewayPlan,
  ctx: OperationContext,
  deps: AddGatewayDeps,
): Promise<StepResult> {
  return pollUntil({
    stepName: "gateway-heartbeat",
    timeoutMs: deps.heartbeatTimeoutMs,
    ctx,
    deps,
    check: async () => {
      const hb = await deps.readGatewayHeartbeat(plan.gatewayId);
      return hb != null && heartbeatMatchesImageTag(hb.version, plan.imageTag);
    },
    timeoutMessage: plan.imageTag
      ? `gateway "${plan.gatewayId}" never published a heartbeat with version=${plan.imageTag} within ${deps.heartbeatTimeoutMs}ms`
      : `gateway "${plan.gatewayId}" never published a heartbeat within ${deps.heartbeatTimeoutMs}ms`,
  });
}

async function syncFleetIngress(ctx: OperationContext, deps: AddGatewayDeps): Promise<StepResult> {
  return runReportedStep({
    stepName: "fleet-ingress",
    ctx,
    deps,
    action: deps.syncFleetIngress,
  });
}

async function runReportedStep(args: {
  stepName: string;
  ctx: OperationContext;
  deps: AddGatewayDeps;
  action: () => Promise<void>;
}): Promise<StepResult> {
  const { stepName, ctx, deps, action } = args;
  const startedAt = deps.now();
  await reportStep(ctx, { name: stepName, status: "running", startedAt });

  try {
    await action();
    await reportStep(ctx, {
      name: stepName,
      status: "done",
      startedAt,
      completedAt: deps.now(),
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportStep(ctx, {
      name: stepName,
      status: "failed",
      startedAt,
      completedAt: deps.now(),
      error: msg,
    });
    return { ok: false, error: msg };
  }
}

function failure(error: string): OperationResult {
  return { steps: [], success: false, error };
}

async function pollUntil(args: {
  stepName: string;
  timeoutMs: number;
  ctx: OperationContext;
  deps: AddGatewayDeps;
  check: () => Promise<boolean>;
  timeoutMessage: string;
}): Promise<StepResult> {
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
      return { ok: false, error: timeoutMessage };
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
