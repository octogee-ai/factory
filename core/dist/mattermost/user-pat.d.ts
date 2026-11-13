export declare const USER_PAT_DESCRIPTION = "Octogee workspace chat";
export interface UserPatRotateDeps {
    mmApiCall: (method: string, endpoint: string, body?: unknown) => Promise<unknown>;
    writeUserSecret: (uid: string, data: {
        personalToken: string;
        rotatedAt: unknown;
    }) => Promise<void>;
    now: () => unknown;
    log?: (msg: string) => void;
}
export interface UserPatRotateResult {
    outcome: 'rotated' | 'mm-user-missing' | 'mint-failed';
    newTokenLastFour?: string;
    revokedTokenIds?: string[];
}
export declare function revokeAndMintUserPat(deps: UserPatRotateDeps, uid: string, userMmUserId: string): Promise<UserPatRotateResult>;
