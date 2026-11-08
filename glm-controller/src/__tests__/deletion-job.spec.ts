import { describe, expect, it } from "vitest";
import {
  postHogMappingOnlyJobPatch,
  readPostHogErasureState,
  verifiedDeletionJobPatch,
} from "../lib/customer-ops/deletion-job.js";

function clearedFields(patch: object): string[] {
  return Object.entries(patch)
    .filter(([, value]) => typeof value === "object" && value !== null && (value as { clear?: unknown }).clear === true)
    .map(([field]) => field)
    .sort();
}

const CLEANUP_FIELDS = [
  "cleanupContext",
  "currentGatewayId",
  "postgresAgentStoreTargets",
  "requestedBy",
  "retiredGatewayProofs",
  "sharedAgentStoreCleanup",
  "slug",
  "suspensionOperationId",
];

describe("deletion job updates", () => {
  it("trims an erased customer's job to the uid and PostHog persons while PostHog verification is pending", () => {
    const posthogErasure = { personUuids: ["person-1"], requestedPersonUuids: ["person-1"] };
    const patch = postHogMappingOnlyJobPatch(
      { productContext: { posthogErasure, stripeCustomerIds: ["cus_1"], stripeSubscriptionIds: ["sub_1"] } },
      "archive-1",
      500,
    );

    expect(patch).toMatchObject({
      status: "product_verification_pending",
      archiveId: "archive-1",
      cloudErasedAt: 500,
      updatedAt: 500,
    });
    expect(clearedFields(patch)).toEqual(CLEANUP_FIELDS);
    expect(patch.productContext).toEqual({ posthogErasure });
    expect(patch).not.toHaveProperty("uid");
    expect(patch).not.toHaveProperty("erasureOperationId");
  });

  it("drops the Stripe references with no PostHog persons to keep while PostHog verification is pending", () => {
    const patch = postHogMappingOnlyJobPatch({ productContext: { stripeCustomerIds: ["cus_1"] } }, "archive-1", 500);

    expect(clearedFields(patch)).toEqual([...CLEANUP_FIELDS, "productContext"].sort());
  });

  it("destroys the uid and PostHog person mapping once erasure is verified", () => {
    const patch = verifiedDeletionJobPatch("archive-1", 900);

    expect(patch).toMatchObject({ status: "verified", archiveId: "archive-1", completedAt: 900 });
    expect(clearedFields(patch)).toEqual(
      [...CLEANUP_FIELDS, "erasureOperationId", "productContext", "uid"].sort(),
    );
  });
});

describe("readPostHogErasureState", () => {
  it("returns nothing before a deletion was requested and de-duplicates persisted persons", () => {
    expect(readPostHogErasureState("delete-1", {})).toBeNull();
    expect(readPostHogErasureState("delete-1", { productContext: { stripeCustomerIds: ["cus_1"] } })).toBeNull();
    expect(readPostHogErasureState("delete-1", { productContext: {
      posthogErasure: {
        personUuids: ["person-2", "person-1", "person-2"],
        requestedPersonUuids: ["person-2", "person-2"],
      },
    } })).toEqual({ personUuids: ["person-1", "person-2"], requestedPersonUuids: ["person-2"] });
  });

  it("treats persons recorded before requests were tracked as not yet requested", () => {
    expect(readPostHogErasureState("delete-1", { productContext: { posthogErasure: { personUuids: ["person-1"] } } }))
      .toEqual({ personUuids: ["person-1"], requestedPersonUuids: [] });
  });

  it("rejects malformed persisted state instead of requesting deletion from it", () => {
    expect(() => readPostHogErasureState("delete-1", { productContext: { posthogErasure: { personUuids: [""] } } }))
      .toThrow(/malformed PostHog erasure state: delete-1/);
    expect(() => readPostHogErasureState("delete-1", { productContext: { posthogErasure: null } }))
      .toThrow(/malformed PostHog erasure state: delete-1/);
    expect(() => readPostHogErasureState("delete-1", { productContext: {
      posthogErasure: { personUuids: ["person-1"], requestedPersonUuids: "person-1" },
    } })).toThrow(/malformed PostHog erasure state: delete-1/);
  });
});
