import { FieldValue } from "firebase-admin/firestore";
import type { PostHogErasureState } from "./posthog-erasure.js";

const CLEANUP_FIELDS = [
  "slug",
  "requestedBy",
  "currentGatewayId",
  "stripeCustomerIds",
  "stripeSubscriptionIds",
  "cleanupContext",
  "suspensionOperationId",
] as const;

const IDENTITY_MAPPING_FIELDS = ["uid", "erasureOperationId", "posthogErasure"] as const;

function deleted(fields: readonly string[]): Record<string, FieldValue> {
  return Object.fromEntries(fields.map((field) => [field, FieldValue.delete()]));
}

export function postHogMappingOnlyJobUpdate(archiveId: string, now: number): Record<string, unknown> {
  return {
    status: "posthog_verification_pending",
    archiveId,
    cloudErasedAt: now,
    updatedAt: now,
    ...deleted(CLEANUP_FIELDS),
  };
}

export function verifiedDeletionJobUpdate(archiveId: string, now: number): Record<string, unknown> {
  return {
    status: "verified",
    archiveId,
    completedAt: now,
    ...deleted([...CLEANUP_FIELDS, ...IDENTITY_MAPPING_FIELDS]),
  };
}

function isPersonUuidList(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((personUuid) => typeof personUuid === "string" && personUuid.length > 0);
}

export function readPostHogErasureState(
  deletionId: string,
  job: Record<string, unknown>,
): PostHogErasureState | null {
  if (job.posthogErasure === undefined) return null;
  const persisted = job.posthogErasure as Partial<Record<keyof PostHogErasureState, unknown>> | null;
  const requested = persisted?.requestedPersonUuids ?? [];
  if (
    !persisted ||
    typeof persisted !== "object" ||
    !isPersonUuidList(persisted.personUuids) ||
    !isPersonUuidList(requested)
  ) {
    throw new Error(`deletion job has malformed PostHog erasure state: ${deletionId}`);
  }
  return {
    personUuids: [...new Set(persisted.personUuids)].sort(),
    requestedPersonUuids: [...new Set(requested)].sort(),
  };
}
