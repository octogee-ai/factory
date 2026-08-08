import { type GatewayRpcClient } from "./gateway-rpc.js";
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
    rpc?: Pick<GatewayRpcClient, "secretsApply" | "close">;
}
/** Applies a plan through the gateway RPC. Throws OpenClawSecretsApplyError on
 *  any transport or gateway refusal — the caller decides whether that is fatal
 *  or a deferral for the next sweep. */
export declare function applyOpenClawSecretsPlan(plan: OpenClawSecretsPlan, opts?: ApplyOpenClawSecretsPlanOptions): Promise<void>;
