import type { Firestore, Query, Transaction } from "firebase-admin/firestore";
import { type SharedGatewayAutoscalingConfig, type SharedGatewayPoolConfig } from "@octogee/shared/types/shared-gateway-pool";
import type { PlatformStateTransaction } from "./platform-state/store.js";
export declare const ORCHESTRATOR_CONFIG_DOC_PATH = "config/orchestrator";
export declare function sharedClassGatewayQuery(db: Firestore): Query;
export declare function readSharedGatewayPoolConfig(db: Firestore, transaction?: Transaction): Promise<SharedGatewayPoolConfig | null>;
export declare function readSharedGatewayPoolConfigInStore(transaction: PlatformStateTransaction): Promise<SharedGatewayPoolConfig | null>;
export declare class InvalidSharedGatewayAutoscalingConfigError extends Error {
    constructor();
}
export declare function readSharedGatewayAutoscalingConfig(db: Firestore, transaction?: Transaction): Promise<SharedGatewayAutoscalingConfig>;
