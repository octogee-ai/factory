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
export interface ApplyOpenClawSecretsPlanOptions {
    apply?: (plan: OpenClawSecretsPlan) => Promise<unknown>;
    log?: (message: string) => void;
}
export declare function applyOpenClawSecretsPlan(plan: OpenClawSecretsPlan, opts?: ApplyOpenClawSecretsPlanOptions): Promise<void>;
