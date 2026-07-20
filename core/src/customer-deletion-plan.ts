interface CustomerDeletionPlanInput {
  uid: string;
  slug: string | null;
  currentGatewayId: string | null;
  requestedBy: string;
  requestedAt: number;
  eraseAfter: number;
  deletionId: string;
  suspensionOperationId: string;
  erasureOperationId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

function operationRecord(input: {
  kind: "suspend-customer" | "erase-customer";
  operationId: string;
  deletionId: string;
  uid: string;
  createdBy: string;
  createdAt: number;
  nextAttemptAt?: number;
}): Record<string, unknown> {
  return {
    kind: input.kind,
    status: "pending",
    createdBy: input.createdBy,
    createdAt: input.createdAt,
    startedAt: null,
    completedAt: null,
    input: { uid: input.uid, deletionId: input.deletionId },
    inputUid: input.uid,
    steps: [],
    ...(input.nextAttemptAt === undefined
      ? {}
      : { nextAttemptAt: input.nextAttemptAt }),
  };
}

export function buildCustomerDeletionPlan(input: CustomerDeletionPlanInput): {
  lifecycle: Record<string, unknown>;
  job: Record<string, unknown>;
  suspensionOperation: Record<string, unknown>;
  erasureOperation: Record<string, unknown>;
} {
  const lifecycle = {
    status: "deletion_scheduled",
    deletionId: input.deletionId,
    suspendedAt: input.requestedAt,
    eraseAfter: input.eraseAfter,
  };
  return {
    lifecycle,
    job: {
      version: 1,
      uid: input.uid,
      slug: input.slug,
      status: "suspension_pending",
      requestedBy: input.requestedBy,
      requestedAt: input.requestedAt,
      eraseAfter: input.eraseAfter,
      currentGatewayId: input.currentGatewayId,
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      suspensionOperationId: input.suspensionOperationId,
      erasureOperationId: input.erasureOperationId,
    },
    suspensionOperation: operationRecord({
      kind: "suspend-customer",
      operationId: input.suspensionOperationId,
      deletionId: input.deletionId,
      uid: input.uid,
      createdBy: input.requestedBy,
      createdAt: input.requestedAt,
    }),
    erasureOperation: operationRecord({
      kind: "erase-customer",
      operationId: input.erasureOperationId,
      deletionId: input.deletionId,
      uid: input.uid,
      createdBy: input.requestedBy,
      createdAt: input.requestedAt,
      nextAttemptAt: input.eraseAfter,
    }),
  };
}
