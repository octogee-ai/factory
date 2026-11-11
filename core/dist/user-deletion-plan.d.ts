import type { AccountLifecycle } from "@octogee/shared/types/account-lifecycle";
import type { UserDeletionJob } from "./platform-state/jobs.js";
import type { OperationRecord } from "./platform-state/operations.js";
interface UserDeletionPlanInput {
    uid: string;
    slug: string | null;
    currentGatewayId: string | null;
    requestedBy: string;
    requestedAt: number;
    eraseAfter: number;
    deletionId: string;
    suspensionOperationId: string;
    erasureOperationId: string;
    stripeCustomerIds: string[];
    stripeSubscriptionIds: string[];
}
export declare function buildUserDeletionPlan(input: UserDeletionPlanInput): {
    lifecycle: AccountLifecycle;
    job: UserDeletionJob;
    suspensionOperation: OperationRecord;
    erasureOperation: OperationRecord;
};
export {};
