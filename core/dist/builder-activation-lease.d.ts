import type { Firestore } from "firebase-admin/firestore";
import { type BuilderTierName } from "@octogee/shared/types/billing-tiers";
import type { BuilderRecord } from "./platform-state/builders.js";
import type { PlatformStateStore, Stored } from "./platform-state/store.js";
export type BuilderRuntimeDemandCause = "run-start" | "chat" | "scheduled" | "manual";
export type BuilderActivationLeaseResult = {
    statusCode: number;
    body: Record<string, unknown>;
};
export type BuilderTierReader = (uid: string, now: number) => Promise<BuilderTierName | null>;
export declare function firestoreBuilderTierReader(db: Pick<Firestore, "doc">): BuilderTierReader;
export declare class BuilderTierChangedError extends Error {
    readonly uid: string;
    constructor(uid: string);
}
export interface CurrentBuilderTier {
    readonly tier: BuilderTierName | null;
    readonly assertCurrent: (builder: Stored<BuilderRecord> | null) => void;
}
export declare function withCurrentBuilderTier<T>(input: {
    store: PlatformStateStore;
    readBuilderTier: BuilderTierReader;
    uid: string;
    now: number;
}, run: (current: CurrentBuilderTier) => Promise<T>): Promise<T>;
export interface BuilderRuntimeDemandRequest {
    store: PlatformStateStore;
    readBuilderTier: BuilderTierReader;
    uid: string;
    reportingGatewayId?: string;
    assignmentEpoch?: number;
    eventKey?: string;
    cause?: BuilderRuntimeDemandCause;
    observedAt?: number;
    createdBy: string;
    now?: number;
    leaseIdFactory?: () => string;
}
export declare function recordBuilderRuntimeActivity(input: {
    store: PlatformStateStore;
    readBuilderTier: BuilderTierReader;
    uid: string;
    gatewayId: string;
    now?: number;
}): Promise<boolean>;
export declare function requestBuilderActivationLease(input: BuilderRuntimeDemandRequest): Promise<BuilderActivationLeaseResult>;
export declare function builderActivateOperationId(gatewayId: string, generation: number): string;
export declare function builderReturnOperationId(gatewayId: string, generation: number): string;
export declare function builderRecoverOperationId(gatewayId: string, generation: number): string;
export declare function placementRetireOperationId(uid: string, gatewayId: string, generation: number): string;
export declare function isBuilderActivateOperationIdFor(operationId: unknown, gatewayId: unknown): boolean;
export declare function isBuilderReturnOperationIdFor(operationId: unknown, gatewayId: unknown): boolean;
