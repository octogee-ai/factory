export declare const USER_IDENTITY_ROUTE = "/internal/fleet/builder-identity";
export type UserIdentityUnavailableReason = "retired" | "retiring" | "not-builder";
export interface ClaimedUserIdentity {
    gatewayId: string;
    state: "claimed";
    ownerUid: string;
    builderSlug: string;
    leaseId: string | null;
    generation: number | null;
    bootMode?: "prelaunch" | "normal" | "activating";
    activationMigrationId?: string;
}
export type UserIdentity = ClaimedUserIdentity | {
    gatewayId: string;
    state: "unavailable";
    reason: UserIdentityUnavailableReason;
};
export declare function isUserOwnerUid(value: unknown): value is string;
export declare function parseUserIdentity(value: unknown, expectedGatewayId: string): UserIdentity | null;
export declare const USER_CLAIM_FILE = "builder-claim.json";
export interface UserClaimRecord {
    schemaVersion: 1;
    gatewayId: string;
    ownerUid: string;
    builderSlug: string;
    leaseId: string | null;
    generation: number | null;
    claimedAt: number;
    overlayAppliedAt: number | null;
}
export declare function parseUserClaimRecord(value: unknown): UserClaimRecord | null;
export declare function userClaimFromIdentity(identity: ClaimedUserIdentity, claimedAt: number): UserClaimRecord;
export declare function sameUserOwner(left: Pick<UserClaimRecord, "gatewayId" | "ownerUid" | "builderSlug">, right: Pick<UserClaimRecord, "gatewayId" | "ownerUid" | "builderSlug">): boolean;
