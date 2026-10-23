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
  stripeCustomerIds: string[];
  stripeSubscriptionIds: string[];
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
  assertRestoreNotInProgress: (uid: string) => Promise<void>;
  suspendAuthUser: (uid: string) => Promise<void>;
  cancelCustomerMigrations: (uid: string, deletionId: string) => Promise<void>;
  deactivateCustomerVisibility: (uid: string) => Promise<void>;
  invalidatePendingCredentialFlows: (uid: string) => Promise<void>;
  unmountFromGateway: (
    gatewayId: string,
    slug: string,
  ) => Promise<UnmountOutcome>;
  releasePlacement: (uid: string, capturedGatewayId: string | null) => Promise<void>;
  cancelStripeSubscription: (subscriptionId: string) => Promise<void>;
  listStripeCustomerIdsForUid: (uid: string) => Promise<string[]>;
  listLiveStripeSubscriptionIds: (customerId: string) => Promise<string[]>;
  listOpenStripeCheckoutSessionIds: (customerId: string) => Promise<string[]>;
  expireStripeCheckoutSession: (sessionId: string) => Promise<void>;
  persistStripeBillingRefs: (
    deletionId: string,
    customerIds: string[],
    subscriptionIds: string[],
  ) => Promise<void>;
  revokeConnectorGrants: (uid: string) => Promise<void>;
  revokeModelBrokerAccess: (uid: string) => Promise<void>;
  disableAutoTopUp: (uid: string) => Promise<void>;
  deleteCredentialSecrets: (secretNames: string[]) => Promise<void>;
  retireProjectAgentMattermostUsers: (userIds: string[]) => Promise<void>;
  deleteProjectAgentCredentialDocs: (docPaths: string[]) => Promise<void>;
  ensureOwnedGatewaysRetired: (
    uid: string,
    deletionId: string,
  ) => Promise<"not-owned" | "retirement-pending" | "retired">;
  markSuspended: (deletionId: string) => Promise<void>;
  now: () => number;
}

interface SuspensionInput {
  uid?: unknown;
  deletionId?: unknown;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

async function report(
  ctx: OperationContext,
  deps: CustomerSuspensionDeps,
  step: OperationStep,
): Promise<void> {
  await ctx.reportStep({ completedAt: deps.now(), ...step });
}

function readSuspensionInput(input: SuspensionInput): { uid: string; deletionId: string } | null {
  return typeof input.uid === "string" && input.uid.length > 0 &&
    typeof input.deletionId === "string" && input.deletionId.length > 0
    ? { uid: input.uid, deletionId: input.deletionId }
    : null;
}

async function checkRestoreFence(
  deps: CustomerSuspensionDeps,
  ctx: OperationContext,
  uid: string,
  deletionId: string,
): Promise<OperationResult | null> {
  try {
    await deps.assertRestoreNotInProgress(uid);
    return null;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await report(ctx, deps, { name: "restore-fence", status: "failed", error });
    return { steps: [], success: false, error, output: { deletionCleanupRetry: { deletionId } } };
  }
}

export function createSuspendCustomerHandler(
  deps: CustomerSuspensionDeps,
): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = readSuspensionInput(op.input);
    if (!input) {
      return { steps: [], success: false, error: "missing uid or deletionId in op.input" };
    }
    const { uid, deletionId } = input;
    const job = await deps.loadDeletionJob(deletionId);
    if (!job || job.uid !== uid) {
      return { steps: [], success: false, error: `deletion job not found or mismatched: ${deletionId}` };
    }
    const restoreFailure = await checkRestoreFence(deps, ctx, uid, deletionId);
    if (restoreFailure) return restoreFailure;
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
    await run("cancel-customer-migrations", () => deps.cancelCustomerMigrations(uid, deletionId));
    await run("deactivate-customer-visibility", () =>
      deps.deactivateCustomerVisibility(uid));
    await run("invalidate-pending-credential-flows", () =>
      deps.invalidatePendingCredentialFlows(uid));
    if (cleanup.currentGatewayId && cleanup.slug) {
      await run("unmount-gateway", () =>
        deps.unmountFromGateway(cleanup.currentGatewayId!, cleanup.slug));
    } else {
      await skip("unmount-gateway");
    }
    await run("release-placement", () =>
      deps.releasePlacement(uid, cleanup.currentGatewayId ?? null));
    await run("retire-owned-gateways", async () => {
      const outcome = await deps.ensureOwnedGatewaysRetired(uid, deletionId);
      if (outcome === "retirement-pending") {
        throw new Error("owned gateway retirement is pending");
      }
    });
    let stripeCustomerIds = job.stripeCustomerIds;
    let stripeSubscriptionIds = job.stripeSubscriptionIds;
    await run("discover-stripe-billing", async () => {
      stripeCustomerIds = uniqueStrings([
        ...stripeCustomerIds,
        ...await deps.listStripeCustomerIdsForUid(uid),
      ]);
      const discovered = await Promise.all(
        stripeCustomerIds.map((customerId) => deps.listLiveStripeSubscriptionIds(customerId)),
      );
      stripeSubscriptionIds = uniqueStrings([
        ...stripeSubscriptionIds,
        ...discovered.flat(),
      ]);
      await deps.persistStripeBillingRefs(
        deletionId,
        stripeCustomerIds,
        stripeSubscriptionIds,
      );
    });
    if (stripeSubscriptionIds.length > 0) {
      await Promise.all(stripeSubscriptionIds.map((subscriptionId) =>
        run(`cancel-stripe-subscription:${subscriptionId}`, () =>
          deps.cancelStripeSubscription(subscriptionId))));
    } else {
      await skip("cancel-stripe-subscription");
    }
    await run("verify-stripe-billing-stopped", async () => {
      stripeCustomerIds = uniqueStrings([
        ...stripeCustomerIds,
        ...await deps.listStripeCustomerIdsForUid(uid),
      ]);
      const remaining = (await Promise.all(
        stripeCustomerIds.map((customerId) => deps.listLiveStripeSubscriptionIds(customerId)),
      )).flat();
      await deps.persistStripeBillingRefs(
        deletionId,
        stripeCustomerIds,
        uniqueStrings([...stripeSubscriptionIds, ...remaining]),
      );
      if (remaining.length > 0) {
        throw new Error(`live subscriptions remain: ${uniqueStrings(remaining).join(", ")}`);
      }
    });
    let stripeCheckoutSessionIds: string[] = [];
    await run("discover-stripe-checkout-sessions", async () => {
      stripeCheckoutSessionIds = uniqueStrings((await Promise.all(
        stripeCustomerIds.map((customerId) => deps.listOpenStripeCheckoutSessionIds(customerId)),
      )).flat());
    });
    if (stripeCheckoutSessionIds.length > 0) {
      await Promise.all(stripeCheckoutSessionIds.map((sessionId) =>
        run(`expire-stripe-checkout-session:${sessionId}`, () =>
          deps.expireStripeCheckoutSession(sessionId))));
    } else {
      await skip("expire-stripe-checkout-session");
    }
    await run("verify-stripe-checkout-sessions-closed", async () => {
      const remaining = uniqueStrings((await Promise.all(
        stripeCustomerIds.map((customerId) => deps.listOpenStripeCheckoutSessionIds(customerId)),
      )).flat());
      if (remaining.length > 0) {
        throw new Error(`open checkout sessions remain: ${remaining.join(", ")}`);
      }
    });
    await run("revoke-connector-grants", () => deps.revokeConnectorGrants(uid));
    await run("revoke-model-broker", () => deps.revokeModelBrokerAccess(uid));
    await run("disable-auto-top-up", () => deps.disableAutoTopUp(uid));
    await run("delete-credential-secrets", () =>
      deps.deleteCredentialSecrets(cleanup.credentialSecretNames));
    await run("retire-project-agent-users", () =>
      deps.retireProjectAgentMattermostUsers(cleanup.projectAgentMmUserIds));
    await run("delete-project-agent-credentials", () =>
      deps.deleteProjectAgentCredentialDocs(cleanup.projectAgentCredentialDocPaths));

    if (failures.length > 0) {
      return {
        steps: [],
        success: false,
        error: failures.join("; "),
        output: { deletionCleanupRetry: { deletionId } },
      };
    }
    await deps.markSuspended(deletionId);
    await report(ctx, deps, { name: "mark-suspended", status: "done" });
    return { steps: [], success: true };
  };
}
