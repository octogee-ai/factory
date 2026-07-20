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
export declare function buildCustomerDeletionPlan(input: CustomerDeletionPlanInput): {
    lifecycle: Record<string, unknown>;
    job: Record<string, unknown>;
    suspensionOperation: Record<string, unknown>;
    erasureOperation: Record<string, unknown>;
};
export {};
