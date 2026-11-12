import type { Firestore } from "firebase-admin/firestore";
import type { PlatformUserRecord } from "./platform-state/users.js";
import { type GatewaySizingProfile } from "./platform-state/config.js";
import type { PlatformStateStore, Stored } from "./platform-state/store.js";
export type IsolatedRuntimeDemandCause = "run-start" | "chat" | "scheduled" | "manual";
export type UserActivationLeaseResult = {
    statusCode: number;
    body: Record<string, unknown>;
};
export type BuilderTierReader = (uid: string, now: number) => Promise<string | null>;
export declare function firestoreBuilderTierReader(db: Pick<Firestore, "doc">): BuilderTierReader;
export declare class BuilderTierChangedError extends Error {
    readonly uid: string;
    constructor(uid: string);
}
export interface CurrentBuilderTier {
    readonly tier: string | null;
    readonly profile: GatewaySizingProfile | null;
    readonly assertCurrent: (user: Stored<PlatformUserRecord> | null) => void;
}
export declare function withCurrentBuilderTier<T>(input: {
    store: PlatformStateStore;
    readBuilderTier: BuilderTierReader;
    uid: string;
    now: number;
}, run: (current: CurrentBuilderTier) => Promise<T>): Promise<T>;
export interface IsolatedRuntimeDemandRequest {
    store: PlatformStateStore;
    readBuilderTier: BuilderTierReader;
    uid: string;
    reportingGatewayId?: string;
    assignmentEpoch?: number;
    eventKey?: string;
    cause?: IsolatedRuntimeDemandCause;
    observedAt?: number;
    createdBy: string;
    now?: number;
    leaseIdFactory?: () => string;
    refuse?: (user: PlatformUserRecord) => UserActivationLeaseResult | null;
}
export type ActivationDemandEligibility = {
    result: UserActivationLeaseResult;
} | {
    entitlementTier: string;
    sizingTier: string;
    slug: string;
};
export declare function activationDemandEligibility(user: PlatformUserRecord, entitlementTier: string | null, profile: GatewaySizingProfile | null): ActivationDemandEligibility;
export declare function requestUserActivationLease(input: IsolatedRuntimeDemandRequest): Promise<UserActivationLeaseResult>;
export declare function builderActivateOperationId(gatewayId: string, generation: number): string;
export declare function builderReturnOperationId(gatewayId: string, generation: number): string;
export declare function isolatedRecoverOperationId(gatewayId: string, generation: number): string;
export declare function placementRetireOperationId(uid: string, gatewayId: string, generation: number): string;
export declare function isUserActivateOperationIdFor(operationId: unknown, gatewayId: unknown): boolean;
export declare function isUserReturnOperationIdFor(operationId: unknown, gatewayId: unknown): boolean;
