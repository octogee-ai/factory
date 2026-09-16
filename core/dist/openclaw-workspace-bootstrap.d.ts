type NativeRequest = <T>(method: string, params: Record<string, unknown>, options: {
    scopes: string[];
}) => Promise<T>;
export declare function beginWorkspaceIdentityBoot(env?: NodeJS.ProcessEnv): void;
export declare function workspaceIdentityReady(env?: NodeJS.ProcessEnv): boolean;
export declare function assertWorkspaceIdentityReady(env?: NodeJS.ProcessEnv): void;
export declare function bootstrapWorkspaceIdentities(args: {
    request: NativeRequest;
    env?: NodeJS.ProcessEnv;
    createProfile?: (uid: string, env: NodeJS.ProcessEnv) => Promise<void>;
}): Promise<void>;
export {};
