import type { UserRecordsRepository } from "./platform-state/users.js";
export interface VerifiedUser {
    readonly uid: string;
    readonly authTime: number | null;
}
export interface UserDocument {
    [field: string]: any;
}
export declare class UserCredentialRejected extends Error {
    readonly name = "UserCredentialRejected";
}
export declare function isUserCredentialRejected(error: unknown): error is UserCredentialRejected;
export interface UserIdentityProvider {
    verifyBearer(token: string): Promise<VerifiedUser>;
    loadUser(uid: string): Promise<UserDocument | null>;
}
export declare function mattermostBearerVerifier(options: {
    readonly mattermostUrl: string;
    readonly users: Pick<UserRecordsRepository, "findByMattermostUserId">;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
}): UserIdentityProvider["verifyBearer"];
