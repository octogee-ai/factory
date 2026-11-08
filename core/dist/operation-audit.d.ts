import { type OperationAuditAliasOutcome, type OperationAuditAliasPlan, type OperationAuditPartialOutcome, type OperationAuditRecord, type OperationAuditReleaseRolloutLinkage, type OperationAuditTestProvenance } from "@octogee/shared/types/glm";
import type { PlatformStateStore, PlatformStateTransaction } from "./platform-state/store.js";
export interface OperationsDocSnapshot {
    exists: boolean;
    id: string;
    data(): Record<string, unknown> | undefined;
}
export interface OperationsDocRef {
    id: string;
    get(): Promise<OperationsDocSnapshot>;
}
export interface OperationsCollection {
    add(data: Record<string, unknown>): Promise<{
        id: string;
    }>;
    doc(id: string): OperationsDocRef;
}
export interface OperationsDb {
    collection(name: string): OperationsCollection;
    runTransaction<T>(body: (transaction: OperationsTransaction) => Promise<T>): Promise<T>;
}
export interface OperationsTransaction {
    get(ref: OperationsDocRef): Promise<OperationsDocSnapshot>;
    create(ref: OperationsDocRef, data: Record<string, unknown>): void;
    update(ref: OperationsDocRef, data: Record<string, unknown>): void;
}
export interface OperationAuditIntentInput {
    actor: string;
    forced: boolean;
    what: string;
    why: string;
    target: Record<string, unknown>;
    preActionStatus: Record<string, unknown>;
    mutation: Record<string, unknown>;
    idempotencyKey?: string;
    aliasPlan?: OperationAuditAliasPlan[];
    releaseRollout?: OperationAuditReleaseRolloutLinkage;
    testProvenance?: OperationAuditTestProvenance;
    now?: () => number;
}
export interface OperationAuditIntent {
    id: string;
    document: Omit<OperationAuditRecord, "id">;
}
export interface RecordedOperationAuditIntent {
    auditId: string;
    disposition: "created" | "existing";
    status: OperationAuditRecord["status"];
}
export interface OperationAuditActionClaim {
    auditId: string;
    claimId: string;
    externalIdempotencyKey: string;
    recovery: boolean;
}
export interface ClaimOperationAuditActionInput {
    claimId: string;
    now?: () => number;
}
export interface RecoverOperationAuditActionInput {
    auditId: string;
    expectedClaimId: string;
    recoveryClaimId: string;
    externalIdempotencyKey: string;
    staleAfterMs: number;
    now: () => number;
}
export declare class OperationAuditMissingError extends Error {
    constructor(auditId: string);
}
export declare class OperationAuditRecordTypeError extends Error {
    constructor(auditId: string);
}
export declare class OperationAuditSchemaError extends Error {
    constructor(auditId: string, options?: ErrorOptions);
}
export declare class OperationAuditRecoveryContractError extends Error {
    constructor(auditId: string);
}
export declare class OperationAuditClaimNotStaleError extends Error {
    constructor(auditId: string, claimId: string, staleAt: number);
}
export declare class OperationAuditStateError extends Error {
    constructor(auditId: string, actual: string, expected: string);
}
export declare class OperationAuditIdempotencyConflictError extends Error {
    readonly auditId: string;
    constructor(auditId: string);
}
export declare function operationAuditMutationFingerprint(mutation: Record<string, unknown>): string;
export declare function operationAuditDocumentId(idempotencyKey: string): string;
export declare function buildOperationAuditIntent(opts: OperationAuditIntentInput): OperationAuditIntent;
export declare function stageOperationAuditIntentInStore(transaction: PlatformStateTransaction, intent: OperationAuditIntent): Promise<RecordedOperationAuditIntent>;
export declare function recordOperationAuditIntent(store: PlatformStateStore, opts: OperationAuditIntentInput): Promise<RecordedOperationAuditIntent>;
export declare function claimOperationAuditAction(store: PlatformStateStore, auditId: string, opts: ClaimOperationAuditActionInput): Promise<OperationAuditActionClaim>;
export type FinishOperationAuditInput = {
    outcome: "completed";
    expectedClaimId: string;
    aliasOutcomes?: OperationAuditAliasOutcome[];
    releaseRollout?: OperationAuditReleaseRolloutLinkage;
    now?: () => number;
} | {
    outcome: "partial";
    expectedClaimId: string;
    aliasOutcomes?: OperationAuditAliasOutcome[];
    partialOutcome: OperationAuditPartialOutcome;
    releaseRollout?: OperationAuditReleaseRolloutLinkage;
    now?: () => number;
} | {
    outcome: "failed";
    expectedClaimId: string;
    aliasOutcomes?: OperationAuditAliasOutcome[];
    partialOutcome?: OperationAuditPartialOutcome;
    releaseRollout?: OperationAuditReleaseRolloutLinkage;
    error: string;
    now?: () => number;
};
export declare const OPERATION_AUDIT_RETENTION_MS: number;
export declare function finishOperationAudit(store: PlatformStateStore, auditId: string, opts: FinishOperationAuditInput): Promise<void>;
export declare function runWithOperationAuditIntent<T>(store: PlatformStateStore, opts: OperationAuditIntentInput, claimOpts: ClaimOperationAuditActionInput, action: (claim: OperationAuditActionClaim) => Promise<T>): Promise<T>;
export declare function resumeOperationAuditAction<T>(store: PlatformStateStore, opts: RecoverOperationAuditActionInput, action: (claim: OperationAuditActionClaim) => Promise<T>): Promise<T>;
