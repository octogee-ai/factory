export interface AuthDeleter {
    deleteUser: (uid: string) => Promise<unknown>;
}
export declare function deleteAuthUserTolerantOfMissing(uid: string, auth: AuthDeleter): Promise<void>;
