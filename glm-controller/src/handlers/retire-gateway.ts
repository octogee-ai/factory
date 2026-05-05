import type { Operation, OperationStep, StepStatus } from "../../../shared/types/glm.js";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { HelmRunner } from "../helm-runner.js";

export interface GatewayLiveState {
  mountedCustomers: string[];
  inFlightJobId: string | null;
}

export interface RetireGatewayDeps {
  helm: Pick<HelmRunner, "readDeployedInstances">;
  /**
   * Reads the gateway's heartbeat doc — null when it doesn't exist (gateway
   * never started; safe to retire). Returns the slug list AND the
   * inFlightJobId so the handler can refuse retire mid-restore.
   */
  readGatewayLiveState: (gatewayId: string) => Promise<GatewayLiveState | null>;
  /** Removes glmGateways/{id} after helm uninstalls. */
  deleteGlmGateway: (gatewayId: string) => Promise<void>;
  /** Removes the heartbeat doc gateways/{id}. */
  deleteGatewayHeartbeat: (gatewayId: string) => Promise<void>;
  /**
   * Optional: disables versions on the per-gateway SM auth-token. Skip
   * to leave the secret resource in place — re-creating the gateway with
   * the same id will re-use it (idempotent on Add Gateway). The auth
   * token itself is rotated by the gateway pod on every boot, so a
   * lingering archived secret is not a security risk.
   */
  archiveAuthTokenSecret?: (gatewayId: string) => Promise<void>;
  /** Reads glmGateways/{id} so we can map gatewayId → instanceName for the helm-uninstall poll. */
  readGlmGatewayInstanceName: (gatewayId: string) => Promise<string | null>;
  helmUninstallTimeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

interface RetireGatewayInput {
  gatewayId?: unknown;
}

interface PollResult {
  ok: boolean;
  errorMsg?: string;
}

const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";

export function createRetireGatewayHandler(deps: RetireGatewayDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as RetireGatewayInput;
    const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
    if (!gatewayId) return { steps: [], success: false, error: "missing gatewayId in op.input" };

    const live = await deps.readGatewayLiveState(gatewayId);
    if (live != null) {
      if (live.mountedCustomers.length > 0) {
        return {
          steps: [],
          success: false,
          error: `gateway ${gatewayId} still has ${live.mountedCustomers.length} mounted customer(s): ${live.mountedCustomers.join(", ")}`,
        };
      }
      if (live.inFlightJobId) {
        return {
          steps: [],
          success: false,
          error: `gateway ${gatewayId} has an in-flight restore job ${live.inFlightJobId}; refusing to retire mid-mount`,
        };
      }
    }
    // null live state → gateway never started; safe to retire (no pod, no
    // customers, nothing to drain).

    const instanceName = await deps.readGlmGatewayInstanceName(gatewayId);
    if (!instanceName) {
      return {
        steps: [],
        success: false,
        error: `glmGateways/${gatewayId} not found — cannot determine instanceName for helm uninstall`,
      };
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
      return { steps: [], success: false, error: helmResult.errorMsg };
    }

    const cleanupStartedAt = deps.now();
    await reportStep(ctx, { name: "cleanup", status: "running", startedAt: cleanupStartedAt });
    try {
      // Order matters: glmGateways FIRST so the desired-state record
      // disappears even if heartbeat delete fails partway. Subsequent
      // re-add of the same gatewayId would otherwise 409 forever on a
      // lingering retired desired-state doc.
      await deps.deleteGlmGateway(gatewayId);
      await deps.deleteGatewayHeartbeat(gatewayId);
      if (deps.archiveAuthTokenSecret) {
        await deps.archiveAuthTokenSecret(gatewayId);
      }
      await reportStep(ctx, {
        name: "cleanup",
        status: "done",
        startedAt: cleanupStartedAt,
        completedAt: deps.now(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reportStep(ctx, {
        name: "cleanup",
        status: "failed",
        startedAt: cleanupStartedAt,
        completedAt: deps.now(),
        error: msg,
      });
      return {
        steps: [],
        success: false,
        error: `cleanup failed after helm uninstall: ${msg}`,
      };
    }

    return { steps: [], success: true };
  };
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
