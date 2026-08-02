import type { Operation, OperationStep, StepStatus } from "@octogee/shared/types/glm";
import type { GatewayDoc, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";

export interface RolloutDeps {
  readGatewayDoc: (gatewayId: string) => Promise<GatewayDoc | null>;
  readReleasePayload: (gatewayId: string, release: number) => Promise<ReleasePayload | null>;
  activateDesiredRelease: (input: {
    gatewayId: string;
    targetRelease: number;
    operationId: string;
  }) => Promise<{ success: true } | { success: false; error: string }>;
  requestReconcileTick?: (gatewayId: string) => void;
  releaseRecordTimeoutMs: number;
  convergeTimeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

interface RolloutInput {
  gatewayId?: unknown;
  targetRelease?: unknown;
  imageTag?: unknown;
}

interface RollTarget {
  gatewayId: string;
  targetRelease: number;
  imageTag: string;
}

interface RollProgress {
  startedAt: number;
  refreshLiveness: () => Promise<void>;
}

function fail(error: string): OperationResult {
  return { steps: [], success: false, error };
}

function parseRollTarget(input: RolloutInput): RollTarget | string {
  if (typeof input.gatewayId !== "string" || input.gatewayId.length === 0) {
    return "missing gatewayId in op.input";
  }
  if (
    typeof input.targetRelease !== "number" ||
    !Number.isSafeInteger(input.targetRelease) ||
    input.targetRelease < 1
  ) {
    return "missing targetRelease in op.input";
  }
  if (typeof input.imageTag !== "string" || input.imageTag.length === 0) {
    return "missing imageTag in op.input";
  }
  return {
    gatewayId: input.gatewayId,
    targetRelease: input.targetRelease,
    imageTag: input.imageTag,
  };
}

export function planDesiredReleaseActivation(
  gateway: GatewayDoc,
  targetRelease: number,
  updatedAt: number,
  operationId: string,
):
  | { success: true; patch: Record<string, unknown> | null }
  | { success: false; error: string } {
  if (gateway.desiredStatus === "retired") {
    return { success: false, error: `gateway ${gateway.gatewayId} is retired — cannot roll` };
  }
  if (gateway.latestRelease !== targetRelease) {
    return {
      success: false,
      error:
        `gateway ${gateway.gatewayId} target release ${targetRelease} was superseded by ` +
        `latest release ${gateway.latestRelease}`,
    };
  }
  if (gateway.desiredRelease === targetRelease) return { success: true, patch: null };
  return {
    success: true,
    patch: {
      desiredRelease: targetRelease,
      updatedAt,
      updatedBy: `rollout:${operationId}`,
    },
  };
}

function converged(gw: GatewayDoc, targetRelease: number): boolean {
  return gw.desiredRelease === targetRelease && gw.liveRelease === targetRelease;
}

export function createRolloutHandler(deps: RolloutDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const target = parseRollTarget(op.input as RolloutInput);
    if (typeof target === "string") return fail(target);
    const gateway = await deps.readGatewayDoc(target.gatewayId);
    if (!gateway) {
      return fail(
        `gateway ${target.gatewayId} has no durable gateways/${target.gatewayId} desired doc`,
      );
    }
    if (gateway.desiredStatus === "retired") {
      return fail(`gateway ${target.gatewayId} is retired — cannot roll`);
    }

    const startedAt = deps.now();
    await reportStep(ctx, { name: "release-roll", status: "running", startedAt });
    const outcome = await runReleaseRoll(deps, target, op.id, {
      startedAt,
      refreshLiveness: () =>
        reportStep(ctx, { name: "release-roll", status: "running", startedAt }),
    });
    await reportStep(ctx, {
      name: "release-roll",
      status: outcome.success ? "done" : "failed",
      startedAt,
      completedAt: deps.now(),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    return outcome.success ? { steps: [], success: true } : fail(outcome.error ?? "roll failed");
  };
}

async function runReleaseRoll(
  deps: RolloutDeps,
  target: RollTarget,
  operationId: string,
  progress: RollProgress,
): Promise<{ success: boolean; error?: string }> {
  const recorded = await awaitTargetRelease(deps, target, progress);
  if (!recorded.success) return recorded;
  const activationWindow = await awaitActivationWindow(deps, target);
  if (!activationWindow.success) return activationWindow;
  const activation = await deps.activateDesiredRelease({
    gatewayId: target.gatewayId,
    targetRelease: target.targetRelease,
    operationId,
  });
  if (!activation.success) return activation;
  deps.requestReconcileTick?.(target.gatewayId);
  return awaitConvergence(deps, target, progress);
}

interface RollNarration {
  lastStatus: string | null;
  lastError: string | null;
}

async function awaitTargetRelease(
  deps: RolloutDeps,
  target: RollTarget,
  progress: RollProgress,
): Promise<{ success: boolean; error?: string }> {
  for (;;) {
    const gateway = await deps.readGatewayDoc(target.gatewayId);
    if (!gateway) {
      return {
        success: false,
        error: `gateway ${target.gatewayId} desired doc disappeared before release activation`,
      };
    }
    if (gateway.latestRelease !== target.targetRelease) {
      return {
        success: false,
        error:
          `gateway ${target.gatewayId} target release ${target.targetRelease} was superseded by ` +
          `latest release ${gateway.latestRelease}`,
      };
    }
    const payload = await deps.readReleasePayload(target.gatewayId, target.targetRelease);
    if (payload?.imageTag === target.imageTag) return { success: true };
    if (deps.now() - progress.startedAt >= deps.releaseRecordTimeoutMs) {
      return {
        success: false,
        error:
          `target release ${target.targetRelease} of ${target.gatewayId} records image ` +
          `${payload?.imageTag ?? "none"}, not the requested ${target.imageTag}`,
      };
    }
    await deps.wait(deps.pollIntervalMs);
    await progress.refreshLiveness();
  }
}

async function awaitActivationWindow(
  deps: RolloutDeps,
  target: RollTarget,
): Promise<{ success: boolean; error?: string }> {
  const gateway = await deps.readGatewayDoc(target.gatewayId);
  if (!gateway) {
    return {
      success: false,
      error: `gateway ${target.gatewayId} desired doc disappeared before release activation`,
    };
  }
  if (gateway.desiredStatus === "retired") {
    return { success: false, error: `gateway ${target.gatewayId} is retired — cannot roll` };
  }
  if (gateway.latestRelease !== target.targetRelease) {
    return {
      success: false,
      error:
        `gateway ${target.gatewayId} target release ${target.targetRelease} was superseded by ` +
        `latest release ${gateway.latestRelease}`,
    };
  }
  return { success: true };
}

async function awaitConvergence(
  deps: RolloutDeps,
  target: RollTarget,
  progress: RollProgress,
): Promise<{ success: boolean; error?: string }> {
  const narration: RollNarration = { lastStatus: null, lastError: null };
  for (;;) {
    const gw = await deps.readGatewayDoc(target.gatewayId);
    if (!gw) {
      return {
        success: false,
        error: `gateway ${target.gatewayId} desired doc disappeared mid-roll`,
      };
    }
    const elapsed = deps.now() - progress.startedAt;
    const outcome = assessRollOutcome(deps, {
      gw,
      ...target,
    });
    if (outcome) return outcome;

    narrateRollProgress(deps, target.gatewayId, gw, narration);
    if (elapsed >= deps.convergeTimeoutMs) {
      return {
        success: false,
        error:
          `roll of ${target.gatewayId} to ${target.imageTag} did not converge within ` +
          `${deps.convergeTimeoutMs}ms` +
          timeoutContext(narration),
      };
    }
    await deps.wait(deps.pollIntervalMs);
    deps.requestReconcileTick?.(target.gatewayId);
    await progress.refreshLiveness();
  }
}

function assessRollOutcome(
  deps: RolloutDeps,
  input: {
    gw: GatewayDoc;
    gatewayId: string;
    targetRelease: number;
    imageTag: string;
  },
): { success: boolean; error?: string } | null {
  const { gw, gatewayId, targetRelease, imageTag } = input;
  if (gw.latestRelease !== targetRelease) {
    return {
      success: false,
      error:
        `rollout ${gatewayId} → release ${targetRelease} (${imageTag}) was superseded by ` +
        `latest release ${gw.latestRelease}`,
    };
  }
  if (gw.desiredRelease !== targetRelease) {
    return {
      success: false,
      error:
        `rollout ${gatewayId} → release ${targetRelease} (${imageTag}) lost desired authority ` +
        `to release ${gw.desiredRelease}`,
    };
  }
  if (converged(gw, targetRelease)) {
    deps.log(`[rollout] ${gatewayId} converged onto release ${targetRelease} (${imageTag})`);
    return { success: true };
  }
  return null;
}

function narrateRollProgress(
  deps: RolloutDeps,
  gatewayId: string,
  gw: GatewayDoc,
  narration: RollNarration,
): void {
  const status = gw.liveRelease === gw.desiredRelease
    ? `live at r${gw.liveRelease}`
    : `converging r${gw.liveRelease ?? "-"} → r${gw.desiredRelease}`;
  if (status !== narration.lastStatus) {
    narration.lastStatus = status;
    deps.log(`[rollout] ${gatewayId}: ${status}`);
  }
}

function timeoutContext(narration: RollNarration): string {
  if (narration.lastError) return ` — last hold: ${narration.lastError}`;
  if (narration.lastStatus) return ` — last status: ${narration.lastStatus}`;
  return "";
}

async function reportStep(
  ctx: OperationContext,
  step: OperationStep & { status: StepStatus },
): Promise<void> {
  await ctx.reportStep(step);
}
