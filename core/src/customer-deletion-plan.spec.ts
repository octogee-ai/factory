import { describe, expect, it } from "vitest";
import { buildCustomerDeletionPlan } from "./customer-deletion-plan.js";

describe("buildCustomerDeletionPlan", () => {
  it("creates immediate suspension and delayed erasure records with one deletion id", () => {
    const plan = buildCustomerDeletionPlan({
      uid: "uid-alice",
      slug: "alice",
      currentGatewayId: "gw-alice",
      requestedBy: "admin-1",
      requestedAt: 10_000,
      eraseAfter: 20_000,
      deletionId: "delete-random",
      suspensionOperationId: "suspend-random",
      erasureOperationId: "erase-random",
      stripeCustomerIds: ["cus_1"],
      stripeSubscriptionIds: ["sub_personal", "sub_builder"],
    });

    expect(plan.lifecycle).toEqual({
      status: "deletion_scheduled",
      deletionId: "delete-random",
      suspendedAt: 10_000,
      eraseAfter: 20_000,
    });
    expect(plan.job).toMatchObject({
      version: 1,
      uid: "uid-alice",
      slug: "alice",
      status: "suspension_pending",
      requestedBy: "admin-1",
      requestedAt: 10_000,
      eraseAfter: 20_000,
      currentGatewayId: "gw-alice",
      stripeCustomerIds: ["cus_1"],
      stripeSubscriptionIds: ["sub_personal", "sub_builder"],
      suspensionOperationId: "suspend-random",
      erasureOperationId: "erase-random",
    });
    expect(plan.suspensionOperation).toMatchObject({
      kind: "suspend-customer",
      status: "pending",
      inputUid: "uid-alice",
      input: { uid: "uid-alice", deletionId: "delete-random" },
    });
    expect(plan.erasureOperation).toMatchObject({
      kind: "erase-customer",
      status: "pending",
      nextAttemptAt: 20_000,
      inputUid: "uid-alice",
      input: { uid: "uid-alice", deletionId: "delete-random" },
    });
  });

  it("does not require a slug or gateway for a pre-provisioning account", () => {
    const plan = buildCustomerDeletionPlan({
      uid: "uid-lite",
      slug: null,
      currentGatewayId: null,
      requestedBy: "admin-1",
      requestedAt: 1,
      eraseAfter: 2,
      deletionId: "delete-lite",
      suspensionOperationId: "suspend-lite",
      erasureOperationId: "erase-lite",
      stripeCustomerIds: [],
      stripeSubscriptionIds: [],
    });
    expect(plan.job).toMatchObject({ uid: "uid-lite", slug: null, currentGatewayId: null });
  });
});
