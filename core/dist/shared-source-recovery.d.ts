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
export interface SourceRecoveryAgentStore {
    uid: string;
    slug: string;
    assignmentEpoch: number;
    agentId: string;
    storeId: string;
    schema: string;
}
export interface SharedSourceRecoveryAuthority {
    postgresAgentStores?: SourceRecoveryAgentStore[];
    root: DocumentData;
    assignments: SourceRecoveryAssignment[];
    failedExports: SourceRecoveryExport[];
    managementRecovery?: ManagementSourceRecovery;
}
export declare class SharedSourceRecoveryConflict extends Error {
}
export declare function postgresImportMaintenanceFailureMatches(row: DocumentData, operationId: string, identity: SourceRecoveryAssignment, gatewayId: string): boolean;
export declare function readPostgresSourceAgentStores(db: Firestore, tx: Transaction, assignments: SourceRecoveryAssignment[]): Promise<SourceRecoveryAgentStore[]>;
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
