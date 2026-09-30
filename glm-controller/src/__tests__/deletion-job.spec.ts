import { FieldValue } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import {
  postHogMappingOnlyJobUpdate,
  readPostHogErasureState,
  verifiedDeletionJobUpdate,
} from "../lib/customer-ops/deletion-job.js";

function deletedFields(update: Record<string, unknown>): string[] {
  return Object.entries(update)
    .filter(([, value]) => value instanceof FieldValue && value.isEqual(FieldValue.delete()))
    .map(([field]) => field)
    .sort();
}

const CLEANUP_FIELDS = [
  "cleanupContext",
  "currentGatewayId",
  "requestedBy",
  "slug",
  "stripeCustomerIds",
  "stripeSubscriptionIds",
  "suspensionOperationId",
];

describe("deletion job updates", () => {
  it("trims an erased customer's job to the uid and PostHog persons while PostHog verification is pending", () => {
    const update = postHogMappingOnlyJobUpdate("archive-1", 500);

    expect(update).toMatchObject({
      status: "posthog_verification_pending",
      archiveId: "archive-1",
      cloudErasedAt: 500,
      updatedAt: 500,
    });
    expect(deletedFields(update)).toEqual(CLEANUP_FIELDS);
    expect(update).not.toHaveProperty("uid");
    expect(update).not.toHaveProperty("posthogErasure");
    expect(update).not.toHaveProperty("erasureOperationId");
  });

  it("destroys the uid and PostHog person mapping once erasure is verified", () => {
    const update = verifiedDeletionJobUpdate("archive-1", 900);

    expect(update).toMatchObject({ status: "verified", archiveId: "archive-1", completedAt: 900 });
    expect(deletedFields(update)).toEqual(
      [...CLEANUP_FIELDS, "erasureOperationId", "posthogErasure", "uid"].sort(),
    );
  });
});

describe("readPostHogErasureState", () => {
  it("returns nothing before a deletion was requested and de-duplicates persisted persons", () => {
    expect(readPostHogErasureState("delete-1", {})).toBeNull();
    expect(readPostHogErasureState("delete-1", {
      posthogErasure: {
        personUuids: ["person-2", "person-1", "person-2"],
        requestedPersonUuids: ["person-2", "person-2"],
      },
    })).toEqual({ personUuids: ["person-1", "person-2"], requestedPersonUuids: ["person-2"] });
  });

  it("treats persons recorded before requests were tracked as not yet requested", () => {
    expect(readPostHogErasureState("delete-1", { posthogErasure: { personUuids: ["person-1"] } }))
      .toEqual({ personUuids: ["person-1"], requestedPersonUuids: [] });
  });

  it("rejects malformed persisted state instead of requesting deletion from it", () => {
    expect(() => readPostHogErasureState("delete-1", { posthogErasure: { personUuids: [""] } }))
      .toThrow(/malformed PostHog erasure state: delete-1/);
    expect(() => readPostHogErasureState("delete-1", { posthogErasure: null }))
      .toThrow(/malformed PostHog erasure state: delete-1/);
    expect(() => readPostHogErasureState("delete-1", {
      posthogErasure: { personUuids: ["person-1"], requestedPersonUuids: "person-1" },
    })).toThrow(/malformed PostHog erasure state: delete-1/);
  });
});
