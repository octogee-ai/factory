import { applyByotState, deriveDesiredByotState, type CoachModelInput } from "./byot-sync.js";
import { type GatewayRpcClient } from "./gateway-rpc.js";
import { type ByosubProvider } from "./byosub-restore.js";
import { applyConfigPatch } from "./apply-config-patch.js";
import { type AgentModelSelections } from "@octogee/shared/types/agent-models";
export declare function applyCoachModelPatch(input: CoachModelInput | null, deps?: {
    applyConfigPatch?: typeof applyConfigPatch;
    logFn?: (m: string) => void;
    isOperatorGateway?: () => boolean;
}): Promise<boolean>;
export declare function applyCoachToolsConvergence(slug: string, houseOnly: boolean, deps?: {
    applyConfigPatch?: typeof applyConfigPatch;
    logFn?: (m: string) => void;
}): Promise<boolean>;
export declare function applyAgentModelOverrides(slug: string, agentModels: AgentModelSelections | undefined, opts: {
    houseOnly: boolean;
}, deps?: {
    applyConfigPatch?: typeof applyConfigPatch;
    logFn?: (m: string) => void;
}): Promise<boolean>;
export declare function applyOauthRuntimeModelAllowlist(providers: readonly ByosubProvider[], deps?: {
    applyConfigPatch?: typeof applyConfigPatch;
    logFn?: (m: string) => void;
}): Promise<OauthRuntimeModelAllowlistResult>;
export interface OauthRuntimeModelAllowlistResult {
    patched: boolean;
    changed: boolean;
    restartRequired: boolean;
}
export declare function requestGatewayRestartForRuntimeChange(reason?: string): Promise<boolean>;
export declare function triggerSecretsReload(): Promise<void>;
export interface OauthStoreRestoreResult {
    restored: boolean;
    present: boolean;
    providers?: ByosubProvider[];
}
export interface ByosubCred {
    provider: ByosubProvider;
    secretName: string;
    credential: string;
}
export declare function brokerFetchByosubCreds(agentId: string): Promise<ByosubCred[] | null>;
export interface RuntimeRegistryPatchResult {
    patched: boolean;
    changed: boolean;
    restartRequired: boolean;
}
export declare function restoreOauthStoreForSlug(slug: string, deps?: {
    fetchByosubCreds?: (agentId: string) => Promise<ByosubCred[] | null>;
    openclawDir?: string;
    claudeCliNativeHomeDir?: string;
    logFn?: (m: string) => void;
}): Promise<OauthStoreRestoreResult>;
export interface SyncByotForCustomerDeps {
    isOperatorGateway?: () => boolean;
    isSharedGateway?: () => boolean;
    usesLlmBrokerToken?: () => boolean;
    logFn?: (m: string) => void;
    applyConfigPatch?: typeof applyConfigPatch;
    applyByotState?: typeof applyByotState;
    restoreOauthStoreForSlug?: typeof restoreOauthStoreForSlug;
    applyCoachModelPatch?: typeof applyCoachModelPatch;
    applyCoachToolsConvergence?: typeof applyCoachToolsConvergence;
    applyOauthRuntimeModelAllowlist?: typeof applyOauthRuntimeModelAllowlist;
    requestGatewayRestart?: typeof requestGatewayRestartForRuntimeChange;
    triggerSecretsReload?: typeof triggerSecretsReload;
    materializePlatformBrokerSurfaces?: (slug: string) => Promise<boolean> | boolean;
    applyAgentModelOverrides?: typeof applyAgentModelOverrides;
    refreshCoachRuntimeSessions?: typeof refreshCoachRuntimeSessions;
    hasPendingPlatformCatalogRestart?: () => boolean;
    markPlatformCatalogRestartPending?: () => void;
    clearPlatformCatalogRestartPending?: () => void;
}
type DesiredByotState = ReturnType<typeof deriveDesiredByotState>;
type SyncByotUserData = Parameters<typeof deriveDesiredByotState>[0];
export declare function agentIdsForSlug(slug: string, config: unknown): string[];
type SessionPolicyRpc = Pick<GatewayRpcClient, "sessionsList" | "sessionsReset" | "close">;
export declare function refreshCoachRuntimeSessions(slug: string, deps?: {
    agentDir?: string;
    config?: unknown;
    rpc?: SessionPolicyRpc;
}): Promise<{
    refreshed: boolean;
    resetCount: number;
}>;
export declare function gateSharedByosub(desired: DesiredByotState, userData: SyncByotUserData, logFn: (m: string) => void): {
    desired: DesiredByotState;
    suppressed: boolean;
};
export declare function syncByotForCustomer(userData: SyncByotUserData, deps?: SyncByotForCustomerDeps): Promise<void>;
export {};
