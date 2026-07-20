import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import type {
  OperationContext,
  OperationHandler,
  OperationResult,
} from "../operation-router.js";
import type { CustomerCleanupContext } from "./deprovision-customer.js";
import type { UnmountOutcome } from "../lib/customer-ops/unmount-gateway.js";

export interface CustomerDeletionJobForSuspension {
  uid: string;
  slug: string | null;
  currentGatewayId: string | null;
  stripeSubscriptionId: string | null;
  cleanupContext: CustomerCleanupContext | null;
}

export interface CustomerSuspensionDeps {
  loadDeletionJob: (
    deletionId: string,
  ) => Promise<CustomerDeletionJobForSuspension | null>;
  loadCleanupContext: (uid: string) => Promise<CustomerCleanupContext | null>;
  persistCleanupContext: (
    deletionId: string,
    cleanup: CustomerCleanupContext,
  ) => Promise<void>;
  suspendAuthUser: (uid: string) => Promise<void>;
  unmountFromGateway: (
    gatewayId: string,
    slug: string,
  ) => Promise<UnmountOutcome>;
  cancelStripeSubscription: (subscriptionId: string) => Promise<void>;
  revokeConnectorGrants: (uid: string) => Promise<void>;
  revokeModelBrokerAccess: (uid: string) => Promise<void>;
  disableAutoTopUp: (uid: string) => Promise<void>;
  deleteCredentialSecrets: (secretNames: string[]) => Promise<void>;
  pauseOwnedDedicatedGateway: (gatewayId: string, uid: string) => Promise<void>;
  markSuspended: (deletionId: string) => Promise<void>;
  now: () => number;
}

interface SuspensionInput {
  uid?: unknown;
  deletionId?: unknown;
}

async function report(
  ctx: OperationContext,
  deps: CustomerSuspensionDeps,
  step: OperationStep,
): Promise<void> {
  await ctx.reportStep({ completedAt: deps.now(), ...step });
}

export function createSuspendCustomerHandler(
  deps: CustomerSuspensionDeps,
): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as SuspensionInput;
    const uid = typeof input.uid === "string" ? input.uid : null;
    const deletionId = typeof input.deletionId === "string" ? input.deletionId : null;
    if (!uid || !deletionId) {
      return { steps: [], success: false, error: "missing uid or deletionId in op.input" };
    }
    const job = await deps.loadDeletionJob(deletionId);
    if (!job || job.uid !== uid) {
      return { steps: [], success: false, error: `deletion job not found or mismatched: ${deletionId}` };
    }
    let cleanup = job.cleanupContext;
    if (!cleanup) {
      const loaded = await deps.loadCleanupContext(uid);
      if (!loaded) {
        return { steps: [], success: false, error: `cleanup context unavailable for ${uid}` };
      }
      cleanup = {
        ...loaded,
        currentGatewayId: job.currentGatewayId ?? loaded.currentGatewayId,
      };
      await deps.persistCleanupContext(deletionId, cleanup);
      await report(ctx, deps, { name: "capture-cleanup-context", status: "done" });
    } else {
      await report(ctx, deps, { name: "capture-cleanup-context", status: "skipped" });
    }

    const failures: string[] = [];
    const run = async (name: string, action: () => Promise<unknown>): Promise<void> => {
      try {
        await action();
        await report(ctx, deps, { name, status: "done" });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failures.push(`${name}: ${error}`);
        await report(ctx, deps, { name, status: "failed", error });
      }
    };
    const skip = (name: string) => report(ctx, deps, { name, status: "skipped" });

    await run("suspend-auth", () => deps.suspendAuthUser(uid));
    if (cleanup.currentGatewayId && cleanup.slug) {
      await run("unmount-gateway", () =>
        deps.unmountFromGateway(cleanup.currentGatewayId!, cleanup.slug));
      await run("pause-dedicated-gateway", () =>
        deps.pauseOwnedDedicatedGateway(cleanup.currentGatewayId!, uid));
    } else {
      await skip("unmount-gateway");
      await skip("pause-dedicated-gateway");
    }
    if (job.stripeSubscriptionId) {
      await run("cancel-stripe-subscription", () =>
        deps.cancelStripeSubscription(job.stripeSubscriptionId!));
    } else {
      await skip("cancel-stripe-subscription");
    }
    await run("revoke-connector-grants", () => deps.revokeConnectorGrants(uid));
    await run("revoke-model-broker", () => deps.revokeModelBrokerAccess(uid));
    await run("disable-auto-top-up", () => deps.disableAutoTopUp(uid));
    await run("delete-credential-secrets", () =>
      deps.deleteCredentialSecrets(cleanup.credentialSecretNames));

    if (failures.length > 0) {
      return { steps: [], success: false, error: failures.join("; ") };
    }
    await deps.markSuspended(deletionId);
    await report(ctx, deps, { name: "mark-suspended", status: "done" });
    return { steps: [], success: true };
  };
}
