import type { Operation, OperationStep, StepStatus } from "../../../shared/types/glm.js";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { HelmRunner } from "../helm-runner.js";

export interface GatewayLiveState {
  mountedCustomers: string[];
  inFlightJobId: string | null;
}

export interface RetireGatewayDeps {
  helm: Pick<HelmRunner, "readDeployedInstances">;

  readGatewayLiveState: (gatewayId: string) => Promise<GatewayLiveState | null>;

  deleteGlmGateway: (gatewayId: string) => Promise<void>;

  deleteGatewayHeartbeat: (gatewayId: string) => Promise<void>;

  readGatewayHeartbeatExists?: (gatewayId: string) => Promise<boolean>;

  archiveAuthTokenSecret?: (gatewayId: string) => Promise<void>;

  deleteGatewayPersistentVolumeClaim?: (instanceName: string) => Promise<void>;

  readGlmGatewayInstanceName: (gatewayId: string) => Promise<string | null>;

  syncFleetIngress: () => Promise<void>;
  helmUninstallTimeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

interface RetireGatewayInput {
  gatewayId?: unknown;
  deletePersistentVolumeClaim?: unknown;
}

interface PollResult {
  ok: boolean;
  errorMsg?: string;
}

interface StepResult {
  ok: boolean;
  error?: string;
}

const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";

function shouldDeletePersistentVolumeClaim(input: RetireGatewayInput): boolean {
  return input.deletePersistentVolumeClaim === true;
}

function failure(error: string): OperationResult {
  return { steps: [], success: false, error };
}

export function createRetireGatewayHandler(deps: RetireGatewayDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as RetireGatewayInput;
    const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
    if (!gatewayId) return failure("missing gatewayId in op.input");
    const deletePersistentVolumeClaim = shouldDeletePersistentVolumeClaim(input);

    const liveFailure = await assertGatewayRetirable(deps, gatewayId);
    if (liveFailure) return liveFailure;

    const instanceName = await deps.readGlmGatewayInstanceName(gatewayId);
    if (!instanceName) {
      return failure(
        `glmGateways/${gatewayId} not found — cannot determine instanceName for helm uninstall`,
      );
    }

    const helmResult = await pollUntil({
      stepName: "helm-uninstall",
      timeoutMs: deps.helmUninstallTimeoutMs,
      ctx,
      deps,
      check: async () => {
        const map = await deps.helm.readDeployedInstances({ namespace: NAMESPACE });
        return !Object.prototype.hasOwnProperty.call(map, instanceName);
      },
      timeoutMessage: `helm did not uninstall instance "${instanceName}" within ${deps.helmUninstallTimeoutMs}ms`,
    });
    if (!helmResult.ok) {
      return failure(helmResult.errorMsg ?? "helm uninstall failed");
    }

    const pvcFailure = await deletePersistentVolumeClaimIfRequested({
      ctx,
      deps,
      deletePersistentVolumeClaim,
      instanceName,
    });
    if (pvcFailure) return pvcFailure;

    const cleanupFailure = await cleanupGatewayRecords(ctx, deps, gatewayId);
    if (cleanupFailure) return cleanupFailure;

    await quiesceGatewayHeartbeat(ctx, deps, gatewayId);

    const ingressFailure = await syncFleetIngress(ctx, deps);
    if (ingressFailure) return ingressFailure;

    return { steps: [], success: true };
  };
}

async function assertGatewayRetirable(
  deps: RetireGatewayDeps,
  gatewayId: string,
): Promise<OperationResult | null> {
  const live = await deps.readGatewayLiveState(gatewayId);
  if (live == null) return null;
  if (live.mountedCustomers.length > 0) {
    return failure(
      `gateway ${gatewayId} still has ${live.mountedCustomers.length} mounted customer(s): ${live.mountedCustomers.join(", ")}`,
    );
  }
  if (live.inFlightJobId) {
    return failure(
      `gateway ${gatewayId} has an in-flight restore job ${live.inFlightJobId}; refusing to retire mid-mount`,
    );
  }
  return null;
}

async function deletePersistentVolumeClaimIfRequested(args: {
  ctx: OperationContext;
  deps: RetireGatewayDeps;
  deletePersistentVolumeClaim: boolean;
  instanceName: string;
}): Promise<OperationResult | null> {
  const { ctx, deps, deletePersistentVolumeClaim, instanceName } = args;
  if (!deletePersistentVolumeClaim) return null;
  const deletePvc = deps.deleteGatewayPersistentVolumeClaim;
  if (!deletePvc) {
    return failure("deletePersistentVolumeClaim requested but PVC deletion is not configured");
  }
  const result = await runReportedStep(ctx, deps, "delete-pvc", () => deletePvc(instanceName));
  return result.ok ? null : failure(result.error ?? "PVC deletion failed");
}

async function cleanupGatewayRecords(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
  gatewayId: string,
): Promise<OperationResult | null> {
  const result = await runReportedStep(ctx, deps, "cleanup", async () => {
    await deps.deleteGlmGateway(gatewayId);
    await deps.deleteGatewayHeartbeat(gatewayId);
    if (deps.archiveAuthTokenSecret) {
      await deps.archiveAuthTokenSecret(gatewayId);
    }
  });
  return result.ok
    ? null
    : failure(`cleanup failed after helm uninstall: ${result.error ?? "unknown error"}`);
}

async function quiesceGatewayHeartbeat(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
  gatewayId: string,
): Promise<void> {
  const readGatewayHeartbeatExists = deps.readGatewayHeartbeatExists;
  if (!readGatewayHeartbeatExists) return;
  const result = await runReportedStep(ctx, deps, "heartbeat-quiesce", async () => {
    await deps.wait(deps.pollIntervalMs);
    const resurrected = await readGatewayHeartbeatExists(gatewayId);
    if (resurrected) {
      await deps.deleteGatewayHeartbeat(gatewayId);
    }
  });
  if (!result.ok) {
    deps.log(
      `[retire-gateway] heartbeat-quiesce failed for ${gatewayId} (reaper will heal within 60s): ${result.error ?? "unknown error"}`,
    );
  }
}

async function syncFleetIngress(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
): Promise<OperationResult | null> {
  const result = await runReportedStep(ctx, deps, "fleet-ingress", () => deps.syncFleetIngress());
  if (result.ok) return null;
  deps.log(
    `[retire-gateway] cleanup committed but fleet-ingress sync failed; reconciler will heal within 30s — ${result.error ?? "unknown error"}`,
  );
  return failure(result.error ?? "fleet-ingress sync failed");
}

async function runReportedStep(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
  name: string,
  run: () => Promise<void>,
): Promise<StepResult> {
  const startedAt = deps.now();
  await reportStep(ctx, { name, status: "running", startedAt });
  try {
    await run();
    await reportStep(ctx, {
      name,
      status: "done",
      startedAt,
      completedAt: deps.now(),
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await reportStep(ctx, {
      name,
      status: "failed",
      startedAt,
      completedAt: deps.now(),
      error: msg,
    });
    return { ok: false, error: msg };
  }
}

async function pollUntil(args: {
  stepName: string;
  timeoutMs: number;
  ctx: OperationContext;
  deps: RetireGatewayDeps;
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
