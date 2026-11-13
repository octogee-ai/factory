interface NativeProfile {
    id: string;
    role?: string | null;
}
type NativeRequest = <T>(method: string, params: Record<string, unknown>, options: {
    scopes: string[];
}) => Promise<T>;
export declare function beginWorkspaceIdentityBoot(env?: NodeJS.ProcessEnv): void;
export declare function workspaceIdentityReady(env?: NodeJS.ProcessEnv): boolean;
export declare function workspaceIdentityFailure(env?: NodeJS.ProcessEnv): string | null;
export declare function workspaceOwnerIdentityReady(env: NodeJS.ProcessEnv, ownerUid: string): boolean;
export declare function assertWorkspaceIdentityReady(env?: NodeJS.ProcessEnv): void;
type BootstrapArgs = {
    request: NativeRequest;
    env?: NodeJS.ProcessEnv;
    signIn?: (uid: string, env: NodeJS.ProcessEnv) => Promise<NativeProfile>;
};
export declare function bootstrapWorkspaceIdentities(args: BootstrapArgs): Promise<void>;
export {};
