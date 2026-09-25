import { applyByotState, deriveDesiredByotState, type CoachModelInput } from "./byot-sync.js";
import { type GatewayRpcClient } from "./gateway-rpc.js";
import { type ByosubProvider } from "./byosub-restore.js";
import { applyConfigPatch } from "./apply-config-patch.js";
import { type AgentModelSelections } from "@octogee/shared/types/agent-models";
export declare function applyCoachModelPatch(input: CoachModelInput | null, deps?: {
    applyConfigPatch?: typeof applyConfigPatch;
    logFn?: (m: string) => void;
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
export declare function brokerPushByosubCred(agentId: string, provider: ByosubProvider, credential: string): Promise<{
    changed: boolean;
    destroyed: number;
}>;
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
    agentIds?: readonly string[];
    logFn?: (m: string) => void;
}): Promise<OauthStoreRestoreResult>;
export interface SyncByotForCustomerDeps {
    isBuilderGateway?: () => boolean;
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
    purgeCustomerOauthRuntime?: typeof purgeCustomerOauthRuntime;
    applyAgentModelOverrides?: typeof applyAgentModelOverrides;
    refreshCoachRuntimeSessions?: typeof refreshCoachRuntimeSessions;
    hasPendingPlatformCatalogRestart?: () => boolean;
    markPlatformCatalogRestartPending?: () => void;
    clearPlatformCatalogRestartPending?: () => void;
}
type DesiredByotState = ReturnType<typeof deriveDesiredByotState>;
type SyncByotUserData = Parameters<typeof deriveDesiredByotState>[0];
export declare function agentIdsForSlug(slug: string, config: unknown): string[];
export declare const CUSTOMER_APPROVED_PLUGINS: readonly ["mattermost", "anthropic", "memory-core", "octogee-chat-tools", "octogee-connector-tools", "octogee-access-tools", "octogee-project-tools", "octogee-board-tools", "octogee-status-tools", "octogee-ops-tools", "octogee-web-tools", "octogee-workspace-tools", "parallel", "openai"];
export type GatewayResolutionEnv = Readonly<Record<string, string | undefined>>;
export declare function customerSecurityProjectionReplacePaths(current: unknown): string[];
export declare function customerOauthRuntimeConfigPatch(current: unknown, slug: string, safeModelRef: string, opts?: {
    forceSafeAll?: boolean;
}): Record<string, unknown>;
export declare function customerMountConfigPatch(current: unknown, mountPatch: Record<string, unknown>, slug: string, safeModelRef: string, gatewayEnv?: GatewayResolutionEnv): Record<string, unknown>;
type PurgeCustomerOauthRuntimeDeps = {
    config?: unknown;
    openclawDir?: string;
    homeDir?: string;
    applyConfigPatch?: typeof applyConfigPatch;
    rpc?: SessionPolicyRpc;
    logFn?: (message: string) => void;
    forceSafeAll?: boolean;
};
export declare function purgeCustomerOauthRuntime(slug: string, safeModelRef: string, deps?: PurgeCustomerOauthRuntimeDeps): Promise<{
    changed: boolean;
    resetCount: number;
}>;
type SessionPolicyRpc = Pick<GatewayRpcClient, "sessionsList" | "sessionsReset" | "close">;
export declare function refreshCoachRuntimeSessions(slug: string, deps?: {
    agentDir?: string;
    config?: unknown;
    rpc?: SessionPolicyRpc;
}): Promise<{
    refreshed: boolean;
    resetCount: number;
}>;
export declare function applyPlatformModelAllowlist(applyConfigPatchFn?: typeof applyConfigPatch, builder?: boolean): Promise<boolean>;
export declare function gateCustomerByosub(desired: DesiredByotState, userData: SyncByotUserData, logFn: (m: string) => void): {
    desired: DesiredByotState;
    suppressed: boolean;
};
export declare function syncByotForCustomer(userData: SyncByotUserData, deps?: SyncByotForCustomerDeps): Promise<void>;
export {};
