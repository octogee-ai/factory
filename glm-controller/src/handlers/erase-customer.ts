import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import type {
  OperationContext,
  OperationHandler,
  OperationResult,
} from "../operation-router.js";
import type { CustomerCleanupContext } from "./deprovision-customer.js";
import type { NukeCloudStepResult } from "../lib/customer-ops/nuke-cloud.js";

export interface ErasureDeletionJob {
  uid: string;
  status: string;
  eraseAfter: number;
  stripeCustomerId: string | null;
  cleanupContext: CustomerCleanupContext | null;
}

export interface EraseCustomerDeps {
  loadDeletionJob: (deletionId: string) => Promise<ErasureDeletionJob | null>;
  ensureAnonymousArchive: (deletionId: string) => Promise<string>;
  deleteStripeCustomer: (customerId: string) => Promise<void>;
  ensureDedicatedGatewayRetired: (
    cleanup: CustomerCleanupContext,
    deletionId: string,
  ) => Promise<"not-owned" | "retirement-pending" | "retired">;
  cloudErase: (
    cleanup: CustomerCleanupContext,
    currentOperationId: string,
  ) => Promise<NukeCloudStepResult[]>;
  verifyErasure: (
    uid: string,
    slug: string,
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

export function createEraseCustomerHandler(deps: EraseCustomerDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as EraseInput;
    const uid = typeof input.uid === "string" ? input.uid : null;
    const deletionId = typeof input.deletionId === "string" ? input.deletionId : null;
    if (!uid || !deletionId) {
      return { steps: [], success: false, error: "missing uid or deletionId in op.input" };
    }
    const job = await deps.loadDeletionJob(deletionId);
    if (!job || job.uid !== uid) {
      return { steps: [], success: false, error: `deletion job not found or mismatched: ${deletionId}` };
    }
    if (deps.now() < job.eraseAfter) {
      return { steps: [], success: false, error: "erasure started before the retention deadline" };
    }
    if (!job.cleanupContext || job.status !== "hibernating") {
      return {
        steps: [],
        success: false,
        error: "customer suspension cleanup context pending",
        output: { deletionFencePending: { deletionId } },
      };
    }

    const archiveId = await deps.ensureAnonymousArchive(deletionId);
    await report(ctx, deps, { name: "archive-operational-data", status: "done" });

    if (job.stripeCustomerId) {
      try {
        await deps.deleteStripeCustomer(job.stripeCustomerId);
        await report(ctx, deps, { name: "delete-stripe-customer", status: "done" });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await report(ctx, deps, { name: "delete-stripe-customer", status: "failed", error });
        return { steps: [], success: false, error };
      }
    } else {
      await report(ctx, deps, { name: "delete-stripe-customer", status: "skipped" });
    }

    const retirement = await deps.ensureDedicatedGatewayRetired(
      job.cleanupContext,
      deletionId,
    );
    if (retirement === "retirement-pending") {
      await report(ctx, deps, { name: "retire-dedicated-gateway", status: "running" });
      return {
        steps: [],
        success: false,
        error: "dedicated gateway retirement pending",
        output: { retirementFencePending: { deletionId } },
      };
    }
    await report(ctx, deps, {
      name: "retire-dedicated-gateway",
      status: retirement === "not-owned" ? "skipped" : "done",
    });

    const cloudResults = await deps.cloudErase(job.cleanupContext, op.id);
    for (const result of cloudResults) {
      await report(ctx, deps, {
        name: result.key,
        status: result.skipped ? "skipped" : result.ok ? "done" : "failed",
        ...(result.error ? { error: result.error } : {}),
      });
    }
    const failures = cloudResults.filter((result) => !result.ok && !result.skipped);
    if (failures.length > 0) {
      return {
        steps: [],
        success: false,
        error: failures.map((result) => `${result.key}: ${result.error}`).join("; "),
      };
    }

    const remaining = await deps.verifyErasure(uid, job.cleanupContext.slug, op.id);
    if (remaining.length > 0) {
      return {
        steps: [],
        success: false,
        error: `erasure verification found identifying references: ${remaining.join(", ")}`,
      };
    }
    await report(ctx, deps, { name: "verify-erasure", status: "done" });
    await deps.finalizeVerifiedErasure(deletionId, archiveId, op.id);
    await report(ctx, deps, { name: "destroy-identity-mapping", status: "done" });
    return {
      steps: [],
      success: true,
      output: { archiveId },
      scrubInputOnSuccess: true,
    };
  };
}
