export declare const BUILDER_PAT_DESCRIPTION = "Octogee workspace chat";
export interface BuilderPatRotateDeps {
    mmApiCall: (method: string, endpoint: string, body?: unknown) => Promise<unknown>;
    writeBuilderSecret: (uid: string, data: {
        personalToken: string;
        rotatedAt: unknown;
    }) => Promise<void>;
    now: () => unknown;
    log?: (msg: string) => void;
}
export interface BuilderPatRotateResult {
    outcome: 'rotated' | 'mm-user-missing' | 'mint-failed';
    newTokenLastFour?: string;
    revokedTokenIds?: string[];
}
export declare function revokeAndMintBuilderPat(deps: BuilderPatRotateDeps, uid: string, builderMmUserId: string): Promise<BuilderPatRotateResult>;
