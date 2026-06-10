import type { Operation, OperationStep, StepStatus } from "../../../shared/types/glm.js";
import { isValidGatewayId } from "../../../shared/types/glm.js";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { HelmRunner } from "../helm-runner.js";

export interface GatewayLiveState {
  mountedCustomers: string[];
}

export interface RetireGatewayDeps {
  helm: Pick<HelmRunner, "readDeployedInstances">;

  readGatewayLiveState: (gatewayId: string) => Promise<GatewayLiveState | null>;

  deleteGlmGateway: (gatewayId: string) => Promise<void>;

  deleteGatewayHeartbeat: (gatewayId: string) => Promise<void>;

  readGatewayHeartbeatExists?: (gatewayId: string) => Promise<boolean>;

  // Teardown of the per-gateway runtime resources. All three are REQUIRED —
  // the teardown-completeness invariant is structural: a retire handler that
  // forgets to remove the PVC or either auth-token secret cannot be
  // constructed. (Mirror of provisioning: provisionGatewayAuthSecret +
  // ensureAuthSecret + the chart PVC created these; decommission removes them.)
  deleteGatewayPersistentVolumeClaim: (gatewayId: string) => Promise<void>;
  deleteGatewayKubeSecret: (gatewayId: string) => Promise<void>;
  deleteAuthTokenSecret: (gatewayId: string) => Promise<void>;

  // Optional, operator-only, best-effort: delete the per-gateway GSA (deleting
  // the service account also removes its Workload-Identity binding). No-op when
  // no GSA exists for the gateway (cattle gateways never have one).
  teardownGatewayServiceAccount?: (gatewayId: string) => Promise<void>;

  readGlmGatewayId: (gatewayId: string) => Promise<string | null>;

  syncFleetIngress: () => Promise<void>;
  helmUninstallTimeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

interface RetireGatewayInput {
  gatewayId?: unknown;
  retainData?: unknown;
  retainServiceAccount?: unknown;
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

function shouldRetainData(input: RetireGatewayInput): boolean {
  return input.retainData === true;
}

function shouldRetainServiceAccount(input: RetireGatewayInput): boolean {
  return input.retainServiceAccount === true;
}

function failure(error: string): OperationResult {
  return { steps: [], success: false, error };
}

export function createRetireGatewayHandler(deps: RetireGatewayDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as RetireGatewayInput;
    const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
    if (!gatewayId) return failure("missing gatewayId in op.input");
    if (!isValidGatewayId(gatewayId)) {
      return failure(`invalid gatewayId in op.input: "${gatewayId}"`);
    }
    const retainData = shouldRetainData(input);
    const retainServiceAccount = shouldRetainServiceAccount(input);

    const liveFailure = await assertGatewayRetirable(deps, gatewayId);
    if (liveFailure) return liveFailure;

    const resolvedGatewayId = await deps.readGlmGatewayId(gatewayId);
    if (!resolvedGatewayId) {
      return failure(
        `glmGateways/${gatewayId} not found — cannot determine gatewayId for helm uninstall`,
      );
    }
    // Teardown targets resources named from resolvedGatewayId but removes
    // records by the input gatewayId — they must be the same gateway, or a
    // mismatched doc would delete one gateway's records while clearing
    // another's resources.
    if (resolvedGatewayId !== gatewayId) {
      return failure(
        `glmGateways/${gatewayId}.gatewayId is "${resolvedGatewayId}" — refusing teardown under a mismatched id`,
      );
    }

    // 1. Stop the workload first — nothing must be holding the PVC / secrets /
    //    service account when we delete them.
    const helmResult = await pollUntil({
      stepName: "helm-uninstall",
      timeoutMs: deps.helmUninstallTimeoutMs,
      ctx,
      deps,
      check: async () => {
        const map = await deps.helm.readDeployedInstances({ namespace: NAMESPACE });
        return !Object.prototype.hasOwnProperty.call(map, resolvedGatewayId);
      },
      timeoutMessage: `helm did not uninstall instance "${resolvedGatewayId}" within ${deps.helmUninstallTimeoutMs}ms`,
    });
    if (!helmResult.ok) {
      return failure(helmResult.errorMsg ?? "helm uninstall failed");
    }

    // 2. Tear down the per-gateway resources. Steps are independent and
    //    best-effort: every one is attempted even if a prior one failed (D4),
    //    so a single stuck resource cannot strand the rest. Records are NOT
    //    removed until all gating teardown succeeds, so a partial failure
    //    leaves the operation re-drivable from glmGateways/<id>.
    const teardownErrors = await teardownResources(
      ctx,
      deps,
      resolvedGatewayId,
      retainData,
      retainServiceAccount,
    );
    if (teardownErrors.length > 0) {
      return failure(
        `teardown incomplete (records preserved for retry): ${teardownErrors.join("; ")}`,
      );
    }

    // 3. Remove the control-plane records last.
    const cleanupFailure = await cleanupGatewayRecords(ctx, deps, gatewayId);
    if (cleanupFailure) return cleanupFailure;

    await quiesceGatewayHeartbeat(ctx, deps, gatewayId);

    const ingressFailure = await syncFleetIngress(ctx, deps);
    if (ingressFailure) return ingressFailure;

    return { steps: [], success: true };
  };
}

async function teardownResources(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
  gatewayId: string,
  retainData: boolean,
  retainServiceAccount: boolean,
): Promise<string[]> {
  const errors: string[] = [];

  if (retainData) {
    deps.log(`[retire-gateway] retainData set — preserving PVC for ${gatewayId}`);
  } else {
    const r = await runReportedStep(ctx, deps, "delete-pvc", () =>
      deps.deleteGatewayPersistentVolumeClaim(gatewayId),
    );
    if (!r.ok) errors.push(`delete-pvc: ${r.error ?? "unknown error"}`);
  }

  const kube = await runReportedStep(ctx, deps, "delete-kube-secret", () =>
    deps.deleteGatewayKubeSecret(gatewayId),
  );
  if (!kube.ok) errors.push(`delete-kube-secret: ${kube.error ?? "unknown error"}`);

  const sm = await runReportedStep(ctx, deps, "delete-sm-secret", () =>
    deps.deleteAuthTokenSecret(gatewayId),
  );
  if (!sm.ok) errors.push(`delete-sm-secret: ${sm.error ?? "unknown error"}`);

  // GSA teardown: a non-404 failure means a per-gateway GSA (a standing IAM
  // principal — the exact thing decommission must remove) is still live, so it
  // is aggregate-gated like the other resources (the op fails and is
  // re-drivable). A 404 "no GSA" is a clean no-op in gateway-gsa.ts, so cattle
  // gateways still pass. retainServiceAccount skips it entirely — for a
  // terraform-managed GSA (gw-bender), decommissioned via terraform, not here.
  const teardownGsa = deps.teardownGatewayServiceAccount;
  if (retainServiceAccount) {
    deps.log(
      `[retire-gateway] retainServiceAccount set — leaving the per-gateway GSA in place for ${gatewayId}`,
    );
  } else if (teardownGsa) {
    const gsa = await runReportedStep(ctx, deps, "teardown-gsa", () => teardownGsa(gatewayId));
    if (!gsa.ok) errors.push(`teardown-gsa: ${gsa.error ?? "unknown error"}`);
  }

  return errors;
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
  return null;
}

async function cleanupGatewayRecords(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
  gatewayId: string,
): Promise<OperationResult | null> {
  const result = await runReportedStep(ctx, deps, "cleanup", async () => {
    await deps.deleteGlmGateway(gatewayId);
    await deps.deleteGatewayHeartbeat(gatewayId);
  });
  return result.ok
    ? null
    : failure(`cleanup failed after teardown: ${result.error ?? "unknown error"}`);
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
