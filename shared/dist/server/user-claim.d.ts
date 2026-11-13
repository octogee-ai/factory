import { userClaimFromIdentity, type UserClaimRecord } from "../types/user-identity.js";
export { userClaimFromIdentity, type UserClaimRecord };
export declare const DEFAULT_OPENCLAW_DIR = "/home/node/.openclaw";
export declare class UserClaimError extends Error {
    constructor(message: string);
}
export declare function userClaimPath(openclawDir: string): string;
export declare function readUserClaim(openclawDir: string, gatewayId: string | undefined): UserClaimRecord | null;
export declare function writeUserClaim(openclawDir: string, record: UserClaimRecord): UserClaimRecord;
export declare function markUserClaimOverlayApplied(openclawDir: string, gatewayId: string, appliedAt: number): UserClaimRecord;
export declare function readUserClaimFromEnv(env?: NodeJS.ProcessEnv): UserClaimRecord | null;
export declare function userClaimSlug(env?: NodeJS.ProcessEnv): string | null;
export declare function userClaimOverlaySlug(env?: NodeJS.ProcessEnv): string | null;
export declare function userClaimOwnerUid(env?: NodeJS.ProcessEnv): string | null;
