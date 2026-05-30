import {
  GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME,
  OPERATOR_GATEWAY_LOCKED_ACCESS,
  OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
  operatorGatewayServiceAccountName,
  resolveGatewayPersistence,
  type Operation,
  type OperationStep,
  type StepStatus,
  type GatewayProfile,
  type GatewayPersistenceSpec,
  type GatewayServiceAccountSpec,
  type OperatorGatewayAccessSpec,
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
  persistence?: GatewayPersistenceSpec;
  serviceAccountName?: string;
  serviceAccount?: GatewayServiceAccountSpec;
  operatorAccess?: OperatorGatewayAccessSpec;
}

export interface RolloutGatewaySpecUpdate {
  gatewayId: string;
  imageRepository: string;
  imageTag: string;
  profile: GatewayProfile;
  persistence: GatewayPersistenceSpec | undefined;
  serviceAccountName: string | undefined;
  serviceAccount: GatewayServiceAccountSpec | undefined;
  operatorAccess: OperatorGatewayAccessSpec | undefined;
}

export interface RolloutDeps {
  helm: Pick<HelmRunner, "readDeployedInstances">;
  
  readCurrentSpec: (gatewayId: string) => Promise<CurrentGatewaySpec | null>;
  
  updateGlmGatewayImage: (update: RolloutGatewaySpecUpdate) => Promise<void>;
  
  readGatewayHeartbeat: (gatewayId: string) => Promise<GatewayHeartbeatVersion | null>;
  
  helmRenderTimeoutMs: number;
  
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
  newPersistence: GatewayPersistenceSpec | undefined;
  newServiceAccountName: string | undefined;
  newServiceAccount: GatewayServiceAccountSpec | undefined;
  newOperatorAccess: OperatorGatewayAccessSpec | undefined;
  resolvedRepository: string;
}

// eslint-disable-next-line complexity -- linear validation/target selection for one rollout operation; splitting obscures the no-op boundary checks.
async function resolveRolloutTarget(
  op: Operation,
  deps: Pick<RolloutDeps, "readCurrentSpec" | "helm" | "log">,
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
  const newPersistence = resolveGatewayPersistence(newProfile, current.persistence);
  const generatedOperatorServiceAccountName = operatorGatewayServiceAccountName(gatewayId);
  const shouldUseLockedOperatorServiceAccount =
    newProfile === "operator" &&
    (!current.serviceAccountName ||
      current.serviceAccountName === GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME);
  const newServiceAccountName = shouldUseLockedOperatorServiceAccount
    ? generatedOperatorServiceAccountName
    : current.serviceAccountName;
  const shouldCreateLockedOperatorServiceAccount =
    newProfile === "operator" &&
    newServiceAccountName === generatedOperatorServiceAccountName &&
    !current.serviceAccount;
  const newServiceAccount =
    shouldUseLockedOperatorServiceAccount || shouldCreateLockedOperatorServiceAccount
      ? OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT
      : current.serviceAccount;
  const newOperatorAccess =
    newProfile === "operator"
      ? current.operatorAccess ?? OPERATOR_GATEWAY_LOCKED_ACCESS
      : current.operatorAccess;
  const resolvedRepository = resolveGatewayImageRepository({
    profile: newProfile,
    imageRepository: newRepository,
  });
  const operatorSafetyDefaultsMissing =
    newProfile === "operator" &&
    (!current.persistence ||
      shouldUseLockedOperatorServiceAccount ||
      shouldCreateLockedOperatorServiceAccount ||
      !current.operatorAccess);

  const desiredMatchesRequest =
    newRepository === current.imageRepository &&
    imageTag === current.imageTag &&
    newProfile === currentProfile &&
    !operatorSafetyDefaultsMissing;
  if (desiredMatchesRequest) {
    const deployedMap = await deps.helm.readDeployedInstances({ namespace: NAMESPACE });
    const deployed = deployedMap[current.instanceName];
    const actualMatchesRequest =
      !!deployed &&
      deployed.image.repository === resolvedRepository &&
      deployed.image.tag === imageTag;
    if (actualMatchesRequest) {
      return {
        error: `gateway ${gatewayId} already on ${newRepository}:${imageTag} (${newProfile}) — no-op rollout`,
      };
    }
    deps.log(
      `[rollout] ${gatewayId} spec matches request but actual deployed (${deployed?.image.repository ?? "absent"}:${deployed?.image.tag ?? "absent"}) differs — proceeding to converge`,
    );
  }
  return {
    target: {
      gatewayId,
      imageTag,
      instanceName: current.instanceName,
      newRepository,
      newProfile,
      newPersistence,
      newServiceAccountName,
      newServiceAccount,
      newOperatorAccess,
      resolvedRepository,
    },
  };
}

export function createRolloutHandler(deps: RolloutDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const resolved = await resolveRolloutTarget(op, deps);
    if ("error" in resolved) {
      return { steps: [], success: false, error: resolved.error };
    }
    const {
      gatewayId,
      imageTag,
      newRepository,
      newProfile,
      newPersistence,
      newServiceAccountName,
      newServiceAccount,
      newOperatorAccess,
      resolvedRepository,
    } =
      resolved.target;

    const updateStartedAt = deps.now();
    await reportStep(ctx, { name: "update-spec", status: "running", startedAt: updateStartedAt });
    try {
      await deps.updateGlmGatewayImage({
        gatewayId,
        imageRepository: newRepository,
        imageTag,
        profile: newProfile,
        persistence: newPersistence,
        serviceAccountName: newServiceAccountName,
        serviceAccount: newServiceAccount,
        operatorAccess: newOperatorAccess,
      });
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
