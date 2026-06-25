import {
  GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME,
  OPERATOR_GATEWAY_LOCKED_ACCESS,
  OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
  operatorGatewayServiceAccountName,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  resolveGatewayPersistence,
  isGatewayClass,
  isGatewayProfile,
  type Operation,
  type OperationStep,
  type StepStatus,
  type GatewayProfile,
  type GatewayClass,
  type GatewayImageProfile,
  type GatewayPersistenceSpec,
  type GatewayServiceAccountSpec,
  type HelmInstanceValue,
  type OperatorGatewayAccessSpec,
} from "@octogee/shared/types/glm";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { HelmRunner } from "../helm-runner.js";
import { resolveGatewayImageRepository } from "../gateway-profiles.js";
import type { BlueGreenRolloutInput } from "./rollout-bluegreen.js";

export interface GatewayHeartbeatVersion {
  version: string | null;
  lastHeartbeatAt: number;
}

export interface CurrentGatewaySpec {
  gatewayId: string;
  imageRepository: string;
  imageTag: string;
  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  builderSlug?: string;
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
  gatewayClass: GatewayClass;
  imageProfile: GatewayImageProfile;
  builderSlug: string | undefined;
  persistence: GatewayPersistenceSpec | undefined;
  serviceAccountName: string | undefined;
  serviceAccount: GatewayServiceAccountSpec | undefined;
  operatorAccess: OperatorGatewayAccessSpec | undefined;
}

// The pending roll parked on glmGateways/{id}.rollout while a BuilderShell is
// attached. Carries enough to re-issue a faithful rollout op when idle.
export interface RolloutDeferMarker {
  imageTag: string;
  imageRepository: string;
  profile?: GatewayProfile;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
}

export interface RolloutDeps {
  helm: Pick<HelmRunner, "readDeployedInstances">;
  
  readCurrentSpec: (gatewayId: string) => Promise<CurrentGatewaySpec | null>;
  
  updateGlmGatewayImage: (update: RolloutGatewaySpecUpdate) => Promise<void>;
  
  readGatewayHeartbeat: (gatewayId: string) => Promise<GatewayHeartbeatVersion | null>;

  // True while a BuilderShell is attached (operator-class gateways only). A roll
  // defers rather than dropping a live shell; the defer sweeper retries when idle.
  readShellActivity: (gatewayId: string) => Promise<{ hasActiveSession: boolean }>;

  // Park the requested roll on glmGateways/{id}.rollout so the defer sweeper can
  // re-enqueue it once the shell detaches.
  deferRollout: (gatewayId: string, marker: RolloutDeferMarker) => Promise<void>;

  // Customers mounted on the gateway right now. > 0 ⇒ blue/green (never drop a
  // live customer); 0 ⇒ in-place upgrade is safe and cheap (fresh/idle/canary).
  readMountedCustomers: (gatewayId: string) => Promise<string[]>;

  // The blue/green orchestrator, pre-wired in index.ts. Called only when the
  // gateway has mounted customers; the in-place path below handles the empty case.
  runBlueGreen: (
    input: BlueGreenRolloutInput,
    ctx: OperationContext,
  ) => Promise<OperationResult>;

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
  gatewayClass?: unknown;
  imageProfile?: unknown;
}

interface PollResult {
  ok: boolean;
  errorMsg?: string;
}

interface ResolvedRolloutInput {
  gatewayId: string;
  imageTag: string;
  imageRepositoryOverride: string | undefined;
  profileOverride: GatewayProfile | undefined;
  gatewayClassOverride: GatewayClass | undefined;
  imageProfileOverride: GatewayImageProfile | undefined;
}

interface OperatorSafetyDefaults {
  serviceAccountName: string | undefined;
  serviceAccount: GatewayServiceAccountSpec | undefined;
  operatorAccess: OperatorGatewayAccessSpec | undefined;
  defaultsMissing: boolean;
}

const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";
const PINNED_OC_MARKER = "-oc";

interface RolloutTarget {
  gatewayId: string;
  imageTag: string;
  newRepository: string;
  newProfile: GatewayProfile;
  newGatewayClass: GatewayClass;
  newImageProfile: GatewayImageProfile;
  builderSlug: string | undefined;
  newPersistence: GatewayPersistenceSpec | undefined;
  newServiceAccountName: string | undefined;
  newServiceAccount: GatewayServiceAccountSpec | undefined;
  newOperatorAccess: OperatorGatewayAccessSpec | undefined;
  resolvedRepository: string;
}

function heartbeatMatchesImageTag(version: string | null | undefined, imageTag: string): boolean {
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

async function resolveRolloutTarget(
  op: Operation,
  deps: Pick<RolloutDeps, "readCurrentSpec" | "helm" | "log">,
): Promise<{ error: string } | { target: RolloutTarget }> {
  const parsedInput = parseRolloutInput(op.input as RolloutInput);
  if ("error" in parsedInput) return parsedInput;
  const {
    gatewayId,
    imageTag,
    imageRepositoryOverride,
    profileOverride,
    gatewayClassOverride,
    imageProfileOverride,
  } = parsedInput.input;

  const current = await deps.readCurrentSpec(gatewayId);
  if (!current) {
    return { error: `glmGateways/${gatewayId} not found — cannot roll out` };
  }
  const newRepository = imageRepositoryOverride ?? current.imageRepository;
  const currentProfile: GatewayProfile = current.profile ?? "standard";
  const currentGatewayClass = resolveGatewayClass(current);
  const currentImageProfile = resolveGatewayImageProfile(current);
  const requestedGatewayClass = resolveRequestedGatewayClass({
    profileOverride,
    gatewayClassOverride,
    imageProfileOverride,
  });
  const newGatewayClass: GatewayClass = requestedGatewayClass ?? currentGatewayClass;
  const newImageProfile: GatewayImageProfile =
    imageProfileOverride ?? profileOverride ?? currentImageProfile;
  const newProfile: GatewayProfile = newImageProfile;
  const newPersistence = resolveGatewayPersistence(newImageProfile, current.persistence);
  const operatorSafetyDefaults = resolveOperatorSafetyDefaults(
    gatewayId,
    newGatewayClass,
    current,
  );
  const resolvedRepository = resolveGatewayImageRepository({
    gatewayClass: newGatewayClass,
    imageProfile: newImageProfile,
    profile: newProfile,
    imageRepository: newRepository,
  });
  const desiredMatchesRequest = rolloutTargetMatchesCurrent({
    current,
    currentProfile,
    currentGatewayClass,
    currentImageProfile,
    newRepository,
    imageTag,
    newProfile,
    newGatewayClass,
    newImageProfile,
    operatorSafetyDefaultsMissing: operatorSafetyDefaults.defaultsMissing,
  });
  if (desiredMatchesRequest) {
    const deployedMap = await deps.helm.readDeployedInstances({ namespace: NAMESPACE });
    const deployed = deployedMap[current.gatewayId];
    if (deployedMatchesRolloutTarget(deployed, resolvedRepository, imageTag)) {
      return {
        error: `gateway ${gatewayId} already on ${newRepository}:${imageTag} (${newGatewayClass}/${newImageProfile}) — no-op rollout`,
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
      newRepository,
      newProfile,
      newGatewayClass,
      newImageProfile,
      builderSlug: current.builderSlug,
      newPersistence,
      newServiceAccountName: operatorSafetyDefaults.serviceAccountName,
      newServiceAccount: operatorSafetyDefaults.serviceAccount,
      newOperatorAccess: operatorSafetyDefaults.operatorAccess,
      resolvedRepository,
    },
  };
}

function parseRolloutInput(
  input: RolloutInput,
): { error: string } | { input: ResolvedRolloutInput } {
  const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
  const imageTag = typeof input.imageTag === "string" ? input.imageTag : undefined;
  if (!gatewayId) return { error: "missing gatewayId in op.input" };
  if (!imageTag) return { error: "missing imageTag in op.input" };
  return {
    input: {
      gatewayId,
      imageTag,
      imageRepositoryOverride:
        typeof input.imageRepository === "string" ? input.imageRepository : undefined,
      profileOverride: isGatewayProfile(input.profile) ? input.profile : undefined,
      gatewayClassOverride: isGatewayClass(input.gatewayClass) ? input.gatewayClass : undefined,
      imageProfileOverride: isGatewayProfile(input.imageProfile) ? input.imageProfile : undefined,
    },
  };
}

function resolveRequestedGatewayClass(input: {
  profileOverride: GatewayProfile | undefined;
  gatewayClassOverride: GatewayClass | undefined;
  imageProfileOverride: GatewayImageProfile | undefined;
}): GatewayClass | undefined {
  if (input.gatewayClassOverride) return input.gatewayClassOverride;
  if (!input.profileOverride && !input.imageProfileOverride) return undefined;
  return resolveGatewayClass({
    profile: input.profileOverride,
    imageProfile: input.imageProfileOverride,
  });
}

function resolveOperatorSafetyDefaults(
  gatewayId: string,
  gatewayClass: GatewayClass,
  current: CurrentGatewaySpec,
): OperatorSafetyDefaults {
  if (gatewayClass !== "operator") {
    return {
      serviceAccountName: current.serviceAccountName,
      serviceAccount: current.serviceAccount,
      operatorAccess: current.operatorAccess,
      defaultsMissing: false,
    };
  }
  const generatedServiceAccountName = operatorGatewayServiceAccountName(gatewayId);
  const shouldUseLockedServiceAccount =
    !current.serviceAccountName ||
    current.serviceAccountName === GATEWAY_PLATFORM_SERVICE_ACCOUNT_NAME;
  const serviceAccountName = shouldUseLockedServiceAccount
    ? generatedServiceAccountName
    : current.serviceAccountName;
  const shouldCreateLockedServiceAccount =
    serviceAccountName === generatedServiceAccountName && !current.serviceAccount;
  return {
    serviceAccountName,
    serviceAccount:
      shouldUseLockedServiceAccount || shouldCreateLockedServiceAccount
        ? OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT
        : current.serviceAccount,
    operatorAccess: current.operatorAccess ?? OPERATOR_GATEWAY_LOCKED_ACCESS,
    defaultsMissing:
      shouldUseLockedServiceAccount || shouldCreateLockedServiceAccount || !current.operatorAccess,
  };
}

function rolloutTargetMatchesCurrent(input: {
  current: CurrentGatewaySpec;
  currentProfile: GatewayProfile;
  currentGatewayClass: GatewayClass;
  currentImageProfile: GatewayImageProfile;
  newRepository: string;
  imageTag: string;
  newProfile: GatewayProfile;
  newGatewayClass: GatewayClass;
  newImageProfile: GatewayImageProfile;
  operatorSafetyDefaultsMissing: boolean;
}): boolean {
  return (
    input.newRepository === input.current.imageRepository &&
    input.imageTag === input.current.imageTag &&
    input.newProfile === input.currentProfile &&
    input.newGatewayClass === input.currentGatewayClass &&
    input.newImageProfile === input.currentImageProfile &&
    !input.operatorSafetyDefaultsMissing
  );
}

function deployedMatchesRolloutTarget(
  deployed: HelmInstanceValue | undefined,
  resolvedRepository: string,
  imageTag: string,
): boolean {
  return (
    !!deployed &&
    deployed.image.repository === resolvedRepository &&
    deployed.image.tag === imageTag
  );
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
      newGatewayClass,
      newImageProfile,
      builderSlug,
      newPersistence,
      newServiceAccountName,
      newServiceAccount,
      newOperatorAccess,
      resolvedRepository,
    } =
      resolved.target;

    // Defer the roll while a BuilderShell is attached — never drop a live shell
    // mid-session. Park the request on glmGateways/{id}.rollout; the defer sweeper
    // re-enqueues it once the shell detaches (Phase 2 will proactively ask the
    // agent to save + close shells first). Checked after no-op resolution so a
    // no-op roll is still skipped rather than parked.
    const shell = await deps.readShellActivity(gatewayId);
    if (shell.hasActiveSession) {
      const deferStartedAt = deps.now();
      await reportStep(ctx, { name: "defer-active-shell", status: "running", startedAt: deferStartedAt });
      try {
        await deps.deferRollout(gatewayId, {
          imageTag,
          imageRepository: newRepository,
          profile: newProfile,
          gatewayClass: newGatewayClass,
          imageProfile: newImageProfile,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await reportStep(ctx, {
          name: "defer-active-shell",
          status: "failed",
          startedAt: deferStartedAt,
          completedAt: deps.now(),
          error: msg,
        });
        return { steps: [], success: false, error: `failed to defer roll for ${gatewayId}: ${msg}` };
      }
      await reportStep(ctx, {
        name: "defer-active-shell",
        status: "done",
        startedAt: deferStartedAt,
        completedAt: deps.now(),
      });
      deps.log(
        `[rollout] ⚠ cannot auto-roll ${gatewayId} → ${imageTag}: active BuilderShell — deferred; ` +
          `defer sweeper retries hourly until the shell detaches or is found dead`,
      );
      return { steps: [], success: true };
    }

    // A gateway with mounted customers must never roll in place — that drops
    // every live session. Hand off to the blue/green orchestrator, which stands
    // up a fresh-SHA sibling, migrates each customer onto it, and retires the
    // source. The empty (0-mounted) case falls through to the cheap in-place
    // upgrade below: fresh canary, idle-paused, or never-mounted instances.
    const mountedCustomers = await deps.readMountedCustomers(gatewayId);
    if (mountedCustomers.length > 0) {
      return deps.runBlueGreen(
        {
          sourceGatewayId: gatewayId,
          targetImageTag: imageTag,
          targetImageRepository: newRepository,
          profile: newProfile,
          gatewayClass: newGatewayClass,
          imageProfile: newImageProfile,
        },
        ctx,
      );
    }

    const updateStartedAt = deps.now();
    await reportStep(ctx, { name: "update-spec", status: "running", startedAt: updateStartedAt });
    try {
      await deps.updateGlmGatewayImage({
        gatewayId,
        imageRepository: newRepository,
        imageTag,
        profile: newProfile,
        gatewayClass: newGatewayClass,
        imageProfile: newImageProfile,
        builderSlug,
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
        const entry = map[resolved.target.gatewayId];
        return entry?.image.tag === imageTag && entry.image.repository === resolvedRepository;
      },
      timeoutMessage: `helm did not render ${resolved.target.gatewayId}@${imageTag} within ${deps.helmRenderTimeoutMs}ms`,
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
        return heartbeatMatchesImageTag(hb?.version, imageTag);
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
