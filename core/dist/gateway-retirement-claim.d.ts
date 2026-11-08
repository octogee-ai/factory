import type { Firestore, Transaction } from "firebase-admin/firestore";
import { type GatewayDoc } from "@octogee/shared/types/gateway-releases";
import type { BuilderRecord } from "./platform-state/builders.js";
import type { NewOperation } from "./platform-state/operations.js";
import type { PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";
export declare class GatewayRetirementConflictError extends Error {
    constructor(message: string);
}
export declare class GatewayRetirementTelemetryUnavailableError extends GatewayRetirementConflictError {
    constructor(message: string);
}
export declare class GatewayRetirementReleaseUnconvergedError extends GatewayRetirementConflictError {
    constructor(message: string);
}
type RetirableGateway = GatewayDoc & {
    desiredStatus: "running" | "draining" | "paused";
};
interface ClaimGatewayRetirementInStoreInput {
    store: PlatformStateStore;
    gatewayId: string;
    operationId: string;
    operation: NewOperation;
    now: number;
    updatedBy: string;
    telemetryObservedAfter?: number;
    claimGuard?: (input: {
        transaction: PlatformStateTransaction;
        root: RetirableGateway;
    }) => Promise<void> | void;
}
interface VerifyGatewayRetirementClaimInput {
    store: PlatformStateStore;
    gatewayId: string;
    operationId: string;
    version: number;
    now: number;
    updatedBy: string;
}
export type GatewayRetirementVerification = {
    ok: true;
} | {
    ok: false;
    error: string;
};
export declare function assertGatewayRuntimeMutationUnfenced(db: Firestore, transaction: Transaction, gatewayId: string, allowedComputerRecoveryOperationId?: string): Promise<void>;
export declare function builderRuntimeMutationFenced(builder: Stored<BuilderRecord>): boolean;
export declare function assertGatewayRuntimeMutationUnfencedInStore(transaction: PlatformStateTransaction, gatewayId: string, allowedComputerRecoveryOperationId?: string): Promise<void>;
export declare function claimGatewayRetirementInStore(input: ClaimGatewayRetirementInStoreInput): Promise<{
    version: number;
}>;
export declare function verifyGatewayRetirementClaimAtomic(input: VerifyGatewayRetirementClaimInput): Promise<GatewayRetirementVerification>;
export {};
