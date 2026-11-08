import type { CustomerDeletionJob, CustomerDeletionJobPatch } from "@octogee/core/platform-state";
import type { PostHogErasureState } from "./posthog-erasure.js";

const CLEAR = { clear: true } as const;

const CLEARED_CLEANUP_FIELDS = {
  slug: CLEAR,
  requestedBy: CLEAR,
  currentGatewayId: CLEAR,
  cleanupContext: CLEAR,
  suspensionOperationId: CLEAR,
  postgresAgentStoreTargets: CLEAR,
  sharedAgentStoreCleanup: CLEAR,
  retiredGatewayProofs: CLEAR,
} satisfies CustomerDeletionJobPatch;

export function postHogMappingOnlyJobPatch(
  job: Pick<CustomerDeletionJob, "productContext">,
  archiveId: string,
  now: number,
): CustomerDeletionJobPatch {
  const posthogErasure = job.productContext?.posthogErasure;
  return {
    status: "product_verification_pending",
    archiveId,
    cloudErasedAt: now,
    updatedAt: now,
    ...CLEARED_CLEANUP_FIELDS,
    productContext: posthogErasure === undefined ? CLEAR : { posthogErasure },
  };
}

export function verifiedDeletionJobPatch(archiveId: string, now: number): CustomerDeletionJobPatch {
  return {
    status: "verified",
    archiveId,
    completedAt: now,
    ...CLEARED_CLEANUP_FIELDS,
    uid: CLEAR,
    erasureOperationId: CLEAR,
    productContext: CLEAR,
  };
}

function isPersonUuidList(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((personUuid) => typeof personUuid === "string" && personUuid.length > 0);
}

export function readPostHogErasureState(
  deletionId: string,
  job: Pick<CustomerDeletionJob, "productContext">,
): PostHogErasureState | null {
  const productContext = job.productContext ?? {};
  if (!("posthogErasure" in productContext)) return null;
  const persisted = productContext.posthogErasure as Partial<Record<keyof PostHogErasureState, unknown>> | null;
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
