export interface AuthProfileApiKeyTarget {
    type: "auth-profiles.api_key.key";
    path: string;
    ref: {
        source: "exec";
        provider: string;
        id: string;
    };
    agentId: string;
    authProfileProvider: string;
}
export interface OpenClawSecretsPlan {
    version: 1;
    protocolVersion: 1;
    generatedAt: string;
    generatedBy: "manual";
    targets: AuthProfileApiKeyTarget[];
}
export interface SecretsApplyCommandResult {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
}
export type SecretsApplyRunner = (command: string, args: string[], options: {
    env: NodeJS.ProcessEnv;
}) => SecretsApplyCommandResult;
export interface ApplyOpenClawSecretsPlanOptions {
    command?: string;
    tmpRoot?: string;
    env?: NodeJS.ProcessEnv;
    dryRun?: boolean;
    run?: SecretsApplyRunner;
}
export declare class OpenClawSecretsApplyError extends Error {
    readonly status: number | null;
    constructor(message: string, status: number | null);
}
export declare function authProfileApiKeyTarget(input: {
    agentId: string;
    profileId: string;
    provider: string;
    refId: string;
    refProvider?: string;
}): AuthProfileApiKeyTarget;
export declare function buildOpenClawSecretsPlan(targets: readonly AuthProfileApiKeyTarget[], now?: () => Date): OpenClawSecretsPlan;
/** Applies a plan through the openclaw CLI. Throws OpenClawSecretsApplyError on
 *  any spawn failure or non-zero exit — the caller decides whether that is fatal
 *  or a retry. */
export declare function applyOpenClawSecretsPlan(plan: OpenClawSecretsPlan, opts?: ApplyOpenClawSecretsPlanOptions): void;
