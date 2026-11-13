import type { Firestore } from "firebase-admin/firestore";
import type { PlatformUserRecord } from "./platform-state/users.js";
import { type GatewaySizingProfile } from "./platform-state/config.js";
import type { PlatformStateStore, Stored } from "./platform-state/store.js";
export type IsolatedRuntimeDemandCause = "run-start" | "chat" | "scheduled" | "manual";
export type UserActivationLeaseResult = {
    statusCode: number;
    body: Record<string, unknown>;
};
export type SizingKeyReader = (uid: string, now: number) => Promise<string | null>;
export declare function firestoreSizingKeyReader(db: Pick<Firestore, "doc">): SizingKeyReader;
export declare class SizingKeyChangedError extends Error {
    readonly uid: string;
    constructor(uid: string);
}
export interface CurrentSizingKey {
    readonly sizingKey: string | null;
    readonly profile: GatewaySizingProfile | null;
    readonly assertCurrent: (user: Stored<PlatformUserRecord> | null) => void;
}
export declare function withCurrentSizingKey<T>(input: {
    store: PlatformStateStore;
    readSizingKey: SizingKeyReader;
    uid: string;
    now: number;
}, run: (current: CurrentSizingKey) => Promise<T>): Promise<T>;
export interface IsolatedRuntimeDemandRequest {
    store: PlatformStateStore;
    readSizingKey: SizingKeyReader;
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
    sizingKey: string;
    sizingTier: string;
    slug: string;
};
export declare function activationDemandEligibility(user: PlatformUserRecord, sizingKey: string | null, profile: GatewaySizingProfile | null): ActivationDemandEligibility;
export declare function requestUserActivationLease(input: IsolatedRuntimeDemandRequest): Promise<UserActivationLeaseResult>;
export declare function builderActivateOperationId(gatewayId: string, generation: number): string;
export declare function builderReturnOperationId(gatewayId: string, generation: number): string;
export declare function isolatedRecoverOperationId(gatewayId: string, generation: number): string;
export declare function placementRetireOperationId(uid: string, gatewayId: string, generation: number): string;
export declare function isUserActivateOperationIdFor(operationId: unknown, gatewayId: unknown): boolean;
export declare function isUserReturnOperationIdFor(operationId: unknown, gatewayId: unknown): boolean;
