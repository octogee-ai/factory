import type { Firestore, Query, QuerySnapshot, Transaction } from "firebase-admin/firestore";
import { type SharedGatewayAutoscalingConfig, type SharedGatewayPoolConfig, type SharedPoolMemberRoot } from "@octogee/shared/types/shared-gateway-pool";
export declare const ORCHESTRATOR_CONFIG_DOC_PATH = "config/orchestrator";
export declare function sharedClassGatewayQuery(db: Firestore): Query;
export declare function sharedPoolMemberRootsFromSnapshot(snapshot: QuerySnapshot): SharedPoolMemberRoot[];
export declare function readSharedPoolMemberRoots(db: Firestore, transaction?: Transaction): Promise<SharedPoolMemberRoot[]>;
export declare function readSharedGatewayPoolConfig(db: Firestore, transaction?: Transaction): Promise<SharedGatewayPoolConfig | null>;
export declare class InvalidSharedGatewayAutoscalingConfigError extends Error {
    constructor();
}
export declare function readSharedGatewayAutoscalingConfig(db: Firestore, transaction?: Transaction): Promise<SharedGatewayAutoscalingConfig>;
