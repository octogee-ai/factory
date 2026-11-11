function operationRecord(input) {
    return {
        id: input.operationId,
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
export function buildUserDeletionPlan(input) {
    const lifecycle = {
        status: "deletion_scheduled",
        deletionId: input.deletionId,
        suspendedAt: input.requestedAt,
        eraseAfter: input.eraseAfter,
    };
    return {
        lifecycle,
        job: {
            deletionId: input.deletionId,
            version: 1,
            uid: input.uid,
            slug: input.slug,
            status: "suspension_pending",
            requestedBy: input.requestedBy,
            requestedAt: input.requestedAt,
            eraseAfter: input.eraseAfter,
            currentGatewayId: input.currentGatewayId,
            suspensionOperationId: input.suspensionOperationId,
            erasureOperationId: input.erasureOperationId,
            productContext: input.productContext,
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
