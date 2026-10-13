import { type ManagementSourceRecovery } from "./shared-source-management-recovery.js";
import type { DocumentData, Firestore, Transaction } from "firebase-admin/firestore";
export interface SourceRecoveryAssignment {
    uid: string;
    slug: string;
    agentId: string;
    assignmentEpoch: number;
    assignment: DocumentData;
}
export interface SourceRecoveryExport {
    operationId: string;
    input: DocumentData;
    startedAt: number;
    completedAt: number;
    error: string;
    steps: DocumentData[];
}
export interface SharedSourceRecoveryAuthority {
    root: DocumentData;
    assignments: SourceRecoveryAssignment[];
    failedExports: SourceRecoveryExport[];
    managementRecovery?: ManagementSourceRecovery;
}
export declare class SharedSourceRecoveryConflict extends Error {
}
export declare function readSharedSourceRecoveryAuthority(db: Firestore, tx: Transaction, gatewayId: string, ownOperationId?: string, predecessorId?: string): Promise<SharedSourceRecoveryAuthority>;
export declare function assertSharedSourceRecoveryUnchanged(current: SharedSourceRecoveryAuthority, captured: SharedSourceRecoveryAuthority): void;
export interface SharedSourceRecoverySupersession {
    operationId: string;
    input: DocumentData;
    startedAt: number;
    completedAt: number;
    error: string;
    fence: DocumentData;
}
export declare function assertSharedSourceRecoveryPredecessor(request: {
    gatewayId: string;
    operationId: string;
    row: DocumentData;
    fence: DocumentData;
    source: SharedSourceRecoveryAuthority;
}): SharedSourceRecoverySupersession;
export declare function readSharedSourceRecoverySupersession(db: Firestore, tx: Transaction, gatewayId: string, operationId: string): Promise<{
    source: SharedSourceRecoveryAuthority;
    supersede: SharedSourceRecoverySupersession;
}>;
