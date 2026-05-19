import type {
  Operation,
  OperationStep,
  StepStatus,
  GatewayProfile,
} from "../../../shared/types/glm.js";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { HelmRunner } from "../helm-runner.js";
import { resolveGatewayImageRepository } from "../gateway-profiles.js";

export interface GatewayHeartbeatVersion {
  version: string | null;
  lastHeartbeatAt: number;
}

export interface CurrentGatewaySpec {
  instanceName: string;
  imageRepository: string;
  imageTag: string;
  profile?: GatewayProfile;
}

export interface RolloutDeps {
  helm: Pick<HelmRunner, "readDeployedInstances">;
  /** Reads glmGateways/{id} so we can check current spec + map to instanceName for helm-render poll. */
  readCurrentSpec: (gatewayId: string) => Promise<CurrentGatewaySpec | null>;
  /** Updates glmGateways/{id}.imageRepository + imageTag + profile. The reconciler picks this up via onSnapshot. */
  updateGlmGatewayImage: (
    gatewayId: string,
    imageRepository: string,
    imageTag: string,
    profile: GatewayProfile,
  ) => Promise<void>;
  /** Reads gateways/{id} heartbeat: version (image tag the pod published) + lastHeartbeatAt. */
  readGatewayHeartbeat: (gatewayId: string) => Promise<GatewayHeartbeatVersion | null>;
  /** Max time to wait for helm to render the new image into the deployed instance map. */
  helmRenderTimeoutMs: number;
  /** Max time to wait for the gateway pod to restart and publish a heartbeat with the new version. */
  heartbeatTimeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

interface RolloutInput {
  gatewayId?: unknown;
  imageTag?: unknown;
  imageRepository?: unknown;
  profile?: unknown;
}

interface PollResult {
  ok: boolean;
  errorMsg?: string;
}

const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";

interface RolloutTarget {
  gatewayId: string;
  imageTag: string;
  instanceName: string;
  newRepository: string;
  newProfile: GatewayProfile;
  resolvedRepository: string;
}

async function resolveRolloutTarget(
  op: Operation,
  deps: Pick<RolloutDeps, "readCurrentSpec">,
): Promise<{ error: string } | { target: RolloutTarget }> {
  const input = op.input as RolloutInput;
  const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
  const imageTag = typeof input.imageTag === "string" ? input.imageTag : undefined;
  const imageRepositoryOverride =
    typeof input.imageRepository === "string" ? input.imageRepository : undefined;
  const profileOverride =
    typeof input.profile === "string" ? (input.profile as GatewayProfile) : undefined;

  if (!gatewayId) return { error: "missing gatewayId in op.input" };
  if (!imageTag) return { error: "missing imageTag in op.input" };

  const current = await deps.readCurrentSpec(gatewayId);
  if (!current) {
    return { error: `glmGateways/${gatewayId} not found — cannot roll out` };
  }
  const newRepository = imageRepositoryOverride ?? current.imageRepository;
  const currentProfile: GatewayProfile = current.profile ?? "standard";
  const newProfile: GatewayProfile = profileOverride ?? currentProfile;
  if (
    newRepository === current.imageRepository &&
    imageTag === current.imageTag &&
    newProfile === currentProfile
  ) {
    return {
      error: `gateway ${gatewayId} already on ${newRepository}:${imageTag} (${newProfile}) — no-op rollout`,
    };
  }
  return {
    target: {
      gatewayId,
      imageTag,
      instanceName: current.instanceName,
      newRepository,
      newProfile,
      resolvedRepository: resolveGatewayImageRepository({
        profile: newProfile,
        imageRepository: newRepository,
      }),
    },
  };
}

export function createRolloutHandler(deps: RolloutDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const resolved = await resolveRolloutTarget(op, deps);
    if ("error" in resolved) {
      return { steps: [], success: false, error: resolved.error };
    }
    const { gatewayId, imageTag, newRepository, newProfile, resolvedRepository } =
      resolved.target;

    const updateStartedAt = deps.now();
    await reportStep(ctx, { name: "update-spec", status: "running", startedAt: updateStartedAt });
    try {
      await deps.updateGlmGatewayImage(
        gatewayId,
        newRepository,
        imageTag,
        newProfile,
      );
      await reportStep(ctx, {
        name: "update-spec",
        status: "done",
        startedAt: updateStartedAt,
        completedAt: deps.now(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reportStep(ctx, {
        name: "update-spec",
        status: "failed",
        startedAt: updateStartedAt,
        completedAt: deps.now(),
        error: msg,
      });
      return { steps: [], success: false, error: `failed to update glmGateways spec: ${msg}` };
    }

    // From this point forward the spec write has landed in Firestore;
    // any failure below leaves glmGateways ahead of helm/pod. The
    // reconciler will keep trying to converge each tick, so the right
    // recovery is either a remediating rollout to a known-good tag or
    // letting the next tick succeed on its own. The op is marked failed
    // either way so the operator sees the timeout in OperationsHistory.
    const renderResult = await pollUntil({
      stepName: "helm-render",
      timeoutMs: deps.helmRenderTimeoutMs,
      ctx,
      deps,
      check: async () => {
        const map = await deps.helm.readDeployedInstances({ namespace: NAMESPACE });
        const entry = map[resolved.target.instanceName];
        return entry?.image.tag === imageTag && entry.image.repository === resolvedRepository;
      },
      timeoutMessage: `helm did not render ${resolved.target.instanceName}@${imageTag} within ${deps.helmRenderTimeoutMs}ms`,
    });
    if (!renderResult.ok) {
      return { steps: [], success: false, error: renderResult.errorMsg };
    }

    const heartbeatResult = await pollUntil({
      stepName: "heartbeat-fresh",
      timeoutMs: deps.heartbeatTimeoutMs,
      ctx,
      deps,
      check: async () => {
        const hb = await deps.readGatewayHeartbeat(gatewayId);
        return hb?.version === imageTag;
      },
      timeoutMessage: `gateway ${gatewayId} never published a heartbeat with version=${imageTag} within ${deps.heartbeatTimeoutMs}ms`,
    });
    if (!heartbeatResult.ok) {
      return { steps: [], success: false, error: heartbeatResult.errorMsg };
    }

    return { steps: [], success: true };
  };
}

async function pollUntil(args: {
  stepName: string;
  timeoutMs: number;
  ctx: OperationContext;
  deps: RolloutDeps;
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
