import { describe, expect, it } from "vitest";
import { buildUserDeletionPlan } from "./user-deletion-plan.js";

describe("buildUserDeletionPlan", () => {
  it("creates immediate suspension and delayed erasure records with one deletion id", () => {
    const plan = buildUserDeletionPlan({
      uid: "uid-alice",
      slug: "alice",
      currentGatewayId: "gw-alice",
      requestedBy: "admin-1",
      requestedAt: 10_000,
      eraseAfter: 20_000,
      deletionId: "delete-random",
      suspensionOperationId: "suspend-random",
      erasureOperationId: "erase-random",
      productContext: { billingRefs: ["ref-1"] },
    });

    expect(plan.lifecycle).toEqual({
      status: "deletion_scheduled",
      deletionId: "delete-random",
      suspendedAt: 10_000,
      eraseAfter: 20_000,
    });
    expect(plan.job).toMatchObject({
      deletionId: "delete-random",
      version: 1,
      uid: "uid-alice",
      slug: "alice",
      status: "suspension_pending",
      requestedBy: "admin-1",
      requestedAt: 10_000,
      eraseAfter: 20_000,
      currentGatewayId: "gw-alice",
      productContext: { billingRefs: ["ref-1"] },
      suspensionOperationId: "suspend-random",
      erasureOperationId: "erase-random",
    });
    expect(plan.suspensionOperation).toMatchObject({
      id: "suspend-random",
      kind: "suspend-user",
      status: "pending",
      inputUid: "uid-alice",
      input: { uid: "uid-alice", deletionId: "delete-random" },
    });
    expect(plan.erasureOperation).toMatchObject({
      id: "erase-random",
      kind: "erase-user",
      status: "pending",
      nextAttemptAt: 20_000,
      inputUid: "uid-alice",
      input: { uid: "uid-alice", deletionId: "delete-random" },
    });
  });

  it("does not require a slug or gateway for a pre-provisioning account", () => {
    const plan = buildUserDeletionPlan({
      uid: "uid-lite",
      slug: null,
      currentGatewayId: null,
      requestedBy: "admin-1",
      requestedAt: 1,
      eraseAfter: 2,
      deletionId: "delete-lite",
      suspensionOperationId: "suspend-lite",
      erasureOperationId: "erase-lite",
      productContext: {},
    });
    expect(plan.job).toMatchObject({ uid: "uid-lite", slug: null, currentGatewayId: null });
  });
});
