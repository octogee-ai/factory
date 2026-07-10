import type { Operation, OperationStep, StepStatus } from "@octogee/shared/types/glm";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { HelmRunner } from "../helm-runner.js";

const UNKNOWN_ERROR = "unknown error";

export interface GatewayLiveState {
  mountedCustomers: string[];
}

export interface RetireGatewayDeps {
  helm: Pick<HelmRunner, "readDeployedInstances">;

  readGatewayLiveState: (gatewayId: string) => Promise<GatewayLiveState | null>;

  deleteGlmGateway: (gatewayId: string) => Promise<void>;

  deleteGatewayHeartbeat: (gatewayId: string) => Promise<void>;

  // Write the revision_gone tombstone for a revision being torn down, so a
  // subsequent revision-pinned `/g/<gw>/r/<n>/…` request answers with the typed
  // revision_gone 404 instead of dialing the now-dead pod. Called with the
  // glmGateways doc id (== revisionId in the new model) BEFORE the doc is
  // deleted; a no-op for a legacy bare gateway that has no /r/<n> addressing.
  // (The roll source-drain retire in PR7 uses the same writer.)
  writeRevisionTombstone?: (revisionId: string) => Promise<void>;

  readGatewayHeartbeatExists?: (gatewayId: string) => Promise<boolean>;

  // Teardown of the per-gateway runtime resources is structurally required.
  deleteGatewayPersistentVolumeClaim: (gatewayId: string) => Promise<void>;
  deleteGatewayKubeSecret: (gatewayId: string) => Promise<void>;
  deleteAuthTokenSecret: (gatewayId: string) => Promise<void>;
  deleteGatewayServiceAccount: (gatewayId: string) => Promise<void>;
  deleteGatewayEdgeService: (gatewayId: string) => Promise<void>;
  deleteGatewayModelKeyKubeSecret: (gatewayId: string) => Promise<void>;
  deleteGatewayModelKeySource: (gatewayId: string) => Promise<void>;

  // Optional, operator-only, best-effort: delete the per-gateway GSA (deleting
  // the service account also removes its Workload-Identity binding). No-op when
  // no GSA exists for the gateway (cattle gateways never have one).
  teardownGatewayServiceAccount?: (gatewayId: string) => Promise<void>;

  // Full-gateway retirement drains every revision before scoped teardown.

  // Assignment docs for the gateway (gateways/{id}/assignments/*). Retirement
  // refuses while any exists — customers must be migrated off first.
  readAssignmentsForGateway: (
    gatewayId: string,
  ) => Promise<Array<{ uid: string; slug: string }>>;

  // Every non-retired revision realization doc for the gateway (glmGateways
  // where gateway == id, lifecycle != retired).
  readNonRetiredRevisions: (
    gatewayId: string,
  ) => Promise<Array<{ revisionId: string; release: number }>>;

  // Revision-scoped Helm uninstall (octogee-gw-{revisionId}) — must tolerate an
  // already-absent release so a crashed retire re-drives cleanly.
  helmUninstallRevision: (revisionId: string) => Promise<void>;

  revokeRevisionMacOpsTokens: (input: {
    gatewayId: string;
    revisionId: string;
  }) => Promise<void>;

  revokeGatewayLegacyMacOpsTokens: (input: { gatewayId: string }) => Promise<void>;

  // Mark the revision doc retired (lifecycle retired + retiredAt + retireReason).
  // The doc is RETAINED (never deleted), matching the roll's source retirement.
  retireRevisionDoc: (revisionId: string, reason: string) => Promise<void>;

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

type RetireGatewayRequest =
  | { error: string }
  | {
      gatewayId: string;
      retainData: boolean;
      retainServiceAccount: boolean;
    };

interface PollResult {
  ok: boolean;
  errorMsg?: string;
}

interface StepResult {
  ok: boolean;
  error?: string;
}

const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function shouldRetainData(input: RetireGatewayInput): boolean {
  return input.retainData === true;
}

function shouldRetainServiceAccount(input: RetireGatewayInput): boolean {
  return input.retainServiceAccount === true;
}

function failure(error: string): OperationResult {
  return { steps: [], success: false, error };
}

function resolveRetireGatewayRequest(input: RetireGatewayInput): RetireGatewayRequest {
  const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
  if (!gatewayId) return { error: "missing gatewayId in op.input" };
  if (!isValidGatewayId(gatewayId)) {
    return { error: `invalid gatewayId in op.input: "${gatewayId}"` };
  }
  return {
    gatewayId,
    retainData: shouldRetainData(input),
    retainServiceAccount: shouldRetainServiceAccount(input),
  };
}

export function createRetireGatewayHandler(deps: RetireGatewayDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const request = resolveRetireGatewayRequest(op.input as RetireGatewayInput);
    if ("error" in request) return failure(request.error);
    const { gatewayId, retainData, retainServiceAccount } = request;

    // Refuse while any customer is still assigned — the operator must migrate
    // them off first. Naming the slugs makes the next action obvious.
    const assignmentFailure = await assertNoAssignments(deps, gatewayId);
    if (assignmentFailure) return assignmentFailure;

    const liveFailure = await assertGatewayRetirable(deps, gatewayId);
    if (liveFailure) return liveFailure;

    // Drain every non-retired revision (uninstall octogee-gw-{revisionId} +
    // tombstone + retire the revision doc) BEFORE any gateway-scoped teardown.
    // Level-triggered: a crash after some revisions retire converges on the next
    // tick (already-retired revisions drop out of the enumeration); the
    // gateway-scoped teardown below is UNREACHABLE while any revision lives.
    const revisionFailure = await drainRevisions(ctx, deps, gatewayId);
    if (revisionFailure) return revisionFailure;

    let resolvedGatewayId = await deps.readGlmGatewayId(gatewayId);
    if (!resolvedGatewayId) {
      if (await helmHasInstance(deps, gatewayId)) {
        return failure(
          `glmGateways/${gatewayId} not found and helm release still exists — cannot retire safely`,
        );
      }
      deps.log(
        `[retire-gateway] glmGateways/${gatewayId} already deleted and helm release is absent — finishing cleanup from operation input`,
      );
      resolvedGatewayId = gatewayId;
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

    const legacyTokenFailure = await revokeLegacyMacOpsTokens(ctx, deps, gatewayId);
    if (legacyTokenFailure) return legacyTokenFailure;

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

async function helmHasInstance(deps: RetireGatewayDeps, gatewayId: string): Promise<boolean> {
  const map = await deps.helm.readDeployedInstances({ namespace: NAMESPACE });
  return Object.prototype.hasOwnProperty.call(map, gatewayId);
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
    await collectTeardownError(ctx, deps, errors, "delete-pvc", () =>
      deps.deleteGatewayPersistentVolumeClaim(gatewayId),
    );
  }

  await collectTeardownError(ctx, deps, errors, "delete-kube-secret", () =>
    deps.deleteGatewayKubeSecret(gatewayId),
  );
  await collectTeardownError(ctx, deps, errors, "delete-sm-secret", () =>
    deps.deleteAuthTokenSecret(gatewayId),
  );
  await collectTeardownError(ctx, deps, errors, "delete-ksa", () =>
    deps.deleteGatewayServiceAccount(gatewayId),
  );
  await collectTeardownError(ctx, deps, errors, "delete-edge-service", () =>
    deps.deleteGatewayEdgeService(gatewayId),
  );
  await collectTeardownError(
    ctx,
    deps,
    errors,
    "delete-model-key-kube-secret",
    () => deps.deleteGatewayModelKeyKubeSecret(gatewayId),
  );
  await collectTeardownError(ctx, deps, errors, "delete-model-key-source", () =>
    deps.deleteGatewayModelKeySource(gatewayId),
  );

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
    await collectTeardownError(ctx, deps, errors, "teardown-gsa", () =>
      teardownGsa(gatewayId),
    );
  }

  return errors;
}

async function collectTeardownError(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
  errors: string[],
  stepName: string,
  action: () => Promise<void>,
): Promise<void> {
  const result = await runReportedStep(ctx, deps, stepName, action);
  if (!result.ok) errors.push(`${stepName}: ${result.error ?? UNKNOWN_ERROR}`);
}

async function assertNoAssignments(
  deps: RetireGatewayDeps,
  gatewayId: string,
): Promise<OperationResult | null> {
  const assignments = await deps.readAssignmentsForGateway(gatewayId);
  if (assignments.length === 0) return null;
  const slugs = assignments.map((a) => a.slug).sort(compareStrings);
  return failure(
    `gateway ${gatewayId} still has ${assignments.length} assigned customer(s): ` +
      `${slugs.join(", ")} — migrate them off before retiring`,
  );
}

// Retire every non-retired revision before any gateway-scoped teardown. Each
// revision's teardown (helm uninstall → tombstone → retire doc) is one reported
// step, aggregate-gated like resource teardown: a failure preserves the revision
// for retry and short-circuits BEFORE gateway-scoped teardown. After the loop we
// re-read: any revision still live (a fresh doc written mid-retire, or a step
// that silently no-op'd) blocks the gateway-scoped phase, converging next tick.
async function drainRevisions(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
  gatewayId: string,
): Promise<OperationResult | null> {
  const revisions = await deps.readNonRetiredRevisions(gatewayId);
  const sorted = [...revisions].sort((a, b) => compareStrings(a.revisionId, b.revisionId));
  const errors: string[] = [];
  for (const rev of sorted) {
    const r = await runReportedStep(ctx, deps, `retire-revision:${rev.revisionId}`, async () => {
      // Tolerates an already-absent Helm release (crash-resume) by contract.
      await deps.helmUninstallRevision(rev.revisionId);
      await deps.revokeRevisionMacOpsTokens({
        gatewayId,
        revisionId: rev.revisionId,
      });
      // Tombstone while the revision doc is still non-retired, so the writer can
      // read its release/gateway to key the revision_gone 404.
      await deps.writeRevisionTombstone?.(rev.revisionId);
      await deps.retireRevisionDoc(rev.revisionId, "gateway-retire");
    });
    if (!r.ok) errors.push(`${rev.revisionId}: ${r.error ?? UNKNOWN_ERROR}`);
  }
  if (errors.length > 0) {
    return failure(
      `revision teardown incomplete (gateway-scoped resources preserved): ${errors.join("; ")}`,
    );
  }
  const remaining = await deps.readNonRetiredRevisions(gatewayId);
  if (remaining.length > 0) {
    return failure(
      `revisions still non-retired after drain: ${remaining
        .map((r) => r.revisionId)
        .join(", ")} — converging next tick before gateway-scoped teardown`,
    );
  }
  return null;
}

async function revokeLegacyMacOpsTokens(
  ctx: OperationContext,
  deps: RetireGatewayDeps,
  gatewayId: string,
): Promise<OperationResult | null> {
  const result = await runReportedStep(ctx, deps, "revoke-legacy-mac-ops-token", () =>
    deps.revokeGatewayLegacyMacOpsTokens({ gatewayId }),
  );
  return result.ok
    ? null
    : failure(`legacy Mac ops token revoke failed: ${result.error ?? UNKNOWN_ERROR}`);
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
    // Tombstone BEFORE the revision doc is deleted, so the writer can still read
    // its release/gateway to key the tombstone and resolve the current-revision
    // pointer.
    await deps.writeRevisionTombstone?.(gatewayId);
    await deps.deleteGlmGateway(gatewayId);
    await deps.deleteGatewayHeartbeat(gatewayId);
  });
  return result.ok
    ? null
    : failure(`cleanup failed after teardown: ${result.error ?? UNKNOWN_ERROR}`);
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
      `[retire-gateway] heartbeat-quiesce failed for ${gatewayId} (reaper will heal within 60s): ${result.error ?? UNKNOWN_ERROR}`,
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
    `[retire-gateway] cleanup committed but fleet-ingress sync failed; reconciler will heal within 30s — ${result.error ?? UNKNOWN_ERROR}`,
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
