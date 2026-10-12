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
}
export declare class SharedSourceRecoveryConflict extends Error {
}
export declare function readSharedSourceRecoveryAuthority(db: Firestore, tx: Transaction, gatewayId: string, ownOperationId?: string): Promise<SharedSourceRecoveryAuthority>;
export declare function assertSharedSourceRecoveryUnchanged(current: SharedSourceRecoveryAuthority, captured: SharedSourceRecoveryAuthority): void;
