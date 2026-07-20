export interface AuthDeleter {
    deleteUser: (uid: string) => Promise<unknown>;
}
export interface AuthSuspender {
    updateUser: (uid: string, properties: {
        disabled: boolean;
    }) => Promise<unknown>;
    revokeRefreshTokens: (uid: string) => Promise<unknown>;
}
export declare function deleteAuthUserTolerantOfMissing(uid: string, auth: AuthDeleter): Promise<void>;
export declare function disableAuthUserAndRevokeSessions(uid: string, auth: AuthSuspender): Promise<void>;
