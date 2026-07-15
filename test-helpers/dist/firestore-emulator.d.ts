import admin from "firebase-admin";
export declare function getAdminDb(): admin.firestore.Firestore;
export declare function getAdminAuth(): admin.auth.Auth;
export declare function resetEmulator(): Promise<void>;
export declare function requireEmulator(): void;
export declare function getIdTokenForUid(uid: string): Promise<string>;
export declare function setupEmulatorTest(opts?: {
    env?: Record<string, string>;
}): void;
export interface AuthTokenHandle {
    bearer: () => string;
    raw: () => string;
}
export declare function useAuthToken(uid: string): AuthTokenHandle;
