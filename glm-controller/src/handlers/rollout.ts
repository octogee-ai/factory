import type { Operation, OperationStep, StepStatus } from "@octogee/shared/types/glm";
import type { GatewayDoc, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";

// The rollout op is a THIN release-roll driver (GATEWAY-RELEASES-SPEC delivery
// item 7). The admin wrapper cuts the release + sets desiredRelease; the
// reconciler's roll arm (converge-roll.ts) does ALL the work, level-triggered
// from durable state. This handler only:
//   1. refuses an un-backfilled gateway (no gateways/{id} desired doc) with the
//      backfill tool named — the guard that replaced the legacy suffix
//      blue/green path outright;
//   2. confirms the desired release records the requested image (tolerating
//      the enqueue/record race);
//   3. kicks a reconcile tick and awaits convergence, narrating roll-status
//      transitions and surfacing the roll's durable error on failure.
// The op holds the queue's rollout single-flight while it waits; a controller
// restart re-drives it idempotently (RESUMABLE_OP_KINDS) — the roll itself
// never depends on this op's lifetime.

export interface RolloutDeps {
  // gateways/{id} filtered through isGatewayDesiredDoc — null for legacy
  // (un-backfilled) gateways.
  readGatewayDoc: (gatewayId: string) => Promise<GatewayDoc | null>;
  readReleasePayload: (gatewayId: string, release: number) => Promise<ReleasePayload | null>;
  requestReconcileTick?: () => void;
  // How long the desired release may lag the requested image before the op
  // fails (the admin wrapper writes the release right after enqueuing the op).
  releaseRecordTimeoutMs: number;
  convergeTimeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

interface RolloutInput {
  gatewayId?: unknown;
  imageTag?: unknown;
}

function fail(error: string): OperationResult {
  return { steps: [], success: false, error };
}

function converged(gw: GatewayDoc): boolean {
  return gw.liveRelease === gw.desiredRelease && gw.roll == null;
}

export function createRolloutHandler(deps: RolloutDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as RolloutInput;
    const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
    const imageTag = typeof input.imageTag === "string" ? input.imageTag : undefined;
    if (!gatewayId) return fail("missing gatewayId in op.input");
    if (!imageTag) return fail("missing imageTag in op.input");

    const gateway = await deps.readGatewayDoc(gatewayId);
    if (!gateway) {
      return fail(
        `gateway ${gatewayId} has no durable gateways/${gatewayId} desired doc — release rolls ` +
          `require the Step 2 identity backfill; run scripts/ops/backfill-gateway-identity.ts ` +
          `(dry-run first), then re-roll`,
      );
    }
    if (gateway.desiredStatus === "retired") {
      return fail(`gateway ${gatewayId} is retired — cannot roll`);
    }

    deps.requestReconcileTick?.();
    const startedAt = deps.now();
    await reportStep(ctx, { name: "release-roll", status: "running", startedAt });

    const outcome = await awaitConvergence(deps, gatewayId, imageTag, startedAt);
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

interface RollNarration {
  lastStatus: string | null;
  lastError: string | null;
}

async function awaitConvergence(
  deps: RolloutDeps,
  gatewayId: string,
  imageTag: string,
  startedAt: number,
): Promise<{ success: boolean; error?: string }> {
  const narration: RollNarration = { lastStatus: null, lastError: null };
  for (;;) {
    const gw = await deps.readGatewayDoc(gatewayId);
    if (!gw) {
      return { success: false, error: `gateway ${gatewayId} desired doc disappeared mid-roll` };
    }
    const payload = await deps.readReleasePayload(gatewayId, gw.desiredRelease);
    const elapsed = deps.now() - startedAt;
    const outcome = assessRollOutcome(deps, {
      gw,
      gatewayId,
      imageTag,
      elapsed,
      recordedImageTag: payload?.imageTag ?? null,
    });
    if (outcome) return outcome;

    narrateRollProgress(deps, gatewayId, gw, narration);
    if (elapsed >= deps.convergeTimeoutMs) {
      return {
        success: false,
        error:
          `roll of ${gatewayId} to ${imageTag} did not converge within ${deps.convergeTimeoutMs}ms` +
          timeoutContext(narration),
      };
    }
    await deps.wait(deps.pollIntervalMs);
  }
}

function assessRollOutcome(
  deps: RolloutDeps,
  input: {
    gw: GatewayDoc;
    gatewayId: string;
    imageTag: string;
    elapsed: number;
    recordedImageTag: string | null;
  },
): { success: boolean; error?: string } | null {
  const { gw, gatewayId, imageTag } = input;
  if (input.recordedImageTag !== imageTag) {
    if (input.elapsed < deps.releaseRecordTimeoutMs) return null;
    return {
      success: false,
      error:
        `desiredRelease ${gw.desiredRelease} of ${gatewayId} records image ` +
        `${input.recordedImageTag ?? "none"}, not the requested ${imageTag} — the release cut ` +
        `failed or a newer release superseded this rollout`,
    };
  }
  if (gw.roll?.status === "failed") {
    return { success: false, error: gw.roll.error ?? `roll to r${gw.desiredRelease} failed` };
  }
  if (converged(gw)) {
    deps.log(`[rollout] ${gatewayId} converged onto release ${gw.liveRelease} (${imageTag})`);
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
  if (gw.roll && gw.roll.status !== narration.lastStatus) {
    narration.lastStatus = gw.roll.status;
    deps.log(
      `[rollout] ${gatewayId} roll r${gw.roll.fromRelease ?? "-"} → r${gw.roll.toRelease}: ${gw.roll.status}`,
    );
  }
  if (gw.roll?.error && gw.roll.error !== narration.lastError) {
    narration.lastError = gw.roll.error;
    deps.log(`[rollout] ⚠ ${gatewayId} roll holds: ${narration.lastError}`);
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
