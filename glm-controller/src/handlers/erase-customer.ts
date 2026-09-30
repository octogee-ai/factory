import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import type {
  OperationContext,
  OperationHandler,
  OperationResult,
} from "../operation-router.js";
import type { CustomerCleanupContext } from "./deprovision-customer.js";
import type { NukeCloudStepResult } from "../lib/customer-ops/nuke-cloud.js";
import {
  PostHogMergedIdentityError,
  PostHogRateLimitedError,
  type PostHogConfirmation,
} from "../lib/customer-ops/posthog-erasure.js";

export const POSTHOG_VERIFICATION_RECHECK_MS = 60 * 60_000;

export interface ErasureDeletionJob {
  uid: string;
  status: string;
  eraseAfter: number;
  stripeCustomerIds: string[];
  archiveId: string | null;
  cleanupContext: CustomerCleanupContext | null;
}

export interface EraseCustomerDeps {
  loadDeletionJob: (deletionId: string) => Promise<ErasureDeletionJob | null>;
  ensureAnonymousArchive: (deletionId: string) => Promise<string>;
  requestPostHogDeletion: (uid: string, deletionId: string) => Promise<{ skipped: boolean }>;
  confirmPostHogDeletion: (uid: string, deletionId: string) => Promise<PostHogConfirmation>;
  retainPostHogMappingOnly: (deletionId: string, archiveId: string) => Promise<void>;
  deleteStripeCustomer: (customerId: string) => Promise<void>;
  discoverStripeCustomerIds: (uid: string) => Promise<string[]>;
  persistStripeCustomerIds: (deletionId: string, customerIds: string[]) => Promise<void>;
  ensureOwnedGatewayRetired: (
    cleanup: CustomerCleanupContext,
    deletionId: string,
  ) => Promise<"not-owned" | "retirement-pending" | "retired">;
  findUndrainedArtifactIds: (artifactIds: string[]) => Promise<string[]>;
  cloudErase: (
    cleanup: CustomerCleanupContext,
    currentOperationId: string,
  ) => Promise<NukeCloudStepResult[]>;
  verifyErasure: (
    cleanup: CustomerCleanupContext,
    currentOperationId: string,
  ) => Promise<string[]>;
  finalizeVerifiedErasure: (
    deletionId: string,
    archiveId: string,
    currentOperationId: string,
  ) => Promise<void>;
  now: () => number;
}

interface EraseInput {
  uid?: unknown;
  deletionId?: unknown;
}

async function report(
  ctx: OperationContext,
  deps: EraseCustomerDeps,
  step: OperationStep,
): Promise<void> {
  await ctx.reportStep({ completedAt: deps.now(), ...step });
}

interface EraseCustomerContext {
  deletionId: string;
  job: ErasureDeletionJob;
  cleanup: CustomerCleanupContext;
}

interface PostHogConfirmationContext {
  deletionId: string;
  uid: string;
  archiveId: string;
}

type EraseCustomerLoadResult =
  | { kind: "context"; context: EraseCustomerContext }
  | { kind: "error"; error: OperationResult }
  | { kind: "awaiting-posthog"; confirmation: PostHogConfirmationContext }
  | { kind: "verified"; deletionId: string; archiveId: string };

async function loadEraseCustomerContext(
  op: Operation,
  deps: EraseCustomerDeps,
): Promise<EraseCustomerLoadResult> {
  const input = op.input as EraseInput;
  const uid = typeof input.uid === "string" ? input.uid : null;
  const deletionId = typeof input.deletionId === "string" ? input.deletionId : null;
  if (!uid || !deletionId) {
    return { kind: "error", error: { steps: [], success: false, error: "missing uid or deletionId in op.input" } };
  }
  const job = await deps.loadDeletionJob(deletionId);
  if (!job || job.uid !== uid) {
    return { kind: "error", error: { steps: [], success: false, error: `deletion job not found or mismatched: ${deletionId}` } };
  }
  if (deps.now() < job.eraseAfter) {
    return { kind: "error", error: { steps: [], success: false, error: "erasure started before the retention deadline" } };
  }
  if (job.status === "verified_pending_completion" && job.archiveId) {
    return { kind: "verified", deletionId, archiveId: job.archiveId };
  }
  if (job.status === "posthog_verification_pending" && job.archiveId) {
    return {
      kind: "awaiting-posthog",
      confirmation: { deletionId, uid, archiveId: job.archiveId },
    };
  }
  if (!job.cleanupContext || job.status !== "hibernating") {
    return {
      kind: "error",
      error: {
        steps: [],
        success: false,
        error: "customer suspension cleanup context pending",
        output: { deletionFencePending: { deletionId } },
      },
    };
  }
  return { kind: "context", context: { deletionId, job, cleanup: job.cleanupContext } };
}

function deletionBlocked(deletionId: string, step: string, error: string): OperationResult {
  return {
    steps: [],
    success: false,
    error,
    output: { deletionBlocked: { deletionId, step } },
  };
}

function cleanupRetry(deletionId: string, error: string): OperationResult {
  return {
    steps: [],
    success: false,
    error,
    output: { deletionCleanupRetry: { deletionId } },
  };
}

function postHogFailure(
  deletionId: string,
  step: string,
  err: unknown,
): OperationResult {
  const error = err instanceof Error ? err.message : String(err);
  if (err instanceof PostHogMergedIdentityError) return deletionBlocked(deletionId, step, error);
  const retry = cleanupRetry(deletionId, error);
  if (err instanceof PostHogRateLimitedError && err.retryAfterMs !== null) {
    return { ...retry, retryAfterMs: err.retryAfterMs };
  }
  return retry;
}

function verifiedErasureResult(deletionId: string, archiveId: string): OperationResult {
  return {
    steps: [],
    success: true,
    output: { archiveId, verifiedDeletion: { deletionId, archiveId } },
    scrubInputOnSuccess: true,
  };
}

async function eraseStripeCustomers(
  context: EraseCustomerContext,
  ctx: OperationContext,
  deps: EraseCustomerDeps,
): Promise<OperationResult | null> {
  try {
    const customerIds = [...new Set([
      ...context.job.stripeCustomerIds,
      ...await deps.discoverStripeCustomerIds(context.job.uid),
    ])].sort();
    await deps.persistStripeCustomerIds(context.deletionId, customerIds);
    for (const customerId of customerIds) await deps.deleteStripeCustomer(customerId);
    const deleted = new Set(customerIds);
    const remaining = (await deps.discoverStripeCustomerIds(context.job.uid))
      .filter((customerId) => !deleted.has(customerId));
    if (remaining.length > 0) {
      throw new Error(`Stripe customers remain: ${remaining.sort().join(", ")}`);
    }
    await report(ctx, deps, {
      name: "delete-stripe-customers",
      status: customerIds.length > 0 ? "done" : "skipped",
    });
    return null;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await report(ctx, deps, { name: "delete-stripe-customers", status: "failed", error });
    return cleanupRetry(context.deletionId, error);
  }
}

const REQUEST_POSTHOG_STEP = "request-posthog-person-deletion";
const CONFIRM_POSTHOG_STEP = "confirm-posthog-person-deletion";

async function requestPostHogDeletion(
  context: EraseCustomerContext,
  ctx: OperationContext,
  deps: EraseCustomerDeps,
): Promise<OperationResult | null> {
  try {
    const outcome = await deps.requestPostHogDeletion(context.job.uid, context.deletionId);
    await report(ctx, deps, {
      name: REQUEST_POSTHOG_STEP,
      status: outcome.skipped ? "skipped" : "done",
    });
    return null;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await report(ctx, deps, { name: REQUEST_POSTHOG_STEP, status: "failed", error });
    return postHogFailure(context.deletionId, REQUEST_POSTHOG_STEP, err);
  }
}

async function confirmPostHogAndFinalize(
  confirmation: PostHogConfirmationContext,
  op: Operation,
  ctx: OperationContext,
  deps: EraseCustomerDeps,
): Promise<OperationResult> {
  const { deletionId, uid, archiveId } = confirmation;
  let outcome: PostHogConfirmation;
  try {
    outcome = await deps.confirmPostHogDeletion(uid, deletionId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await report(ctx, deps, { name: CONFIRM_POSTHOG_STEP, status: "failed", error });
    return postHogFailure(deletionId, CONFIRM_POSTHOG_STEP, err);
  }
  if (outcome === "pending") {
    await report(ctx, deps, { name: CONFIRM_POSTHOG_STEP, status: "running" });
    return {
      steps: [],
      success: false,
      error: "PostHog event deletion verification is still pending",
      output: { postHogVerificationPending: { deletionId } },
      retryAfterMs: POSTHOG_VERIFICATION_RECHECK_MS,
    };
  }
  await report(ctx, deps, {
    name: CONFIRM_POSTHOG_STEP,
    status: outcome === "skipped" ? "skipped" : "done",
  });
  await deps.finalizeVerifiedErasure(deletionId, archiveId, op.id);
  await report(ctx, deps, { name: "destroy-identity-mapping", status: "done" });
  return verifiedErasureResult(deletionId, archiveId);
}

function cloudStepStatus(result: NukeCloudStepResult): OperationStep["status"] {
  if (result.skipped) return "skipped";
  return result.ok ? "done" : "failed";
}

async function reportCloudErasure(
  results: NukeCloudStepResult[],
  ctx: OperationContext,
  deps: EraseCustomerDeps,
): Promise<void> {
  for (const result of results) {
    await report(ctx, deps, {
      name: result.key,
      status: cloudStepStatus(result),
      ...(result.error ? { error: result.error } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    });
  }
}

async function runEraseCustomer(
  op: Operation,
  ctx: OperationContext,
  deps: EraseCustomerDeps,
): Promise<OperationResult> {
  const loaded = await loadEraseCustomerContext(op, deps);
  if (loaded.kind === "error") return loaded.error;
  if (loaded.kind === "verified") {
    return verifiedErasureResult(loaded.deletionId, loaded.archiveId);
  }
  if (loaded.kind === "awaiting-posthog") {
    return confirmPostHogAndFinalize(loaded.confirmation, op, ctx, deps);
  }
    const { deletionId, cleanup } = loaded.context;

    const archiveId = await deps.ensureAnonymousArchive(deletionId);
    await report(ctx, deps, { name: "archive-operational-data", status: "done" });

    const stripeFailure = await eraseStripeCustomers(loaded.context, ctx, deps);
    if (stripeFailure) return stripeFailure;

    const postHogFailure = await requestPostHogDeletion(loaded.context, ctx, deps);
    if (postHogFailure) return postHogFailure;

    const retirement = await deps.ensureOwnedGatewayRetired(cleanup, deletionId);
    if (retirement === "retirement-pending") {
      await report(ctx, deps, { name: "retire-owned-gateway", status: "running" });
      return {
        steps: [],
        success: false,
        error: "owned gateway retirement pending",
        output: { retirementFencePending: { deletionId } },
      };
    }
    await report(ctx, deps, {
      name: "retire-owned-gateway",
      status: retirement === "not-owned" ? "skipped" : "done",
    });

    const undrainedArtifactIds = await deps.findUndrainedArtifactIds(cleanup.chatArtifactIds);
    if (undrainedArtifactIds.length > 0) {
      await report(ctx, deps, { name: "drain-artifact-workers", status: "running" });
      return {
        steps: [],
        success: false,
        error: `artifact workers still hold leases: ${undrainedArtifactIds.join(", ")}`,
        output: { artifactDrainPending: { deletionId } },
      };
    }
    await report(ctx, deps, {
      name: "drain-artifact-workers",
      status: cleanup.chatArtifactIds.length > 0 ? "done" : "skipped",
    });

    const cloudResults = await deps.cloudErase(cleanup, op.id);
    await reportCloudErasure(cloudResults, ctx, deps);
    const failures = cloudResults.filter((result) => !result.ok && !result.skipped);
    if (failures.length > 0) {
      return cleanupRetry(
        deletionId,
        failures.map((result) => `${result.key}: ${result.error}`).join("; "),
      );
    }

    const remaining = await deps.verifyErasure(cleanup, op.id);
    if (remaining.length > 0) {
      return cleanupRetry(
        deletionId,
        `erasure verification found identifying references: ${remaining.join(", ")}`,
      );
    }
    await report(ctx, deps, { name: "verify-erasure", status: "done" });
    await deps.retainPostHogMappingOnly(deletionId, archiveId);
    return confirmPostHogAndFinalize(
      { deletionId, uid: loaded.context.job.uid, archiveId },
      op,
      ctx,
      deps,
    );
}

export function createEraseCustomerHandler(deps: EraseCustomerDeps): OperationHandler {
  return (op, ctx) => runEraseCustomer(op, ctx, deps);
}
