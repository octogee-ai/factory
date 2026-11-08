import type { DocumentData } from "firebase-admin/firestore";
import type { GatewayAssignment } from "./platform-state/gateways.js";
import type { PlatformStateTransaction } from "./platform-state/store.js";
export interface SourceRecoveryAssignment {
    uid: string;
    slug: string;
    agentId: string;
    assignmentEpoch: number;
    assignment: GatewayAssignment;
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
    schedulerStateRecovery: true;
    postgresAgentStores: SourceRecoveryAgentStore[];
    root: DocumentData;
    assignments: SourceRecoveryAssignment[];
}
export declare class SharedSourceRecoveryConflict extends Error {
}
export declare function readPostgresSourceAgentStores(transaction: PlatformStateTransaction, assignments: readonly SourceRecoveryAssignment[]): Promise<SourceRecoveryAgentStore[]>;
export declare function readSharedSourceRecoveryAuthority(transaction: PlatformStateTransaction, gatewayId: string, ownOperationId?: string, predecessorId?: string): Promise<SharedSourceRecoveryAuthority>;
export declare function assertSharedSourceRecoveryUnchanged(current: SharedSourceRecoveryAuthority, captured: SharedSourceRecoveryAuthority): void;
export interface SharedSourceRecoverySupersession {
    operationId: string;
    input: DocumentData;
    inputFingerprint: string;
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
export declare function readSharedSourceRecoverySupersession(transaction: PlatformStateTransaction, gatewayId: string, operationId: string): Promise<{
    source: SharedSourceRecoveryAuthority;
    supersede: SharedSourceRecoverySupersession;
}>;
