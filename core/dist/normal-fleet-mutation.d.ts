import type { OperationAuditPartialOutcome, OperationAuditReleaseRolloutLinkage } from "@octogee/shared/types/glm";
import { type OperationAuditActionClaim, type OperationAuditIntentInput, type OperationsDb, type OperationsDocRef } from "./operation-audit.js";
export declare const GLM_MAINTENANCE_DOC_PATH = "config/glmMaintenance";
export interface NormalFleetMutationDb extends OperationsDb {
    doc(path: string): OperationsDocRef;
}
export declare class FleetMutationFrozenError extends Error {
    readonly reason: string | null;
    constructor(reason: string | null);
}
export declare class FleetMutationMaintenanceUnavailableError extends Error {
    constructor(cause: unknown);
}
export declare class FleetMutationIdempotencyError extends Error {
    readonly auditId: string;
    readonly status: "recorded" | "in-progress" | "completed" | "failed";
    constructor(auditId: string, status: "recorded" | "in-progress" | "completed" | "failed");
}
export declare function assertNormalFleetMutationOpen(db: NormalFleetMutationDb): Promise<void>;
export declare function assertNormalFleetMutationSnapshotOpen(snapshot: Awaited<ReturnType<OperationsDocRef["get"]>>): void;
export type NormalFleetMutationResult = {
    outcome: "completed";
    releaseRollout?: OperationAuditReleaseRolloutLinkage;
} | {
    outcome: "partial";
    partialOutcome: OperationAuditPartialOutcome;
    releaseRollout?: OperationAuditReleaseRolloutLinkage;
} | {
    outcome: "failed";
    error: string;
    partialOutcome?: OperationAuditPartialOutcome;
    releaseRollout?: OperationAuditReleaseRolloutLinkage;
};
export interface NormalFleetMutationInput<T> extends OperationAuditIntentInput {
    claimId?: string;
    action: (claim: OperationAuditActionClaim) => Promise<T>;
    classifyResult?: (result: T) => NormalFleetMutationResult;
}
export declare function runNormalFleetMutation<T>(db: NormalFleetMutationDb, input: NormalFleetMutationInput<T>): Promise<T>;
