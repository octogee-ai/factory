export type ByosubProvider = "openai" | "anthropic";
export interface ByosubRestorePlanItem {
    agentId: string;
    provider: ByosubProvider;
    secretName: string;
    openclawDir: string;
}
/**
 * Every rostered agent id, from either roster form.
 *
 * 2026.7.2 rewrites `agents.list` into keyed `agents.entries` at pre-boot, so on
 * a current pod the list form is simply absent. Reading only `.list` there
 * returns [] and turns every caller into a silent no-op — the model-ready boot
 * sweep, git-identity hydration, byosub syncback and the broker-profile retry
 * all quietly stop working. Entries win when both are present: the migration
 * leaves the pre-migration list behind, so it is the stale copy.
 */
export declare function agentIdsFromConfig(config: unknown): string[];
export declare function isSafeAgentId(agentId: string): boolean;
export declare function codexHomeDir(openclawDir: string, agentId: string): string;
export declare function codexAuthJsonPath(openclawDir: string, agentId: string): string;
export declare function claudeCliNativeCredentialsPath(homeDir: string): string;
export declare function codexStagingHomeDir(openclawDir: string, agentId: string): string;
export declare function codexStagingAuthJsonPath(openclawDir: string, agentId: string): string;
export declare function codexAgentDir(openclawDir: string, agentId: string): string;
export declare function sharedAuthAgentDir(openclawDir: string): string;
export declare function removeSubscriptionProfiles(agentDir: string, providers: readonly ByosubProvider[]): boolean;
export declare function codexAuthStatePath(openclawDir: string, agentId: string): string;
export interface CustomerOauthRuntimePurgeResult {
    removedFiles: number;
    removedDirectories: number;
    scrubbedProfileStores: number;
    resetSessions: number;
    affectedAgentIds: string[];
}
interface CustomerOauthRuntimePurgeOptions {
    openclawDir: string;
    homeDir: string;
    agentIds: readonly string[];
    resetSessionStores?: boolean;
    directRuntimeModelRefs?: readonly string[];
    allowedModelRefs?: readonly string[];
    allowedProviderIds?: readonly string[];
    modelProviders?: Record<string, unknown>;
}
export declare function purgeCustomerOauthRuntimeArtifacts(opts: CustomerOauthRuntimePurgeOptions): CustomerOauthRuntimePurgeResult;
/**
 * Reads the codex auth-state payload as text — preferring the SQLite
 * auth_profile_state row (openclaw v2026.6.5+) and falling back to the
 * legacy auth-state.json file when the SQLite row is absent. Returns null
 * when neither source has data.
 *
 * Keeps the text-in / health-out contract of `deriveCodexAuthHealth`
 * unchanged.
 */
export declare function readCodexAuthStateText(openclawDir: string, agentId: string): string | null;
export declare function shouldRestoreCodexCredential(opts: {
    usableCodexProfilePresent: boolean;
    authStateText: string | null;
    profileId: string;
    now: number;
}): "write" | "skip";
export declare function removeStaleCodexAuthJson(openclawDir: string, agentId: string): boolean;
export declare function restoreByosubCredentials(opts: {
    plan: ByosubRestorePlanItem[];
    fetchSecret: (secretName: string) => Promise<string>;
    logFn?: (m: string) => void;
    claudeCliNativeHomeDir?: string;
}): Promise<{
    restored: number;
    failed: number;
    skipped: number;
}>;
export {};
